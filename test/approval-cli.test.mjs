// Companion CLI approval commands: approvals / approve / deny (channel 2 of the approval gate).
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DIST_CLI } from "./helpers/mcp-client.mjs";

const { createApprovalStore } = await import("../dist/utils/approvalStore.js");
const { approveInteractive } = await import("../dist/cli.js");

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), "approval-cli-"));
  dirs.push(d);
  return d;
}

const SUMMARY = "drive_delete: delete a file\npath: /my-files/a.txt\n";
function seed(dir, opts = {}) {
  const store = createApprovalStore({ dir, ...opts });
  const { code } = store.request({ tool: "drive_delete", opHash: "h1", summary: SUMMARY });
  return { store, code };
}

function runCli(args, dir, { input } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, PROTON_DRIVE_APPROVAL_DIR: dir };
    const child = spawn(process.execPath, [DIST_CLI, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

function fakeIO(answer, isTTY = true) {
  const stdin = new PassThrough();
  let out = "", err = "";
  if (answer !== undefined) stdin.end(answer + "\n"); else stdin.end();
  return {
    io: { stdin, stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, isTTY },
    out: () => out, err: () => err,
  };
}

describe("approve (process level, no TTY)", () => {
  it("refuses with piped stdin even when 'yes' is supplied, and approves nothing", async () => {
    const dir = tmpDir();
    const { store, code } = seed(dir);
    const r = await runCli(["approve", code], dir, { input: "yes\n" });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /interactive terminal/);
    assert.equal(store.get(code).status, "pending");
    assert.equal(store.consume({ tool: "drive_delete", opHash: "h1" }), null);
  });

  it("unknown code gives a non-zero exit (non-TTY refusal comes first, nothing created)", async () => {
    const dir = tmpDir();
    const r = await runCli(["approve", "AAAA-BBBB"], dir);
    assert.notEqual(r.code, 0);
  });
});

describe("approveInteractive (injected TTY)", () => {
  it("prints the stored summary and approves on a typed 'yes'", async () => {
    const dir = tmpDir();
    const { store, code } = seed(dir);
    const t = fakeIO("yes");
    assert.equal(await approveInteractive(store, code, t.io), 0);
    assert.ok(t.out().includes(SUMMARY.trimEnd()), t.out());
    assert.equal(store.get(code).status, "approved");
    assert.deepEqual(store.consume({ tool: "drive_delete", opHash: "h1" }), { code });
  });

  it("accepts a lowercase code", async () => {
    const dir = tmpDir();
    const { store, code } = seed(dir);
    assert.equal(await approveInteractive(store, code.toLowerCase(), fakeIO("yes").io), 0);
  });

  for (const answer of ["y", "no", "YES", "", "yes please", undefined]) {
    it(`aborts on ${JSON.stringify(answer)} and approves nothing`, async () => {
      const dir = tmpDir();
      const { store, code } = seed(dir);
      const t = fakeIO(answer);
      assert.equal(await approveInteractive(store, code, t.io), 1);
      assert.match(t.out(), /Aborted/);
      assert.equal(store.get(code).status, "pending");
    });
  }

  it("refuses without a TTY", async () => {
    const dir = tmpDir();
    const { store, code } = seed(dir);
    const t = fakeIO("yes", false);
    assert.equal(await approveInteractive(store, code, t.io), 1);
    assert.match(t.err(), /interactive terminal/);
    assert.equal(store.get(code).status, "pending");
  });

  it("unknown code: clear error, non-zero", async () => {
    const dir = tmpDir();
    const { store } = seed(dir);
    const t = fakeIO("yes");
    assert.equal(await approveInteractive(store, "ZZZZ-ZZZZ", t.io), 1);
    assert.match(t.err(), /unknown, expired/);
  });

  it("malformed code: clear error, non-zero", async () => {
    const dir = tmpDir();
    const { store } = seed(dir);
    const t = fakeIO("yes");
    assert.equal(await approveInteractive(store, "nope", t.io), 1);
    assert.match(t.err(), /invalid approval code/);
  });

  it("expired code: refused, nothing approved", async () => {
    const dir = tmpDir();
    let now = 1_000_000;
    const { store, code } = seed(dir, { now: () => now, pendingTtlMs: 1000 });
    now += 5000;
    const t = fakeIO("yes");
    assert.equal(await approveInteractive(store, code, t.io), 1);
    assert.match(t.err(), /expired/);
    assert.equal(store.consume({ tool: "drive_delete", opHash: "h1" }), null);
  });

  it("a record expired on disk (old expiresAt) is refused too", async () => {
    const dir = tmpDir();
    const { store, code } = seed(dir);
    const f = join(dir, "pending", `${code}.json`);
    const rec = JSON.parse(readFileSync(f, "utf8"));
    writeFileSync(f, JSON.stringify({ ...rec, expiresAt: Date.now() - 1000 }));
    assert.equal(await approveInteractive(store, code, fakeIO("yes").io), 1);
    assert.equal(store.list().length, 0);
  });

  it("an already-approved code is not approved again", async () => {
    const dir = tmpDir();
    const { store, code } = seed(dir);
    store.approve(code);
    const t = fakeIO("yes");
    assert.equal(await approveInteractive(store, code, t.io), 1);
    assert.match(t.err(), /already approved/);
  });

  it("missing code argument prints usage", async () => {
    const t = fakeIO("yes");
    assert.equal(await approveInteractive(createApprovalStore({ dir: tmpDir() }), undefined, t.io), 1);
    assert.match(t.err(), /Usage: approve/);
  });
});

describe("approvals and deny (process level)", () => {
  it("lists code, tool, status, expiry and the first summary line", async () => {
    const dir = tmpDir();
    const { code } = seed(dir);
    const r = await runCli(["approvals"], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(code));
    assert.match(r.stdout, /pending/);
    assert.match(r.stdout, /drive_delete/);
    assert.match(r.stdout, /expires in/);
    assert.match(r.stdout, /drive_delete: delete a file/);
    assert.ok(!r.stdout.includes("/my-files/a.txt"), "only the first summary line is listed");
  });

  it("--json prints one line of records", async () => {
    const dir = tmpDir();
    const { store, code } = seed(dir);
    store.request({ tool: "drive_empty_trash", opHash: "h2", summary: "empty\n" });
    store.approve(code);
    const r = await runCli(["approvals", "--json"], dir);
    assert.equal(r.code, 0, r.stderr);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows.length, 2);
    const row = rows.find((x) => x.code === code);
    assert.equal(row.status, "approved");
    assert.equal(row.tool, "drive_delete");
    assert.equal(typeof row.expiresInSeconds, "number");
    assert.equal(row.summary, "drive_delete: delete a file");
  });

  it("says so when nothing is pending", async () => {
    const r = await runCli(["approvals"], tmpDir());
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /No pending approvals/);
  });

  it("deny removes the record", async () => {
    const dir = tmpDir();
    const { store, code } = seed(dir);
    const r = await runCli(["deny", code], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(store.get(code), null);
    assert.equal(store.list().length, 0);
  });

  it("deny removes an approved record so it cannot be consumed", async () => {
    const dir = tmpDir();
    const { store, code } = seed(dir);
    store.approve(code);
    const r = await runCli(["deny", code], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(store.consume({ tool: "drive_delete", opHash: "h1" }), null);
  });

  it("deny of an unknown code exits non-zero", async () => {
    const r = await runCli(["deny", "AAAA-BBBB"], tmpDir());
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /unknown or already used/);
  });

  it("deny without a code prints usage", async () => {
    const r = await runCli(["deny"], tmpDir());
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Usage: deny/);
  });
});
