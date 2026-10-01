// `doctor` and `setup-claude-desktop` (dist/cli.js) — temp files/dirs only, never the real Claude config.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSandbox, fakeEnv, DIST_CLI, DIST_INDEX, FAKE_CLI } from "./helpers/mcp-client.mjs";

const cleanups = [];
after(() => cleanups.forEach((f) => f()));

function tmp() {
  const d = mkdtempSync(join(tmpdir(), "pdmcp-doctor-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function run(args, { mode = "json", env = {} } = {}) {
  const sb = makeSandbox();
  cleanups.push(sb.cleanup);
  const e = fakeEnv(mode, sb, { CLAUDE_DESKTOP_CONFIG: join(sb.dir, "nope", "c.json"), ...env });
  for (const k of Object.keys(env)) if (env[k] === undefined) delete e[k];
  return new Promise((resolve) => {
    execFile(process.execPath, [DIST_CLI, ...args], { env: e, timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

const SECRET = "s3cr3t-token-XYZ";
const others = { mcpServers: { other: { command: "npx", args: ["other"], env: { API_KEY: SECRET } } } };
const cfgWith = (d, obj) => { const f = join(d, "claude_desktop_config.json"); writeFileSync(f, JSON.stringify(obj, null, 2)); return f; };

describe("doctor", () => {
  it("OK path exits 0 with --json shape", async () => {
    const r = await run(["doctor", "--json"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    for (const c of j.checks) assert.ok(c.id && ["ok", "warn", "fail"].includes(c.status) && typeof c.message === "string");
    assert.deepEqual(j.checks.map((c) => c.id).slice(0, 4), ["node", "cli", "cli-version", "auth"]);
  });
  it("human output is a checklist", async () => {
    const r = await run(["doctor"]);
    assert.match(r.stdout, /✓ node/);
    assert.match(r.stdout, /✓ auth/);
  });
  it("missing CLI exits 1 with a hint", async () => {
    const r = await run(["doctor"], { env: { PROTON_DRIVE_BIN: "/nonexistent/proton-drive" } });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /✗ cli/);
    assert.match(r.stdout, /PROTON_DRIVE_BIN/);
    assert.doesNotMatch(r.stdout, /auth:/);
  });
  it("not authenticated exits 1", async () => {
    const r = await run(["doctor"], { mode: "auth-fail" });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /✗ auth: Not authenticated/);
    assert.match(r.stdout, /auth login/);
  });
  it("sync path missing fails; existing dir passes", async () => {
    const d = tmp();
    const bad = await run(["doctor"], { env: { PROTON_DRIVE_SYNC_PATH: join(d, "missing") } });
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /✗ sync-path/);
    const good = await run(["doctor"], { env: { PROTON_DRIVE_SYNC_PATH: d } });
    assert.equal(good.code, 0);
    assert.match(good.stdout, /✓ sync-path/);
  });
  it("config without our entry warns (exit 0) and never leaks other servers", async () => {
    const f = cfgWith(tmp(), others);
    const r = await run(["doctor", "--config", f]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /⚠ claude-desktop: No proton-drive-mcp entry/);
    assert.ok(!(r.stdout + r.stderr).includes(SECRET));
    assert.ok(!(r.stdout + r.stderr).includes("other"));
  });
  it("config with our entry: ok, secret of other servers never printed (json too)", async () => {
    const f = cfgWith(tmp(), { mcpServers: { ...others.mcpServers, "proton-drive-mcp": { command: process.execPath, args: [DIST_INDEX], env: { PROTON_DRIVE_BIN: FAKE_CLI, OTHER: SECRET } } } });
    for (const flags of [[], ["--json"]]) {
      const r = await run(["doctor", "--config", f, ...flags]);
      assert.equal(r.code, 0, r.stdout);
      assert.ok(!(r.stdout + r.stderr).includes(SECRET));
      assert.match(r.stdout, /looks good/);
    }
  });
  it("entry with bad command or bad PROTON_DRIVE_BIN fails", async () => {
    const d = tmp();
    const badCmd = cfgWith(d, { mcpServers: { "proton-drive-mcp": { command: "/no/such/node", args: [] } } });
    assert.equal((await run(["doctor", "--config", badCmd])).code, 1);
    const badBin = cfgWith(tmp(), { mcpServers: { x: { command: process.execPath, args: ["/a/proton-drive-mcp/dist/index.js"], env: { PROTON_DRIVE_BIN: "/no/such/bin" } } } });
    const r = await run(["doctor", "--config", badBin]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /PROTON_DRIVE_BIN=\/no\/such\/bin/);
  });
  it("entry without PROTON_DRIVE_BIN and CLI outside system PATH dirs warns", async () => {
    const f = cfgWith(tmp(), { mcpServers: { "proton-drive-mcp": { command: process.execPath, args: [DIST_INDEX] } } });
    const r = await run(["doctor", "--config", f]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /⚠ claude-desktop/);
    assert.match(r.stdout, /setup-claude-desktop/);
  });
  it("unparsable config fails", async () => {
    const d = tmp();
    const f = join(d, "c.json");
    writeFileSync(f, "{ nope");
    assert.equal((await run(["doctor", "--config", f])).code, 1);
  });
});

describe("setup-claude-desktop", () => {
  it("dry run prints entry and writes nothing", async () => {
    const d = tmp();
    const f = join(d, "sub", "c.json");
    const r = await run(["setup-claude-desktop", "--config", f]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Dry run/);
    assert.ok(r.stdout.includes(f));
    assert.ok(r.stdout.includes(FAKE_CLI));
    assert.ok(!existsSync(join(d, "sub")));
  });
  it("--write creates file+dir, keeps others, backs up, is idempotent", async () => {
    const d = tmp();
    const f = cfgWith(d, { theme: "dark", ...others });
    const before = readFileSync(f, "utf8");
    const sync = tmp();
    const r1 = await run(["setup-claude-desktop", "--config", f, "--sync-path", sync, "--write"]);
    assert.equal(r1.code, 0, r1.stderr);
    assert.match(r1.stdout, /restart Claude Desktop/);
    const baks = readdirSync(d).filter((n) => /^claude_desktop_config\.json\.bak-\d{17}$/.test(n));
    assert.equal(baks.length, 1);
    assert.equal(readFileSync(join(d, baks[0]), "utf8"), before);
    const j1 = JSON.parse(readFileSync(f, "utf8"));
    assert.equal(j1.theme, "dark");
    assert.deepEqual(j1.mcpServers.other, others.mcpServers.other);
    assert.deepEqual(j1.mcpServers["proton-drive-mcp"], { command: process.execPath, args: [DIST_INDEX], env: { PROTON_DRIVE_BIN: FAKE_CLI, PROTON_DRIVE_SYNC_PATH: sync } });
    const text1 = readFileSync(f, "utf8");
    assert.ok(text1.endsWith("}\n"));
    await run(["setup-claude-desktop", "--config", f, "--sync-path", sync, "--write"]);
    assert.equal(readFileSync(f, "utf8"), text1);
    assert.equal(readdirSync(d).filter((n) => n.includes(".bak-")).length, 1, "unchanged re-run must not add backups");
  });
  it("--write keeps the file mode and leaves no temp files", async () => {
    const d = tmp();
    const f = cfgWith(d, others);
    chmodSync(f, 0o600);
    const r = await run(["setup-claude-desktop", "--config", f, "--write"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.equal(statSync(join(d, readdirSync(d).find((n) => n.includes(".bak-")))).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(d).filter((n) => n.includes(".tmp-")), []);
  });
  it("--write creates missing file and parent dir", async () => {
    const f = join(tmp(), "a", "b", "c.json");
    const r = await run(["setup-claude-desktop", "--config", f, "--write"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(JSON.parse(readFileSync(f, "utf8")).mcpServers["proton-drive-mcp"]);
  });
  it("refuses unparsable JSON and leaves it untouched", async () => {
    const d = tmp();
    const f = join(d, "c.json");
    writeFileSync(f, "{ broken");
    const r = await run(["setup-claude-desktop", "--config", f, "--write"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not valid JSON/);
    assert.equal(readFileSync(f, "utf8"), "{ broken");
    assert.deepEqual(readdirSync(d), ["c.json"]);
  });
  it("refuses when the CLI is missing", async () => {
    const f = join(tmp(), "c.json");
    const r = await run(["setup-claude-desktop", "--config", f, "--write"], { env: { PROTON_DRIVE_BIN: "/nonexistent/proton-drive" } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not found/);
    assert.ok(!existsSync(f));
  });
  it("validates --sync-path", async () => {
    const f = join(tmp(), "c.json");
    const r = await run(["setup-claude-desktop", "--config", f, "--sync-path", join(tmp(), "missing"), "--write"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--sync-path/);
    assert.ok(!existsSync(f));
  });
});
