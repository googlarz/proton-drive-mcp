// walkTree / invalidatePath against an injected runner (no subprocess).
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DriveService } from "../dist/services/drive.js";
import { walkTree, invalidatePath } from "../dist/services/walk.js";
import { DriveNotAuthenticatedError } from "../dist/utils/errors.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const folder = (name, i) => ({ uid: `d-${name}-${i}`, parentUid: "p", type: "folder", name: { ok: true, value: name } });
const file = (name, size, extra = {}) => ({
  uid: `f-${name}`, parentUid: "p", type: "file", name: { ok: true, value: name }, mediaType: "application/pdf",
  modificationTime: "2026-01-02T00:00:00.000Z",
  activeRevision: { claimedSize: size, claimedModificationTime: "2025-05-05T00:00:00.000Z", storageSize: size + 100, claimedDigests: { sha1: "abc" } },
  ...extra,
});

/** tree: { "/my-files": [items], "/my-files/a": [items], ... } ; a function value is called per listing. */
function makeSvc(tree, { delay = 0 } = {}) {
  const stats = { calls: [], active: 0, maxActive: 0 };
  const runner = async (args) => {
    assert.deepEqual(args.slice(0, 2), ["filesystem", "list"]);
    const path = args[2];
    stats.calls.push(path);
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    try {
      if (delay) await sleep(delay);
      const v = tree[path];
      if (v === undefined) throw new Error(`Node not found: ${path}`);
      return typeof v === "function" ? v(path, stats) : v;
    } finally {
      stats.active--;
    }
  };
  return { svc: new DriveService(runner), stats };
}

const small = () => ({
  "/my-files": [folder("a", 1), folder("b", 2), folder(".git", 3), file("root.txt", 5)],
  "/my-files/a": [folder("deep", 4), file("x.pdf", 2_000_000)],
  "/my-files/a/deep": [file("y.pdf", 10)],
  "/my-files/b": [file("z.txt", 7)],
  "/my-files/.git": [file("HEAD", 1)],
});

beforeEach(() => { invalidatePath("/"); delete process.env.PROTON_DRIVE_WALK_TTL_MS; });

describe("walkTree", () => {
  it("collects every node with full metadata, excluding .git by default", async () => {
    const { svc, stats } = makeSvc(small());
    const r = await walkTree(svc, "/my-files");
    assert.equal(r.complete, true);
    assert.equal(r.fromCache, false);
    assert.equal(r.callsMade, 4); // root, a, deep, b (not .git)
    assert.ok(!stats.calls.includes("/my-files/.git"));
    assert.deepEqual(r.nodes.map((n) => n.path), ["/my-files/.git", "/my-files/a", "/my-files/a/deep", "/my-files/a/deep/y.pdf", "/my-files/a/x.pdf", "/my-files/b", "/my-files/b/z.txt", "/my-files/root.txt"]);
    const x = r.nodes.find((n) => n.path === "/my-files/a/x.pdf");
    assert.deepEqual(x, {
      path: "/my-files/a/x.pdf", uid: "f-x.pdf", parentUid: "p", type: "file", mediaType: "application/pdf",
      size: 2_000_000, storageSize: undefined, mtime: "2025-05-05T00:00:00.000Z", uploadedAt: "2026-01-02T00:00:00.000Z",
      sha1: "abc", isShared: undefined, isSharedByUrl: undefined,
    });
  });

  it("exclude: [] descends into .git; custom exclude skips named folders", async () => {
    let { svc, stats } = makeSvc(small());
    await walkTree(svc, "/my-files", { exclude: [] });
    assert.ok(stats.calls.includes("/my-files/.git"));
    invalidatePath("/");
    ({ svc, stats } = makeSvc(small()));
    await walkTree(svc, "/my-files", { exclude: ["b"] });
    assert.ok(!stats.calls.includes("/my-files/b") && stats.calls.includes("/my-files/.git"));
  });

  it("maxDepth stops descending and reports complete:false only when a folder was cut", async () => {
    const { svc, stats } = makeSvc(small());
    const r = await walkTree(svc, "/my-files", { maxDepth: 1 });
    assert.deepEqual(stats.calls, ["/my-files"]);
    assert.equal(r.complete, false);
    const r2 = await walkTree(svc, "/my-files/b", { maxDepth: 1 }); // no subfolders: nothing cut
    assert.equal(r2.complete, true);
  });

  it("never exceeds the concurrency bound, and uses it", async () => {
    const tree = { "/r": Array.from({ length: 30 }, (_, i) => folder(`f${i}`, i)) };
    for (let i = 0; i < 30; i++) tree[`/r/f${i}`] = [file(`a${i}`, 1)];
    for (const [concurrency, expected] of [[3, 3], [8, 8], [50, 12]]) {
      const { svc, stats } = makeSvc(tree, { delay: 15 });
      const r = await walkTree(svc, "/r", { concurrency, refresh: true });
      assert.equal(r.callsMade, 31);
      assert.equal(stats.maxActive, expected, `concurrency ${concurrency}`);
    }
  });

  it("maxCalls cuts the walk: complete:false, unlisted folders reported in skipped", async () => {
    const tree = { "/r": Array.from({ length: 10 }, (_, i) => folder(`f${i}`, i)) };
    for (let i = 0; i < 10; i++) tree[`/r/f${i}`] = [file(`a${i}`, 1)];
    const { svc } = makeSvc(tree);
    const r = await walkTree(svc, "/r", { maxCalls: 4, concurrency: 2 });
    assert.equal(r.callsMade, 4);
    assert.equal(r.complete, false);
    assert.equal(r.skipped.length, 7); // 10 folders, 3 listed after the root call
    assert.match(r.skipped[0].reason, /maxCalls/);
  });

  it("a failing folder is retried once, then reported in skipped; siblings still walked", async () => {
    const tree = small();
    let bCalls = 0;
    tree["/my-files/b"] = () => { bCalls++; throw new Error("database is locked"); };
    const { svc } = makeSvc(tree);
    const r = await walkTree(svc, "/my-files");
    assert.equal(bCalls, 2);
    assert.equal(r.complete, false);
    assert.deepEqual(r.skipped.map((s) => s.path), ["/my-files/b"]);
    assert.match(r.skipped[0].reason, /database is locked/);
    assert.ok(r.nodes.some((n) => n.path === "/my-files/a/deep/y.pdf"));
  });

  it("a folder that fails once then succeeds is fully walked", async () => {
    const tree = small();
    let n = 0;
    tree["/my-files/b"] = () => { if (n++ === 0) throw new Error("Request timed out"); return [file("z.txt", 7)]; };
    const { svc } = makeSvc(tree);
    const r = await walkTree(svc, "/my-files");
    assert.equal(r.complete, true);
    assert.deepEqual(r.skipped, []);
    assert.ok(r.nodes.some((x) => x.path === "/my-files/b/z.txt"));
  });

  it("a failing root rejects; an auth error rejects from anywhere and is not retried", async () => {
    const { svc } = makeSvc({});
    await assert.rejects(walkTree(svc, "/nope"), /not found/i);
    const tree = small();
    let calls = 0;
    tree["/my-files/a"] = () => { calls++; throw new DriveNotAuthenticatedError(); };
    await assert.rejects(walkTree(makeSvc(tree).svc, "/my-files"), DriveNotAuthenticatedError);
    assert.equal(calls, 1);
  });

  it("abort rejects promptly and stops issuing calls", async () => {
    const tree = { "/r": Array.from({ length: 20 }, (_, i) => folder(`f${i}`, i)) };
    for (let i = 0; i < 20; i++) tree[`/r/f${i}`] = [];
    const { svc, stats } = makeSvc(tree, { delay: 30 });
    const ac = new AbortController();
    const p = walkTree(svc, "/r", { signal: ac.signal, concurrency: 2 });
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p, /abort/i);
    const seen = stats.calls.length;
    await sleep(150);
    assert.equal(stats.calls.length, seen, "no new calls after abort settled");
    assert.ok(seen < 21);
    await assert.rejects(walkTree(svc, "/r", { signal: ac.signal }), /abort/i); // already aborted
  });

  it("caches: second call is served from cache; refresh re-walks", async () => {
    const { svc, stats } = makeSvc(small());
    await walkTree(svc, "/my-files");
    const n = stats.calls.length;
    const hit = await walkTree(svc, "/my-files");
    assert.equal(hit.fromCache, true);
    assert.equal(hit.callsMade, 0);
    assert.equal(stats.calls.length, n);
    assert.ok(hit.ageMs >= 0);
    const fresh = await walkTree(svc, "/my-files", { refresh: true });
    assert.equal(fresh.fromCache, false);
    assert.equal(stats.calls.length, 2 * n);
  });

  it("cache entries expire after PROTON_DRIVE_WALK_TTL_MS", async () => {
    process.env.PROTON_DRIVE_WALK_TTL_MS = "40";
    const { svc, stats } = makeSvc(small());
    await walkTree(svc, "/my-files");
    const n = stats.calls.length;
    await sleep(80);
    const r = await walkTree(svc, "/my-files");
    assert.equal(r.fromCache, false);
    assert.equal(stats.calls.length, 2 * n);
  });

  it("a subfolder walk is served from a complete ancestor walk, respecting depth", async () => {
    const { svc, stats } = makeSvc(small());
    await walkTree(svc, "/my-files");
    const n = stats.calls.length;
    const sub = await walkTree(svc, "/my-files/a");
    assert.equal(sub.fromCache, true);
    assert.deepEqual(sub.nodes.map((x) => x.path), ["/my-files/a/deep", "/my-files/a/deep/y.pdf", "/my-files/a/x.pdf"]);
    const shallow = await walkTree(svc, "/my-files/a", { maxDepth: 1 });
    assert.deepEqual(shallow.nodes.map((x) => x.path), ["/my-files/a/deep", "/my-files/a/x.pdf"]);
    assert.equal(shallow.complete, false);
    assert.equal(stats.calls.length, n);
  });

  it("an excluded folder is never answered from an ancestor walk that skipped it", async () => {
    const tree = { ...small(), "/my-files/a/node_modules": [file("pkg.js", 3)] };
    tree["/my-files/a"] = [...tree["/my-files/a"], folder("node_modules", 9)];
    const { svc, stats } = makeSvc(tree);
    await walkTree(svc, "/my-files"); // excludes .git and node_modules
    const n = stats.calls.length;
    const r = await walkTree(svc, "/my-files/a/node_modules");
    assert.equal(r.fromCache, false);
    assert.deepEqual(r.nodes.map((x) => x.path), ["/my-files/a/node_modules/pkg.js"]);
    assert.ok(stats.calls.length > n);
    const below = await walkTree(svc, "/my-files/.git", { refresh: false });
    assert.deepEqual(below.nodes.map((x) => x.path), ["/my-files/.git/HEAD"]);
  });

  it("a depth-limited or partial ancestor walk does not answer a deeper request", async () => {
    const { svc, stats } = makeSvc(small());
    await walkTree(svc, "/my-files", { maxDepth: 1 });
    const n = stats.calls.length;
    const r = await walkTree(svc, "/my-files/a");
    assert.equal(r.fromCache, false);
    assert.ok(stats.calls.length > n);
  });

  it("invalidatePath drops walks rooted at an ancestor or descendant, keeps unrelated ones", async () => {
    const { svc, stats } = makeSvc(small());
    await walkTree(svc, "/my-files/a", { refresh: true });
    await walkTree(svc, "/my-files/b", { refresh: true });
    invalidatePath("/my-files/a/deep/new.txt"); // ancestor /my-files/a is dropped
    const n = stats.calls.length;
    assert.equal((await walkTree(svc, "/my-files/b")).fromCache, true);
    assert.equal((await walkTree(svc, "/my-files/a")).fromCache, false);
    assert.ok(stats.calls.length > n);
    await walkTree(svc, "/my-files/a/deep");
    invalidatePath("/my-files/a"); // descendant root /my-files/a/deep is dropped too
    assert.equal((await walkTree(svc, "/my-files/a/deep")).fromCache, false);
  });

  it("DriveService writes invalidate cached walks", async () => {
    const tree = { ...small(), "/trash": [] };
    const writes = [];
    const runner = async (args) => {
      if (args[1] === "list") return tree[args[2]];
      writes.push(args[1]);
      return args[1] === "upload" ? { transferredItems: 1, skippedItems: 0, failedItems: 0 } : [];
    };
    const svc = new DriveService(runner);
    const cases = [
      () => svc.mkdir("/my-files/a/new"),
      () => svc.upload("/tmp/x", "/my-files/a"),
      () => svc.rename("/my-files/a/x.pdf", "q.pdf"),
      () => svc.move("/my-files/a/x.pdf", "/my-files/b/x.pdf"),
      () => svc.copy("/my-files/a/x.pdf", "/my-files/b"),
      () => svc.trash("/my-files/a/x.pdf"),
      () => svc.restore("/trash/x.pdf"),
    ];
    for (const write of cases) {
      await walkTree(svc, "/my-files", { refresh: true });
      assert.equal((await walkTree(svc, "/my-files")).fromCache, true);
      await write().catch((e) => { throw new Error(`${write}: ${e.message}`); });
      assert.equal((await walkTree(svc, "/my-files")).fromCache, false, String(write));
    }
    // Permanent delete acts on the trash, not on live walks.
    await walkTree(svc, "/trash", { refresh: true });
    await svc.delete("/trash/x.pdf");
    assert.equal((await walkTree(svc, "/trash")).fromCache, false);
  });

  it("a failing write still invalidates (it may have half-applied)", async () => {
    const tree = { ...small(), "/trash": [] };
    const runner = async (args) => {
      if (args[1] === "list") return tree[args[2]];
      throw new Error("boom");
    };
    const svc = new DriveService(runner);
    const cases = [
      () => svc.mkdir("/my-files/a/new"),
      () => svc.upload("/tmp/x", "/my-files/a"),
      () => svc.rename("/my-files/a/x.pdf", "q.pdf"),
      () => svc.copy("/my-files/a/x.pdf", "/my-files/b"),
      () => svc.trash("/my-files/a/x.pdf"),
      () => svc.bulkTrash(["/my-files/a/x.pdf"]),
      () => svc.restore("/trash/x.pdf"),
      () => svc.delete("/trash/x.pdf"),
      () => svc.emptyTrash(),
    ];
    for (const write of cases) {
      await walkTree(svc, "/my-files", { refresh: true });
      await walkTree(svc, "/trash", { refresh: true });
      await assert.rejects(write());
      const live = (await walkTree(svc, "/my-files")).fromCache;
      const trash = (await walkTree(svc, "/trash")).fromCache;
      assert.ok(!live || !trash, String(write)); // at least the affected walk was dropped
      if (/trash|restore|delete|emptyTrash/.test(String(write))) assert.equal(trash, false, String(write));
      if (!/delete|emptyTrash/.test(String(write))) assert.equal(live, false, String(write));
    }
  });

  it("trashing an item also drops cached /trash walks", async () => {
    const tree = { ...small(), "/trash": [] };
    const svc = new DriveService(async (args) => (args[1] === "list" ? tree[args[2]] : []));
    await walkTree(svc, "/trash", { refresh: true });
    assert.equal((await walkTree(svc, "/trash")).fromCache, true);
    await svc.trash("/my-files/a/x.pdf");
    assert.equal((await walkTree(svc, "/trash")).fromCache, false);
  });
});
