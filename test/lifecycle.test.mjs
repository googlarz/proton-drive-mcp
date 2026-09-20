// Process-lifecycle tests: symlink launch, startup latency, signals, cancellation,
// stdin close, EPIPE and concurrency. The fake CLI's `hang` mode spawns a
// SIGTERM-trapping grandchild so we can prove the whole process group dies.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { McpClient, makeSandbox, fakeEnv, startServer, readPids, isAlive, waitFor, sleep, DIST_INDEX, ROOT } from "./helpers/mcp-client.mjs";

const cleanups = [];
const clients = [];
after(async () => {
  for (const c of clients) c.kill("SIGKILL");
  for (const f of cleanups) f();
});

function track(client) { clients.push(client); return client; }

function newSandbox() {
  const sb = makeSandbox();
  cleanups.push(sb.cleanup);
  return sb;
}

/** Waits until a non-version hung CLI child and its grandchild are logged; returns their pids. */
async function waitForHungTree(sb) {
  const ok = await waitFor(() => {
    const rows = readPids(sb.pidFile).filter((r) => r.argv0 !== "version");
    return rows.some((r) => r.role === "child") && rows.some((r) => r.role === "grandchild");
  }, 8000);
  assert.ok(ok, "hung CLI child + grandchild never appeared");
  const rows = readPids(sb.pidFile).filter((r) => r.argv0 !== "version");
  return { child: rows.find((r) => r.role === "child").pid, grandchild: rows.find((r) => r.role === "grandchild").pid };
}

async function assertDead(pids, timeoutMs, label) {
  const dead = await waitFor(() => pids.every((p) => !isAlive(p)), timeoutMs);
  assert.ok(dead, `${label}: still alive: ${pids.filter(isAlive).join(",")}`);
}

const HANG = { FAKE_MODE: "hang" };

describe("launch and startup", () => {
  it("serves MCP when launched through a relative symlink (npm .bin style)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdmcp-link-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, ".bin"));
    // Relative target, exactly like node_modules/.bin/<bin> -> ../<pkg>/dist/index.js.
    symlinkSync(relative(realpathSync(join(dir, ".bin")), realpathSync(DIST_INDEX)), join(dir, ".bin", "proton-drive-mcp"));
    const sb = newSandbox();
    const c = track(new McpClient({ script: join(dir, ".bin", "proton-drive-mcp"), env: fakeEnv("json", sb) }));
    const res = await c.initialize({ timeout: 5000 });
    assert.equal(res.result.serverInfo.name, "proton-drive-mcp");
    assert.equal((await c.listTools()).length, 38);
    await c.close();
  });

  it("serves MCP when launched through a symlinked directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdmcp-dirlink-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    symlinkSync(ROOT, join(dir, "pkg"), "dir");
    const sb = newSandbox();
    const c = track(new McpClient({ script: join(dir, "pkg", "dist", "index.js"), env: fakeEnv("json", sb) }));
    const res = await c.initialize({ timeout: 5000 });
    assert.equal(res.result.serverInfo.name, "proton-drive-mcp");
    await c.close();
  });

  it("answers initialize in under 2s even when the startup `version` probe hangs", async () => {
    const sb = newSandbox();
    const c = track(new McpClient({ env: fakeEnv("hang", sb, { FAKE_HANG_VERSION: "1" }) }));
    const t0 = Date.now();
    await c.initialize({ timeout: 5000 });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `initialize took ${elapsed}ms`);
    const tools = await c.listTools();
    assert.equal(tools.length, 38);
    c.kill("SIGTERM");
    await c.exitPromise;
  });

  it("exits promptly when stdin closes with nothing in flight", async () => {
    const sb = newSandbox();
    const c = track(await startServer("json", sb));
    const t0 = Date.now();
    c.proc.stdin.end();
    const info = await Promise.race([c.exitPromise, sleep(5000).then(() => null)]);
    assert.ok(info, "server did not exit after stdin closed");
    assert.ok(Date.now() - t0 < 5000);
  });
});

describe("signals", () => {
  for (const sig of ["SIGTERM", "SIGINT"]) {
    it(`${sig} kills an in-flight hung CLI child and its SIGTERM-trapping grandchild`, async () => {
      const sb = newSandbox();
      const c = track(await startServer("hang", sb));
      c.callRaw("drive_list", { path: "/my-files" }, { timeout: 30_000 }).catch(() => {});
      const { child, grandchild } = await waitForHungTree(sb);
      assert.ok(isAlive(child) && isAlive(grandchild));
      c.proc.kill(sig);
      const info = await Promise.race([c.exitPromise, sleep(5000).then(() => null)]);
      assert.ok(info, "server did not exit on " + sig);
      assert.equal(info.code, 0);
      await assertDead([child, grandchild], 3000, sig);
    });
  }
});

describe("cancellation", () => {
  it("notifications/cancelled kills the request's CLI process tree and the server keeps serving", async () => {
    const sb = newSandbox();
    const c = track(await startServer("hang", sb));
    const id = 4242;
    c.requestWithId(id, "tools/call", { name: "drive_list", arguments: { path: "/my-files" } }, { timeout: 30_000 }).catch(() => {});
    const { child, grandchild } = await waitForHungTree(sb);
    c.notify("notifications/cancelled", { requestId: id, reason: "test" });
    await assertDead([child, grandchild], 3000, "cancel");
    assert.equal(c.exited, false, "server must survive a cancellation");
    assert.equal((await c.listTools()).length, 38);
    await c.close();
  });

  it("cancelling one call leaves a concurrent call's CLI process alone", async () => {
    const sb = newSandbox();
    const c = track(await startServer("hang", sb));
    c.requestWithId(1001, "tools/call", { name: "drive_list", arguments: { path: "/a" } }, { timeout: 30_000 }).catch(() => {});
    c.requestWithId(1002, "tools/call", { name: "drive_list", arguments: { path: "/b" } }, { timeout: 30_000 }).catch(() => {});
    await waitFor(() => readPids(sb.pidFile).filter((r) => r.argv0 !== "version" && r.role === "child").length >= 2, 8000);
    const children = readPids(sb.pidFile).filter((r) => r.argv0 !== "version" && r.role === "child");
    assert.equal(children.length, 2);
    c.notify("notifications/cancelled", { requestId: 1001 });
    // Exactly one of the two children (the one for /a) should die.
    const oneDied = await waitFor(() => children.filter((r) => !isAlive(r.pid)).length === 1, 3000);
    assert.ok(oneDied, "expected exactly one child to be killed");
    await sleep(300);
    assert.equal(children.filter((r) => !isAlive(r.pid)).length, 1, "the other call must keep running");
    c.kill("SIGTERM");
    await c.exitPromise;
    await assertDead(children.map((r) => r.pid), 3000, "cleanup");
  });
});

describe("host disconnect", () => {
  it("stdin closed with a hung call in flight: server exits and the child tree is dead within ~20s", { timeout: 40_000 }, async () => {
    const sb = newSandbox();
    const c = track(await startServer("hang", sb));
    c.callRaw("drive_list", { path: "/my-files" }, { timeout: 60_000 }).catch(() => {});
    const { child, grandchild } = await waitForHungTree(sb);
    const t0 = Date.now();
    c.proc.stdin.end();
    const info = await Promise.race([c.exitPromise, sleep(20_000).then(() => null)]);
    assert.ok(info, "server did not exit within 20s of stdin closing");
    assert.ok(Date.now() - t0 >= 1000, "should have waited for the in-flight call rather than exiting instantly");
    await assertDead([child, grandchild], 3000, "stdin-close");
  });

  it("EPIPE on stdout kills running children and exits", async () => {
    const sb = newSandbox();
    const c = track(await startServer("hang", sb));
    c.callRaw("drive_list", { path: "/my-files" }, { timeout: 30_000 }).catch(() => {});
    const { child, grandchild } = await waitForHungTree(sb);
    c.proc.stdout.destroy(); // reader goes away
    c.send({ jsonrpc: "2.0", id: 999, method: "tools/list", params: {} }); // forces a write -> EPIPE
    const info = await Promise.race([c.exitPromise, sleep(5000).then(() => null)]);
    assert.ok(info, "server did not exit after EPIPE");
    await assertDead([child, grandchild], 3000, "EPIPE");
  });
});

describe("concurrency", () => {
  it("runs 10 parallel drive_list calls concurrently (~1 call of wall time, not 10)", async () => {
    const sb = newSandbox();
    const c = track(await startServer("json", sb, { FAKE_SLEEP_MS: "500", FAKE_STDOUT: '[{"name":"a","type":"file"}]' }));
    const t0 = Date.now();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => c.call("drive_list", { path: `/my-files/d${i}` }, { timeout: 15_000 })));
    const elapsed = Date.now() - t0;
    for (const r of results) { assert.equal(r.isError, false, r.text); assert.equal(r.data.total, 1); }
    assert.ok(elapsed < 2500, `10 parallel calls took ${elapsed}ms (sequential would be ~5000ms)`);
    await c.close();
  });

  it("correlates responses to the right request when calls finish out of order", async () => {
    const sb = newSandbox();
    const c = track(await startServer("json", sb, { FAKE_SLEEP_MS: "300", FAKE_STDOUT: '[{"name":"a","type":"file"}]' }));
    const [a, b] = await Promise.all([
      c.call("drive_list", { path: "/my-files/first" }),
      c.call("drive_info", { path: "/my-files/second" }),
    ]);
    assert.equal(a.data.path, "/my-files/first");
    assert.equal(a.isError, false);
    assert.equal(b.isError, false);
    await c.close();
  });
});
