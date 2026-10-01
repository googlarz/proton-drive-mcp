// Walk time budget: partial results, shared in-flight walk, background completion.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriveService } from "../dist/services/drive.js";
import { walkTree, invalidatePath, abortBackgroundRefreshes, resetWalkCacheForTests, flushWalkIndexForTests } from "../dist/services/walk.js";
import { readIndex } from "../dist/services/walkIndex.js";
import { driveSearch, driveTree } from "../dist/services/find.js";
import { driveUsage, driveFindDuplicates, driveSharingAudit } from "../dist/services/analytics.js";
import { syncPlan } from "../dist/services/plan.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const folder = (name) => ({ uid: `d-${name}`, parentUid: "p", type: "folder", name: { ok: true, value: name } });
const file = (name) => ({
  uid: `f-${name}`, parentUid: "p", type: "file", name: { ok: true, value: name }, mediaType: "text/plain",
  modificationTime: "2026-01-02T00:00:00.000Z", activeRevision: { claimedSize: 5, claimedModificationTime: "2025-05-05T00:00:00.000Z" },
});

/** root -> n folders, each holding one file. Every listing takes `delay` ms. */
function makeSvc(n, delay) {
  const stats = { calls: [], active: 0, maxActive: 0 };
  const names = Array.from({ length: n }, (_, i) => `f${i + 1}`);
  const runner = async (args) => {
    const path = args[2];
    stats.calls.push(path);
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    try {
      await sleep(delay);
      if (path === "/my-files") return names.map(folder);
      return [file(`${path.split("/").pop()}.txt`)];
    } finally {
      stats.active--;
    }
  };
  return { svc: new DriveService(runner), stats };
}

beforeEach(() => { resetWalkCacheForTests(); delete process.env.PROTON_DRIVE_WALK_BUDGET_MS; delete process.env.PROTON_DRIVE_WALK_TTL_MS; });
afterEach(async () => { abortBackgroundRefreshes(); await flushWalkIndexForTests(); resetWalkCacheForTests(); });

// 6 folders at concurrency 1, 160 ms each: root done at 160, f1 at 320, f2 at 480 ... full walk ~1120 ms.
// Budget 400 ms falls between f1 and f2 with ~80 ms margin on both sides (slow CI runners still pass).
const opts = (extra = {}) => ({ concurrency: 1, budgetMs: 400, ...extra });

describe("walk time budget", () => {
  it("returns a partial result at the budget, finishes in the background, then serves the full walk from cache", async () => {
    const { svc, stats } = makeSvc(6, 160);
    const t0 = Date.now();
    const r = await walkTree(svc, "/my-files", opts());
    assert.ok(Date.now() - t0 < 900, "returned at the budget, not after the full walk");
    assert.equal(r.partial, true);
    assert.equal(r.continuing, true);
    assert.equal(r.complete, false);
    assert.equal(r.fromCache, false);
    assert.ok(r.nodes.length > 0 && r.nodes.length < 12);
    assert.ok(r.skipped.length > 0);
    assert.ok(r.skipped.every((s) => s.reason === "not listed yet: time budget"));
    assert.ok(r.skipped.some((s) => s.path === "/my-files/f6"));
    assert.ok(!r.skipped.some((s) => s.path === "/my-files/f1")); // already listed

    await flushWalkIndexForTests();
    assert.equal(stats.calls.length, 7); // one walk, no restart
    const full = await walkTree(svc, "/my-files", opts());
    assert.equal(full.fromCache, true);
    assert.equal(full.complete, true);
    assert.equal(full.partial, undefined);
    assert.equal(full.nodes.length, 12);
    assert.equal(stats.calls.length, 7);
  });

  it("is not partial when the walk finishes inside the budget", async () => {
    const { svc } = makeSvc(2, 5);
    const r = await walkTree(svc, "/my-files", { budgetMs: 1000 });
    assert.equal(r.complete, true);
    assert.equal(r.partial, undefined);
    assert.equal(r.continuing, undefined);
  });

  it("two callers during one in-flight walk share it", async () => {
    const { svc, stats } = makeSvc(6, 160);
    const [a, b] = await Promise.all([walkTree(svc, "/my-files", opts()), walkTree(svc, "/my-files", opts())]);
    assert.equal(a.partial, true);
    assert.equal(b.partial, true);
    // a third caller joins the same walk later and still gets the budgeted treatment
    const c = await walkTree(svc, "/my-files", opts());
    assert.equal(c.fromCache, false);
    await flushWalkIndexForTests();
    assert.equal(stats.calls.length, 7);
  });

  it("budgetMs 0 waits for the full walk; a joiner with budget 0 waits for the walk another caller left running", async () => {
    const { svc, stats } = makeSvc(6, 160);
    const partial = await walkTree(svc, "/my-files", opts());
    assert.equal(partial.partial, true);
    const full = await walkTree(svc, "/my-files", opts({ budgetMs: 0 }));
    assert.equal(full.complete, true);
    assert.equal(full.partial, undefined);
    assert.equal(full.nodes.length, 12);
    assert.equal(stats.calls.length, 7);
  });

  it("a partial result is never cached or persisted as complete", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pdbudget-"));
    process.env.PROTON_DRIVE_INDEX = "1";
    process.env.PROTON_DRIVE_INDEX_DIR = join(tmp, "idx");
    try {
      const { svc } = makeSvc(6, 160);
      const r = await walkTree(svc, "/my-files", opts());
      assert.equal(r.partial, true);
      assert.equal(readIndex(), undefined, "nothing on disk while the walk is unfinished");
      const again = await walkTree(svc, "/my-files", opts()); // still in flight: shared, still partial
      assert.equal(again.fromCache, false);
      assert.equal(again.partial, true);
      await flushWalkIndexForTests();
      const f = readIndex();
      assert.equal(f.entries.length, 1);
      assert.equal(f.entries[0].nodes.length, 12);
    } finally {
      delete process.env.PROTON_DRIVE_INDEX;
      delete process.env.PROTON_DRIVE_INDEX_DIR;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a caller abort before the budget expires cancels the walk", async () => {
    const { svc, stats } = makeSvc(6, 160);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(new Error("caller gave up")), 200);
    await assert.rejects(walkTree(svc, "/my-files", opts({ budgetMs: 1000, signal: ctl.signal })), /caller gave up/);
    const n = stats.calls.length;
    await sleep(600);
    assert.equal(stats.calls.length, n, "the walk stopped listing");
    assert.ok(n < 7);
  });

  it("one of two waiters aborting does not cancel the shared walk", async () => {
    const { svc, stats } = makeSvc(4, 120);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(new Error("one gave up")), 160);
    const [x, y] = await Promise.allSettled([
      walkTree(svc, "/my-files", { concurrency: 1, budgetMs: 0, signal: ctl.signal }),
      walkTree(svc, "/my-files", { concurrency: 1, budgetMs: 0 }),
    ]);
    assert.equal(x.status, "rejected");
    assert.equal(y.status, "fulfilled");
    assert.equal(y.value.complete, true);
    assert.equal(stats.calls.length, 5);
  });

  it("a caller abort after a partial was returned does not kill the background walk", async () => {
    const { svc, stats } = makeSvc(6, 160);
    const ctl = new AbortController();
    const r = await walkTree(svc, "/my-files", opts({ signal: ctl.signal }));
    assert.equal(r.partial, true);
    ctl.abort(new Error("late cancel"));
    await flushWalkIndexForTests();
    assert.equal(stats.calls.length, 7);
    assert.equal((await walkTree(svc, "/my-files", opts())).fromCache, true);
  });

  it("shutdown stops the background walk and caches nothing", async () => {
    const { svc, stats } = makeSvc(6, 160);
    const r = await walkTree(svc, "/my-files", opts());
    assert.equal(r.partial, true);
    abortBackgroundRefreshes();
    await flushWalkIndexForTests();
    const n = stats.calls.length;
    await sleep(480);
    assert.equal(stats.calls.length, n);
    assert.ok(n < 7);
    resetWalkCacheForTests();
    assert.equal((await walkTree(svc, "/my-files", opts({ budgetMs: 0 }))).fromCache, false);
  });

  it("invalidatePath during the background walk prevents caching the stale tree", async () => {
    const { svc, stats } = makeSvc(6, 160);
    const r = await walkTree(svc, "/my-files", opts());
    assert.equal(r.partial, true);
    invalidatePath("/my-files/f1");
    await flushWalkIndexForTests();
    const before = stats.calls.length;
    const next = await walkTree(svc, "/my-files", opts({ budgetMs: 0 }));
    assert.equal(next.fromCache, false);
    assert.equal(next.complete, true);
    assert.ok(stats.calls.length > before, "a fresh walk was made");
  });

  it("an invalidation while a caller still waits does not cache that walk's result", async () => {
    const { svc } = makeSvc(3, 120);
    const p = walkTree(svc, "/my-files", { concurrency: 1, budgetMs: 0 });
    await sleep(80);
    invalidatePath("/my-files/f1");
    const r = await p;
    assert.equal(r.complete, true);
    assert.equal((await walkTree(svc, "/my-files", { concurrency: 1, budgetMs: 0 })).fromCache, false);
  });

  it("PROTON_DRIVE_WALK_BUDGET_MS sets the default and the surface says so", async () => {
    process.env.PROTON_DRIVE_WALK_BUDGET_MS = "100";
    const { svc } = makeSvc(40, 30);
    const out = await driveSearch(svc, { path: "/my-files" });
    assert.equal(out.walk.partial, true);
    assert.equal(out.walk.complete, false);
    assert.match(out.walk.note, /^Partial: the drive walk was still running after 0\.1 s; repeat the call in a minute for the full result\.$/);
    const tree = await driveTree(svc, { path: "/my-files" });
    assert.equal(tree.partial, true);
    assert.match(tree.note, /^Partial:/);
    assert.equal(tree.complete, false);
    await flushWalkIndexForTests();
  });

  it("concurrency never exceeds 12 and defaults to 12", async () => {
    const { svc, stats } = makeSvc(40, 10);
    await walkTree(svc, "/my-files", { concurrency: 50, budgetMs: 0 });
    assert.equal(stats.maxActive, 12);
    resetWalkCacheForTests();
    const b = makeSvc(40, 10);
    await walkTree(b.svc, "/my-files", { budgetMs: 0 });
    assert.equal(b.stats.maxActive, 12);
  });
});

describe("which tools wait for a complete walk", () => {
  const w = (extra = {}) => ({ root: "/my-files", nodes: [], complete: true, callsMade: 1, skipped: [], fromCache: false, ageMs: 0, ...extra });
  const capture = (extra) => { const seen = []; const fn = async (_s, _p, o) => { seen.push(o); return w(extra); }; fn.seen = seen; return fn; };
  const svc = new DriveService(async () => []);

  it("sharing audit and duplicates pass budgetMs 0", async () => {
    const a = capture();
    await driveSharingAudit(svc, { path: "/my-files" }, { walk: a, status: async () => ({}) });
    assert.equal(a.seen[0].budgetMs, 0);
    const d = capture();
    await driveFindDuplicates(svc, { path: "/my-files" }, { walk: d });
    assert.equal(d.seen[0].budgetMs, 0);
  });

  it("sync plan passes budgetMs 0", async () => {
    const p = capture();
    const dir = mkdtempSync(join(tmpdir(), "pdplan-"));
    try {
      await syncPlan(svc, { localPath: dir, drivePath: "/my-files" }, p);
      assert.equal(p.seen[0].budgetMs, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("usage keeps the default budget and labels a partial walk", async () => {
    const u = capture({ partial: true, continuing: true, complete: false, budgetMs: 25_000 });
    const out = await driveUsage(svc, { path: "/my-files" }, { walk: u, now: Date.now() });
    assert.equal(u.seen[0].budgetMs, undefined);
    assert.equal(out.partial, true);
    assert.match(out.note, /still running after 25 s/);
  });
});
