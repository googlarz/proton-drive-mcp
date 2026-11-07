// drive_size wraps `proton-drive filesystem size <path>` (CLI 0.9.0+).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSandbox, startServer, nonVersionCalls } from "./helpers/mcp-client.mjs";

async function withServer(mode, env, fn) {
  const sb = makeSandbox();
  const c = await startServer(mode, sb, { PROTON_DRIVE_RETRY_BASE_MS: "1", ...env });
  try { return await fn(c, sb); } finally { await c.close(); sb.cleanup(); }
}

describe("drive_size", () => {
  it("passes the path as an argument array and returns the CLI result with verification wrappers unwrapped", async () => {
    const payload = JSON.stringify({ uid: "n1", size: { ok: true, value: 1234 }, parentUid: "p" });
    await withServer("json", { FAKE_STDOUT: payload }, async (c, sb) => {
      const r = await c.call("drive_size", { path: "/my-files/Projects" });
      assert.equal(r.isError, false, r.text);
      assert.deepEqual(r.data, { uid: "n1", size: 1234 });
      assert.deepEqual(nonVersionCalls(sb.argvLog), [["filesystem", "size", "/my-files/Projects", "--json"]]);
    });
  });

  it("is a read tool: listed and callable in readonly mode", async () => {
    await withServer("json", { PROTON_DRIVE_MODE: "readonly", FAKE_STDOUT: "{\"size\":1}" }, async (c) => {
      assert.ok((await c.listTools()).some((t) => t.name === "drive_size"));
      const r = await c.call("drive_size", { path: "/my-files" });
      assert.equal(r.isError, false, r.text);
    });
  });

  it("refuses a path outside PROTON_DRIVE_REMOTE_ROOTS without calling the CLI", async () => {
    await withServer("json", { PROTON_DRIVE_REMOTE_ROOTS: "/my-files/A", FAKE_STDOUT: "{\"size\":1}" }, async (c, sb) => {
      const ok = await c.call("drive_size", { path: "/my-files/A/sub" });
      assert.equal(ok.isError, false, ok.text);
      const before = nonVersionCalls(sb.argvLog).length;
      for (const path of ["/my-files/AB", "/my-files", "/my-files/A/../AB"]) {
        const r = await c.call("drive_size", { path });
        assert.equal(r.isError, true, path);
      }
      const named = await c.call("drive_size", { path: "/my-files/AB" });
      assert.match(named.text, /outside PROTON_DRIVE_REMOTE_ROOTS/);
      assert.equal(nonVersionCalls(sb.argvLog).length, before);
    });
  });

  it("maps a CLI 0.8-style 'unknown command' failure to a clear error", async () => {
    await withServer("size-legacy", {}, async (c) => {
      const r = await c.call("drive_size", { path: "/my-files" });
      assert.equal(r.isError, true);
      assert.match(r.text, /drive_size needs Proton Drive CLI 0\.9\.0 or newer/);
      assert.doesNotMatch(r.text, /Usage:/);
    });
  });

  it("does not mask an ordinary failure as a version problem", async () => {
    await withServer("fail-stderr", {}, async (c) => {
      const r = await c.call("drive_size", { path: "/my-files" });
      assert.equal(r.isError, true);
      assert.doesNotMatch(r.text, /0\.9\.0/);
    });
  });
});
