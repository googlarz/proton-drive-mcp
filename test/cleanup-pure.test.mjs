import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planCleanup, planFingerprint, summarizeForDialog, planSamples, TRASH_NAME_REASON } from "../dist/services/cleanup.js";
import { keeperOf, findDuplicateCandidates } from "../dist/services/analytics.js";

const ROOT = "/my-files";
const parentOf = (p) => { for (let i = p.length - 1; i > 0; i--) if (p[i] === "/" && p[i - 1] !== "\\") return p.slice(0, i); return "/"; };
const nameOf = (p) => p.slice(parentOf(p).length + (parentOf(p) === "/" ? 0 : 1)).replace(/\\\//g, "/");
const uidOf = (p) => "u:" + p;
const SHA = "a".repeat(40);
const node = (type, path, extra = {}) => ({
  path, uid: uidOf(path), parentUid: parentOf(path) === ROOT ? "u:root" : uidOf(parentOf(path)), type,
  isShared: false, isSharedByUrl: false, ...extra,
});
const file = (path, size = 5000, extra = {}) => node("file", path, { size, sha1: SHA, mtime: "2024-01-01T00:00:00.000Z", ...extra });
const dir = (path, extra = {}) => node("folder", path, extra);
const run = (nodes, extra = {}) => planCleanup({
  nodes, rootPath: ROOT, fixes: ["duplicates", "empty-folders"], trashNames: new Map(), complete: true, rootShared: false, ...extra,
});
const paths = (r) => r.items.map((i) => i.path);

// ---- seeded PRNG for the property tests ----
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const shuffle = (arr, r) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

describe("planCleanup refusals", () => {
  const n = [file(`${ROOT}/a.bin`), file(`${ROOT}/b.bin`)];
  it("refuses an incomplete walk", () => {
    const r = run(n, { complete: false });
    assert.equal(r.ok, false);
    assert.match(r.reason, /incomplete/);
  });
  it("refuses when something under the path was skipped", () => {
    const r = run(n, { skippedUnderPath: true });
    assert.equal(r.ok, false);
    assert.match(r.reason, /skipped/);
  });
  it("refuses stale or partial data", () => {
    const r = run(n, { stale: true });
    assert.equal(r.ok, false);
    assert.match(r.reason, /stale/);
  });
  it("refuses no fixes, unknown fixes and a bad cap", () => {
    assert.equal(run(n, { fixes: [] }).ok, false);
    assert.equal(run(n, { fixes: ["everything"] }).ok, false);
    assert.equal(run(n, { cap: 0 }).ok, false);
    assert.equal(run(n, { cap: 1.5 }).ok, false);
  });
  it("only runs the requested fix", () => {
    const nodes = [dir(`${ROOT}/empty`), file(`${ROOT}/a.bin`), file(`${ROOT}/b.bin`)];
    assert.deepEqual(paths(run(nodes, { fixes: ["empty-folders"] })), [`${ROOT}/empty`]);
    assert.deepEqual(paths(run(nodes, { fixes: ["duplicates"] })), [`${ROOT}/b.bin`]);
  });
});

describe("duplicates (no download)", () => {
  it("keeps the oldest copy and lists the others with their keeper", () => {
    const nodes = [
      file(`${ROOT}/new.bin`, 5000, { mtime: "2025-01-01T00:00:00.000Z" }),
      file(`${ROOT}/old.bin`, 5000, { mtime: "2020-01-01T00:00:00.000Z" }),
      file(`${ROOT}/mid.bin`, 5000, { mtime: "2022-01-01T00:00:00.000Z" }),
    ];
    const r = run(nodes);
    assert.equal(r.ok, true);
    assert.deepEqual(r.items.map((i) => [i.path, i.keeps, i.kind, i.size, i.name]), [
      [`${ROOT}/mid.bin`, `${ROOT}/old.bin`, "duplicate", 5000, "mid.bin"],
      [`${ROOT}/new.bin`, `${ROOT}/old.bin`, "duplicate", 5000, "new.bin"],
    ]);
    assert.deepEqual(r.counts, { duplicates: 2, emptyFolders: 0 });
    assert.equal(r.bytes, 10000);
    assert.equal(r.remaining, 0);
    assert.deepEqual(r.skipped, []);
    assert.equal(r.items[0].uid, uidOf(`${ROOT}/mid.bin`));
    assert.equal(r.items[0].parentUid, "u:root");
  });

  it("ties on time go to the shortest path (the existing keeperOf)", () => {
    const nodes = [file(`${ROOT}/sub/long-name.bin`), file(`${ROOT}/x.bin`), dir(`${ROOT}/sub`, {})];
    // the dir has no files of its own below, but sub holds a file, so it is not empty
    const r = run(nodes);
    assert.deepEqual(paths(r), [`${ROOT}/sub/long-name.bin`]);
    assert.equal(r.items[0].keeps, `${ROOT}/x.bin`);
  });

  it("matches keeperOf exactly", () => {
    const g = findDuplicateCandidates([file(`${ROOT}/q/a.bin`), file(`${ROOT}/b.bin`, 5000, { mtime: "2019-05-05T00:00:00.000Z" }), file(`${ROOT}/c.bin`)], 1)[0];
    const r = run([...g.members, dir(`${ROOT}/q`)]);
    assert.ok(r.items.every((i) => i.keeps === keeperOf(g.members).path));
  });

  it("ignores files under minSize and files without a size", () => {
    const small = [file(`${ROOT}/a.bin`, 10), file(`${ROOT}/b.bin`, 10)];
    assert.deepEqual(paths(run(small)), []);
    assert.deepEqual(paths(run(small, { minSize: 1 })), [`${ROOT}/b.bin`]);
  });

  it("a forged sha1 in a shared folder with an older date is not eligible without verify", () => {
    const nodes = [
      dir(`${ROOT}/team`, { isShared: true }),
      file(`${ROOT}/team/forged.bin`, 5000, { mtime: "2001-01-01T00:00:00.000Z" }),
      file(`${ROOT}/mine.bin`, 5000, { mtime: "2024-01-01T00:00:00.000Z" }),
    ];
    const r = run(nodes);
    assert.deepEqual(paths(r), []);
    assert.deepEqual(r.skipped, [{ count: 1, reason: "needs verify: shared, in a shared folder or link, or share status unknown" }]);
  });

  it("with verify the forged copy is not in any verified group, so the real file is never trashed", () => {
    const forged = file(`${ROOT}/team/forged.bin`, 5000, { mtime: "2001-01-01T00:00:00.000Z" });
    const mine = file(`${ROOT}/mine.bin`, 5000, { mtime: "2024-01-01T00:00:00.000Z" });
    const nodes = [dir(`${ROOT}/team`, { isShared: true }), forged, mine];
    const r = run(nodes, { verifiedGroups: [] });
    assert.deepEqual(paths(r), []);
  });

  it("a verified group in a shared folder is eligible and keeps the oldest verified member", () => {
    const a = file(`${ROOT}/team/a.bin`, 5000, { mtime: "2021-01-01T00:00:00.000Z" });
    const b = file(`${ROOT}/mine.bin`, 5000, { mtime: "2024-01-01T00:00:00.000Z" });
    const nodes = [dir(`${ROOT}/team`, { isShared: true }), a, b];
    const r = run(nodes, { verifiedGroups: [{ kind: "verified", members: [a, b] }] });
    assert.deepEqual(r.items.map((i) => [i.path, i.keeps]), [[`${ROOT}/mine.bin`, `${ROOT}/team/a.bin`]]);
  });

  it("a file shared by link, or in a folder shared by link, needs verify", () => {
    const viaLink = [file(`${ROOT}/a.bin`, 5000, { isSharedByUrl: true }), file(`${ROOT}/b.bin`)];
    assert.deepEqual(paths(run(viaLink)), []);
    const viaFolder = [dir(`${ROOT}/d`, { isSharedByUrl: true }), dir(`${ROOT}/d/e`), file(`${ROOT}/d/e/a.bin`), file(`${ROOT}/b.bin`)];
    assert.deepEqual(paths(run(viaFolder)), []);
  });

  it("a shared root (or an unknown rootShared) makes every group need verify", () => {
    const nodes = [file(`${ROOT}/a.bin`), file(`${ROOT}/b.bin`)];
    assert.deepEqual(paths(run(nodes, { rootShared: true })), []);
    const { rootShared, ...noRoot } = { rootShared: undefined };
    assert.deepEqual(paths(planCleanup({ nodes, rootPath: ROOT, fixes: ["duplicates"], trashNames: new Map(), complete: true })), []);
    assert.equal(rootShared, undefined);
    assert.ok(noRoot);
  });

  it("missing share flags (nothing known) count as unknown, not as unshared", () => {
    const bare = (p) => { const n = file(p); delete n.isShared; delete n.isSharedByUrl; return n; };
    assert.deepEqual(paths(run([bare(`${ROOT}/a.bin`), bare(`${ROOT}/b.bin`)])), []);
  });

  it("a broken parent chain is not provably unshared", () => {
    const orphan = file(`${ROOT}/deep/sub/a.bin`, 5000, { parentUid: "u:nowhere" });
    assert.deepEqual(paths(run([orphan, file(`${ROOT}/b.bin`)])), []);
  });

  it("same-size groups and groups with different sizes are not provably identical", () => {
    const sameSize = [file(`${ROOT}/a.bin`, 5000, { sha1: undefined, mediaType: "x/y" }), file(`${ROOT}/b.bin`, 5000, { sha1: undefined, mediaType: "x/y" })];
    const r1 = run(sameSize);
    assert.deepEqual(paths(r1), []);
    assert.deepEqual(r1.skipped, [{ count: 1, reason: "needs verify: not provably identical" }]);
    const diffSize = [file(`${ROOT}/a.bin`, 5000), file(`${ROOT}/b.bin`, 6000)];
    assert.deepEqual(paths(run(diffSize)), []);
  });

  it("a group with a member outside the path is skipped", () => {
    const r = run([file(`${ROOT}/in/a.bin`), file(`/my-files-other/b.bin`), dir(`${ROOT}/in`)], { rootPath: `${ROOT}/in` });
    assert.deepEqual(paths(r), []);
    assert.deepEqual(r.skipped, [{ count: 1, reason: "outside the cleanup path" }]);
  });

  it("works for a sub-folder root and never lists the root itself", () => {
    const nodes = [dir(`${ROOT}/sub`), file(`${ROOT}/sub/a.bin`), file(`${ROOT}/sub/b.bin`), file(`${ROOT}/c.bin`, 5000, { sha1: "9".repeat(40) })];
    const r = run(nodes, { rootPath: `${ROOT}/sub/` });
    assert.deepEqual(paths(r), [`${ROOT}/sub/b.bin`]);
    const empty = run([dir(`${ROOT}/sub`)], { rootPath: `${ROOT}/sub` });
    assert.deepEqual(paths(empty), []);
  });
});

describe("verify mode", () => {
  const a = file(`${ROOT}/a.bin`, 5000, { sha1: "1".repeat(40), mtime: "2020-01-01T00:00:00.000Z" });
  const b = file(`${ROOT}/b.bin`, 5000, { sha1: "1".repeat(40), mtime: "2021-01-01T00:00:00.000Z" });
  const c = file(`${ROOT}/c.bin`, 5000, { sha1: "1".repeat(40), mtime: "2022-01-01T00:00:00.000Z" });
  const nodes = [a, b, c];

  it("uses only verified groups: a claimed group whose member did not verify is not trashed", () => {
    // a and b verified equal; c has a forged sha1 and fell out of the group
    const r = run(nodes, { verifiedGroups: [{ kind: "verified", members: [a, b] }] });
    assert.deepEqual(r.items.map((i) => [i.path, i.keeps]), [[`${ROOT}/b.bin`, `${ROOT}/a.bin`]]);
  });

  it("drops unverified entries (verify note, claimed kind) and reports them", () => {
    const r = run(nodes, { verifiedGroups: [{ kind: "claimed-sha1", members: [a, b, c], verifyNote: "skipped: verify budget reached" }] });
    assert.deepEqual(paths(r), []);
    assert.equal(r.skipped[0].count, 2);
    assert.match(r.skipped[0].reason, /not verified/);
  });

  it("drops a verified group that no longer matches the current listing", () => {
    const changed = { ...b, size: 5001 };
    for (const grp of [[a, changed], [a, { ...b, sha1: "2".repeat(40) }], [a, { ...b, uid: "u:gone" }], [a, { ...b, path: `${ROOT}/moved.bin` }]]) {
      const r = run(nodes, { verifiedGroups: [{ kind: "verified", members: grp }] });
      assert.deepEqual(paths(r), []);
      assert.match(r.skipped[0].reason, /no longer matches/);
    }
  });

  it("members come from the walk, not from the caller's objects", () => {
    const fake = { ...b, parentUid: "u:evil" };
    const r = run(nodes, { verifiedGroups: [{ kind: "verified", members: [a, fake] }] });
    assert.equal(r.items[0].parentUid, "u:root");
  });

  it("verified groups are still limited to the path", () => {
    const out = file(`/my-files-other/z.bin`, 5000, { sha1: "1".repeat(40) });
    const r = run([a, out, dir(`${ROOT}/x`)], { verifiedGroups: [{ kind: "verified", members: [a, out] }] });
    assert.deepEqual(r.items.filter((i) => i.kind === "duplicate"), []);
  });

  it("verify mode still proposes empty folders", () => {
    const r = run([dir(`${ROOT}/e`), a, b], { verifiedGroups: [] });
    assert.deepEqual(paths(r), [`${ROOT}/e`]);
  });
});

describe("empty folders", () => {
  it("proposes a folder with no children", () => {
    const r = run([dir(`${ROOT}/e`), dir(`${ROOT}/full`), file(`${ROOT}/full/x.txt`, 10)]);
    assert.deepEqual(r.items.map((i) => [i.path, i.kind, i.size, i.keeps]), [[`${ROOT}/e`, "empty-folder", 0, undefined]]);
    assert.deepEqual(r.counts, { duplicates: 0, emptyFolders: 1 });
  });

  it("nested empty folders: only the topmost", () => {
    const r = run([dir(`${ROOT}/a`), dir(`${ROOT}/a/b`), dir(`${ROOT}/a/b/c`), dir(`${ROOT}/z`)]);
    assert.deepEqual(paths(r), [`${ROOT}/a`, `${ROOT}/z`]);
  });

  it("never a folder that contains a non-empty item, but empty children of it are proposed", () => {
    const r = run([dir(`${ROOT}/a`), dir(`${ROOT}/a/b`), dir(`${ROOT}/a/b/c`), file(`${ROOT}/a/b/f.txt`, 3), dir(`${ROOT}/a/e1`), dir(`${ROOT}/a/e2`)]);
    assert.deepEqual(paths(r), [`${ROOT}/a/b/c`, `${ROOT}/a/e1`, `${ROOT}/a/e2`]);
  });

  it("a folder the walk did not open (excluded name) is never empty and keeps its parents", () => {
    const nodes = [dir(`${ROOT}/repo`), dir(`${ROOT}/repo/.git`), dir(`${ROOT}/nm`), dir(`${ROOT}/nm/node_modules`), dir(`${ROOT}/real`)];
    assert.deepEqual(paths(run(nodes)), [`${ROOT}/real`]);
    // walked with exclude: [] means the names are not special
    assert.deepEqual(paths(run(nodes, { exclude: [] })), [`${ROOT}/nm`, `${ROOT}/repo`, `${ROOT}/real`].sort());
  });

  it("children are found by path even when parentUid is missing", () => {
    const x = file(`${ROOT}/a/x.txt`, 3);
    delete x.parentUid;
    assert.deepEqual(paths(run([dir(`${ROOT}/a`), x])), []);
  });

  it("children are found by parentUid even when the path looks elsewhere", () => {
    const x = file(`${ROOT}/other/x.txt`, 3, { parentUid: uidOf(`${ROOT}/a`) });
    assert.ok(!paths(run([dir(`${ROOT}/a`), dir(`${ROOT}/other`), x])).includes(`${ROOT}/a`));
  });

  it("a parentUid cycle never counts as empty", () => {
    const a = dir(`${ROOT}/a`, { parentUid: uidOf(`${ROOT}/b`) });
    const b = dir(`${ROOT}/b`, { parentUid: uidOf(`${ROOT}/a`) });
    assert.deepEqual(paths(run([a, b])), []);
  });

  it("the root itself is never proposed, nor anything outside it", () => {
    const r = run([dir(ROOT), dir(`/my-files-other/e`), dir(`/photos/e`)]);
    assert.deepEqual(paths(r), []);
  });

  it("shared folders, folders in shared folders and folders holding shared ones are left for a manual decision", () => {
    const nodes = [
      dir(`${ROOT}/s`, { isShared: true }),
      dir(`${ROOT}/p`), dir(`${ROOT}/p/q`, { isSharedByUrl: true }), dir(`${ROOT}/p/ok`),
      dir(`${ROOT}/t`, { isShared: true }), dir(`${ROOT}/t/inner`),
      dir(`${ROOT}/plain`),
    ];
    const r = run(nodes);
    assert.deepEqual(paths(r), [`${ROOT}/p/ok`, `${ROOT}/plain`]);
    assert.deepEqual(r.skipped, [{ count: 4, reason: "shared, in a shared folder or link, or share status unknown (left for a manual decision)" }]);
  });

  it("a shared root blocks every empty folder", () => {
    assert.deepEqual(paths(run([dir(`${ROOT}/e`)], { rootShared: true })), []);
  });
});

describe("trash name collisions", () => {
  it("leaves out an item whose name is already in /trash", () => {
    const nodes = [file(`${ROOT}/a.bin`), file(`${ROOT}/x/b.bin`), file(`${ROOT}/c.bin`), dir(`${ROOT}/x`), dir(`${ROOT}/old`)];
    const r = run(nodes, { trashNames: new Map([["b.bin", 1], ["old", 2], ["zero", 0]]) });
    assert.deepEqual(paths(r), [`${ROOT}/c.bin`]);
    assert.deepEqual(r.skipped, [{ count: 2, reason: TRASH_NAME_REASON }]);
    assert.equal(TRASH_NAME_REASON, "name already in trash (not reliably restorable)");
  });

  it("a trash count of 0 is not a collision", () => {
    const r = run([file(`${ROOT}/a.bin`), file(`${ROOT}/b.bin`)], { trashNames: new Map([["b.bin", 0]]) });
    assert.deepEqual(paths(r), [`${ROOT}/b.bin`]);
  });

  it("leaves out items of the same batch that share a name, including across kinds", () => {
    const nodes = [
      file(`${ROOT}/a.bin`, 5000, { mtime: "2020-01-01T00:00:00.000Z" }),
      file(`${ROOT}/d1/copy.bin`, 5000), file(`${ROOT}/d2/copy.bin`, 5000), file(`${ROOT}/solo.bin`, 5000),
      dir(`${ROOT}/d1`), dir(`${ROOT}/d2`),
      dir(`${ROOT}/e1`), file(`${ROOT}/e1/other.txt`, 3), dir(`${ROOT}/e1/solo.bin`),
    ];
    const r = run(nodes);
    // d1/copy.bin and d2/copy.bin collide; solo.bin (file) collides with the empty folder e1/solo.bin
    assert.deepEqual(paths(r), []);
    assert.deepEqual(r.skipped, [{ count: 4, reason: TRASH_NAME_REASON }]);
  });

  it("matches on the unescaped name", () => {
    const r = run([file(`${ROOT}/a.bin`), file(`${ROOT}/we\\/ird.bin`)], { trashNames: new Map([["we/ird.bin", 1]]) });
    assert.deepEqual(paths(r), []);
    assert.equal(run([file(`${ROOT}/a.bin`), file(`${ROOT}/we\\/ird.bin`)]).items[0].name, "we/ird.bin");
  });

  it("a keeper's name colliding with trash does not matter", () => {
    const r = run([file(`${ROOT}/a.bin`, 5000, { mtime: "2020-01-01T00:00:00.000Z" }), file(`${ROOT}/b.bin`)], { trashNames: new Map([["a.bin", 3]]) });
    assert.deepEqual(paths(r), [`${ROOT}/b.bin`]);
  });
});

describe("cap, remaining and determinism", () => {
  const many = (n) => {
    const nodes = [file(`${ROOT}/keep.bin`, 5000, { mtime: "2000-01-01T00:00:00.000Z" })];
    for (let i = 0; i < n; i++) nodes.push(file(`${ROOT}/copy-${String(i).padStart(4, "0")}.bin`, 5000));
    return nodes;
  };

  it("defaults to 200 items and reports what is left", () => {
    const r = run(many(250));
    assert.equal(r.items.length, 200);
    assert.equal(r.remaining, 50);
    assert.equal(r.counts.duplicates, 200);
    assert.equal(r.bytes, 200 * 5000);
  });

  it("honours a smaller cap and continues once the first page is gone", () => {
    const nodes = many(7);
    const first = run(nodes, { cap: 3 });
    assert.equal(first.items.length, 3);
    assert.equal(first.remaining, 4);
    const gone = new Set(first.items.map((i) => i.uid));
    const second = run(nodes.filter((n) => !gone.has(n.uid)), { cap: 3 });
    assert.equal(second.items.length, 3);
    assert.equal(second.remaining, 1);
    assert.ok(second.items.every((i) => !gone.has(i.uid)));
    assert.ok(second.items.every((i) => i.keeps === `${ROOT}/keep.bin`));
  });

  it("items are ordered by path", () => {
    const r = run(many(30));
    const p = paths(r);
    assert.deepEqual(p, [...p].sort());
  });

  it("the same input in any order gives the same plan", () => {
    const base = many(40).concat([dir(`${ROOT}/z/e/f`), dir(`${ROOT}/z/e`), dir(`${ROOT}/z`)]);
    const expected = JSON.stringify(run(base, { cap: 15 }));
    const r = rng(7);
    for (let i = 0; i < 25; i++) assert.equal(JSON.stringify(run(shuffle(base, r), { cap: 15 })), expected);
  });

  it("ties on date and length are broken by path in every order", () => {
    const trio = [file(`${ROOT}/b/x.bin`), file(`${ROOT}/a/x.bin`), file(`${ROOT}/c/x.bin`)];
    const r = rng(3);
    const keeps = new Set();
    for (let i = 0; i < 12; i++) { const p = run([...shuffle(trio, r), dir(`${ROOT}/a`), dir(`${ROOT}/b`), dir(`${ROOT}/c`)]); keeps.add(p.items[0]?.keeps); }
    assert.equal(keeps.size, 1);
  });
});

describe("fingerprint and dialog lines", () => {
  const nodes = [
    file(`${ROOT}/a.bin`, 5000, { mtime: "2020-01-01T00:00:00.000Z" }), file(`${ROOT}/b.bin`), dir(`${ROOT}/e`),
  ];

  it("is stable for the same plan, whatever the input order", () => {
    const r = rng(11);
    const f = planFingerprint(run(nodes));
    assert.match(f, /^[0-9a-f]{64}$/);
    for (let i = 0; i < 10; i++) assert.equal(planFingerprint(run(shuffle(nodes, r))), f);
  });

  it("changes when any field of any item changes", () => {
    const plan = run(nodes);
    const f = planFingerprint(plan);
    for (const [k, v] of [["path", "/my-files/zz"], ["uid", "other"], ["parentUid", "p2"], ["name", "n2"], ["size", 1], ["kind", "empty-folder"], ["keeps", "/my-files/q"]]) {
      const items = plan.items.map((i, idx) => (idx === 0 ? { ...i, [k]: v } : i));
      assert.notEqual(planFingerprint({ ...plan, items }), f, k);
    }
    assert.notEqual(planFingerprint({ ...plan, items: plan.items.slice(1) }), f);
    assert.notEqual(planFingerprint({ ...plan, items: [...plan.items, plan.items[0]] }), f);
    assert.notEqual(planFingerprint({ ...plan, items: [...plan.items].reverse() }), f);
  });

  it("changes when the drive changes between plan and apply", () => {
    const before = planFingerprint(run(nodes));
    assert.notEqual(planFingerprint(run([...nodes, file(`${ROOT}/c.bin`)])), before); // a new duplicate
    assert.notEqual(planFingerprint(run(nodes.filter((n) => n.path !== `${ROOT}/e`))), before); // folder gone
    assert.notEqual(planFingerprint(run([...nodes, file(`${ROOT}/e/new.txt`, 3)])), before); // file added to the "empty" folder
  });

  it("does not depend on skipped or remaining", () => {
    const plan = run(nodes);
    assert.equal(planFingerprint({ ...plan, remaining: 99, skipped: [{ count: 1, reason: "x" }] }), planFingerprint(plan));
  });

  it("dialog lines are raw and show the kept copy on every duplicate line", () => {
    const evil = [file(`${ROOT}/a\n(keeps \\/x).bin`, 5000, { mtime: "2020-01-01T00:00:00.000Z" }), file(`${ROOT}/b‮.bin`), dir(`${ROOT}/e`)];
    const lines = summarizeForDialog(run(evil));
    assert.deepEqual(lines, [`${ROOT}/b‮.bin  (keeps ${ROOT}/a\n(keeps \\/x).bin)`, `${ROOT}/e  (empty folder)`]);
  });

  it("samples are capped at 10", () => {
    const nodes2 = [file(`${ROOT}/keep.bin`, 5000, { mtime: "2000-01-01T00:00:00.000Z" })];
    for (let i = 0; i < 25; i++) nodes2.push(file(`${ROOT}/c${String(i).padStart(2, "0")}.bin`));
    const plan = run(nodes2);
    assert.equal(planSamples(plan).length, 10);
    assert.equal(planSamples(plan)[0], `trash ${ROOT}/c00.bin (keeps ${ROOT}/keep.bin)`);
    assert.equal(summarizeForDialog(plan).length, 25);
  });
});

// ---- property tests over random trees ----
function makeTree(r) {
  const nodes = [];
  const folders = [ROOT];
  const sharedPaths = new Set(); // folders or files flagged shared / shared by link
  let n = 0;
  const flag = (extra, p) => {
    const roll = r();
    if (roll < 0.08) { extra.isShared = true; sharedPaths.add(p); }
    else if (roll < 0.12) { extra.isSharedByUrl = true; sharedPaths.add(p); }
  };
  const nFolders = 1 + Math.floor(r() * 9);
  for (let i = 0; i < nFolders; i++) {
    const parent = folders[Math.floor(r() * folders.length)];
    const name = r() < 0.07 ? ".git" : `dir${n++}`;
    const p = `${parent}/${name}`;
    const extra = {};
    flag(extra, p);
    nodes.push(dir(p, extra));
    folders.push(p);
  }
  const pool = 1 + Math.floor(r() * 4);
  const nFiles = Math.floor(r() * 16);
  for (let i = 0; i < nFiles; i++) {
    const parent = folders[Math.floor(r() * folders.length)];
    if (parent !== ROOT && parent.endsWith("/.git")) continue; // excluded folders are never opened
    const k = Math.floor(r() * pool);
    const nameRoll = r();
    const name = nameRoll < 0.3 ? `same${k}.bin` : `f${n++}.bin`; // some copies share a name
    const p = `${parent}/${name}`;
    if (nodes.some((x) => x.path === p)) continue;
    const extra = { sha1: String(k).repeat(40).slice(0, 40), size: 2000 + k * 10, mtime: [`2020-01-01T00:00:00.000Z`, `2021-06-01T00:00:00.000Z`, undefined][Math.floor(r() * 3)] };
    if (r() < 0.06) extra.size += 1; // a forged or odd size inside a claimed group
    if (r() < 0.05) delete extra.sha1; // falls into the same-size bucket
    flag(extra, p);
    nodes.push(file(p, extra.size, extra));
  }
  // excluded folders have no children in the walk: drop anything below .git
  return { nodes: nodes.filter((x) => !x.path.includes("/.git/")), sharedPaths };
}
const isSharedPath = (sharedPaths, p) => { for (const s of sharedPaths) if (p === s || p.startsWith(s + "/")) return true; return false; };

function oracle(nodes, sharedPaths, trashNames, { verified }) {
  const filesUnder = (f) => nodes.some((x) => x.type === "file" && x.path.startsWith(f + "/"));
  const gitUnder = (f) => nodes.some((x) => x.type === "folder" && x.path.startsWith(f + "/") && x.path.endsWith("/.git"));
  const effEmpty = (f) => !f.endsWith("/.git") && !filesUnder(f) && !gitUnder(f);
  const exp = new Map(); // path -> keeps
  const keepers = new Set();
  const groupsOut = [];
  const cands = findDuplicateCandidates(nodes, 1024);
  for (const g of cands) {
    const k = keeperOf(g.members);
    keepers.add(k.path);
    groupsOut.push({ members: g.members.map((m) => m.path), keeper: k.path });
    if (verified) continue;
    const ok = g.kind === "claimed-sha1" && g.members.every((m) => m.size === g.members[0].size) && g.members.every((m) => !isSharedPath(sharedPaths, m.path));
    if (ok) for (const m of g.members) if (m.path !== k.path) exp.set(m.path, k.path);
  }
  const folders = nodes.filter((x) => x.type === "folder");
  const childFolders = (f) => folders.filter((x) => parentOf(x.path) === f);
  const subtreeShared = (f) => isSharedPath(sharedPaths, f) || nodes.some((x) => x.path.startsWith(f + "/") && isSharedPath(sharedPaths, x.path));
  const propose = (f) => {
    if (!subtreeShared(f)) { exp.set(f, undefined); return; }
    if (!isSharedPath(sharedPaths, f)) for (const c of childFolders(f)) propose(c.path);
  };
  for (const f of folders) if (effEmpty(f.path) && (parentOf(f.path) === ROOT || !effEmpty(parentOf(f.path)))) propose(f.path);
  const nameCount = new Map();
  for (const p of exp.keys()) nameCount.set(nameOf(p), (nameCount.get(nameOf(p)) ?? 0) + 1);
  const finalExp = new Map([...exp].filter(([p]) => nameCount.get(nameOf(p)) === 1 && !(trashNames.get(nameOf(p)) > 0)));
  return { expected: finalExp, groups: groupsOut, keepers };
}

describe("property: random trees", () => {
  const N = 400;

  it(`${N} seeded trees: keepers never listed, every group keeps one member, output matches an independent oracle`, () => {
    let withDup = 0, withEmpty = 0, withShared = 0, withSkippedShared = 0;
    for (let seed = 1; seed <= N; seed++) {
      const r = rng(seed * 7919);
      const { nodes, sharedPaths } = makeTree(r);
      const trashNames = new Map();
      for (const x of nodes) if (r() < 0.07) trashNames.set(nameOf(x.path), 1);
      const input = shuffle(nodes, r);
      const plan = run(input, { trashNames, cap: 1000 });
      assert.equal(plan.ok, true, `seed ${seed}`);
      const { expected, groups, keepers } = oracle(nodes, sharedPaths, trashNames, { verified: false });

      // exact match with the independent oracle
      assert.deepEqual(new Map(plan.items.map((i) => [i.path, i.keeps])), expected, `seed ${seed}`);
      // invariants, independent of the oracle
      const uids = plan.items.map((i) => i.uid);
      assert.equal(new Set(uids).size, uids.length, `seed ${seed}: uid twice`);
      for (const i of plan.items) {
        assert.ok(i.path.startsWith(ROOT + "/"), `seed ${seed}: outside`);
        assert.ok(!keepers.has(i.path), `seed ${seed}: keeper listed ${i.path}`);
        assert.equal(i.uid, uidOf(i.path));
      }
      for (const g of groups) {
        const listed = g.members.filter((m) => plan.items.some((i) => i.path === m));
        assert.ok(listed.length <= g.members.length - 1, `seed ${seed}: group emptied`);
        assert.ok(!listed.includes(g.keeper), `seed ${seed}: keeper in list`);
        for (const m of listed) assert.equal(plan.items.find((i) => i.path === m).keeps, g.keeper);
      }
      const dups = plan.items.filter((i) => i.kind === "duplicate");
      const empties = plan.items.filter((i) => i.kind === "empty-folder");
      for (const e of empties) {
        assert.ok(!nodes.some((x) => x.type === "file" && x.path.startsWith(e.path + "/")), `seed ${seed}: folder with files`);
        assert.ok(!empties.some((o) => o !== e && e.path.startsWith(o.path + "/")), `seed ${seed}: nested empty folder listed`);
        assert.ok(!isSharedPath(sharedPaths, e.path), `seed ${seed}: shared folder listed`);
      }
      for (const d of dups) assert.ok(!isSharedPath(sharedPaths, d.path), `seed ${seed}: shared duplicate listed without verify`);
      if (dups.length) withDup++;
      if (empties.length) withEmpty++;
      if (sharedPaths.size) withShared++;
      if (plan.skipped.some((s) => /shared/.test(s.reason))) withSkippedShared++;
    }
    // the generator really exercises the interesting cases
    assert.ok(withDup > 100 && withEmpty > 100 && withShared > 100 && withSkippedShared > 20, JSON.stringify({ withDup, withEmpty, withShared, withSkippedShared }));
  });

  it(`${N} seeded trees in verify mode: only verified members, keeper of the verified group stays`, () => {
    for (let seed = 1; seed <= N; seed++) {
      const r = rng(seed * 104729);
      const { nodes, sharedPaths } = makeTree(r);
      // pretend verification: split each claimed group at random into "verified" subgroups
      const verifiedGroups = [];
      for (const g of findDuplicateCandidates(nodes, 1024)) {
        const buckets = new Map();
        for (const m of g.members) { const b = Math.floor(r() * 2); buckets.set(b, [...(buckets.get(b) ?? []), m]); }
        for (const b of buckets.values()) if (b.length > 1) verifiedGroups.push({ kind: "verified", members: b });
      }
      const plan = run(shuffle(nodes, r), { verifiedGroups: shuffle(verifiedGroups, r), cap: 1000 });
      assert.equal(plan.ok, true);
      const listed = new Set(plan.items.filter((i) => i.kind === "duplicate").map((i) => i.path));
      for (const g of verifiedGroups) {
        const k = keeperOf(g.members).path;
        assert.ok(!listed.has(k), `seed ${seed}: keeper listed`);
        const inList = g.members.filter((m) => listed.has(m.path));
        assert.ok(inList.length <= g.members.length - 1, `seed ${seed}: verified group emptied`);
        for (const m of inList) assert.equal(plan.items.find((i) => i.path === m.path).keeps, k);
      }
      // nothing outside a verified group is ever listed as a duplicate
      const inVerified = new Set(verifiedGroups.flatMap((g) => g.members.map((m) => m.path)));
      for (const p of listed) assert.ok(inVerified.has(p), `seed ${seed}: ${p} not verified`);
      void sharedPaths;
    }
  });

  it("random caps: pages are a prefix of the full plan and remaining adds up", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const r = rng(seed * 31337);
      const { nodes } = makeTree(r);
      const full = run(nodes, { cap: 1000 });
      const cap = 1 + Math.floor(r() * 6);
      const page = run(nodes, { cap });
      assert.deepEqual(page.items, full.items.slice(0, cap));
      assert.equal(page.remaining, Math.max(0, full.items.length - cap));
      assert.equal(page.counts.duplicates + page.counts.emptyFolders, page.items.length);
    }
  });
});
