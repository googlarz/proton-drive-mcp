// PROTON_DRIVE_TOOL_TIER: full (default) vs core tool surface, call-time gating and size budgets.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeSandbox, startServer, nonVersionCalls, sleep, fakeEnv, DIST_INDEX } from "./helpers/mcp-client.mjs";
import { spawn } from "node:child_process";

const CORE = [
  "drive_auth_status", "drive_version", "drive_list", "drive_info", "drive_list_trash", "drive_search", "drive_tree",
  "drive_mkdir", "drive_upload", "drive_download", "drive_rename", "drive_move", "drive_copy",
  "drive_trash", "drive_restore", "drive_share_status", "photos_list_timeline", "photos_download",
];
const FULL_ONLY = ["drive_delete", "drive_empty_trash", "drive_auth_logout", "drive_share_set_url", "drive_share_invite", "photos_delete_album", "drive_write_file"];
const size = (tools) => Buffer.byteLength(JSON.stringify({ tools }));

async function withServer(env, fn) {
  const sb = makeSandbox();
  const c = await startServer("json", sb, env);
  try { return await fn(c, sb); } finally { await c.close(); sb.cleanup(); }
}

describe("tool tier", () => {
  let full, core;
  before(async () => {
    full = await withServer({}, (c) => c.listTools());
    core = await withServer({ PROTON_DRIVE_TOOL_TIER: "core" }, (c) => c.listTools());
  });

  it("default lists all 40 tools", () => assert.equal(full.length, 40));

  it("core lists exactly the curated set, all present in full", () => {
    assert.deepEqual(core.map((t) => t.name).sort(), [...CORE].sort());
    const fullNames = new Set(full.map((t) => t.name));
    for (const n of CORE) assert.ok(fullNames.has(n), n);
    for (const n of FULL_ONLY) assert.ok(!core.some((t) => t.name === n), `${n} must not be in core`);
  });

  it("every core tool has a sentence-long description and a valid object schema", () => {
    for (const t of core) {
      assert.match(t.description, /[A-Za-z].*[.)]$/s, t.name);
      assert.equal(t.inputSchema.type, "object", t.name);
      for (const r of t.inputSchema.required ?? []) assert.ok(r in t.inputSchema.properties, `${t.name}.${r}`);
    }
  });

  it("tools/list stays within the size budget", () => {
    assert.ok(size(full) <= 60_000, `full ${size(full)} bytes`);
    assert.ok(size(core) <= 16_000, `core ${size(core)} bytes`);
  });

  it("core refuses a hidden tool at call time without touching the CLI", async () => {
    await withServer({ PROTON_DRIVE_TOOL_TIER: "core" }, async (c, sb) => {
      const r = await c.call("drive_delete", { path: "/trash/x", confirmed: true });
      assert.equal(r.isError, true);
      assert.match(r.text, /PROTON_DRIVE_TOOL_TIER=full/);
      await sleep(100);
      assert.deepEqual(nonVersionCalls(sb.argvLog), []);
    });
  });

  it("core still serves an in-tier tool", async () => {
    await withServer({ PROTON_DRIVE_TOOL_TIER: "core" }, async (c) => {
      assert.equal((await c.call("drive_version")).isError, false);
    });
  });

  it("unknown tier behaves as full, warns on stderr, keeps stdout pure JSON-RPC", async () => {
    const sb = makeSandbox();
    const p = spawn(process.execPath, [DIST_INDEX], { env: fakeEnv("json", sb, { PROTON_DRIVE_TOOL_TIER: "bogus" }), stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    await sleep(400);
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    await sleep(400);
    p.stdin.end();
    await new Promise((r) => p.on("exit", r));
    sb.cleanup();
    const lines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l)); // throws on any non-JSON line
    assert.ok(lines.every((m) => m.jsonrpc === "2.0"));
    assert.equal(lines.find((m) => m.id === 2).result.tools.length, 40);
    assert.equal((err.match(/PROTON_DRIVE_TOOL_TIER/g) ?? []).length, 1);
  });
});
