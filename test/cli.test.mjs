// Companion CLI (dist/cli.js) tests against the fake proton-drive binary.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSandbox, fakeEnv, nonVersionCalls, McpClient, DIST_CLI } from "./helpers/mcp-client.mjs";

const TMP = tmpdir();
const cleanups = [];
after(() => cleanups.forEach((f) => f()));

/** Runs dist/cli.js; resolves {code, stdout, stderr, calls} (calls = CLI invocations excluding `version`). */
function runCli(args, { mode = "json", env = {} } = {}) {
  const sb = makeSandbox();
  cleanups.push(sb.cleanup);
  return new Promise((resolve) => {
    execFile(process.execPath, [DIST_CLI, ...args], { env: fakeEnv(mode, sb, env), timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr, calls: nonVersionCalls(sb.argvLog) });
    });
  });
}

describe("confirmation flags", () => {
  const refusals = [
    ["delete", ["delete", "/trash/a.txt"]],
    ["trash empty", ["trash", "empty"]],
    ["share remove-all", ["share", "remove-all", "/my-files/a"]],
    ["album delete", ["album", "delete", "/albums/Trip"]],
  ];
  for (const [label, args] of refusals) {
    it(`${label} exits 1 without --confirm and never calls the CLI`, async () => {
      const r = await runCli(args);
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, /--confirm/);
      assert.equal(r.calls.length, 0);
    });
    it(`${label} proceeds with --confirm`, async () => {
      const r = await runCli([...args, "--confirm"]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.calls.length > 0);
    });
  }

  it("upload --file-conflict replace exits 1 without --confirm", async () => {
    const r = await runCli(["upload", join(TMP, "x.txt"), "/my-files", "--file-conflict", "replace"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--confirm/);
    assert.equal(r.calls.length, 0);
  });
  it("upload --folder-conflict replace exits 1 without --confirm", async () => {
    const r = await runCli(["upload", join(TMP, "x"), "/my-files", "--folder-conflict", "replace"]);
    assert.equal(r.code, 1);
    assert.equal(r.calls.length, 0);
  });
  it("upload --file-conflict replace succeeds with --confirm and passes the strategy", async () => {
    const r = await runCli(["upload", join(TMP, "x.txt"), "/my-files", "--file-conflict", "replace", "--confirm"]);
    assert.equal(r.code, 0, r.stderr);
    const argv = r.calls[0];
    assert.equal(argv[argv.indexOf("--file-conflict-strategy") + 1], "replace");
  });
  it("upload with the default strategy needs no --confirm", async () => {
    const r = await runCli(["upload", join(TMP, "x.txt"), "/my-files"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls.length, 1);
  });

  it("download --file-conflict remove exits 1 without --confirm", async () => {
    const r = await runCli(["download", "/my-files/a.txt", join(TMP, "dl"), "--file-conflict", "remove"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--confirm/);
    assert.equal(r.calls.length, 0);
  });
  it("download --folder-conflict remove exits 1 without --confirm", async () => {
    const r = await runCli(["download", "/my-files/a", join(TMP, "dl"), "--folder-conflict", "remove"]);
    assert.equal(r.code, 1);
    assert.equal(r.calls.length, 0);
  });
  it("download --file-conflict remove succeeds with --confirm", async () => {
    const r = await runCli(["download", "/my-files/a.txt", join(TMP, "dl"), "--file-conflict", "remove", "--confirm"]);
    assert.equal(r.code, 0, r.stderr);
    const argv = r.calls[0];
    assert.equal(argv[argv.indexOf("--file-conflict-strategy") + 1], "remove");
  });

  it("photo download --conflict remove exits 1 without --confirm", async () => {
    const r = await runCli(["photo", "download", "/photos/p1.jpg", join(TMP, "ph"), "--conflict", "remove"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--confirm/);
    assert.equal(r.calls.length, 0);
  });
  it("photo download --conflict remove succeeds with --confirm and --confirm is not treated as a path", async () => {
    const r = await runCli(["photo", "download", "/photos/p1.jpg", join(TMP, "ph"), "--conflict", "remove", "--confirm"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.calls[0], ["photo", "download", "/photos/p1.jpg", join(TMP, "ph"), "--conflict-strategy", "remove", "--json"]);
  });
});

describe("argument validation", () => {
  it("share invite rejects an invalid role without calling the CLI", async () => {
    const r = await runCli(["share", "invite", "/my-files/a", "bob@example.com", "owner"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Invalid role/);
    assert.equal(r.calls.length, 0);
  });
  it("share set-url rejects --role admin", async () => {
    const r = await runCli(["share", "set-url", "/my-files/a", "--role", "admin"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Invalid --role/);
    assert.equal(r.calls.length, 0);
  });
  it("upload rejects an unknown --file-conflict value", async () => {
    const r = await runCli(["upload", join(TMP, "x"), "/my-files", "--file-conflict", "explode"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Invalid --file-conflict/);
    assert.equal(r.calls.length, 0);
  });
  it("download rejects an unknown --folder-conflict value", async () => {
    const r = await runCli(["download", "/my-files/a", join(TMP, "dl"), "--folder-conflict", "explode"]);
    assert.equal(r.code, 1);
    assert.equal(r.calls.length, 0);
  });
  it("photo upload rejects --conflict remove (skip/rename only)", async () => {
    const r = await runCli(["photo", "upload", join(TMP, "a.jpg"), "--conflict", "remove"]);
    assert.equal(r.code, 1);
    assert.equal(r.calls.length, 0);
  });
  it("a relative remote path is rejected", async () => {
    const r = await runCli(["list", "my-files"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /absolute/);
    assert.equal(r.calls.length, 0);
  });
  it("an unknown command exits 1 and prints usage", async () => {
    const r = await runCli(["frobnicate"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Unknown command: frobnicate/);
    assert.match(r.stdout, /Commands:/);
  });
});

describe("help and pass-through", () => {
  it("--help exits 0 and mentions every command group", async () => {
    const r = await runCli(["--help"]);
    assert.equal(r.code, 0, r.stderr);
    for (const w of ["auth status", "auth logout", "version", "list ", "info ", "mkdir", "upload", "download", "rename", "move", "delete", "share status", "share invite", "share revoke", "share remove-all", "share set-url", "share remove-url", "share leave", "copy", "trash", "restore", "invitation", "album", "photo"]) {
      assert.ok(r.stdout.includes(w), `usage() does not mention '${w}'`);
    }
    assert.equal(r.calls.length, 0);
  });

  it("copy --name passes --name to the CLI before the positionals", async () => {
    const r = await runCli(["copy", "/my-files/a.txt", "/my-files/dir", "--name", "b.txt"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.calls[0], ["filesystem", "copy", "--name", "b.txt", "/my-files/a.txt", "/my-files/dir", "--json"]);
  });

  it("copy without --name omits it", async () => {
    const r = await runCli(["copy", "/my-files/a.txt", "/my-files/dir"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.calls[0].includes("--name"));
  });

  it("info --verbose exits 0 and returns the raw node", async () => {
    const r = await runCli(["info", "/my-files/a.txt", "--verbose", "--json"], { env: { FAKE_STDOUT: '{"uid":"u1","weirdExtraField":42}' } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).weirdExtraField, 42);
  });

  it("list --json prints one line of JSON", async () => {
    const r = await runCli(["list", "/my-files", "--json"], { env: { FAKE_STDOUT: '[{"name":"a","type":"file"}]' } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(r.stdout)[0].name, "a");
  });

  it("a failing CLI exits 1 without leaking the password argument", async () => {
    const r = await runCli(["share", "set-url", "/my-files/a", "--password", "Zx9secretQ"], { mode: "fail-stderr-echo" });
    assert.equal(r.code, 1);
    assert.ok(!r.stderr.includes("Zx9secretQ"), r.stderr);
  });

  it("an authentication failure prints the not-authenticated message", async () => {
    const r = await runCli(["list", "/my-files"], { mode: "auth-fail" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Not authenticated/);
  });
});

describe("no arguments", () => {
  it("starts the MCP server (answers initialize and lists tools)", async () => {
    const sb = makeSandbox();
    cleanups.push(sb.cleanup);
    const c = new McpClient({ script: DIST_CLI, env: fakeEnv("json", sb) });
    try {
      const res = await c.initialize({ timeout: 5000 });
      assert.equal(res.result.serverInfo.name, "proton-drive-mcp");
      assert.equal((await c.listTools()).length, 38);
    } finally { await c.close(); }
  });
});
