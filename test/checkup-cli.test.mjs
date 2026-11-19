// Companion CLI `checkup` and `undo` (1.12.0, PLAN-1.12.0 C1) against the stateful fake Drive (FAKE_MODE=drive).
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, fakeEnv, nonVersionCalls, DIST_CLI } from "./helpers/mcp-client.mjs";
import { driveSetup, file, folder, seedJournal, patchState, trashedUids, treeShape, undoDir } from "./helpers/drive-state.mjs";

const OLD = "2020-01-01T00:00:00Z";
const NEW = "2024-01-01T00:00:00Z";
const MB = 1024 * 1024;
const BASE = [
  folder("d1", "root", "docs"), folder("d2", "root", "inbox"), folder("d3", "root", "empty"), folder("d4", "root", "Shared", { shared: true }),
  file("f1", "d1", "a.pdf", { size: 5000, sha1: "S1", mtime: OLD }),
  file("f2", "d2", "a (1).pdf", { size: 5000, sha1: "S1", mtime: NEW }),
  file("f3", "d1", "unique.txt", { size: 3000, sha1: "U1", mtime: OLD }),
  file("f4", "d4", "passport-scan.pdf", { size: 2000, mtime: NEW }),
  file("big", "root", "backup.iso", { size: 60 * MB, mtime: OLD }),
];

const cleanups = [];
after(() => cleanups.forEach((f) => f()));

/** A sandbox with a fake Drive holding `nodes`; ctx.run(args, env) runs dist/cli.js. */
function setup(nodes = BASE, extraEnv = {}) {
  const sb = makeSandbox();
  cleanups.push(sb.cleanup);
  const env = fakeEnv("drive", sb, driveSetup(nodes)(sb));
  Object.assign(env, extraEnv);
  let seen = 0;
  const run = (args, more = {}) => new Promise((resolve) => {
    execFile(process.execPath, [DIST_CLI, ...args], { env: { ...env, ...more }, timeout: 30_000 }, (err, stdout, stderr) => {
      const all = nonVersionCalls(sb.argvLog);
      const calls = all.slice(seen); // only this run's CLI calls
      seen = all.length;
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr, calls });
    });
  });
  const state = () => readFileSync(join(sb.dir, "state.json"), "utf8");
  return { sb, ctx: { dir: sb.dir }, run, state };
}

/** Batch of trashed items: marks them trashed in the fake Drive and records them in the journal. */
function trashBatch(s, uids, extra = {}) {
  const nodes = JSON.parse(s.state()).nodes;
  const pathOf = (n) => `/my-files/${nodes[n.parentUid].name === "my-files" ? "" : nodes[n.parentUid].name + "/"}${n.name}`;
  const items = uids.map((u) => ({ uid: u, parentUid: nodes[u].parentUid, from: pathOf(nodes[u]), name: nodes[u].name, restorable: true }));
  patchState(s.ctx, (n) => uids.forEach((u) => { n[u].trashTime = "2026-11-19T10:00:00Z"; }));
  return seedJournal(s.sb, { items, ...extra });
}

describe("checkup", () => {
  it("prints a readable table: score, per-finding line with severity/count/size, fix hint, samples", async () => {
    const s = setup();
    const r = await s.run(["checkup"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Drive checkup of \/my-files: score \d+\/100/);
    assert.match(r.stdout, /Scanned 5 files, 4 folders/);
    assert.match(r.stdout, /\[info\] duplicates\s+1.*fix: ask the assistant \(drive_cleanup\)/);
    assert.match(r.stdout, /\[\w+\] empty-folders\s+1/);
    assert.match(r.stdout, /large-old\s+1, 60\.0 MB/);
    assert.ok(r.stdout.includes("/my-files/empty"), "sample name shown");
    assert.match(r.stdout, /trash: 0 items/);
    assert.ok(!r.stdout.trimStart().startsWith("{"));
  });

  it("--json prints the raw summary on one line", async () => {
    const s = setup();
    const r = await s.run(["checkup", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim().split("\n").length, 1);
    const d = JSON.parse(r.stdout);
    assert.equal(d.path, "/my-files");
    assert.equal(typeof d.score, "number");
    assert.ok(d.findings.some((f) => f.id === "duplicates" && f.count === 1));
  });

  it("[path] limits the scan to that folder", async () => {
    const s = setup();
    const d = JSON.parse((await s.run(["checkup", "/my-files/docs", "--json"])).stdout);
    assert.equal(d.path, "/my-files/docs");
    assert.equal(d.scanned.files, 2);
  });

  it("--finding pages the items with --limit and --offset", async () => {
    const extra = [file("g1", "d1", "x1.bin", { size: 70 * MB, mtime: OLD }), file("g2", "d1", "x2.bin", { size: 80 * MB, mtime: OLD })];
    const s = setup([...BASE, ...extra]);
    const p1 = JSON.parse((await s.run(["checkup", "--finding", "large-old", "--limit", "2", "--json"])).stdout);
    assert.equal(p1.total, 3);
    assert.equal(p1.items.length, 2);
    assert.equal(p1.nextOffset, 2);
    const p2 = JSON.parse((await s.run(["checkup", "--finding", "large-old", "--limit", "2", "--offset", "2", "--json"])).stdout);
    assert.equal(p2.items.length, 1);
    assert.equal(p2.nextOffset, undefined);
    assert.deepEqual([...p1.items, ...p2.items].map((i) => i.path).sort(), ["/my-files/backup.iso", "/my-files/docs/x1.bin", "/my-files/docs/x2.bin"]);
    const text = await s.run(["checkup", "--finding", "large-old", "--limit", "2"]);
    assert.match(text.stdout, /large-old in \/my-files: 3 total, showing 2 from offset 0/);
    assert.match(text.stdout, /More: --offset 2/);
  });

  it("an unknown --finding exits 1 and names the valid ones", async () => {
    const r = await setup().run(["checkup", "--finding", "bogus"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--finding must be one of: duplicates, empty-folders/);
    assert.ok(!/at \w+ \(/.test(r.stderr), "no stack trace");
  });

  it("--no-sharing makes no sharing calls; the default does", async () => {
    const withSharing = await setup().run(["checkup", "--json"]);
    assert.ok(withSharing.calls.some((a) => a[0] === "sharing"), "sharing audit ran by default");
    const without = await setup().run(["checkup", "--no-sharing", "--json"]);
    assert.equal(without.code, 0, without.stderr);
    assert.ok(!without.calls.some((a) => a[0] === "sharing"));
  });

  it("with PROTON_DRIVE_REMOTE_ROOTS set the trash is skipped, with a note", async () => {
    const s = setup([...BASE, file("t1", "d1", "old.txt", { size: 10, trashTime: NEW })]);
    const open = JSON.parse((await s.run(["checkup", "--json"])).stdout);
    assert.equal(open.trash.count, 1);
    const roots = await s.run(["checkup", "/my-files/docs", "--json"], { PROTON_DRIVE_REMOTE_ROOTS: "/my-files/docs" });
    assert.equal(roots.code, 0, roots.stderr);
    assert.equal(JSON.parse(roots.stdout).trash.count, 0);
    assert.ok(!roots.calls.some((a) => a[0] === "filesystem" && a[1] === "list" && a[2] === "/trash"), "trash not listed");
    assert.match((await s.run(["checkup", "/my-files/docs"], { PROTON_DRIVE_REMOTE_ROOTS: "/my-files/docs" })).stdout, /Note: The trash is not included/);
  });
});

describe("undo", () => {
  it("--list shows batches without file names; none recorded says so", async () => {
    const s = setup();
    assert.match((await s.run(["undo", "--list"])).stdout, /No recorded batches/);
    const id = trashBatch(s, ["f2"]);
    const r = await s.run(["undo", "--list"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`${id}  .*drive_cleanup  trash  1 item\\(s\\)  applied`));
    assert.ok(!r.stdout.includes("a (1).pdf"));
    const j = JSON.parse((await s.run(["undo", "--list", "--json"])).stdout);
    assert.equal(j.batches[0].id, id);
  });

  it("without --confirm prints the plan and changes nothing (state file and journal unchanged)", async () => {
    const s = setup();
    const id = trashBatch(s, ["f2", "d3"]);
    const stateBefore = s.state();
    const journalBefore = readdirSync(undoDir(s.ctx)).filter((n) => n.endsWith(".json")).map((n) => readFileSync(join(undoDir(s.ctx), n), "utf8"));
    const r = await s.run(["undo"]); // default id: newest not undone
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Undo plan for ${id}: drive_cleanup \\(trash\\)`));
    assert.match(r.stdout, /Would restore from trash \(2\):/);
    assert.ok(r.stdout.includes("/my-files/inbox/a (1).pdf") && r.stdout.includes("/my-files/empty"));
    assert.match(r.stdout, /Restorable: 2 of 2/);
    assert.match(r.stderr, /Plan only\. Pass --confirm/);
    assert.equal(s.state(), stateBefore);
    assert.deepEqual(readdirSync(undoDir(s.ctx)).filter((n) => n.endsWith(".json")).map((n) => readFileSync(join(undoDir(s.ctx), n), "utf8")), journalBefore);
    assert.ok(!r.calls.some((a) => a[1] === "restore" || a[1] === "move" || a[1] === "trash"));
    const j = JSON.parse((await s.run(["undo", id, "--json"])).stdout);
    assert.equal(j.applied, false);
    assert.equal(j.restorableCount, 2);
  });

  it("--confirm restores what the plan listed and marks the batch undone; a second undo is refused", async () => {
    const s = setup();
    const before = treeShape(s.ctx);
    const id = trashBatch(s, ["f2", "d3"]);
    assert.deepEqual(trashedUids(s.ctx), ["d3", "f2"]);
    const r = await s.run(["undo", id, "--confirm"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Would restore from trash \(2\):/, "the plan is printed first");
    assert.match(r.stdout, new RegExp(`Undone 2 item\\(s\\); batch ${id} is now undone`));
    assert.deepEqual(treeShape(s.ctx), before);
    assert.deepEqual(trashedUids(s.ctx), []);
    assert.equal(JSON.parse(readFileSync(join(undoDir(s.ctx), `${id}.json`), "utf8")).status, "undone");

    const again = await s.run(["undo", id, "--confirm"]);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already undone/);
    const none = await s.run(["undo"]);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /nothing to undo/);
  });

  it("--confirm --json prints plan and result on one line", async () => {
    const s = setup();
    const id = trashBatch(s, ["f2"]);
    const r = await s.run(["undo", id, "--confirm", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.applied, true);
    assert.equal(j.plan.id, id);
    assert.equal(j.result.undone, 1);
    assert.equal(j.result.status, "undone");
  });

  it("a move batch is moved back", async () => {
    const s = setup();
    patchState(s.ctx, (n) => { n.f2.parentUid = "d1"; });
    const id = seedJournal(s.sb, { tool: "drive_bulk_move", kind: "move", items: [{ uid: "f2", parentUid: "d2", from: "/my-files/inbox/a (1).pdf", to: "/my-files/docs/a (1).pdf", name: "a (1).pdf", restorable: true }] });
    const plan = await s.run(["undo", id]);
    assert.match(plan.stdout, /Would move back \(1\):\n  \/my-files\/docs\/a \(1\)\.pdf -> \/my-files\/inbox\/a \(1\)\.pdf/);
    assert.equal((await s.run(["undo", id, "--confirm"])).code, 0);
    assert.equal(JSON.parse(s.state()).nodes.f2.parentUid, "d2");
  });

  it("a plan that changes between print and apply is refused, and nothing is changed", async () => {
    const s = setup();
    const id = trashBatch(s, ["f2", "d3"]);
    const stateAfterTrash = s.state();
    const saved = { ...process.env };
    // The fake binary must be in the environment before the CLI modules are loaded (they resolve it at import).
    Object.assign(process.env, fakeEnv("drive", s.sb, { FAKE_STATE: join(s.sb.dir, "state.json") }));
    try {
      const { undoCommand } = await import("../dist/cli.js");
      const { DriveService } = await import("../dist/services/drive.js");
      const { createUndoJournal } = await import("../dist/utils/undoJournal.js");
      const journal = createUndoJournal({ dir: join(s.sb.dir, "undo"), account: "root" });
      let out = "", err = "";
      const io = {
        // The moment the plan has been printed, something else takes the original name of one item.
        stdout: { write: (t) => { out += t; if (/Restorable:/.test(t)) patchState(s.ctx, (n) => { n.new1 = file("new1", "d2", "a (1).pdf"); }); } },
        stderr: { write: (t) => { err += t; } },
      };
      const code = await undoCommand(new DriveService(), { journal }, { list: false, id, confirm: true, json: false }, io);
      assert.equal(code, 1);
      assert.match(err, /changed since the undo plan/);
      assert.ok(!/Undone/.test(out));
      assert.deepEqual(trashedUids(s.ctx), ["d3", "f2"], "nothing restored");
      assert.equal(journal.get(id).status, "applied");
      assert.notEqual(s.state(), stateAfterTrash);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it("an item whose original name is taken is reported as not restorable; nothing restorable exits 1", async () => {
    const s = setup();
    const id = trashBatch(s, ["f2"]);
    patchState(s.ctx, (n) => { n.new1 = file("new1", "d2", "a (1).pdf"); });
    const plan = await s.run(["undo", id]);
    assert.equal(plan.code, 0);
    assert.match(plan.stdout, /Cannot restore \(1\):\n  \/my-files\/inbox\/a \(1\)\.pdf: an item named "a \(1\)\.pdf" already exists/);
    assert.match(plan.stdout, /Restorable: 0 of 1/);
    const r = await s.run(["undo", id, "--confirm"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Nothing in batch .* can be undone/);
    assert.deepEqual(trashedUids(s.ctx), ["f2"]);
  });

  it("an unknown id exits 1 with a plain message", async () => {
    const s = setup();
    const r = await s.run(["undo", "ABCD-EFGH"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No undo record with code ABCD-EFGH/);
    assert.ok(!/at \w+ \(/.test(r.stderr));
    const bad = await s.run(["undo", "nope"]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /invalid undo code/);
  });

  it("PROTON_DRIVE_UNDO=0: 'undo is switched off', exit 1, nothing touched", async () => {
    const s = setup();
    trashBatch(s, ["f2"]);
    const stateBefore = s.state();
    for (const args of [["undo", "--list"], ["undo"], ["undo", "--confirm"]]) {
      const r = await s.run(args, { PROTON_DRIVE_UNDO: "0" });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /undo is switched off/);
    }
    assert.equal(s.state(), stateBefore);
  });

  it("PROTON_DRIVE_REMOTE_ROOTS: items outside the roots are not restorable", async () => {
    const s = setup();
    const id = trashBatch(s, ["f1", "f2"]); // /my-files/docs/a.pdf and /my-files/inbox/a (1).pdf
    const r = await s.run(["undo", id], { PROTON_DRIVE_REMOTE_ROOTS: "/my-files/docs" });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Would restore from trash \(1\):\n  \/my-files\/docs\/a\.pdf/);
    assert.match(r.stdout, /\/my-files\/inbox\/a \(1\)\.pdf: outside the allowed Drive roots/);
    const done = await s.run(["undo", id, "--confirm"], { PROTON_DRIVE_REMOTE_ROOTS: "/my-files/docs" });
    assert.equal(done.code, 1, "partial: one item was left outside the roots");
    assert.match(done.stdout, /Undone 1 item\(s\); batch .* is now partial/);
    assert.deepEqual(trashedUids(s.ctx), ["f2"]);
  });
});
