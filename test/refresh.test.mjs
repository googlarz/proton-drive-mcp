// Incremental, resumable refresh of the saved folder index (1.8.0): walkTree's incremental mode and drive_refresh_index.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriveService } from "../dist/services/drive.js";
import { walkTree, resetWalkCacheForTests, flushWalkIndexForTests, invalidatePath } from "../dist/services/walk.js";
import { driveTree } from "../dist/services/find.js";
import { driveRefreshIndex } from "../dist/services/refreshIndex.js";
import { readIndex, writeIndex, indexPath, indexDir, INDEX_VERSION } from "../dist/services/walkIndex.js";
import { READ_TOOL_NAMES, MUTATING_TOOL_NAMES, REMOTE_PATH_ARGS, rootsRefusal } from "../dist/index.js";
import { makeSandbox, startServer, nonVersionCalls } from "./helpers/mcp-client.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3_600_000;
const folder = (name, uid = `d-${name}`) => ({ uid, parentUid: "p", type: "folder", name: { ok: true, value: name } });
const file = (name, size = 5, extra = {}) => ({
  uid: `f-${name}`, parentUid: "p", type: "file", name: { ok: true, value: name }, mediaType: "text/plain",
  modificationTime: "2026-01-02T00:00:00.000Z", activeRevision: { claimedSize: size }, ...extra,
});
/** The tree is mutable: a test changes it between calls like the real drive changes between refreshes. */
function makeSvc(tree, { delay = 0 } = {}) {
  const calls = [];
  const runner = async (args) => {
    const path = args[2];
    calls.push(path);
    if (delay) await sleep(delay);
    const v = tree[path];
    if (v === undefined) throw new Error(`Node not found: ${path}`);
    return typeof v === "function" ? v() : v;
  };
  return { svc: new DriveService(runner), calls, tree };
}
const small = () => ({
  "/my-files": [folder("a"), folder("b"), folder(".git"), file("root.txt")],
  "/my-files/a": [folder("deep"), file("x.txt", 20)],
  "/my-files/a/deep": [file("y.txt", 10)],
  "/my-files/b": [file("z.txt", 7)],
  "/my-files/.git": [file("HEAD", 1)],
});
const count = (calls, p) => calls.filter((c) => c === p).length;
const paths = (r) => r.nodes.map((n) => n.path);

/** Ages saved folder listings: `by` maps a folder path to ms (or a number for all of them). */
function ageListed(by) {
  const f = readIndex();
  for (const e of f.entries) {
    for (const k of Object.keys(e.listed)) e.listed[k] -= typeof by === "number" ? by : by[k] ?? 0;
  }
  assert.equal(writeIndex(f), "ok");
}
/** A cold walk (saved), then "a new process": memory dropped, file kept. */
async function seed(tree = small()) {
  const { svc } = makeSvc(tree);
  const r = await walkTree(svc, "/my-files");
  assert.equal(r.complete, true);
  await flushWalkIndexForTests();
  resetWalkCacheForTests();
}
/** One refresh slice like drive_refresh_index runs it. */
const slice = (svc, o = {}) => walkTree(svc, "/my-files", { resumable: true, maxCalls: 1_000_000, budgetMs: 5000, maxListingAgeMs: HOUR, concurrency: 1, ...o });

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pdrefresh-"));
  process.env.PROTON_DRIVE_INDEX = "1";
  process.env.PROTON_DRIVE_INDEX_DIR = join(tmp, "idx");
  for (const k of ["PROTON_DRIVE_INDEX_MAX_AGE_H", "PROTON_DRIVE_INDEX_FOLDER_MAX_AGE_H", "PROTON_DRIVE_WALK_TTL_MS"]) delete process.env[k];
  resetWalkCacheForTests();
});
afterEach(async () => {
  await flushWalkIndexForTests();
  resetWalkCacheForTests();
  for (const k of ["PROTON_DRIVE_INDEX", "PROTON_DRIVE_INDEX_DIR", "PROTON_DRIVE_INDEX_MAX_AGE_H", "PROTON_DRIVE_INDEX_FOLDER_MAX_AGE_H", "PROTON_DRIVE_WALK_TTL_MS"]) delete process.env[k];
  rmSync(tmp, { recursive: true, force: true });
});

describe("incremental refresh: which folders are listed", () => {
  it("saves a listing time for every folder (not the excluded ones) in a version 2 file", async () => {
    await seed();
    const f = readIndex();
    assert.equal(f.version, INDEX_VERSION);
    assert.deepEqual(Object.keys(f.entries[0].listed).sort(), ["/my-files", "/my-files/a", "/my-files/a/deep", "/my-files/b"]);
  });

  it("reuses listings younger than the allowed age and lists only the older ones", async () => {
    await seed();
    ageListed({ "/my-files": 2 * HOUR, "/my-files/a": 2 * HOUR });
    const { svc, calls } = makeSvc(small());
    const r = await slice(svc);
    assert.equal(r.complete, true);
    assert.equal(r.partial, undefined);
    assert.equal(r.foldersRefreshed, 2);
    assert.equal(r.foldersReused, 2);
    assert.equal(r.foldersRemaining, 0);
    assert.equal(count(calls, "/my-files"), 2, "the account check and the stale root");
    assert.equal(count(calls, "/my-files/a"), 1);
    assert.equal(count(calls, "/my-files/b"), 0);
    assert.equal(count(calls, "/my-files/a/deep"), 0);
    assert.equal(count(calls, "/my-files/.git"), 0, "excluded folders are never listed");
    assert.equal(r.nodes.length, 8);
    assert.ok(r.oldestListingAgeMs < HOUR && r.ageMs === r.oldestListingAgeMs, "oldest listing age is reported");
  });

  it("lists the oldest listings first", async () => {
    await seed();
    ageListed({ "/my-files": 5 * HOUR, "/my-files/a": 4 * HOUR, "/my-files/b": 3 * HOUR, "/my-files/a/deep": 6 * HOUR });
    const { svc, calls } = makeSvc(small());
    await slice(svc);
    assert.deepEqual(calls.slice(1), ["/my-files/a/deep", "/my-files", "/my-files/a", "/my-files/b"]); // calls[0] is the account check
  });

  it("maxAge 0 / PROTON_DRIVE_INDEX_FOLDER_MAX_AGE_H=0 means no reuse: an ordinary call walks from scratch", async () => {
    await seed();
    ageListed(30 * HOUR); // past the 24 h the index may be served
    process.env.PROTON_DRIVE_INDEX_FOLDER_MAX_AGE_H = "0";
    const { svc, calls } = makeSvc(small());
    const r = await walkTree(svc, "/my-files");
    assert.equal(r.foldersRefreshed, undefined, "not an incremental walk");
    assert.equal(r.complete, true);
    assert.equal(count(calls, "/my-files/b"), 1);
  });

  it("an ordinary call past the 24 h limit refreshes in place instead of walking from scratch", async () => {
    await seed();
    ageListed(30 * HOUR);
    const f = readIndex();
    f.entries[0].listed["/my-files/b"] += 29.5 * HOUR; // b was read recently (30 min ago)
    writeIndex(f);
    const { svc, calls } = makeSvc(small());
    const r = await walkTree(svc, "/my-files");
    assert.equal(r.complete, true);
    assert.equal(r.foldersReused, 1);
    assert.equal(count(calls, "/my-files/b"), 0);
    assert.equal(count(calls, "/my-files/a"), 1);
    assert.ok(r.ageMs < HOUR, "the result is as old as its oldest listing, which was just read");
  });
});

describe("incremental refresh: budget, checkpoints, convergence", () => {
  const wide = (n) => {
    const t = { "/my-files": Array.from({ length: n }, (_, i) => folder(`f${i + 1}`)) };
    for (let i = 1; i <= n; i++) t[`/my-files/f${i}`] = [file(`f${i}.txt`)];
    return t;
  };

  it("a budget stop returns a partial result, saves its progress, and repeated calls converge without re-listing", async () => {
    const t = wide(8);
    const { svc, calls } = makeSvc(t, { delay: 60 });
    const first = await slice(svc, { budgetMs: 250 });
    assert.equal(first.partial, true);
    assert.equal(first.continuing, true);
    assert.equal(first.complete, false);
    assert.ok(first.foldersRemaining > 0 && first.foldersRefreshed > 0);
    assert.ok(first.skipped.length === first.foldersRemaining && first.skipped.every((s) => s.reason === "not refreshed yet: time budget"));
    assert.equal(await (await import("../dist/services/walk.js")).settleIndexWrites(), true);

    let last = first, rounds = 1;
    while (!last.complete && rounds < 12) {
      resetWalkCacheForTests(); // a new process each time: only the file carries the progress
      last = await slice(svc, { budgetMs: 250 });
      rounds++;
      await (await import("../dist/services/walk.js")).settleIndexWrites();
    }
    assert.equal(last.complete, true);
    assert.equal(last.foldersRemaining, 0);
    assert.ok(rounds > 1 && rounds < 12, `converged in ${rounds} calls`);
    assert.equal(last.nodes.length, 8 + 8);
    for (let i = 1; i <= 8; i++) assert.equal(count(calls, `/my-files/f${i}`), 1, `f${i} listed once overall`);
  });

  it("a partial result never claims completeness, in memory or on disk, and an ordinary call continues it", async () => {
    const t = wide(8);
    const { svc, calls } = makeSvc(t, { delay: 60 });
    const first = await slice(svc, { budgetMs: 200 });
    await flushWalkIndexForTests();
    assert.equal(first.complete, false);
    const saved = readIndex().entries[0];
    assert.ok(Object.keys(saved.listed).length < 9, "unlisted folders have no listing time");
    assert.ok(saved.nodes.length > 0);
    // Same process, ordinary caller: the half-built tree is not served as a finished one.
    const before = calls.length;
    const again = await walkTree(svc, "/my-files", { budgetMs: 0, concurrency: 4 });
    assert.ok(calls.length > before, "it listed the missing folders");
    assert.equal(again.complete, true);
    assert.equal(again.nodes.length, 16);
  });

  it("an ordinary call with a small budget on a partial tree is partial (not complete) and says what is left", async () => {
    const { svc } = makeSvc(wide(8), { delay: 60 });
    await slice(svc, { budgetMs: 150 });
    await flushWalkIndexForTests();
    resetWalkCacheForTests();
    const r = await walkTree(svc, "/my-files", { budgetMs: 100, concurrency: 1 });
    assert.equal(r.partial, true);
    assert.equal(r.complete, false);
    assert.equal(r.stale, true);
    assert.ok(r.foldersRemaining > 0);
    const tree = await driveTree(svc, { path: "/my-files", depth: 1 });
    assert.equal(tree.fromCache, false, "a depth-limited request is not cut from the unfinished tree; it walks live");
  });

  it("a cold start through the refresh tool works without a saved tree (and the call cap stops a slice too)", async () => {
    const { svc } = makeSvc(wide(6));
    const r = await slice(svc, { maxCalls: 3 });
    assert.equal(r.complete, false);
    assert.equal(r.partial, true);
    assert.equal(r.callsMade, 3);
    assert.ok(r.skipped.every((s) => /maxCalls \(3\) reached/.test(s.reason)));
    await flushWalkIndexForTests();
    resetWalkCacheForTests();
    const done = await slice(svc);
    assert.equal(done.complete, true);
    assert.equal(done.nodes.length, 12);
  });

  it("a failing folder stays as it was, is reported, and the rest of the slice is saved", async () => {
    await seed();
    ageListed(2 * HOUR);
    const t = small();
    t["/my-files/b"] = () => { throw new Error("down"); };
    t["/my-files/a"] = [folder("deep"), file("x.txt", 20), file("new.txt", 1)];
    const { svc } = makeSvc(t);
    const r = await slice(svc);
    assert.equal(r.complete, false);
    assert.equal(r.partial, undefined, "not cut by budget: a failure");
    assert.ok(r.skipped.some((s) => s.path === "/my-files/b" && /down/.test(s.reason)));
    assert.ok(paths(r).includes("/my-files/b/z.txt"), "the failed folder keeps its old entries");
    assert.ok(paths(r).includes("/my-files/a/new.txt"));
    await flushWalkIndexForTests();
    const saved = readIndex().entries[0];
    assert.ok(saved.nodes.some((n) => n.path === "/my-files/a/new.txt"));
    assert.ok(saved.listed["/my-files/b"] < Date.now() - HOUR, "b is still old on disk");
  });
});

describe("incremental refresh: removals", () => {
  it("drops entries only for folders that were re-listed", async () => {
    await seed();
    ageListed({ "/my-files/a": 2 * HOUR });
    const t = small();
    t["/my-files/a"] = [folder("deep")]; // x.txt removed in a (re-listed)
    t["/my-files/b"] = []; // z.txt removed in b, which is NOT re-listed
    const { svc } = makeSvc(t);
    const r = await slice(svc);
    assert.ok(!paths(r).includes("/my-files/a/x.txt"));
    assert.ok(paths(r).includes("/my-files/b/z.txt"), "b was not listed again, so nothing is removed from it");
    // ... until b is listed again
    ageListed({ "/my-files/b": 2 * HOUR });
    await flushWalkIndexForTests();
    resetWalkCacheForTests();
    const r2 = await slice(makeSvc(t).svc);
    assert.ok(!paths(r2).includes("/my-files/b/z.txt"));
  });

  it("removing a folder removes every cached descendant and its listing times", async () => {
    await seed();
    ageListed({ "/my-files": 2 * HOUR }); // only the root is re-listed; a and deep are young
    const t = small();
    t["/my-files"] = [folder("b"), folder(".git"), file("root.txt")];
    const { svc } = makeSvc(t);
    const r = await slice(svc);
    assert.deepEqual(paths(r).filter((p) => p.startsWith("/my-files/a")), []);
    assert.equal(r.complete, true);
    await flushWalkIndexForTests();
    const saved = readIndex().entries[0];
    assert.deepEqual(Object.keys(saved.listed).sort(), ["/my-files", "/my-files/b"]);
    assert.deepEqual(saved.nodes.filter((n) => n.path.startsWith("/my-files/a")), []);
  });

  it("a renamed folder leaves no orphans under its old path; its contents are listed under the new one", async () => {
    await seed();
    ageListed({ "/my-files": 2 * HOUR });
    const t = small();
    t["/my-files"] = [folder("a2", "d-a"), folder("b"), folder(".git"), file("root.txt")]; // same uid, new name
    t["/my-files/a2"] = [folder("deep"), file("x.txt", 20)];
    t["/my-files/a2/deep"] = [file("y.txt", 10)];
    delete t["/my-files/a"];
    delete t["/my-files/a/deep"];
    const { svc, calls } = makeSvc(t);
    const r = await slice(svc);
    assert.equal(r.complete, true);
    assert.deepEqual(paths(r).filter((p) => p.startsWith("/my-files/a/") || p === "/my-files/a"), []);
    assert.ok(paths(r).includes("/my-files/a2/deep/y.txt"));
    assert.equal(count(calls, "/my-files/a"), 0, "the old path is not listed");
    assert.equal(count(calls, "/my-files/a2"), 1);
  });

  it("a folder deleted and recreated under the same name (new uid) does not keep the old folder's children", async () => {
    await seed();
    ageListed({ "/my-files": 2 * HOUR });
    const t = small();
    t["/my-files"] = [folder("a", "d-a-NEW"), folder("b"), folder(".git"), file("root.txt")];
    t["/my-files/a"] = [file("fresh.txt", 3)];
    delete t["/my-files/a/deep"];
    const { svc } = makeSvc(t);
    const r = await slice(svc);
    assert.deepEqual(paths(r).filter((p) => p.startsWith("/my-files/a")), ["/my-files/a", "/my-files/a/fresh.txt"]);
  });

  it("changes:true counts what re-listed folders gained, lost or changed, with at most 50 samples", async () => {
    await seed();
    ageListed({ "/my-files/a": 2 * HOUR, "/my-files/b": 2 * HOUR });
    const t = small();
    t["/my-files/a"] = [folder("deep"), file("x.txt", 21), file("n1.txt")]; // x.txt modified (size), n1 added
    t["/my-files/b"] = []; // z removed
    const { svc } = makeSvc(t);
    const out = await driveRefreshIndex(svc, { changes: true, timeBudgetMs: 5000, maxAgeHours: 1 });
    assert.deepEqual([out.changes.added, out.changes.removed, out.changes.modified], [1, 1, 1]);
    assert.deepEqual(out.changes.samples.map((s) => `${s.kind}:${s.path}`).sort(), ["added:/my-files/a/n1.txt", "modified:/my-files/a/x.txt", "removed:/my-files/b/z.txt"]);
    // many changes: counted fully, sampled up to the cap
    await flushWalkIndexForTests();
    resetWalkCacheForTests();
    ageListed({ "/my-files/a": 2 * HOUR });
    t["/my-files/a"] = Array.from({ length: 200 }, (_, i) => file(`m${i}.txt`));
    const big = await driveRefreshIndex(makeSvc(t).svc, { changes: true, timeBudgetMs: 5000, maxAgeHours: 1 });
    assert.ok(big.changes.added >= 200 && big.changes.removed >= 1);
    assert.ok(big.changes.samples.length <= 50);
  });
});

describe("incremental refresh: the saved file", () => {
  it("a checkpoint round-trips through the file: a new process continues exactly where the last one stopped", async () => {
    const t = { "/my-files": [folder("f1"), folder("f2"), folder("f3")], "/my-files/f1": [file("a")], "/my-files/f2": [file("b")], "/my-files/f3": [file("c")] };
    const { svc, calls } = makeSvc(t);
    await slice(svc, { maxCalls: 2 }); // root + one folder
    await flushWalkIndexForTests();
    const saved = readIndex();
    assert.deepEqual(Object.keys(saved.entries[0].listed).length, 2);
    assert.equal(saved.entries[0].nodes.length, 4); // 3 folders + the file of the listed one
    resetWalkCacheForTests();
    calls.length = 0;
    const r = await slice(svc);
    assert.equal(r.complete, true);
    assert.equal(r.foldersReused, 2);
    assert.deepEqual(calls, ["/my-files", "/my-files/f2", "/my-files/f3"], "the account check, then only the two unlisted folders");
  });

  it("a corrupt file, an unknown version and a malformed listed map are discarded safely and the walk starts over", async () => {
    await seed();
    for (const body of ["{not json", JSON.stringify({ version: 3, accountKey: "p", savedAt: 1, entries: [] })]) {
      writeFileSync(indexPath(), body, { mode: 0o600 });
      resetWalkCacheForTests();
      const { svc } = makeSvc(small());
      const r = await slice(svc);
      assert.equal(r.complete, true);
      assert.equal(r.nodes.length, 8);
      await flushWalkIndexForTests();
      assert.equal(readIndex().entries[0].nodes.length, 8, "rewritten as a valid file");
    }
    const f = readIndex();
    f.entries[0].listed["/my-files/a"] = "yesterday";
    writeFileSync(indexPath(), JSON.stringify(f), { mode: 0o600 });
    assert.equal(readIndex(), undefined, "a non-numeric listing time invalidates the file");
  });

  it("a version 1 file (complete walks, no listing times) is read: every folder counts as listed at completedAt", async () => {
    await seed();
    const f = readIndex();
    const e = f.entries[0];
    delete e.listed;
    e.completedAt = Date.now() - 3 * HOUR;
    writeFileSync(indexPath(), JSON.stringify({ ...f, version: 1 }), { mode: 0o600 });
    resetWalkCacheForTests();
    const young = makeSvc(small());
    const reuse = await slice(young.svc, { maxListingAgeMs: 10 * HOUR });
    assert.equal(reuse.complete, true);
    assert.equal(reuse.foldersRefreshed, 0);
    assert.deepEqual(young.calls, ["/my-files"], "only the account check");
    resetWalkCacheForTests();
    const old = makeSvc(small());
    const relist = await slice(old.svc, { maxListingAgeMs: HOUR });
    assert.equal(relist.foldersRefreshed, 4);
    assert.equal(relist.foldersReused, 0);
    await flushWalkIndexForTests();
    assert.equal(readIndex().version, INDEX_VERSION);
    assert.ok(readIndex().entries[0].listed["/my-files/b"]);
  });

  it("another account's file is discarded, not merged", async () => {
    await seed();
    const f = readIndex(); f.accountKey = "someone-else"; writeIndex(f);
    resetWalkCacheForTests();
    const { svc, calls } = makeSvc(small());
    const r = await slice(svc);
    assert.equal(r.complete, true);
    assert.equal(r.foldersReused, 0);
    assert.equal(count(calls, "/my-files/b"), 1);
    await flushWalkIndexForTests();
    assert.equal(readIndex().accountKey, "p");
  });
});

describe("serving depth-limited requests from the saved index", () => {
  it("drive_tree with a depth is answered from a fresh saved full walk and reports its age", async () => {
    await seed();
    ageListed(HOUR);
    const { svc, calls } = makeSvc(small());
    const t = await driveTree(svc, { path: "/my-files", depth: 1 });
    assert.equal(t.fromCache, true);
    assert.equal(t.stale, true);
    assert.ok(t.ageMs >= HOUR && t.ageMs < 2 * HOUR);
    assert.deepEqual(t.tree.map((e) => e.name).sort(), [".git", "a", "b", "root.txt"]);
    assert.deepEqual(calls, ["/my-files"], "only the account check");
    await flushWalkIndexForTests();
  });

  it("is also answered from the memory cache, and a saved tree older than the index max age is not used", async () => {
    const { svc, calls } = makeSvc(small());
    await walkTree(svc, "/my-files");
    const n = calls.length;
    const shallow = await walkTree(svc, "/my-files", { maxDepth: 1 });
    assert.equal(shallow.fromCache, true);
    assert.equal(calls.length, n);
    assert.deepEqual(paths(shallow).sort(), ["/my-files/.git", "/my-files/a", "/my-files/b", "/my-files/root.txt"]);
    await flushWalkIndexForTests();
    resetWalkCacheForTests();
    ageListed(30 * HOUR);
    const live = await walkTree(svc, "/my-files", { maxDepth: 1 });
    assert.equal(live.fromCache, false, "too old to serve");
  });
});

describe("other walk users use the incremental mode", () => {
  it("a noDisk caller without maxListingAgeMs never reads the saved index: a remote deletion is visible", async () => {
    await seed();
    const t = small();
    t["/my-files/b"] = []; // z.txt deleted remotely; the saved listing of b is only seconds old
    const { svc, calls } = makeSvc(t);
    const r = await walkTree(svc, "/my-files", { noDisk: true, budgetMs: 0 });
    assert.equal(r.complete, true);
    assert.equal(r.foldersRefreshed, undefined, "a plain full walk, not an incremental one");
    assert.ok(!paths(r).includes("/my-files/b/z.txt"));
    assert.equal(count(calls, "/my-files/b"), 1);
    assert.equal(count(calls, "/my-files"), 1, "no account check either");
  });

  it("a noDisk caller never sees saved-index data through the memory cache of an earlier walk that was seeded from the index", async () => {
    await seed();
    const t = small();
    t["/my-files/a"] = [folder("deep")]; // x.txt deleted remotely
    const { svc, calls } = makeSvc(t);
    invalidatePath("/my-files/b/new.txt"); // this server wrote into b: the saved index no longer answers whole, so the walk merges into it
    const first = await walkTree(svc, "/my-files"); // e.g. drive_tree: seeds from the saved index, reuses the young listing of a
    assert.ok(paths(first).includes("/my-files/a/x.txt"), "the ordinary caller may be served saved data");
    calls.length = 0;
    const r = await walkTree(svc, "/my-files", { noDisk: true, budgetMs: 0 }); // e.g. drive_sharing_audit
    assert.ok(calls.length > 0, "listed again");
    assert.ok(!paths(r).includes("/my-files/a/x.txt"));
    // an explicit age still accepts the memory entry
    calls.length = 0;
    await walkTree(svc, "/my-files", { noDisk: true, maxListingAgeMs: HOUR });
    assert.equal(calls.length, 0);
  });

  it("the content index's 60 s window: listings read 10 s ago are reused, ones read 2 min ago are listed again", async () => {
    await seed();
    ageListed({ "/my-files": 10_000, "/my-files/a": 120_000, "/my-files/b": 10_000, "/my-files/a/deep": 10_000 });
    const { svc, calls } = makeSvc(small());
    const r = await walkTree(svc, "/my-files", { noDisk: true, maxListingAgeMs: 60_000, budgetMs: 25_000 });
    assert.equal(r.complete, true);
    assert.deepEqual([r.foldersRefreshed, r.foldersReused], [1, 3]);
    assert.deepEqual(calls.filter((c) => c !== "/my-files"), ["/my-files/a"]);
    assert.ok(r.ageMs <= 61_000);
  });

  it("refresh:true is still a full re-walk", async () => {
    await seed();
    const { svc, calls } = makeSvc(small());
    const r = await walkTree(svc, "/my-files", { refresh: true, noDisk: true });
    assert.equal(r.foldersRefreshed, undefined);
    assert.equal(count(calls, "/my-files/b"), 1);
    assert.equal(count(calls, "/my-files/a/deep"), 1);
    assert.equal(count(calls, "/my-files"), 1, "no account check either");
  });

  it("without PROTON_DRIVE_INDEX nothing changes: a plain full walk", async () => {
    delete process.env.PROTON_DRIVE_INDEX;
    const { svc } = makeSvc(small());
    const r = await walkTree(svc, "/my-files", { noDisk: true, maxListingAgeMs: 1000 });
    assert.equal(r.foldersRefreshed, undefined);
    assert.equal(r.complete, true);
  });
});

describe("drive_refresh_index", () => {
  it("needs PROTON_DRIVE_INDEX=1 and validates its arguments", async () => {
    const { svc } = makeSvc(small());
    delete process.env.PROTON_DRIVE_INDEX;
    await assert.rejects(driveRefreshIndex(svc, {}), /PROTON_DRIVE_INDEX=1/);
    process.env.PROTON_DRIVE_INDEX = "1";
    await assert.rejects(driveRefreshIndex(svc, { path: "/photos" }), /my-files/);
    await assert.rejects(driveRefreshIndex(svc, { timeBudgetMs: 10 }), /timeBudgetMs/);
    await assert.rejects(driveRefreshIndex(svc, { maxAgeHours: 0 }), /maxAgeHours/);
    process.env.PROTON_DRIVE_INDEX_FOLDER_MAX_AGE_H = "0";
    await assert.rejects(driveRefreshIndex(svc, {}), /maxAgeHours/);
  });

  it("reports progress and an ETA, and converges", async () => {
    const t = { "/my-files": Array.from({ length: 6 }, (_, i) => folder(`f${i + 1}`)) };
    for (let i = 1; i <= 6; i++) t[`/my-files/f${i}`] = [file(`x${i}`)]; // uids are unique on the real drive
    const { svc } = makeSvc(t, { delay: 80 });
    const a = await driveRefreshIndex(svc, { timeBudgetMs: 1000 }, { walk: (s, p, o) => walkTree(s, p, { ...o, budgetMs: 300, concurrency: 1 }) });
    assert.equal(a.complete, false);
    assert.equal(a.partial, true);
    assert.ok(a.foldersRefreshed > 0 && a.foldersRemaining > 0);
    assert.equal(a.etaCalls, Math.ceil(a.foldersRemaining / a.foldersRefreshed));
    assert.equal(a.saved, true);
    assert.equal(a.maxAgeHours, 24);
    let out = a;
    for (let i = 0; i < 10 && !out.complete; i++) out = await driveRefreshIndex(svc, { timeBudgetMs: 1000 }, { walk: (s, p, o) => walkTree(s, p, { ...o, budgetMs: 300, concurrency: 1 }) });
    assert.equal(out.complete, true);
    assert.equal(out.etaCalls, 0);
    assert.equal(out.foldersRemaining, 0);
    assert.equal(out.entries, 12);
    const idle = await driveRefreshIndex(svc, {}); // everything young: nothing to list
    assert.equal(idle.foldersRefreshed, 0);
    assert.equal(idle.complete, true);
  });
});

describe("drive_refresh_index in the server", () => {
  it("is a classified, path-scoped read tool confined by PROTON_DRIVE_REMOTE_ROOTS", () => {
    assert.ok(READ_TOOL_NAMES.has("drive_refresh_index"));
    assert.ok(!MUTATING_TOOL_NAMES.has("drive_refresh_index"));
    assert.deepEqual(REMOTE_PATH_ARGS.drive_refresh_index, [{ arg: "path", dflt: "/my-files" }]);
    assert.match(rootsRefusal("drive_refresh_index", {}, ["/my-files/A"]), /outside PROTON_DRIVE_REMOTE_ROOTS/, "the default /my-files is refused when roots are set");
    assert.match(rootsRefusal("drive_refresh_index", { path: "/my-files/B" }, ["/my-files/A"]), /outside/);
    assert.equal(rootsRefusal("drive_refresh_index", { path: "/my-files/A/x" }, ["/my-files/A"]), undefined);
  });

  async function withServer(extraEnv, fn) {
    const sb = makeSandbox();
    mkdirSync(join(sb.dir, "idx"), { mode: 0o700 });
    const tree = {
      "/my-files": [{ ...folder("A"), parentUid: "root" }, { ...folder("B"), parentUid: "root" }],
      "/my-files/A": [{ ...file("a.txt"), parentUid: "dA" }],
      "/my-files/B": [{ ...file("b.txt"), parentUid: "dB" }],
    };
    writeFileSync(join(sb.dir, "tree.json"), JSON.stringify(tree));
    const c = await startServer("tree", sb, { FAKE_TREE: join(sb.dir, "tree.json"), PROTON_DRIVE_RETRY_BASE_MS: "1", ...extraEnv(sb) });
    try { return await fn(c, sb); } finally { await c.close(); sb.cleanup(); }
  }

  it("without the index it answers with how to turn it on; with it, it refreshes and saves", async () => {
    await withServer(() => ({}), async (c) => {
      const r = await c.call("drive_refresh_index", {});
      assert.equal(r.isError, true);
      assert.match(r.text, /PROTON_DRIVE_INDEX=1/);
    });
    await withServer((sb) => ({ PROTON_DRIVE_INDEX: "1", PROTON_DRIVE_INDEX_DIR: join(sb.dir, "idx") }), async (c, sb) => {
      const r = await c.call("drive_refresh_index", { timeBudgetMs: 5000, changes: true });
      assert.equal(r.isError, false, r.text);
      const out = JSON.parse(r.text);
      assert.equal(out.complete, true);
      assert.equal(out.entries, 4);
      assert.equal(out.saved, true);
      assert.equal(out.foldersRefreshed, 3);
      assert.equal(out.changes.added, 4);
      const again = JSON.parse((await c.call("drive_refresh_index", {})).text);
      assert.equal(again.foldersRefreshed, 0);
      assert.equal(again.foldersReused, 3);
      const listed = nonVersionCalls(sb.argvLog).filter((a) => a[0] === "filesystem" && a[1] === "list").map((a) => a[2]);
      assert.equal(listed.filter((p) => p === "/my-files/A").length, 1, "the second call reused the saved listing");
    });
  });

  it("with PROTON_DRIVE_REMOTE_ROOTS the default path is refused and a folder inside a root works", async () => {
    await withServer((sb) => ({ PROTON_DRIVE_INDEX: "1", PROTON_DRIVE_INDEX_DIR: join(sb.dir, "idx"), PROTON_DRIVE_REMOTE_ROOTS: "/my-files/A" }), async (c, sb) => {
      const refused = await c.call("drive_refresh_index", {});
      assert.equal(refused.isError, true);
      assert.match(refused.text, /outside PROTON_DRIVE_REMOTE_ROOTS/);
      assert.deepEqual(nonVersionCalls(sb.argvLog), [], "nothing was listed");
      const ok = await c.call("drive_refresh_index", { path: "/my-files/A", timeBudgetMs: 5000 });
      assert.equal(ok.isError, false, ok.text);
      assert.equal(JSON.parse(ok.text).complete, true);
    });
  });
});

// ---- review fixes (1.8.0) ----------------------------------------------------------------------------------------------
/** Like makeSvc, with a per-path delay in ms (default 0). */
function makeSlowSvc(tree, delays = {}) {
  const calls = [];
  const runner = async (args) => {
    const path = args[2];
    calls.push(path);
    if (delays[path]) await sleep(delays[path]);
    const v = tree[path];
    if (v === undefined) throw new Error(`Node not found: ${path}`);
    return typeof v === "function" ? v() : v;
  };
  return { svc: new DriveService(runner), calls };
}

describe("review fixes: saved-tree safety", () => {
  it("an account check that cannot be completed (unknown) neither restarts nor replaces the saved progress", async () => {
    await seed();
    ageListed(2 * HOUR);
    const t = small();
    let first = true;
    t["/my-files"] = () => { if (first) { first = false; throw new Error("rate limited"); } return small()["/my-files"]; };
    const { svc } = makeSvc(t);
    await assert.rejects(slice(svc), /could not verify the account, try again/);
    await flushWalkIndexForTests();
    const e = readIndex().entries[0];
    assert.equal(e.nodes.length, 8, "the saved tree survived");
    assert.equal(Object.keys(e.listed).length, 4);
    resetWalkCacheForTests();
    const r = await slice(makeSvc(small()).svc); // the next call verifies and continues
    assert.equal(r.complete, true);
    assert.equal(r.nodes.length, 8);
  });

  it("a real account mismatch still starts from scratch", async () => {
    await seed();
    ageListed(2 * HOUR);
    const t = small();
    t["/my-files"] = [{ ...folder("a", "x-a"), parentUid: "other-drive" }, { ...folder("b", "x-b"), parentUid: "other-drive" }];
    t["/my-files/a"] = [];
    t["/my-files/b"] = [];
    const r = await slice(makeSvc(t).svc);
    assert.deepEqual(paths(r).sort(), ["/my-files/a", "/my-files/b"]);
  });

  it("a server write clears only the written node and its parent's listing time, keeping the rest of the saved tree", async () => {
    await seed();
    invalidatePath("/my-files/a/x.txt");
    let e = readIndex().entries[0];
    assert.ok(!e.nodes.some((n) => n.path === "/my-files/a/x.txt"), "the written node is dropped");
    assert.ok(e.nodes.some((n) => n.path === "/my-files/a/deep/y.txt") && e.nodes.some((n) => n.path === "/my-files/b/z.txt"));
    assert.deepEqual(Object.keys(e.listed).sort(), ["/my-files", "/my-files/a/deep", "/my-files/b"], "only a (the parent) lost its listing time");
    // a written folder: its own and its descendants' listings are read again, the parent's too, nothing else
    await seed();
    invalidatePath("/my-files/a");
    e = readIndex().entries[0];
    assert.deepEqual(Object.keys(e.listed), ["/my-files/b"]);
    assert.equal(e.nodes.length, 8, "the folder's cached contents stay as the baseline of the next diff");
  });

  it("a write at the walk root, and a write above it, are handled (everything re-listed / entry dropped)", async () => {
    await seed();
    invalidatePath("/my-files");
    assert.deepEqual(readIndex().entries[0].listed, {});
    assert.equal(readIndex().entries[0].nodes.length, 8);
    await seed();
    invalidatePath("/");
    assert.equal(readIndex(), undefined, "an ancestor of the root removes the entry (and the empty file)");
  });

  it("a write unrelated to the saved root leaves the file untouched", async () => {
    await seed();
    invalidatePath("/trash");
    assert.equal(readIndex().entries[0].nodes.length, 8);
    assert.equal(Object.keys(readIndex().entries[0].listed).length, 4);
  });

  it("works on the loaded copy too: after a write the in-memory index no longer serves the written path", async () => {
    await seed();
    const t = small();
    const { svc, calls } = makeSvc(t);
    await walkTree(svc, "/my-files"); // served from the saved index, which is now loaded in memory
    t["/my-files/b"] = [];
    invalidatePath("/my-files/b/z.txt");
    calls.length = 0;
    const r = await walkTree(svc, "/my-files");
    assert.ok(!paths(r).includes("/my-files/b/z.txt"));
    assert.deepEqual(calls, ["/my-files/b"], "only the parent of the written node is listed again");
  });

  it("changes:true after an in-session write reports only the real delta, not the whole subtree", async () => {
    await seed();
    const t = small();
    t["/my-files/a"] = [folder("deep"), file("x.txt", 20), file("new.txt", 3)]; // the write: an upload into a
    const { svc, calls } = makeSvc(t);
    await walkTree(svc, "/my-files"); // loads the saved index in this process
    invalidatePath("/my-files/a/new.txt");
    calls.length = 0;
    const out = await driveRefreshIndex(svc, { changes: true, timeBudgetMs: 5000, maxAgeHours: 1 });
    assert.deepEqual([out.changes.added, out.changes.removed, out.changes.modified], [1, 0, 0]);
    assert.deepEqual(out.changes.samples.map((s) => `${s.kind}:${s.path}`), ["added:/my-files/a/new.txt"]);
    assert.equal(out.foldersRefreshed, 1, "only the parent folder is listed again");
    assert.equal(calls.filter((c) => c !== "/my-files").length, 1);
    assert.equal(out.entries, 9);
  });
});

describe("review fixes: applying listings", () => {
  it("an item moved to another folder appears only at its new path while the old parent's listing is reused", async () => {
    await seed();
    ageListed({ "/my-files": 2 * HOUR, "/my-files/b": 2 * HOUR }); // a is young: its saved listing still has x.txt and deep
    const t = small();
    t["/my-files/a"] = [folder("deep"), file("x.txt", 20)];
    t["/my-files/b"] = [file("z.txt", 7), file("x.txt", 20, { uid: "f-x.txt" }), folder("deep", "d-deep")];
    t["/my-files/b/deep"] = [file("y.txt", 10)];
    const r = await slice(makeSvc(t).svc);
    assert.equal(r.complete, true);
    assert.deepEqual(paths(r).filter((p) => p.endsWith("x.txt")), ["/my-files/b/x.txt"]);
    assert.deepEqual(paths(r).filter((p) => p.includes("deep")), ["/my-files/b/deep", "/my-files/b/deep/y.txt"]);
    await flushWalkIndexForTests();
    const saved = readIndex().entries[0];
    assert.deepEqual(Object.keys(saved.listed).sort(), ["/my-files", "/my-files/a", "/my-files/b", "/my-files/b/deep"]);
  });

  it("a listing result for a folder that was dropped meanwhile is not applied", async () => {
    await seed();
    ageListed({ "/my-files/a/deep": 3 * HOUR, "/my-files": 2 * HOUR });
    const t = small();
    t["/my-files"] = [folder("b"), folder(".git"), file("root.txt")]; // a is gone
    const { svc } = makeSlowSvc(t, { "/my-files/a/deep": 150, "/my-files": 10 });
    const r = await slice(svc, { concurrency: 2 });
    assert.deepEqual(paths(r).filter((p) => p.startsWith("/my-files/a")), []);
    await flushWalkIndexForTests();
    assert.deepEqual(Object.keys(readIndex().entries[0].listed).sort(), ["/my-files", "/my-files/b"], "no resurrected listing for the dropped folder");
  });

  it("a listing that arrives late does not move an item back to its old folder", async () => {
    await seed();
    ageListed({ "/my-files/a": 3 * HOUR, "/my-files/b": 2 * HOUR }); // a is listed first, then b; the root stays young
    const t = small();
    t["/my-files/a"] = [folder("deep"), file("x.txt", 20)]; // read before the move happened
    t["/my-files/b"] = [file("z.txt", 7), file("x.txt", 20)]; // read after it (b is quick, a is slow)
    const { svc } = makeSlowSvc(t, { "/my-files/a": 150 });
    const r = await slice(svc, { concurrency: 2 });
    assert.deepEqual(paths(r).filter((p) => p.endsWith("x.txt")), ["/my-files/b/x.txt"]);
    await flushWalkIndexForTests();
    const saved = readIndex().entries[0];
    assert.deepEqual(saved.nodes.filter((n) => n.path.endsWith("x.txt")).map((n) => n.path), ["/my-files/b/x.txt"]);
  });

  it("a listing time in the future (the clock moved back) counts as old", async () => {
    await seed();
    const f = readIndex();
    f.entries[0].listed["/my-files/b"] = Date.now() + 10 * HOUR;
    assert.equal(writeIndex(f), "ok");
    assert.equal(readIndex().entries[0].listed["/my-files/b"], 0, "read back as old");
    const { svc, calls } = makeSvc(small());
    const r = await slice(svc);
    assert.equal(r.foldersRefreshed, 1);
    assert.equal(count(calls, "/my-files/b"), 1);
  });
});

describe("review fixes: time budget", () => {
  const wide = () => {
    const t = { "/my-files": Array.from({ length: 10 }, (_, i) => folder(`f${i}`)) };
    for (let i = 0; i < 10; i++) t[`/my-files/f${i}`] = [file("a")];
    return t;
  };

  it("stops issuing new listings after ~70% of the budget", async () => {
    const delays = { "/my-files": 400 };
    for (let i = 0; i < 10; i++) delays[`/my-files/f${i}`] = 400;
    const { svc, calls } = makeSlowSvc(wide(), delays);
    const t0 = Date.now();
    const r = await slice(svc, { budgetMs: 1000, concurrency: 1 });
    // root 0-400, f0 400-800; at 800 ms (>= 700) nothing new starts. Without the soft stop f1 would start and end at 1200.
    assert.equal(calls.length, 2);
    assert.ok(Date.now() - t0 < 1000, "finished inside the budget");
    assert.equal(r.partial, true);
    assert.equal(r.budgetOverrunMs, undefined);
  });

  it("reports budgetOverrunMs when an already started listing runs past the budget (also through drive_refresh_index)", async () => {
    const { svc } = makeSlowSvc(wide(), { "/my-files": 1500 });
    const out = await driveRefreshIndex(svc, { timeBudgetMs: 1000 });
    assert.ok(out.budgetOverrunMs >= 400 && out.budgetOverrunMs < 1500, `overrun ${out.budgetOverrunMs}`);
    assert.equal(out.complete, false);
  });
});
