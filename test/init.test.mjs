// `init` (dist/cli.js and the `proton-drive-mcp init` bin, dist/index.js) — temp dirs only, never the real Claude config or HOME.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { cpSync, symlinkSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSandbox, fakeEnv, readArgvLog, DIST_CLI, DIST_INDEX, FAKE_CLI, ROOT } from "./helpers/mcp-client.mjs";

const cleanups = [];
after(() => cleanups.forEach((f) => f()));

function tmp() {
  const d = mkdtempSync(join(tmpdir(), "pdmcp-init-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

// bin: which script is run, as `npx -y proton-drive-mcp init` (dist/index.js) or `proton-drive-cli init` (dist/cli.js).
function run(args, { mode = "json", env = {}, bin = DIST_CLI, sandbox } = {}) {
  const sb = sandbox ?? makeSandbox();
  if (!sandbox) cleanups.push(sb.cleanup);
  const e = fakeEnv(mode, sb, { CLAUDE_DESKTOP_CONFIG: join(sb.dir, "nope", "c.json"), ...env });
  for (const k of Object.keys(env)) if (env[k] === undefined) delete e[k];
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { env: e, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

const SECRET = "s3cr3t-token-XYZ";
const others = { mcpServers: { other: { command: "npx", args: ["other"], env: { API_KEY: SECRET } } } };
const cfgWith = (d, obj) => { const f = join(d, "claude_desktop_config.json"); writeFileSync(f, JSON.stringify(obj, null, 2)); return f; };
const baks = (d) => readdirSync(d).filter((n) => /^claude_desktop_config\.json\.bak-\d{17}$/.test(n));
const NPX_ENTRY = { command: "npx", args: ["-y", "proton-drive-mcp"], env: { PROTON_DRIVE_BIN: FAKE_CLI } };

describe("init: output", () => {
  it("dry run runs the doctor checks and prints both configs, writing nothing", async () => {
    const d = tmp();
    const f = join(d, "sub", "c.json");
    const r = await run(["init", "--config", f]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /✓ node/);
    assert.match(r.stdout, /✓ cli:/);
    assert.match(r.stdout, /✓ auth/);
    assert.match(r.stdout, /Dry run: nothing changed/);
    // Claude Desktop block: the npx form with the absolute CLI path.
    const block = r.stdout.slice(r.stdout.indexOf("{\n"), r.stdout.lastIndexOf("}\n") + 1);
    assert.deepEqual(JSON.parse(block), { mcpServers: { "proton-drive-mcp": NPX_ENTRY } });
    // Claude Code line.
    assert.ok(r.stdout.includes(`claude mcp add --env PROTON_DRIVE_BIN='${FAKE_CLI}' proton-drive -- npx -y proton-drive-mcp`));
    assert.ok(!existsSync(join(d, "sub")));
  });

  it("works as `proton-drive-mcp init` (the dist/index.js bin used by npx)", async () => {
    const f = join(tmp(), "c.json");
    const r = await run(["init", "--config", f], { bin: DIST_INDEX });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Dry run/);
    assert.match(r.stdout, /claude mcp add/);
    assert.ok(!existsSync(f));
  });

  it("--json is one machine-readable line", async () => {
    const r = await run(["init", "--json", "--config", join(tmp(), "c.json")]);
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.cliPath, FAKE_CLI);
    assert.deepEqual(j.claudeDesktop.entry, NPX_ENTRY);
    assert.equal(j.claudeDesktop.action, "dry-run");
    assert.match(j.claudeCode, /^claude mcp add --env PROTON_DRIVE_BIN=/);
  });

  it("quotes the CLI path for the shell in single quotes (nothing expands, not even `!`)", async () => {
    const { shellQuote } = await import(join(ROOT, "dist", "utils", "init.js"));
    assert.equal(shellQuote("/a b/c"), "'/a b/c'");
    assert.equal(shellQuote("/a'b"), "'/a'\\''b'");
    for (const nasty of ["/a b/$HOME/`id`/!!/\"q\"/it's", "'", "''", "\\", "!x"]) {
      const out = execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(nasty)}`], { encoding: "utf8" });
      assert.equal(out, nasty);
    }
  });

  it("never touches the session: only read-only version/filesystem probes reach the CLI", async () => {
    const sb = makeSandbox();
    cleanups.push(sb.cleanup);
    const r = await run(["init", "--config", join(sb.dir, "c.json")], { sandbox: sb });
    assert.equal(r.code, 0);
    const calls = readArgvLog(sb.argvLog);
    assert.ok(calls.length > 0);
    for (const argv of calls) assert.ok(argv[0] === "version" || (argv[0] === "filesystem" && argv[1] === "info"), JSON.stringify(argv));
  });
});

describe("init: failures give the next step", () => {
  it("missing CLI: exit 1, install + login + re-run, no config printed, --write writes nothing", async () => {
    const d = tmp();
    const f = join(d, "c.json");
    const home = tmp(); // no ~/.local/bin/proton-drive here
    const env = { PROTON_DRIVE_BIN: "/nonexistent/proton-drive", HOME: home };
    for (const flags of [[], ["--write"]]) {
      const r = await run(["init", "--config", f, ...flags], { env });
      assert.equal(r.code, 1);
      assert.match(r.stdout, /✗ cli/);
      assert.match(r.stdout, /Next step: Install the official Proton Drive CLI from https:\/\/proton\.me\/download\/drive\/cli\/index\.html/);
      assert.match(r.stdout, /proton-drive auth login/);
      assert.match(r.stdout, /re-run `npx -y proton-drive-mcp init`/);
      assert.doesNotMatch(r.stdout, /claude mcp add/);
      assert.ok(!existsSync(f));
    }
  });

  it("not authenticated: exit 1 with `proton-drive auth login` as the next step, config still shown", async () => {
    const r = await run(["init", "--config", join(tmp(), "c.json")], { mode: "auth-fail" });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /✗ auth: Not authenticated/);
    assert.match(r.stdout, /Next step: Run `proton-drive auth login`/);
    assert.match(r.stdout, /claude mcp add/);
  });

  it("invalid JSON config: --write refuses, exits 1 and leaves the file byte-identical", async () => {
    const d = tmp();
    const f = join(d, "claude_desktop_config.json");
    writeFileSync(f, "{ nope");
    const r = await run(["init", "--config", f, "--write"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /not valid JSON; refusing to modify it/);
    assert.equal(readFileSync(f, "utf8"), "{ nope");
    assert.equal(baks(d).length, 0);
  });
});

describe("init: CLI resolution", () => {
  it("falls back to ~/.local/bin when the CLI is not on PATH", async () => {
    const home = tmp();
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const wrapper = join(home, ".local", "bin", "proton-drive");
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    const r = await run(["init", "--config", join(tmp(), "c.json")], { env: { PROTON_DRIVE_BIN: undefined, HOME: home, PATH: "/usr/bin:/bin" } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /✓ auth/);
    assert.ok(r.stdout.includes(`PROTON_DRIVE_BIN='${wrapper}'`), r.stdout);
  });

  it("an explicit PROTON_DRIVE_BIN is not second-guessed by the fallback", async () => {
    const home = tmp();
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const wrapper = join(home, ".local", "bin", "proton-drive");
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    const r = await run(["init", "--config", join(tmp(), "c.json")], { env: { PROTON_DRIVE_BIN: "/nonexistent/proton-drive", HOME: home } });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /PROTON_DRIVE_BIN=\/nonexistent\/proton-drive is not an executable file/);
  });
});

describe("init --write", () => {
  it("creates a missing config (and its directory) without a backup", async () => {
    const d = tmp();
    const f = join(d, "Claude", "claude_desktop_config.json");
    const r = await run(["init", "--config", f, "--write"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /restart Claude Desktop/);
    assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { mcpServers: { "proton-drive-mcp": NPX_ENTRY } });
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.equal(readdirSync(join(d, "Claude")).length, 1);
  });

  it("backs up first and touches only the proton-drive-mcp entry", async () => {
    const d = tmp();
    const f = cfgWith(d, { theme: "dark", ...others });
    const before = readFileSync(f, "utf8");
    const r = await run(["init", "--config", f, "--write"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const b = baks(d);
    assert.equal(b.length, 1);
    assert.match(r.stdout, new RegExp(`backup: .*${b[0]}`));
    assert.equal(readFileSync(join(d, b[0]), "utf8"), before);
    const j = JSON.parse(readFileSync(f, "utf8"));
    assert.equal(j.theme, "dark");
    assert.deepEqual(j.mcpServers.other, others.mcpServers.other);
    assert.deepEqual(j.mcpServers["proton-drive-mcp"], NPX_ENTRY);
    assert.deepEqual(Object.keys(j.mcpServers).sort(), ["other", "proton-drive-mcp"]);
    assert.ok(!(r.stdout + r.stderr).includes(SECRET));
  });

  it("dry run on an existing config changes nothing", async () => {
    const d = tmp();
    const f = cfgWith(d, others);
    const before = readFileSync(f, "utf8");
    const r = await run(["init", "--config", f]);
    assert.equal(r.code, 0);
    assert.equal(readFileSync(f, "utf8"), before);
    assert.equal(baks(d).length, 0);
    assert.ok(!(r.stdout + r.stderr).includes(SECRET));
  });

  it("running twice is idempotent: no second backup, file unchanged", async () => {
    const d = tmp();
    const f = cfgWith(d, others);
    await run(["init", "--config", f, "--write"]);
    const after1 = readFileSync(f, "utf8");
    assert.equal(baks(d).length, 1);
    const r2 = await run(["init", "--config", f, "--write"]);
    assert.equal(r2.code, 0, r2.stdout + r2.stderr);
    assert.match(r2.stdout, /Already up to date/);
    assert.equal(readFileSync(f, "utf8"), after1);
    assert.equal(baks(d).length, 1);
    // doctor agrees that the written entry is fine.
    const doc = await run(["doctor", "--config", f]);
    assert.equal(doc.code, 0, doc.stdout);
    assert.match(doc.stdout, /✓ claude-desktop/);
  });

  it("replaces an existing setup-claude-desktop entry (after a backup), says so, and keeps its other env keys", async () => {
    const d = tmp();
    const kept = { PROTON_DRIVE_MODE: "readonly", PROTON_DRIVE_REMOTE_ROOTS: "/my-files/SECRET-FOLDER", PROTON_DRIVE_AUDIT_LOG: "/x/audit.log", PROTON_DRIVE_SYNC_PATH: "/x/sync" };
    const old = { command: process.execPath, args: [DIST_INDEX], env: { PROTON_DRIVE_BIN: "/old/proton-drive", ...kept } };
    const f = cfgWith(d, { mcpServers: { ...others.mcpServers, "proton-drive-mcp": old } });
    const dry = await run(["init", "--config", f]);
    assert.match(dry.stdout, /existing proton-drive-mcp entry would be replaced/);
    assert.match(dry.stdout, /pinned install \(setup-claude-desktop form\).*npx form runs the latest published version instead/);
    assert.match(dry.stdout, /env PROTON_DRIVE_MODE, PROTON_DRIVE_REMOTE_ROOTS, PROTON_DRIVE_AUDIT_LOG, PROTON_DRIVE_SYNC_PATH \(values not shown\)/);
    for (const v of ["readonly", "SECRET-FOLDER", "/x/audit.log", "/x/sync"]) assert.ok(!dry.stdout.includes(v), v);
    assert.deepEqual(JSON.parse(readFileSync(f, "utf8")).mcpServers["proton-drive-mcp"], old);
    const r = await run(["init", "--config", f, "--write"]);
    assert.equal(r.code, 0, r.stdout);
    for (const v of ["readonly", "SECRET-FOLDER", "/x/audit.log"]) assert.ok(!r.stdout.includes(v), v);
    const b = baks(d);
    assert.equal(b.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(d, b[0]), "utf8")).mcpServers["proton-drive-mcp"], old);
    const j = JSON.parse(readFileSync(f, "utf8"));
    assert.deepEqual(j.mcpServers["proton-drive-mcp"], { command: "npx", args: ["-y", "proton-drive-mcp"], env: { PROTON_DRIVE_BIN: FAKE_CLI, ...kept } });
    assert.deepEqual(j.mcpServers.other, others.mcpServers.other);
    // Idempotent on the merged entry: no second backup, file untouched.
    const text = readFileSync(f, "utf8");
    const r2 = await run(["init", "--config", f, "--write"]);
    assert.equal(r2.code, 0);
    assert.match(r2.stdout, /Already up to date/);
    assert.match(r2.stdout, /env PROTON_DRIVE_MODE/);
    assert.equal(readFileSync(f, "utf8"), text);
    assert.equal(baks(d).length, 1);
  });

  it("an npx entry that only differs in PROTON_DRIVE_BIN is updated and its readonly guard survives", async () => {
    const d = tmp();
    const entry = { command: "npx", args: ["-y", "proton-drive-mcp"], env: { PROTON_DRIVE_BIN: "/old/bin", PROTON_DRIVE_MODE: "readonly", PROTON_DRIVE_REMOTE_ROOTS: "/my-files/a" } };
    const f = cfgWith(d, { mcpServers: { "proton-drive-mcp": entry } });
    const r = await run(["init", "--config", f, "--write"]);
    assert.equal(r.code, 0, r.stdout);
    assert.doesNotMatch(r.stdout, /pinned install/);
    assert.deepEqual(JSON.parse(readFileSync(f, "utf8")).mcpServers["proton-drive-mcp"].env, { PROTON_DRIVE_BIN: FAKE_CLI, PROTON_DRIVE_MODE: "readonly", PROTON_DRIVE_REMOTE_ROOTS: "/my-files/a" });
  });

  it("refuses --write when the server is already registered under another key; the dry run warns", async () => {
    const d = tmp();
    const twin = { command: "npx", args: ["-y", "proton-drive-mcp"], env: { PROTON_DRIVE_BIN: FAKE_CLI } };
    const f = cfgWith(d, { mcpServers: { ...others.mcpServers, "my-proton": twin } });
    const before = readFileSync(f, "utf8");
    const dry = await run(["init", "--config", f]);
    assert.equal(dry.code, 1);
    assert.match(dry.stdout, /already registered under "my-proton".*double the tools.*remove that entry.*rename it to "proton-drive-mcp"/);
    assert.match(dry.stdout, /\nProblems found\.\n$/);
    assert.doesNotMatch(dry.stdout, /No problems found/);
    assert.equal(JSON.parse((await run(["init", "--json", "--config", f])).stdout).ok, false);
    const r = await run(["init", "--config", f, "--write"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /already registered under "my-proton"/);
    assert.equal(readFileSync(f, "utf8"), before);
    assert.equal(baks(d).length, 0);
    // Also when the standard key exists next to a twin.
    const f2 = cfgWith(tmp(), { mcpServers: { "proton-drive-mcp": twin, dup: { command: "node", args: ["/x/proton-drive-mcp/dist/index.js"] } } });
    const before2 = readFileSync(f2, "utf8");
    assert.equal((await run(["init", "--config", f2, "--write"])).code, 1);
    assert.equal(readFileSync(f2, "utf8"), before2);
  });

  it("always notes that the npx entry uses the Node on Claude Desktop's PATH", async () => {
    const r = await run(["init", "--config", join(tmp(), "c.json")]);
    assert.match(r.stdout, /runs with the Node that Claude Desktop finds on its own PATH.*doctor cannot check that/);
  });

  it("refuses on Windows with a clear message", async () => {
    const { runInit } = await import(join(ROOT, "dist", "utils", "init.js"));
    const real = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const f = join(tmp(), "c.json");
      const r = await runInit({ configPath: f, write: true });
      assert.equal(r.ok, false);
      assert.match(r.text, /not supported on Windows/);
      assert.ok(!existsSync(f));
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  });

  it("works from a temporary npx cache, which setup-claude-desktop refuses", async () => {
    const root = tmp();
    const pkgDir = join(root, "_npx", "abc123", "node_modules", "proton-drive-mcp");
    mkdirSync(pkgDir, { recursive: true });
    cpSync(join(ROOT, "dist"), join(pkgDir, "dist"), { recursive: true });
    cpSync(join(ROOT, "package.json"), join(pkgDir, "package.json"));
    symlinkSync(join(ROOT, "node_modules", "@modelcontextprotocol"), join(root, "_npx", "abc123", "node_modules", "@modelcontextprotocol"));
    const bin = join(pkgDir, "dist", "index.js");
    const f = join(tmp(), "c.json");
    const refused = await run(["setup-claude-desktop", "--config", f, "--write"], { bin: join(pkgDir, "dist", "cli.js") });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /temporary npx cache/);
    const r = await run(["init", "--config", f, "--write"], { bin });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const written = JSON.parse(readFileSync(f, "utf8"));
    assert.deepEqual(written.mcpServers["proton-drive-mcp"], NPX_ENTRY);
    assert.ok(!JSON.stringify(written).includes("_npx"));
  });
});

describe("init: existing entries in other shapes", () => {
  const entryOf = (f) => JSON.parse(readFileSync(f, "utf8")).mcpServers["proton-drive-mcp"];

  it("a stale entry (dead command, dead PROTON_DRIVE_BIN) does not block init; --write fixes it", async () => {
    const d = tmp();
    const f = cfgWith(d, { mcpServers: { "proton-drive-mcp": { command: "/no/such/node", args: [DIST_INDEX], env: { PROTON_DRIVE_BIN: "/no/such/bin" } } } });
    const dry = await run(["init", "--config", f]);
    assert.equal(dry.code, 0, dry.stdout);
    assert.match(dry.stdout, /⚠ claude-desktop/);
    assert.doesNotMatch(dry.stdout, /✗/);
    assert.match(dry.stdout, /\nNo problems found\.\n$/);
    const r = await run(["init", "--config", f, "--write"]);
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(entryOf(f), NPX_ENTRY);
  });

  it("an absolute path to an existing npx is kept and is not called a pinned install", async () => {
    const d = tmp();
    const npx = join(d, "npx");
    writeFileSync(npx, "#!/bin/sh\nexit 0\n");
    chmodSync(npx, 0o755);
    const same = { command: npx, args: ["-y", "proton-drive-mcp"], env: { PROTON_DRIVE_BIN: FAKE_CLI, PROTON_DRIVE_MODE: "readonly" } };
    const f = cfgWith(d, { mcpServers: { "proton-drive-mcp": same } });
    const before = readFileSync(f, "utf8");
    const r1 = await run(["init", "--config", f, "--write"]);
    assert.equal(r1.code, 0, r1.stdout);
    assert.match(r1.stdout, /Already up to date/);
    assert.doesNotMatch(r1.stdout, /pinned/);
    assert.equal(readFileSync(f, "utf8"), before);
    assert.equal(baks(d).length, 0);
    // A different PROTON_DRIVE_BIN is updated, the command stays absolute.
    writeFileSync(f, JSON.stringify({ mcpServers: { "proton-drive-mcp": { ...same, env: { ...same.env, PROTON_DRIVE_BIN: "/old/bin" } } } }));
    const r2 = await run(["init", "--config", f, "--write"]);
    assert.equal(r2.code, 0, r2.stdout);
    assert.doesNotMatch(r2.stdout, /pinned/);
    assert.deepEqual(entryOf(f), same);
    // A dead absolute npx is replaced by bare npx.
    writeFileSync(f, JSON.stringify({ mcpServers: { "proton-drive-mcp": { ...same, command: join(d, "gone", "npx") } } }));
    await run(["init", "--config", f, "--write"]);
    assert.equal(entryOf(f).command, "npx");
  });

  it("the README global-install form (command proton-drive-mcp, no args) under another key counts as a second copy", async () => {
    for (const command of ["proton-drive-mcp", "/usr/local/bin/proton-drive-mcp"]) {
      const d = tmp();
      const f = cfgWith(d, { mcpServers: { drive: { command } } });
      const before = readFileSync(f, "utf8");
      const dry = await run(["init", "--config", f]);
      assert.equal(dry.code, 1);
      assert.match(dry.stdout, /already registered under "drive"/);
      assert.equal((await run(["init", "--config", f, "--write"])).code, 1);
      assert.equal(readFileSync(f, "utf8"), before);
    }
  });

  it("does not mistake other things for a second copy (e.g. a proton-drive-mcp-notes directory)", async () => {
    const d = tmp();
    const others2 = {
      notes: { command: "node", args: ["/home/u/proton-drive-mcp-notes/server.js"] },
      grep: { command: "grep", args: ["proton-drive-mcp-notes"] },
      docs: { command: "/opt/proton-drive-mcp-docs/bin/serve" },
    };
    const f = cfgWith(d, { mcpServers: others2 });
    const r = await run(["init", "--config", f, "--write"]);
    assert.equal(r.code, 0, r.stdout);
    const j = JSON.parse(readFileSync(f, "utf8")).mcpServers;
    assert.deepEqual(entryOf(f), NPX_ENTRY);
    for (const k of Object.keys(others2)) assert.deepEqual(j[k], others2[k]);
  });

  it("looksLikeOurServer is precise", async () => {
    const { looksLikeOurServer } = await import(join(ROOT, "dist", "utils", "claudeConfig.js"));
    for (const yes of [
      { command: "proton-drive-mcp" }, { command: "/usr/local/bin/proton-drive-mcp" },
      { command: "npx", args: ["-y", "proton-drive-mcp"] }, { command: "npx", args: ["-y", "proton-drive-mcp@1.8.0"] }, { command: "npx", args: ["proton-drive-mcp@latest"] },
      { command: "node", args: ["/usr/lib/node_modules/proton-drive-mcp/dist/index.js"] }, { command: "node", args: ["proton-drive-mcp/dist/index.js"] },
    ]) assert.equal(looksLikeOurServer(yes), true, JSON.stringify(yes));
    for (const no of [
      null, {}, { command: "node" }, { command: "proton-drive-mcp-notes" }, { command: "node", args: ["/h/proton-drive-mcp-notes/a.js"] },
      { command: "node", args: ["/h/proton-drive-mcp/notes.md"] }, { command: "npx", args: ["xproton-drive-mcp"] }, { command: "npx", args: ["-y", "proton-drive-mcp-extras"] },
    ]) assert.equal(looksLikeOurServer(no), false, JSON.stringify(no));
  });

  it("a version pin is reported and dropped in favor of the latest", async () => {
    const d = tmp();
    const f = cfgWith(d, { mcpServers: { "proton-drive-mcp": { command: "npx", args: ["-y", "proton-drive-mcp@1.8.0"], env: { PROTON_DRIVE_BIN: FAKE_CLI } } } });
    const dry = await run(["init", "--config", f]);
    assert.match(dry.stdout, /version pin proton-drive-mcp@1\.8\.0 is dropped in favor of the latest published version/);
    assert.doesNotMatch(dry.stdout, /pinned install/);
    assert.deepEqual(entryOf(f).args, ["-y", "proton-drive-mcp@1.8.0"]);
    const r = await run(["init", "--config", f, "--write"]);
    assert.match(r.stdout, /version pin proton-drive-mcp@1\.8\.0 is dropped/);
    assert.deepEqual(entryOf(f).args, ["-y", "proton-drive-mcp"]);
    assert.equal(JSON.parse((await run(["init", "--json", "--config", f])).stdout).claudeDesktop.droppedVersionPin, null);
  });

  it("reports disabled: true and cwd, keeps them, and leaves an otherwise identical entry alone", async () => {
    const d = tmp();
    const entry = { ...NPX_ENTRY, disabled: true, cwd: "/some/where-SECRETDIR" };
    const f = cfgWith(d, { mcpServers: { "proton-drive-mcp": entry } });
    const before = readFileSync(f, "utf8");
    const r = await run(["init", "--config", f, "--write"]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /Already up to date/);
    assert.match(r.stdout, /"disabled": true \(kept\), so Claude Desktop will not start it/);
    assert.match(r.stdout, /"cwd" field \(kept\)/);
    assert.ok(!r.stdout.includes("SECRETDIR"));
    assert.equal(readFileSync(f, "utf8"), before);
    // When the entry does change, both fields survive.
    writeFileSync(f, JSON.stringify({ mcpServers: { "proton-drive-mcp": { ...entry, env: { PROTON_DRIVE_BIN: "/old" } } } }));
    await run(["init", "--config", f, "--write"]);
    assert.deepEqual(entryOf(f), entry);
  });

  it("never prints env values of the existing entry (stdout, stderr, --json), though doctor itself does", async () => {
    const d = tmp();
    const entry = {
      command: process.execPath, args: [DIST_INDEX],
      env: { PROTON_DRIVE_BIN: FAKE_CLI, PROTON_DRIVE_SYNC_PATH: "/leak/SYNCVALUE", PROTON_DRIVE_MODE: "MODEVALUE", PROTON_DRIVE_REMOTE_ROOTS: "/my-files/ROOTVALUE" },
    };
    const f = cfgWith(d, { mcpServers: { "proton-drive-mcp": entry } });
    const doc = await run(["doctor", "--config", f]);
    assert.ok(doc.stdout.includes("SYNCVALUE"), "precondition: doctor echoes the sync path");
    for (const flags of [[], ["--json"], ["--write"], ["--write", "--json"]]) {
      const r = await run(["init", "--config", f, ...flags]);
      assert.equal(r.code, 0, r.stdout);
      for (const v of ["SYNCVALUE", "MODEVALUE", "ROOTVALUE"]) assert.ok(!(r.stdout + r.stderr).includes(v), `${v} in ${flags.join(" ")}`);
    }
    assert.equal(entryOf(f).env.PROTON_DRIVE_SYNC_PATH, "/leak/SYNCVALUE");
    // A dead PROTON_DRIVE_BIN in the entry is reported without its value.
    const g = cfgWith(tmp(), { mcpServers: { "proton-drive-mcp": { ...entry, env: { PROTON_DRIVE_BIN: "/dead/BINVALUE/proton-drive" } } } });
    const r = await run(["init", "--config", g]);
    assert.match(r.stdout, /PROTON_DRIVE_BIN in the entry is not an executable file/);
    assert.ok(!(r.stdout + r.stderr).includes("BINVALUE"));
  });
});
