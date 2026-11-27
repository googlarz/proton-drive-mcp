// drive_undo engine (src/services/undo.ts) against the stateful fake CLI (FAKE_MODE=drive).
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_CLI } from "./helpers/mcp-client.mjs";

// The CLI binary is read when subprocess.js is first imported, so set the env before importing dist.
process.env.PROTON_DRIVE_BIN = FAKE_CLI;
process.env.FAKE_MODE = "drive";
delete process.env.FAKE_FAIL_UIDS;
delete process.env.FAKE_LIE_UIDS;
const { DriveService } = await import("../dist/services/drive.js");
const { planUndo, applyUndo, UndoError } = await import("../dist/services/undo.js");
const { createUndoJournal } = await import("../dist/utils/undoJournal.js");

let dir, statePath, argvLog, drive, journal;

const file = (uid, parentUid, name, extra = {}) => ({ uid, parentUid, name, type: "file", size: 10, ...extra });
const folder = (uid, parentUid, name, extra = {}) => ({ uid, parentUid, name, type: "folder", ...extra });
const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
const writeState = (s) => writeFileSync(statePath, JSON.stringify(s));
const patch = (fn) => { const s = readState(); fn(s.nodes); writeState(s); };
const node = (uid) => readState().nodes[uid];
const calls = () => (existsSync(argvLog) ? readFileSync(argvLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).argv.filter((a) => a !== "--json")) : []);
const mutations = () => calls().filter((a) => a[0] === "filesystem" && ["trash", "restore", "move", "rename"].includes(a[1]));
const isBack = (uid, parentUid, name) => { const n = node(uid); return !!n && n.trashTime === undefined && n.parentUid === parentUid && n.name === name; };

/** Journal item the way W1 records it: uid, path before, name. */
const item = (uid, from, to) => ({ uid, from, ...(to ? { to } : {}), name: from.split("/").pop(), restorable: true });
function record(kind, items, complete = true) {
  const { id } = journal.begin({ tool: kind === "trash" ? "drive_cleanup" : "drive_bulk_move", kind, items });
  if (complete) journal.complete(id, { status: "applied" });
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "undo-engine-"));
  statePath = join(dir, "state.json");
  argvLog = join(dir, "argv.log");
  process.env.FAKE_STATE = statePath;
  process.env.FAKE_ARGV_LOG = argvLog;
  delete process.env.FAKE_FAIL_UIDS;
  delete process.env.FAKE_LIE_UIDS;
  writeState({
    nodes: {
      root: folder("root", null, "my-files"),
      d1: folder("d1", "root", "docs"),
      d2: folder("d2", "root", "pics"),
      d3: folder("d3", "root", "archive"),
      f1: file("f1", "d1", "a.txt"),
      f2: file("f2", "d1", "b.txt"),
      f3: file("f3", "d1", "c.txt"),
      f4: file("f4", "d2", "x.jpg"),
    },
  });
  drive = new DriveService();
  journal = createUndoJournal({ dir: join(dir, "undo"), account: "acct-1" });
});

afterEach(() => {
  delete process.env.FAKE_STATE;
  delete process.env.FAKE_ARGV_LOG;
  delete process.env.FAKE_FAIL_UIDS;
  delete process.env.FAKE_LIE_UIDS;
  rmSync(dir, { recursive: true, force: true });
});

const trashAB = () => {
  patch((n) => { n.f1.trashTime = "2026-11-19T10:00:00Z"; n.f2.trashTime = "2026-11-19T10:00:01Z"; });
  return record("trash", [item("f1", "/my-files/docs/a.txt"), item("f2", "/my-files/docs/b.txt")]);
};

describe("drive_undo: trash batches", () => {
  it("restores every item by uid in one batched restore call and verifies them in the original folder", async () => {
    const id = trashAB();
    const plan = await planUndo(drive, journal, { action: "plan", id });
    assert.equal(plan.restorableCount, 2);
    assert.deepEqual(plan.restore, ["/my-files/docs/a.txt", "/my-files/docs/b.txt"]);
    assert.deepEqual(plan.moveBack, []);
    assert.match(plan.fingerprint, /^[0-9a-f]{32}$/);
    assert.deepEqual(mutations(), [], "planning mutates nothing");

    const r = await applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint });
    assert.deepEqual({ undone: r.undone, failed: r.failed, status: r.status }, { undone: 2, failed: [], status: "undone" });
    assert.ok(isBack("f1", "d1", "a.txt") && isBack("f2", "d1", "b.txt"));
    assert.deepEqual(mutations(), [["filesystem", "restore", "/trash/a.txt", "/trash/b.txt"]]);
    assert.equal(journal.get(id).status, "undone");
    assert.equal(r.journalUpdated, true);
  });

  it("defaults to the newest batch that is not undone", async () => {
    const first = trashAB();
    const second = record("trash", [item("f3", "/my-files/docs/c.txt")]);
    patch((n) => { n.f3.trashTime = "2026-11-19T10:00:02Z"; });
    const plan = await planUndo(drive, journal, { action: "plan" });
    // Same-millisecond batches order by id; either way the default must be one of the two and a real batch.
    assert.ok([first, second].includes(plan.id));
    await applyUndo(drive, journal, { id: plan.id, expectedFingerprint: plan.fingerprint });
    const next = await planUndo(drive, journal, { action: "plan" });
    assert.notEqual(next.id, plan.id);
  });

  it("skips an item whose name is also in trash (restore addresses by name) and restores the rest", async () => {
    const id = trashAB();
    patch((n) => { n["other"] = file("other", "d2", "a.txt", { trashTime: "2026-11-18T00:00:00Z" }); });
    const plan = await planUndo(drive, journal, { action: "plan", id });
    const a = plan.items.find((i) => i.path.endsWith("/a.txt"));
    assert.equal(a.restorable, false);
    assert.match(a.reason, /same name is in trash/);
    assert.deepEqual(plan.restore, ["/my-files/docs/b.txt"]);

    const r = await applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint });
    assert.equal(r.undone, 1);
    assert.equal(r.status, "partial");
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].path, "/my-files/docs/a.txt");
    assert.deepEqual(mutations(), [["filesystem", "restore", "/trash/b.txt"]], "a.txt is never addressed by name");
    assert.ok(node("f1").trashTime && node("other").trashTime, "neither same-named trashed item was touched");
    assert.equal(journal.get(id).status, "partial");
  });

  it("refuses two items of one batch that share a name (both would be addressed by the same /trash/<name>)", async () => {
    patch((n) => {
      n.f1.trashTime = "t1";
      n["g1"] = file("g1", "d2", "a.txt", { trashTime: "t2" });
    });
    const id = record("trash", [item("f1", "/my-files/docs/a.txt"), item("g1", "/my-files/pics/a.txt")]);
    const plan = await planUndo(drive, journal, { action: "plan", id });
    assert.equal(plan.restorableCount, 0);
    await assert.rejects(applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint }), (e) => e instanceof UndoError && e.code === "nothing_restorable");
    assert.deepEqual(mutations(), []);
    assert.equal(journal.get(id).status, "applied", "a refused undo leaves the batch undoable");
  });

  it("reports an item whose original folder is gone (deleted or in trash) and does not call the CLI for it", async () => {
    const id = trashAB();
    patch((n) => { n.d1.trashTime = "2026-11-19T11:00:00Z"; });
    const plan = await planUndo(drive, journal, { action: "plan", id });
    assert.equal(plan.restorableCount, 0);
    assert.match(plan.items[0].reason, /original folder \/my-files\/docs no longer exists/);
    await assert.rejects(applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint }), /Nothing in batch .* can be undone/);
    assert.deepEqual(mutations(), []);

    patch((n) => { delete n.d1; });
    const plan2 = await planUndo(drive, journal, { action: "plan", id });
    assert.match(plan2.items[1].reason, /no longer exists/);
  });

  it("never overwrites: a name taken in the original folder skips that item, the other is restored", async () => {
    const id = trashAB();
    patch((n) => { n["new"] = file("new", "d1", "a.txt", { size: 99 }); });
    const plan = await planUndo(drive, journal, { action: "plan", id });
    assert.match(plan.items[0].reason, /already exists in \/my-files\/docs/);
    const r = await applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint });
    assert.equal(r.undone, 1);
    assert.equal(r.status, "partial");
    assert.deepEqual(r.failed.map((f) => f.path), ["/my-files/docs/a.txt"]);
    assert.deepEqual(node("new"), file("new", "d1", "a.txt", { size: 99 }), "the new file is untouched");
    assert.ok(node("f1").trashTime, "the trashed a.txt stays in trash");
    assert.deepEqual(mutations(), [["filesystem", "restore", "/trash/b.txt"]]);
  });

  it("reports honestly when the CLI exits 0 but reports some items failed", async () => {
    const id = trashAB();
    process.env.FAKE_FAIL_UIDS = "f2";
    const plan = await planUndo(drive, journal, { action: "plan", id });
    const r = await applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint });
    assert.equal(r.undone, 1);
    assert.equal(r.status, "partial");
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].path, "/my-files/docs/b.txt");
    assert.match(r.failed[0].reason, /injected failure/);
    assert.equal(journal.get(id).status, "partial");
  });

  it("does not trust an ok:true report that changed nothing: the uid check marks it failed", async () => {
    const id = trashAB();
    process.env.FAKE_LIE_UIDS = "f1";
    const plan = await planUndo(drive, journal, { action: "plan", id });
    const r = await applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint });
    assert.equal(r.undone, 1);
    assert.equal(r.status, "partial");
    assert.match(r.failed[0].reason, /not verified back/);
    assert.equal(r.failed[0].path, "/my-files/docs/a.txt");
  });

  it("a partial undo can be finished later: restored items count as already in place and the batch ends undone", async () => {
    const id = trashAB();
    process.env.FAKE_FAIL_UIDS = "f2";
    let plan = await planUndo(drive, journal, { action: "plan", id });
    await applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint });
    delete process.env.FAKE_FAIL_UIDS;
    plan = await planUndo(drive, journal, { action: "plan", id });
    assert.deepEqual(plan.restore, ["/my-files/docs/b.txt"]);
    assert.equal(plan.items.find((i) => i.path.endsWith("/a.txt")).alreadyInPlace, true);
    const r = await applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint });
    assert.deepEqual({ undone: r.undone, alreadyInPlace: r.alreadyInPlace, failed: r.failed, status: r.status }, { undone: 1, alreadyInPlace: 1, failed: [], status: "undone" });
  });

  it("refuses an apply whose fingerprint no longer matches (approval_changed) and mutates nothing", async () => {
    const id = trashAB();
    const plan = await planUndo(drive, journal, { action: "plan", id });
    patch((n) => { n["other"] = file("other", "d2", "b.txt", { trashTime: "2026-11-19T12:00:00Z" }); });
    await assert.rejects(
      applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint }),
      (e) => e instanceof UndoError && e.code === "approval_changed",
    );
    assert.deepEqual(mutations(), []);
    assert.equal(journal.get(id).status, "applied");
    await assert.rejects(applyUndo(drive, journal, { id, expectedFingerprint: "0".repeat(32) }), (e) => e.code === "approval_changed");
  });

  it("the fingerprint is stable across plans of an unchanged drive", async () => {
    const id = trashAB();
    const a = await planUndo(drive, journal, { action: "plan", id });
    const b = await planUndo(drive, journal, { action: "plan", id });
    assert.equal(a.fingerprint, b.fingerprint);
  });

  it("refuses a second undo of an undone batch, at plan and at apply, without any CLI mutation", async () => {
    const id = trashAB();
    const plan = await planUndo(drive, journal, { action: "plan", id });
    await applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint });
    const before = mutations().length;
    await assert.rejects(planUndo(drive, journal, { action: "plan", id }), (e) => e instanceof UndoError && e.code === "already_undone");
    await assert.rejects(applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint }), (e) => e.code === "already_undone");
    assert.equal(mutations().length, before);
  });

  it("refuses a journal item outside the allowed roots at plan time, per item, and never executes it", async () => {
    patch((n) => { n.f1.trashTime = "t1"; n.f4.trashTime = "t2"; });
    const id = record("trash", [item("f1", "/my-files/docs/a.txt"), item("f4", "/my-files/pics/x.jpg")]);
    const isPathAllowed = (p) => p === "/my-files/docs" || p.startsWith("/my-files/docs/");
    const plan = await planUndo(drive, journal, { action: "plan", id, isPathAllowed });
    assert.deepEqual(plan.restore, ["/my-files/docs/a.txt"], "only the item inside the roots is planned");
    assert.match(plan.items[1].reason, /outside the allowed Drive roots/);
    const r = await applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint, isPathAllowed });
    assert.equal(r.undone, 1);
    assert.equal(r.status, "partial");
    assert.deepEqual(r.failed.map((f) => f.path), ["/my-files/pics/x.jpg"]);
    assert.deepEqual(mutations(), [["filesystem", "restore", "/trash/a.txt"]]);
    assert.ok(node("f4").trashTime, "the out-of-roots item stays in trash");
  });

  it("refuses journal paths that point at roots or the trash itself", async () => {
    patch((n) => { n.f1.trashTime = "t"; });
    const id = record("trash", [item("f1", "/trash/a.txt")]);
    const plan = await planUndo(drive, journal, { action: "plan", id });
    assert.match(plan.items[0].reason, /invalid path/);
  });

  it("honours an item the journal recorded as not restorable", async () => {
    patch((n) => { n.f1.trashTime = "t"; n.f2.trashTime = "t"; });
    const id = record("trash", [{ ...item("f1", "/my-files/docs/a.txt"), restorable: false, reason: "name already in trash when trashed" }, item("f2", "/my-files/docs/b.txt")]);
    const plan = await planUndo(drive, journal, { action: "plan", id });
    assert.equal(plan.items[0].reason, "name already in trash when trashed");
    assert.deepEqual(plan.restore, ["/my-files/docs/b.txt"]);
  });
});

describe("drive_undo: pending (crashed) batches are reconciled by uid", () => {
  it("an item already in trash counts as applied; an item still at its original place has nothing to undo", async () => {
    patch((n) => { n.f1.trashTime = "t"; });
    const id = record("trash", [item("f1", "/my-files/docs/a.txt"), item("f2", "/my-files/docs/b.txt")], false);
    assert.equal(journal.get(id).status, "pending");
    const plan = await planUndo(drive, journal, { action: "plan", id });
    assert.deepEqual(plan.restore, ["/my-files/docs/a.txt"]);
    const b = plan.items.find((i) => i.path.endsWith("/b.txt"));
    assert.equal(b.restorable, false);
    assert.equal(b.alreadyInPlace, true);
    assert.match(b.reason, /never completed/);
    const r = await applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint });
    assert.deepEqual({ undone: r.undone, alreadyInPlace: r.alreadyInPlace, failed: r.failed, status: r.status }, { undone: 1, alreadyInPlace: 1, failed: [], status: "undone" });
    assert.ok(isBack("f1", "d1", "a.txt"));
  });

  it("a pending batch where nothing happened is consumed without any CLI mutation", async () => {
    const id = record("trash", [item("f1", "/my-files/docs/a.txt")], false);
    const plan = await planUndo(drive, journal, { action: "plan", id });
    const r = await applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint });
    assert.deepEqual({ undone: r.undone, alreadyInPlace: r.alreadyInPlace, status: r.status }, { undone: 0, alreadyInPlace: 1, status: "undone" });
    assert.deepEqual(mutations(), []);
  });

  it("a pending move batch: moved items are moved back by uid", async () => {
    patch((n) => { n.f4.parentUid = "d1"; });
    const id = record("move", [item("f4", "/my-files/pics/x.jpg", "/my-files/docs/x.jpg"), item("f3", "/my-files/archive/c.txt", "/my-files/docs/c.txt")], false);
    patch((n) => { n.f3.parentUid = "d1"; });
    const plan = await planUndo(drive, journal, { action: "plan", id });
    assert.deepEqual(plan.moveBack, ["/my-files/docs/x.jpg -> /my-files/pics/x.jpg", "/my-files/docs/c.txt -> /my-files/archive/c.txt"]);
    const r = await applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint });
    assert.equal(r.status, "undone");
    assert.ok(isBack("f4", "d2", "x.jpg") && isBack("f3", "d3", "c.txt"));
  });
});

describe("drive_undo: move and rename batches", () => {
  const moved = () => {
    patch((n) => { n.f4.parentUid = "d1"; });
    return record("move", [item("f4", "/my-files/pics/x.jpg", "/my-files/docs/x.jpg")]);
  };

  it("moves an item back (one move per original folder) and verifies it by uid", async () => {
    const id = moved();
    patch((n) => { n.f3.parentUid = "d3"; });
    const plan = await planUndo(drive, journal, { action: "plan", id });
    assert.deepEqual(plan.moveBack, ["/my-files/docs/x.jpg -> /my-files/pics/x.jpg"]);
    assert.deepEqual(plan.restore, []);
    const r = await applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint });
    assert.deepEqual({ undone: r.undone, failed: r.failed, status: r.status }, { undone: 1, failed: [], status: "undone" });
    assert.ok(isBack("f4", "d2", "x.jpg"));
    assert.deepEqual(mutations(), [["filesystem", "move", "/my-files/docs/x.jpg", "/my-files/pics"]]);
  });

  it("groups several items returning to one folder into a single move call", async () => {
    patch((n) => { n.f1.parentUid = "d3"; n.f2.parentUid = "d3"; });
    const id = record("move", [item("f1", "/my-files/docs/a.txt", "/my-files/archive/a.txt"), item("f2", "/my-files/docs/b.txt", "/my-files/archive/b.txt")]);
    const plan = await planUndo(drive, journal, { action: "plan", id });
    await applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint });
    assert.deepEqual(mutations(), [["filesystem", "move", "/my-files/archive/a.txt", "/my-files/archive/b.txt", "/my-files/docs"]]);
    assert.ok(isBack("f1", "d1", "a.txt") && isBack("f2", "d1", "b.txt"));
  });

  it("refuses an item the user moved again meanwhile (its uid is no longer where the batch put it)", async () => {
    const id = moved();
    patch((n) => { n.f4.parentUid = "d3"; });
    const plan = await planUndo(drive, journal, { action: "plan", id });
    assert.equal(plan.items[0].restorable, false);
    assert.match(plan.items[0].reason, /no longer at \/my-files\/docs\/x\.jpg/);
    await assert.rejects(applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint }), /Nothing in batch/);
    assert.equal(node("f4").parentUid, "d3");
    assert.deepEqual(mutations(), []);
  });

  it("does not move back a different item that now sits at the batch's destination path", async () => {
    const id = moved();
    patch((n) => { n.f4.parentUid = "d3"; n["imp"] = file("imp", "d1", "x.jpg"); });
    const plan = await planUndo(drive, journal, { action: "plan", id });
    assert.equal(plan.restorableCount, 0);
    assert.deepEqual(mutations(), []);
  });

  it("refuses when the original folder is gone or already holds that name", async () => {
    const id = moved();
    patch((n) => { n["clash"] = file("clash", "d2", "x.jpg"); });
    let plan = await planUndo(drive, journal, { action: "plan", id });
    assert.match(plan.items[0].reason, /already exists in \/my-files\/pics/);
    patch((n) => { delete n.clash; n.d2.trashTime = "t"; });
    plan = await planUndo(drive, journal, { action: "plan", id });
    assert.match(plan.items[0].reason, /no longer exists/);
    assert.deepEqual(mutations(), []);
  });

  it("renames back, and refuses when the old name has been taken", async () => {
    patch((n) => { n.f1.name = "renamed.txt"; });
    const id = record("rename", [item("f1", "/my-files/docs/a.txt", "/my-files/docs/renamed.txt")]);
    let plan = await planUndo(drive, journal, { action: "plan", id });
    assert.deepEqual(plan.moveBack, ["/my-files/docs/renamed.txt -> /my-files/docs/a.txt"]);
    const r = await applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint });
    assert.equal(r.status, "undone");
    assert.ok(isBack("f1", "d1", "a.txt"));
    assert.deepEqual(mutations(), [["filesystem", "rename", "/my-files/docs/renamed.txt", "a.txt"]]);

    patch((n) => { n.f2.name = "second.txt"; });
    const id2 = record("rename", [item("f2", "/my-files/docs/b.txt", "/my-files/docs/second.txt")]);
    patch((n) => { n["taken"] = file("taken", "d1", "b.txt"); });
    plan = await planUndo(drive, journal, { action: "plan", id: id2 });
    assert.match(plan.items[0].reason, /already exists/);
    assert.equal(node("f2").name, "second.txt");
  });

  it("a move that also renamed goes back to its original folder and name", async () => {
    patch((n) => { n.f4.parentUid = "d1"; n.f4.name = "photo.jpg"; });
    const id = record("move", [item("f4", "/my-files/pics/x.jpg", "/my-files/docs/photo.jpg")]);
    const plan = await planUndo(drive, journal, { action: "plan", id });
    const r = await applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint });
    assert.equal(r.status, "undone");
    assert.ok(isBack("f4", "d2", "x.jpg"));
  });

  it("a CLI per-item move failure is reported, not counted", async () => {
    const id = moved();
    process.env.FAKE_FAIL_UIDS = "f4";
    const plan = await planUndo(drive, journal, { action: "plan", id });
    const r = await applyUndo(drive, journal, { id, expectedFingerprint: plan.fingerprint });
    assert.equal(r.undone, 0);
    assert.equal(r.status, "partial");
    assert.match(r.failed[0].reason, /injected failure/);
    assert.equal(node("f4").parentUid, "d1");
  });

  it("refuses move paths outside the roots (destination of the journaled change)", async () => {
    const id = moved();
    const plan = await planUndo(drive, journal, { action: "plan", id, isPathAllowed: (p) => p.startsWith("/my-files/pics") });
    assert.match(plan.items[0].reason, /outside the allowed Drive roots/);
  });
});

describe("drive_undo: list, ids and accounts", () => {
  it("lists the newest 20 batches without file names", async () => {
    for (let i = 0; i < 23; i++) record("trash", [item(`u${i}`, `/my-files/docs/secret-name-${i}.txt`)]);
    const l = await planUndo(drive, journal, { action: "list" });
    assert.equal(l.action, "list");
    assert.equal(l.batches.length, 20);
    assert.ok(!JSON.stringify(l).includes("secret-name"));
    assert.deepEqual(Object.keys(l.batches[0]).sort(), ["id", "items", "kind", "status", "tool", "when"]);
    assert.equal(l.batches[0].items, 1);
    assert.match(l.batches[0].when, /^\d{4}-\d\d-\d\dT/);
  });

  it("a batch of another account is invisible: not listed, not planned, not applied", async () => {
    const id = trashAB();
    const other = createUndoJournal({ dir: join(dir, "undo"), account: "acct-2" });
    assert.deepEqual((await planUndo(drive, other, { action: "list" })).batches, []);
    await assert.rejects(planUndo(drive, other, { action: "plan", id }), (e) => e instanceof UndoError && e.code === "not_found");
    await assert.rejects(applyUndo(drive, other, { id, expectedFingerprint: "x" }), (e) => e.code === "not_found");
    assert.deepEqual(mutations(), []);
  });

  it("rejects a malformed id (path-like codes included) and an unknown id; no batch at all gives no_batch", async () => {
    await assert.rejects(planUndo(drive, journal, { action: "plan", id: "../../etc" }), (e) => e instanceof UndoError && e.code === "invalid_id");
    await assert.rejects(planUndo(drive, journal, { action: "plan", id: "ABCD-EFGH" }), (e) => e.code === "not_found");
    await assert.rejects(planUndo(drive, journal, { action: "plan" }), (e) => e.code === "no_batch");
  });

  it("works with journalling disabled: nothing to list, plan refuses cleanly", async () => {
    const off = createUndoJournal({ dir: join(dir, "undo"), account: "acct-1", enabled: false });
    assert.deepEqual((await planUndo(drive, off, { action: "list" })).batches, []);
    await assert.rejects(planUndo(drive, off, { action: "plan" }), (e) => e.code === "no_batch");
  });
});

describe("drive_undo: folder listings", () => {
  /** The real service with `list` counted: calls per folder and the highest number in flight. */
  const counted = () => {
    const seen = { calls: [], max: 0, now: 0 };
    return {
      seen,
      drive: {
        list: async (path, opts) => {
          seen.calls.push(path);
          seen.max = Math.max(seen.max, ++seen.now);
          try { await new Promise((r) => setTimeout(r, 20)); return await drive.list(path, opts); } finally { seen.now--; }
        },
        listTrash: () => drive.listTrash(),
        restoreMany: (p) => drive.restoreMany(p),
        moveMany: (a, b) => drive.moveMany(a, b),
        move: (a, b) => drive.move(a, b),
        rename: (a, b) => drive.rename(a, b),
      },
    };
  };
  const spread = () => {
    const items = [];
    patch((n) => {
      for (let i = 0; i < 8; i++) {
        n[`p${i}`] = folder(`p${i}`, "d3", `sub${i}`);
        n[`g${i}`] = file(`g${i}`, `p${i}`, `g${i}.txt`, { trashTime: "2026-11-19T10:00:00Z" });
        items.push({ ...item(`g${i}`, `/my-files/archive/sub${i}/g${i}.txt`), parentUid: `p${i}` });
      }
    });
    return record("trash", items);
  };

  it("lists distinct folders in parallel (at most 4 at a time), each once per planning pass and once to verify", async () => {
    const id = spread();
    const parents = Array.from({ length: 8 }, (_, i) => `/my-files/archive/sub${i}`);
    const expected = [...parents, "/my-files/archive"].sort();
    const a = counted();
    const plan = await planUndo(a.drive, journal, { action: "plan", id });
    assert.equal(plan.restorableCount, 8);
    assert.deepEqual([...a.seen.calls].sort(), expected);
    assert.ok(a.seen.max > 1 && a.seen.max <= 4, `max in flight ${a.seen.max}`);

    const b = counted();
    const r = await applyUndo(b.drive, journal, { id, expectedFingerprint: plan.fingerprint });
    assert.equal(r.undone, 8);
    // one fresh re-plan, then one verification listing per folder
    assert.deepEqual([...b.seen.calls].sort(), [...expected, ...parents].sort());
    assert.ok(b.seen.max > 1 && b.seen.max <= 4, `max in flight ${b.seen.max}`);
  });

  it("lists no folder for an item refused before any lookup", async () => {
    const id = spread();
    const a = counted();
    const plan = await planUndo(a.drive, journal, { action: "plan", id, isPathAllowed: () => false });
    assert.equal(plan.restorableCount, 0);
    assert.deepEqual(a.seen.calls, []);
  });
});
