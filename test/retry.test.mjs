// Transient-error retry for read-only CLI calls (rate limit, request timeout, network reset).
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { join } from "node:path";
import { makeSandbox, startServer, nonVersionCalls, sleep } from "./helpers/mcp-client.mjs";

describe("transient retry (real server, fake CLI)", () => {
  const sandboxes = [];
  const clients = [];
  after(async () => {
    for (const c of clients) await c.close();
    for (const s of sandboxes) s.cleanup();
  });

  async function server(kind, times, extra = {}) {
    const sb = makeSandbox();
    sandboxes.push(sb);
    const client = await startServer("transient-then-json", sb, {
      FAKE_COUNTER: join(sb.dir, "counter"),
      FAKE_TRANSIENT_KIND: kind,
      FAKE_TRANSIENT_TIMES: String(times),
      PROTON_DRIVE_RETRY_BASE_MS: "20",
      FAKE_STDOUT: JSON.stringify([{ uid: "a", name: { ok: true, value: "a.txt" }, type: "file" }]),
      ...extra,
    });
    clients.push(client);
    return { client, sb };
  }

  for (const kind of ["ratelimit", "timeout", "reset"]) {
    it(`recovers from ${kind} after two failures`, async () => {
      const { client, sb } = await server(kind, 2);
      const res = await client.call("drive_list", { path: "/my-files" });
      assert.equal(res.isError, false, res.text);
      assert.equal(nonVersionCalls(sb.argvLog).length, 3);
    });

    it(`gives up on ${kind} after three attempts with the real message`, async () => {
      const { client, sb } = await server(kind, 9);
      const res = await client.call("drive_list", { path: "/my-files" });
      assert.equal(res.isError, true);
      assert.match(res.text, /Too many|timed out|ECONNRESET/);
      assert.equal(nonVersionCalls(sb.argvLog).length, 3);
    });
  }

  it("does not retry a mutating command", async () => {
    const { client, sb } = await server("ratelimit", 1);
    const res = await client.call("drive_mkdir", { path: "/my-files/new" });
    assert.equal(res.isError, true);
    assert.equal(nonVersionCalls(sb.argvLog).length, 1);
  });

  it("does not retry not-found", async () => {
    const { client, sb } = await server("notfound", 1);
    const res = await client.call("drive_list", { path: "/my-files" });
    assert.equal(res.isError, true);
    assert.equal(nonVersionCalls(sb.argvLog).length, 1);
  });

  it("does not retry an auth failure", async () => {
    const sb = makeSandbox();
    sandboxes.push(sb);
    const client = await startServer("auth-fail", sb);
    clients.push(client);
    const res = await client.call("drive_list", { path: "/my-files" });
    assert.equal(res.isError, true);
    assert.equal(nonVersionCalls(sb.argvLog).length, 1);
  });

  it("caps Retry-After at 5s", async () => {
    const { client, sb } = await server("retryafter", 1);
    const t0 = Date.now();
    const res = await client.call("drive_list", { path: "/my-files" }, { timeout: 15_000 });
    const dt = Date.now() - t0;
    assert.equal(res.isError, false, res.text);
    assert.equal(nonVersionCalls(sb.argvLog).length, 2);
    assert.ok(dt >= 4500 && dt < 9000, `waited ${dt}ms (Retry-After 30 must be capped to 5s)`);
  });

  it("cancellation during backoff aborts without another attempt", async () => {
    const { client, sb } = await server("ratelimit", 9, { PROTON_DRIVE_RETRY_BASE_MS: "1500" });
    const id = 5151;
    client.requestWithId(id, "tools/call", { name: "drive_list", arguments: { path: "/my-files" } }, { timeout: 15_000 }).catch(() => {});
    await sleep(600); // first attempt done, now in backoff (1.5-3s)
    client.notify("notifications/cancelled", { requestId: id, reason: "test" });
    await sleep(3500);
    assert.equal(nonVersionCalls(sb.argvLog).length, 1);
    assert.equal(client.exited, false);
  });
});
