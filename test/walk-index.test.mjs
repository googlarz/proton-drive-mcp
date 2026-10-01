// walkTree + persistent index (stale-while-revalidate) against an injected runner.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriveService } from "../dist/services/drive.js";
import { walkTree, invalidatePath, resetWalkCacheForTests, flushWalkIndexForTests } from "../dist/services/walk.js";
import { driveSearch, driveTree } from "../dist/services/find.js";
import { readIndex, writeIndex, indexPath } from "../dist/services/walkIndex.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const folder = (name, i) => ({ uid: `d-${name}-${i}`, parentUid: "p", type: "folder", name: { ok: true, value: name } });
const file = (name, size) => ({
  uid: `f-${name}`, parentUid: "p", type: "file", name: { ok: true, value: name }, mediaType: "application/pdf",
  modificationTime: "2026-01-02T00:00:00.000Z", activeRevision: { claimedSize: size, storageSize: size + 100 },
});
function makeSvc(tree, { delay = 0 } = {}) {
  const calls = [];
  const runner = async (args) => {
    const path = args[2];
    calls.push(path);
    if (delay) await sleep(delay);
    const v = tree[path];
    if (v === undefined) throw new Error(`Node not found: ${path}`);
    return typeof v === "function" ? v(path, calls) : v;
  };
  return { svc: new DriveService(runner), calls };
}
const small = (extra = []) => ({
  "/my-files": [folder("a", 1), folder("b", 2), folder(".git", 3), file("root.txt", 5), ...extra],
  "/my-files/a": [folder("deep", 4), file("x.pdf", 20)],
  "/my-files/a/deep": [file("y.pdf", 10)],
  "/my-files/b": [file("z.txt", 7)],
  "/my-files/.git": [file("HEAD", 1)],
});
const count = (calls, p) => calls.filter((c) => c === p).length;

/** Ages the persisted entries by `ms` so they look old. */
function ageDisk(ms) {
  const f = readIndex();
  for (const e of f.entries) e.completedAt -= ms;
  assert.equal(writeIndex(f), "ok");
}
/** A cold walk (persisted), then a "new process" (memory + loaded disk state dropped, file kept). */
async function seed(tree = small()) {
  const { svc } = makeSvc(tree);
  const r = await walkTree(svc, "/my-files");
  await flushWalkIndexForTests();
  assert.equal(r.fromCache, false);
  resetWalkCacheForTests();
}

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pdwalk-"));
  process.env.PROTON_DRIVE_INDEX = "1";
  process.env.PROTON_DRIVE_INDEX_DIR = join(tmp, "idx");
  delete process.env.PROTON_DRIVE_INDEX_MAX_AGE_H;
  delete process.env.PROTON_DRIVE_WALK_TTL_MS;
  resetWalkCacheForTests();
});
afterEach(async () => {
  await flushWalkIndexForTests();
  resetWalkCacheForTests();
  delete process.env.PROTON_DRIVE_INDEX;
  delete process.env.PROTON_DRIVE_INDEX_DIR;
  delete process.env.PROTON_DRIVE_INDEX_MAX_AGE_H;
  rmSync(tmp, { recursive: true, force: true });
});

describe("walk index: persistence", () => {
  it("persists a complete walk with the account fingerprint", async () => {
    await seed();
    const f = readIndex();
    assert.equal(f.accountKey, "p");
    assert.equal(f.entries.length, 1);
    assert.equal(f.entries[0].root, "/my-files");
    assert.equal(f.entries[0].nodes.length, 8);
  });

  it("does not persist incomplete walks", async () => {
    const t = small();
    t["/my-files/b"] = () => { throw new Error("boom"); };
    const { svc } = makeSvc(t);
    const r = await walkTree(svc, "/my-files");
    await flushWalkIndexForTests();
    assert.equal(r.complete, false);
    assert.equal(existsSync(indexPath()), false);
  });

  it("writes nothing when PROTON_DRIVE_INDEX is unset", async () => {
    delete process.env.PROTON_DRIVE_INDEX;
    const { svc } = makeSvc(small());
    await walkTree(svc, "/my-files");
    await flushWalkIndexForTests();
    assert.equal(existsSync(join(tmp, "idx")), false);
  });

  it("invalidatePath removes matching entries from the file", async () => {
    const { svc } = makeSvc(small());
    await walkTree(svc, "/my-files");
    await walkTree(svc, "/my-files/a/deep", { maxDepth: 1 });
    await flushWalkIndexForTests();
    assert.equal(readIndex().entries.length, 1); // deep is served from the /my-files walk; nothing new stored
    invalidatePath("/my-files/b");
    assert.equal(existsSync(indexPath()) ? readIndex().entries.length : 0, 0);
  });
});

describe("walk index: serving", () => {
  it("serves an old disk entry instantly (stale, refreshing) after one account check, with one background walk for 5 callers", async () => {
    await seed();
    ageDisk(3_600_000);
    const { svc, calls } = makeSvc(small([file("new.txt", 1)]), { delay: 30 });
    const rs = await Promise.all(Array.from({ length: 5 }, () => walkTree(svc, "/my-files")));
    for (const r of rs) {
      assert.equal(r.fromCache, true);
      assert.equal(r.stale, true);
      assert.equal(r.refreshing, true);
      assert.ok(r.ageMs >= 3_600_000);
      assert.equal(r.nodes.length, 8); // old data, no new.txt
    }
    assert.equal(calls[0], "/my-files"); // account check precedes serving
    await flushWalkIndexForTests();
    assert.equal(count(calls, "/my-files/a"), 1, "exactly one background walk");
    assert.equal(count(calls, "/my-files"), 2);
    const later = await walkTree(svc, "/my-files");
    assert.ok(!later.stale);
    assert.equal(later.fromCache, true);
    assert.equal(later.nodes.length, 9);
    assert.ok(later.ageMs < 60_000);
    assert.ok(Date.now() - readIndex().entries[0].completedAt < 60_000, "disk entry replaced");
  });

  it("serves an entry younger than the memory TTL as fresh, with no refresh", async () => {
    await seed();
    const { svc, calls } = makeSvc(small());
    const r = await walkTree(svc, "/my-files");
    await flushWalkIndexForTests();
    assert.equal(r.fromCache, true);
    assert.equal(r.stale, false);
    assert.ok(!r.refreshing);
    assert.deepEqual(calls, ["/my-files"]); // the account check only
  });

  it("keeps the stale entry when the background walk fails, and does not throw", async () => {
    await seed();
    ageDisk(3_600_000);
    const t = small();
    let n = 0;
    t["/my-files"] = () => { if (++n > 1) throw new Error("offline"); return small()["/my-files"]; };
    const { svc } = makeSvc(t);
    const r = await walkTree(svc, "/my-files");
    assert.equal(r.stale, true);
    await flushWalkIndexForTests();
    assert.equal(readIndex().entries[0].nodes.length, 8);
    const again = await walkTree(svc, "/my-files");
    assert.equal(again.stale, true);
    await flushWalkIndexForTests();
  });

  it("walks fresh when the entry is older than PROTON_DRIVE_INDEX_MAX_AGE_H", async () => {
    await seed();
    ageDisk(3 * 3_600_000);
    process.env.PROTON_DRIVE_INDEX_MAX_AGE_H = "2";
    const { svc } = makeSvc(small([file("new.txt", 1)]));
    const r = await walkTree(svc, "/my-files");
    assert.equal(r.fromCache, false);
    assert.equal(r.nodes.length, 9);
  });

  it("MAX_AGE_H=0 disables use of disk data", async () => {
    await seed();
    process.env.PROTON_DRIVE_INDEX_MAX_AGE_H = "0";
    const { svc, calls } = makeSvc(small());
    const r = await walkTree(svc, "/my-files");
    assert.equal(r.fromCache, false);
    assert.equal(count(calls, "/my-files"), 1); // no account check either
  });

  it("refresh:true bypasses disk data", async () => {
    await seed();
    ageDisk(3_600_000);
    const { svc, calls } = makeSvc(small([file("new.txt", 1)]));
    const r = await walkTree(svc, "/my-files", { refresh: true });
    assert.equal(r.fromCache, false);
    assert.ok(!r.stale);
    assert.equal(r.nodes.length, 9);
    assert.equal(count(calls, "/my-files"), 1);
  });

  it("an ancestor on disk answers a subfolder, but not an excluded folder (exclude rule)", async () => {
    await seed();
    ageDisk(3_600_000);
    const { svc } = makeSvc(small());
    const sub = await walkTree(svc, "/my-files/a");
    assert.equal(sub.fromCache, true);
    assert.equal(sub.stale, true);
    assert.deepEqual(sub.nodes.map((n) => n.path), ["/my-files/a/deep", "/my-files/a/deep/y.pdf", "/my-files/a/x.pdf"]);
    await flushWalkIndexForTests();
    resetWalkCacheForTests();
    const git = await walkTree(svc, "/my-files/.git");
    assert.equal(git.fromCache, false);
  });

  it("an account mismatch discards the file and walks fresh, checking first", async () => {
    await seed();
    ageDisk(3_600_000);
    const f = readIndex(); f.accountKey = "someone-else"; writeIndex(f);
    const { svc, calls } = makeSvc(small([file("new.txt", 1)]));
    const r = await walkTree(svc, "/my-files");
    assert.equal(r.fromCache, false);
    assert.equal(r.nodes.length, 9);
    assert.equal(calls[0], "/my-files");
    await flushWalkIndexForTests();
    assert.equal(readIndex().accountKey, "p"); // rewritten for the current account
  });

  it("a failed account check discards the disk index and walks fresh", async () => {
    await seed();
    ageDisk(3_600_000);
    const t = small();
    let n = 0;
    t["/my-files"] = () => { if (++n === 1) throw new Error("flaky"); return small()["/my-files"]; };
    const { svc } = makeSvc(t);
    const r = await walkTree(svc, "/my-files");
    assert.equal(r.fromCache, false);
    assert.ok(!r.stale);
  });

  it("a background walk superseded by invalidatePath is discarded", async () => {
    await seed();
    ageDisk(3_600_000);
    const { svc } = makeSvc(small([file("new.txt", 1)]), { delay: 20 });
    const r = await walkTree(svc, "/my-files");
    assert.equal(r.stale, true);
    invalidatePath("/my-files/b");
    await flushWalkIndexForTests();
    assert.equal(existsSync(indexPath()) ? readIndex().entries.length : 0, 0);
    const next = await walkTree(svc, "/my-files");
    assert.equal(next.fromCache, false);
  });

  it("drive_search and drive_tree surface stale and refreshing", async () => {
    await seed();
    ageDisk(3_600_000);
    const { svc } = makeSvc(small(), { delay: 5 });
    const found = await driveSearch(svc, { query: "pdf" });
    assert.equal(found.walk.stale, true);
    assert.equal(found.walk.refreshing, true);
    await flushWalkIndexForTests();
    await driveTree(svc, { path: "/my-files", depth: 5 }); // own key; a depth-cut walk is incomplete and never persisted
    await flushWalkIndexForTests();
    resetWalkCacheForTests();
    ageDisk(3_600_000);
    const tree = await driveTree(svc, { path: "/my-files", depth: 5 });
    assert.equal(tree.stale, true);
    assert.equal(tree.refreshing, true);
    await flushWalkIndexForTests();
  });
});
