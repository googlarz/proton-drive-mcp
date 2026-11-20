// computeCleanupPlan (src/services/cleanupRun.ts) against an injected runner: the re-plan after approval is a fresh walk and does not
// download verified files again (1.12.0 review fixes).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DriveService } from "../dist/services/drive.js";
import { resetWalkCacheForTests, abortBackgroundRefreshes, invalidatePath } from "../dist/services/walk.js";
import { computeCleanupPlan, memoHasher } from "../dist/services/cleanupRun.js";
import { planFingerprint } from "../dist/services/cleanup.js";

const item = (uid, parentUid, name, type, extra = {}) => ({
  uid, parentUid, type, name: { ok: true, value: name }, isShared: false, isSharedByUrl: false,
  ...(type === "file" ? { activeRevision: { claimedSize: extra.size ?? 5000, claimedModificationTime: extra.mtime ?? "2020-01-01T00:00:00Z", claimedDigests: { sha1: "S" } } } : {}),
});
const tree = () => ({
  "/my-files": [item("a", "root", "a", "folder"), item("b", "root", "b", "folder")],
  "/my-files/a": [item("x", "a", "x.bin", "file")],
  "/my-files/b": [item("y", "b", "y.bin", "file", { mtime: "2024-01-01T00:00:00Z" })],
  "/trash": [],
});
function makeSvc(t) {
  const calls = [];
  const svc = new DriveService(async (args) => {
    calls.push(args[2]);
    if (t[args[2]] === undefined) throw new Error(`Node not found: ${args[2]}`);
    return t[args[2]];
  });
  return { svc, calls };
}
beforeEach(() => { resetWalkCacheForTests(); invalidatePath("/"); });
afterEach(() => { abortBackgroundRefreshes(); resetWalkCacheForTests(); });

describe("computeCleanupPlan: the re-plan after approval", () => {
  it("walks again (a fresh walk of its own) but does not download verified files a second time", async () => {
    const t = tree();
    const { svc, calls } = makeSvc(t);
    const hashed = [];
    const hasher = async (n) => { hashed.push(n.path); return "digest"; };
    const memo = new Map();
    const first = await computeCleanupPlan(svc, { path: "/my-files", fixes: ["duplicates"], verify: true, hashMemo: memo, hasher });
    assert.ok(first.plan, JSON.stringify(first));
    assert.deepEqual(first.plan.items.map((i) => i.path), ["/my-files/b/y.bin"]);
    assert.deepEqual(hashed.sort(), ["/my-files/a/x.bin", "/my-files/b/y.bin"]);
    const listsOfA = () => calls.filter((c) => c === "/my-files/a").length;
    assert.equal(listsOfA(), 1);

    const again = await computeCleanupPlan(svc, { path: "/my-files", fixes: ["duplicates"], verify: true, hashMemo: memo, hasher });
    assert.equal(listsOfA(), 2, "the second plan listed the folders again");
    assert.equal(hashed.length, 2, "no second download: the memo answered");
    assert.equal(planFingerprint(again.plan), planFingerprint(first.plan));
  });

  it("a file that changed after the plan is hashed again, and the list differs", async () => {
    const t = tree();
    const { svc } = makeSvc(t);
    const hashed = [];
    const digests = { "/my-files/a/x.bin": "same", "/my-files/b/y.bin": "same" };
    const hasher = async (n) => { hashed.push(n.path); return digests[n.path]; };
    const memo = new Map();
    const first = await computeCleanupPlan(svc, { path: "/my-files", fixes: ["duplicates"], verify: true, hashMemo: memo, hasher });
    assert.equal(first.plan.items.length, 1);
    // y.bin is replaced by a new revision (new upload time) with other content, same size and claimed hash
    t["/my-files/b"] = [{ ...item("y", "b", "y.bin", "file", { mtime: "2024-01-01T00:00:00Z" }), modificationTime: "2026-11-19T10:00:00Z" }];
    digests["/my-files/b/y.bin"] = "other";
    const again = await computeCleanupPlan(svc, { path: "/my-files", fixes: ["duplicates"], verify: true, hashMemo: memo, hasher });
    assert.deepEqual(hashed.filter((p) => p === "/my-files/b/y.bin").length, 2, "the changed file was downloaded again");
    assert.equal(hashed.filter((p) => p === "/my-files/a/x.bin").length, 1, "the unchanged file was not");
    assert.equal(again.plan.items.length, 0, "no longer a verified duplicate");
  });

  it("R2-3: new content with the same size, times and claimed hash but another revision is hashed again", async () => {
    const withRev = (rev) => ({ ...item("y", "b", "y.bin", "file", { mtime: "2024-01-01T00:00:00Z" }), activeRevision: { uid: rev, creationTime: `t-${rev}`, claimedSize: 5000, claimedModificationTime: "2024-01-01T00:00:00Z", claimedDigests: { sha1: "S" } } });
    const t = tree();
    t["/my-files/b"] = [withRev("rev1")];
    const { svc } = makeSvc(t);
    const hashed = [];
    const digests = { "/my-files/a/x.bin": "same", "/my-files/b/y.bin": "same" };
    const hasher = async (n) => { hashed.push(n.path); return digests[n.path]; };
    const memo = new Map();
    const first = await computeCleanupPlan(svc, { path: "/my-files", fixes: ["duplicates"], verify: true, hashMemo: memo, hasher });
    assert.equal(first.plan.items.length, 1);
    // same listing again: answered from the memo
    await computeCleanupPlan(svc, { path: "/my-files", fixes: ["duplicates"], verify: true, hashMemo: memo, hasher });
    assert.equal(hashed.filter((p) => p === "/my-files/b/y.bin").length, 1);
    // someone uploads other content of the same size with the same claimed time and hash: only the revision differs
    t["/my-files/b"] = [withRev("rev2")];
    digests["/my-files/b/y.bin"] = "other";
    const again = await computeCleanupPlan(svc, { path: "/my-files", fixes: ["duplicates"], verify: true, hashMemo: memo, hasher });
    assert.equal(hashed.filter((p) => p === "/my-files/b/y.bin").length, 2, "downloaded and hashed again");
    assert.equal(again.plan.items.length, 0, "no longer a verified duplicate");
  });

  it("memoHasher keys on uid, path, size, times and claimed hash", async () => {
    let n = 0;
    const h = memoHasher(async () => `d${++n}`, new Map());
    const node = { uid: "u", path: "/p", size: 1, mtime: "t", uploadedAt: "u", sha1: "s", revisionId: "r|c" };
    assert.equal(await h(node), "d1");
    assert.equal(await h({ ...node }), "d1");
    assert.equal(await h({ ...node, size: 2 }), "d2");
    assert.equal(await h({ ...node, uploadedAt: "later" }), "d3");
    assert.equal(await h({ ...node, revisionId: "r2|c" }), "d4");
  });
});
