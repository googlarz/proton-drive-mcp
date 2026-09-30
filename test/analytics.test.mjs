import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  summarizeUsage, summarizeTrash, findDuplicateCandidates, verifyGroups, makeDriveHasher,
  auditShareStatus, driveUsage, driveFindDuplicates, driveSharingAudit,
} from "../dist/services/analytics.js";
import { DriveService } from "../dist/services/drive.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-30T00:00:00Z");
const f = (path, size, extra = {}) => ({ path, uid: "u" + path, type: "file", size, ...extra });
const d = (path, extra = {}) => ({ path, uid: "u" + path, type: "folder", ...extra });
const walkOf = (nodes, extra = {}) => ({ root: "/my-files", nodes, complete: true, callsMade: 1, skipped: [], fromCache: false, ageMs: 0, ...extra });
const fakeWalk = (nodes, extra) => async () => walkOf(nodes, extra);

describe("summarizeUsage", () => {
  it("handles an empty tree", () => {
    const r = summarizeUsage(walkOf([]), { top: 5, now: NOW });
    assert.deepEqual(r.totals, { files: 0, folders: 0, bytes: 0 });
    assert.deepEqual(r.largestFiles, []);
    assert.deepEqual(r.largestFolders, []);
    assert.equal(r.olderThan, undefined);
  });

  it("totals, ranks, rolls folders up and breaks down by extension/mediaType", () => {
    const nodes = [
      d("/my-files/a"), d("/my-files/a/b"), d("/my-files/c"),
      f("/my-files/a/b/x.PDF", 300, { mediaType: "application/pdf" }),
      f("/my-files/a/y.pdf", 100, { mediaType: "application/pdf" }),
      f("/my-files/c/z.txt", 50),
      f("/my-files/noext", 50),
      f("/my-files/dot.d/w.bin", 10),
    ];
    const r = summarizeUsage(walkOf(nodes), { top: 2, now: NOW });
    assert.deepEqual(r.totals, { files: 5, folders: 3, bytes: 510 });
    assert.deepEqual(r.largestFiles.map((x) => x.path), ["/my-files/a/b/x.PDF", "/my-files/a/y.pdf"]);
    assert.deepEqual(r.largestFolders[0], { path: "/my-files/a", bytes: 400, files: 2 });
    assert.deepEqual(r.largestFolders[1], { path: "/my-files/a/b", bytes: 300, files: 1 });
    assert.deepEqual(r.byExtension[0], { ext: "pdf", count: 2, bytes: 400 });
    assert.deepEqual(r.byMediaType[0], { mediaType: "application/pdf", count: 2, bytes: 400 });
    assert.equal(r.complete, true);
  });

  it("breaks ties deterministically by path and keeps a folder with an escaped slash as one folder", () => {
    const nodes = [f("/my-files/b", 5), f("/my-files/a", 5), f("/my-files/p\\/q/r", 7)];
    const r = summarizeUsage(walkOf(nodes), { top: 10, now: NOW });
    assert.deepEqual(r.largestFiles.map((x) => x.path), ["/my-files/p\\/q/r", "/my-files/a", "/my-files/b"]);
    assert.deepEqual(r.largestFolders, [{ path: "/my-files/p\\/q", bytes: 7, files: 1 }]);
  });

  it("olderThan uses mtime, falls back to uploadedAt, and counts undated files separately", () => {
    const iso = (days) => new Date(NOW - days * DAY).toISOString();
    const nodes = [
      f("/my-files/old", 100, { mtime: iso(400) }),
      f("/my-files/fallback", 10, { uploadedAt: iso(400) }),
      f("/my-files/mtime-wins", 1, { mtime: iso(1), uploadedAt: iso(900) }),
      f("/my-files/undated", 1000),
    ];
    const r = summarizeUsage(walkOf(nodes), { top: 5, olderThanDays: 365, now: NOW });
    assert.equal(r.olderThan.count, 2);
    assert.equal(r.olderThan.bytes, 110);
    assert.equal(r.olderThan.undated, 1);
    assert.deepEqual(r.olderThan.largest.map((x) => x.path), ["/my-files/old", "/my-files/fallback"]);
  });

  it("labels a partial walk", () => {
    const r = summarizeUsage(walkOf([], { complete: false, skipped: [{ path: "/my-files/x", reason: "maxCalls" }] }), { top: 1, now: NOW });
    assert.equal(r.complete, false);
    assert.equal(r.skippedCount, 1);
  });
});

describe("summarizeTrash", () => {
  it("counts, sums and finds the oldest trash time", () => {
    const r = summarizeTrash([
      { name: "a", path: "/trash/a", type: "file", size: 10, trashedAt: "2026-09-02T00:00:00Z" },
      { name: "b", path: "/trash/b", type: "folder", trashedAt: "2026-09-01T00:00:00Z" },
      { name: "c", path: "/trash/c", type: "file", size: 5 },
    ]);
    assert.deepEqual(r, { count: 3, bytes: 15, oldestTrashedAt: "2026-09-01T00:00:00Z" });
    assert.deepEqual(summarizeTrash([]), { count: 0, bytes: 0, oldestTrashedAt: undefined });
  });
});

describe("findDuplicateCandidates", () => {
  it("groups by claimed sha1, and sha1-less files by size+mediaType", () => {
    const nodes = [
      f("/my-files/a1", 2000, { sha1: "AA" }), f("/my-files/a2", 2000, { sha1: "aa" }), f("/my-files/a3", 2000, { sha1: "bb" }),
      f("/my-files/s1", 3000, { mediaType: "x/y" }), f("/my-files/s2", 3000, { mediaType: "x/y" }), f("/my-files/s3", 3000, { mediaType: "x/z" }),
      f("/my-files/tiny1", 10), f("/my-files/tiny2", 10),
      d("/my-files/dir"),
    ];
    const g = findDuplicateCandidates(nodes, 1024);
    assert.equal(g.length, 2);
    const sha = g.find((x) => x.kind === "claimed-sha1");
    assert.deepEqual(sha.members.map((m) => m.path).sort(), ["/my-files/a1", "/my-files/a2"]);
    assert.deepEqual(g.find((x) => x.kind === "same-size").members.map((m) => m.path).sort(), ["/my-files/s1", "/my-files/s2"]);
    assert.equal(g[0].kind, "same-size"); // larger wasted bytes first
  });

  it("returns nothing for zero files or files without sizes", () => {
    assert.deepEqual(findDuplicateCandidates([], 1024), []);
    assert.deepEqual(findDuplicateCandidates([{ path: "/p", uid: "1", type: "file" }, { path: "/q", uid: "2", type: "file" }], 0), []);
  });

  it("does not mix a sha1 file with a sha1-less file of the same size", () => {
    assert.deepEqual(findDuplicateCandidates([f("/my-files/a", 5000, { sha1: "aa" }), f("/my-files/b", 5000)], 0), []);
  });
});

describe("verifyGroups", () => {
  const A = f("/my-files/a", 2000, { mtime: "2026-01-01T00:00:00Z" });
  const B = f("/my-files/bb", 2000, { mtime: "2026-01-02T00:00:00Z" });
  const C = f("/my-files/ccc", 2000, { mtime: "2026-01-03T00:00:00Z" });
  const digests = { a: "h1", bb: "h1", ccc: "h2" };
  const hash = async (n) => digests[n.path.split("/").pop()];

  it("splits a candidate group by digest and labels matches verified", async () => {
    const out = await verifyGroups([{ kind: "same-size", members: [A, B, C] }], hash, { maxVerifyBytes: 1e6 });
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "verified");
    assert.deepEqual(out[0].members.map((m) => m.path), ["/my-files/a", "/my-files/bb"]);
  });

  it("drops groups whose members all differ (false candidates)", async () => {
    const out = await verifyGroups([{ kind: "claimed-sha1", members: [A, C] }], hash, { maxVerifyBytes: 1e6 });
    assert.deepEqual(out, []);
  });

  it("never hashes files over maxVerifyBytes", async () => {
    let calls = 0;
    const out = await verifyGroups([{ kind: "same-size", members: [A, B] }], async () => { calls++; return "x"; }, { maxVerifyBytes: 1000 });
    assert.equal(calls, 0);
    assert.equal(out[0].kind, "same-size");
    assert.match(out[0].verifyNote, /maxVerifyBytes/);
  });

  it("keeps the group unverified with a note when a hash fails", async () => {
    const out = await verifyGroups([{ kind: "same-size", members: [A, B] }], async (n) => { if (n === B) throw new Error("boom"); return "h"; }, { maxVerifyBytes: 1e6 });
    assert.equal(out[0].kind, "same-size");
    assert.match(out[0].verifyNote, /boom/);
  });

  it("stops hashing once the total download budget is used; later groups stay unverified", async () => {
    const g1 = { kind: "same-size", members: [f("/my-files/p1", 600), f("/my-files/p2", 600)] };
    const g2 = { kind: "same-size", members: [f("/my-files/q1", 600), f("/my-files/q2", 600)] };
    const hashed = [];
    const out = await verifyGroups([g1, g2], async (n) => { hashed.push(n.path); return "h"; }, { maxVerifyBytes: 1e6, maxTotalBytes: 1500 });
    assert.deepEqual(hashed.sort(), ["/my-files/p1", "/my-files/p2"]);
    assert.equal(out.find((g) => g.members[0].path === "/my-files/q1").kind, "same-size");
    assert.match(out.find((g) => g.members[0].path === "/my-files/q1").verifyNote, /total verify budget/);
  });

  it("caps the number of members verified", async () => {
    const many = Array.from({ length: 5 }, (_, i) => f(`/my-files/m${i}`, 10));
    let calls = 0;
    const out = await verifyGroups([{ kind: "same-size", members: many }], async () => { calls++; return "h"; }, { maxVerifyBytes: 1e6, maxMembers: 4 });
    assert.equal(calls, 0);
    assert.match(out[0].verifyNote, /budget/);
  });

  it("abort stops verification between members/groups", async () => {
    const ac = new AbortController();
    const groups = [1, 2, 3].map((i) => ({ kind: "same-size", members: [f(`/my-files/a${i}`, 10), f(`/my-files/b${i}`, 10)] }));
    const hashed = [];
    await assert.rejects(verifyGroups(groups, async (n) => { hashed.push(n.path); ac.abort(new Error("cancelled")); return "h"; }, { maxVerifyBytes: 1e6, concurrency: 1, signal: ac.signal }), /cancelled/);
    assert.equal(hashed.length, 1);
  });

  it("an aborted verify still removes the hasher's temp dir", async () => {
    const ac = new AbortController();
    const before = readdirSync(tmpdir()).filter((x) => x.startsWith("pdmcp-dup-")).length;
    const drive = { download: async (_p, dir) => { writeFileSync(join(dir, "f.bin"), "x"); ac.abort(new Error("cancelled")); return { downloaded: 1, failed: 0 }; } };
    const hash = makeDriveHasher(drive);
    await assert.rejects(verifyGroups([{ kind: "same-size", members: [f("/my-files/a", 1), f("/my-files/b", 1)] }], hash, { maxVerifyBytes: 1e6, concurrency: 1, signal: ac.signal }), /cancelled/);
    assert.equal(readdirSync(tmpdir()).filter((x) => x.startsWith("pdmcp-dup-")).length, before);
  });

  it("bounds concurrency", async () => {
    let live = 0, peak = 0;
    const many = Array.from({ length: 12 }, (_, i) => f(`/my-files/n${i}`, 2000));
    await verifyGroups([{ kind: "same-size", members: many }], async () => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return "h";
    }, { maxVerifyBytes: 1e6, concurrency: 4 });
    assert.ok(peak <= 4 && peak > 1, `peak ${peak}`);
  });
});

describe("makeDriveHasher", () => {
  it("downloads into a private temp dir, hashes, and removes it (also on failure)", async () => {
    const dirs = [];
    const drive = {
      download: async (remote, dir) => {
        dirs.push(dir);
        if (remote.endsWith("bad")) return { downloaded: 0, skipped: 0, failed: 1 };
        writeFileSync(join(dir, "file.bin"), "hello");
        return { downloaded: 1, skipped: 0, failed: 0 };
      },
    };
    const hash = makeDriveHasher(drive);
    assert.equal(await hash(f("/my-files/ok", 5)), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    await assert.rejects(hash(f("/my-files/bad", 5)), /download failed/);
    assert.equal(dirs.length, 2);
    assert.notEqual(dirs[0], dirs[1]);
    for (const dir of dirs) assert.equal(existsSync(dir), false);
  });
});

describe("auditShareStatus", () => {
  it("flags a public link with no expiry and editor role, without exposing the URL", () => {
    const r = auditShareStatus("/my-files/x", { path: "/my-files/x", isShared: true, members: [], shareUrl: "https://drive.proton.me/urls/T#key", shareUrlRole: "editor", sharePasswordProtected: false });
    assert.deepEqual(r.flags, ["public-link-no-expiry", "public-link-editor"]);
    assert.deepEqual(r.publicLink, { role: "editor", expiresAt: undefined, passwordProtected: false });
    assert.equal(JSON.stringify(r).includes("#key"), false);
  });

  it("does not flag a viewer link with expiry and password; flags external invitee incl. pending", () => {
    const ok = auditShareStatus("/p", { path: "/p", isShared: true, members: [{ email: "a@proton.me", role: "viewer", status: "accepted" }], shareUrl: "u", shareUrlRole: "viewer", shareUrlExpiresAt: "2026-12-01T00:00:00Z", sharePasswordProtected: true });
    assert.deepEqual(ok.flags, []);
    const ext = auditShareStatus("/p", { path: "/p", isShared: true, members: [{ email: "a@proton.me", role: "viewer", status: "accepted" }, { email: "Bob@Gmail.com", role: "editor", status: "pending" }] });
    assert.deepEqual(ext.flags, ["external-invitee"]);
    assert.deepEqual(ext.pending, [{ email: "Bob@Gmail.com", role: "editor" }]);
    assert.equal(ext.publicLink, undefined);
  });
});

describe("driveUsage", () => {
  it("combines the walk with one /trash list call", async () => {
    const calls = [];
    const drive = new DriveService(async (args) => { calls.push(args); return [{ uid: "t", name: { ok: true, value: "gone" }, type: "file", activeRevision: { claimedSize: 7 }, trashTime: "2026-09-01T00:00:00Z" }]; });
    const r = await driveUsage(drive, { path: "/my-files", top: 3 }, { walk: fakeWalk([f("/my-files/a", 4)]), now: NOW });
    assert.deepEqual(calls, [["filesystem", "list", "/trash"]]);
    assert.deepEqual(r.trash, { count: 1, bytes: 7, oldestTrashedAt: "2026-09-01T00:00:00Z" });
    assert.equal(r.totals.bytes, 4);
    assert.match(r.note, /not the account/);
  });

  it("reports a trash failure instead of failing the whole call", async () => {
    const drive = new DriveService(async () => { throw new Error("nope"); });
    const r = await driveUsage(drive, { path: "/my-files" }, { walk: fakeWalk([]), now: NOW });
    assert.deepEqual(r.trash, { error: "nope" });
  });
});

describe("driveFindDuplicates", () => {
  const nodes = [
    f("/my-files/dir/copy.bin", 5000, { sha1: "aa", mtime: "2026-02-01T00:00:00Z" }),
    f("/my-files/orig.bin", 5000, { sha1: "aa", mtime: "2026-01-01T00:00:00Z" }),
    f("/my-files/x1", 9000, { mediaType: "m", mtime: "2026-01-01T00:00:00Z" }),
    f("/my-files/x2", 9000, { mediaType: "m", mtime: "2026-01-01T00:00:00Z" }),
  ];
  const drive = new DriveService(async () => []);

  it("reports groups, wasted bytes and an oldest/shortest-path keeper without verify", async () => {
    const r = await driveFindDuplicates(drive, { path: "/my-files" }, { walk: fakeWalk(nodes), hash: async () => { throw new Error("must not hash"); } });
    assert.equal(r.totalGroups, 2);
    assert.equal(r.totalWastedBytes, 14000);
    assert.equal(r.groups[0].kind, "same-size");
    assert.equal(r.groups[0].suggestedKeeper, "/my-files/x1"); // tie on mtime -> shortest then lexical
    assert.equal(r.groups[1].suggestedKeeper, "/my-files/orig.bin");
  });

  it("verify upgrades matching groups and drops false candidates", async () => {
    const hash = async (n) => (n.path.startsWith("/my-files/x") ? n.path : "same");
    const r = await driveFindDuplicates(drive, { path: "/my-files", verify: true }, { walk: fakeWalk(nodes), hash });
    assert.equal(r.totalGroups, 1);
    assert.equal(r.groups[0].kind, "verified");
    assert.equal(r.totalWastedBytes, 5000);
  });
});

describe("driveFindDuplicates verify budget", () => {
  it("rejects an out-of-range maxVerifyTotalBytes and honours a small one", async () => {
    const nodes = [f("/my-files/a1", 9000, { sha1: "aa" }), f("/my-files/a2", 9000, { sha1: "aa" })];
    const drive = new DriveService(async () => []);
    const walk = { walk: async () => ({ root: "/my-files", nodes, complete: true, callsMade: 0, skipped: [], fromCache: true, ageMs: 0 }) };
    await assert.rejects(driveFindDuplicates(drive, { path: "/my-files", verify: true, maxVerifyTotalBytes: 2_000_000_001 }, walk), /maxVerifyTotalBytes/);
    let hashed = 0;
    const r = await driveFindDuplicates(drive, { path: "/my-files", verify: true, maxVerifyTotalBytes: 100 }, { ...walk, hash: async () => { hashed++; return "h"; } });
    assert.equal(hashed, 0);
    assert.match(r.groups[0].verifyNote, /total verify budget/);
  });
});

describe("driveFindDuplicates limit", () => {
  it("verifies and returns only the top `limit` groups", async () => {
    const nodes = [
      f("/my-files/a1", 9000, { sha1: "aa" }), f("/my-files/a2", 9000, { sha1: "aa" }),
      f("/my-files/b1", 2000, { sha1: "bb" }), f("/my-files/b2", 2000, { sha1: "bb" }),
    ];
    const hashed = [];
    const r = await driveFindDuplicates(new DriveService(async () => []), { path: "/my-files", verify: true, limit: 1 }, {
      walk: fakeWalk(nodes), hash: async (n) => { hashed.push(n.path); return "h"; },
    });
    assert.deepEqual(hashed.sort(), ["/my-files/a1", "/my-files/a2"]);
    assert.equal(r.totalGroups, 2);
    assert.equal(r.groups.length, 1);
    assert.equal(r.groups[0].kind, "verified");
  });
});

describe("driveSharingAudit", () => {
  const share = (path, extra = {}) => f(path, 1, { isShared: true, ...extra });
  it("audits shared nodes, skipping roots, and carries per-node errors", async () => {
    const asked = [];
    const status = async (p) => {
      asked.push(p);
      if (p.endsWith("bad")) throw new Error("status failed");
      return { path: p, isShared: true, members: [{ email: "e@gmail.com", role: "viewer", status: "accepted" }] };
    };
    const nodes = [share("/my-files", { type: "folder" }), share("/my-files/good"), share("/my-files/bad"), f("/my-files/private", 1)];
    const r = await driveSharingAudit(new DriveService(async () => []), { path: "/my-files" }, { walk: fakeWalk(nodes), status });
    assert.deepEqual(asked.sort(), ["/my-files/bad", "/my-files/good"]);
    assert.equal(r.sharedNodes, 2);
    assert.equal(r.flaggedCount, 1);
    assert.deepEqual(r.errors, [{ path: "/my-files/bad", error: "status failed" }]);
    assert.equal(r.capped, false);
  });

  it("caps at 100 shared nodes and says so, with bounded concurrency", async () => {
    let live = 0, peak = 0;
    const status = async (p) => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 2));
      live--;
      return { path: p, isShared: true, members: [] };
    };
    const nodes = Array.from({ length: 130 }, (_, i) => share(`/my-files/n${i}`));
    const r = await driveSharingAudit(new DriveService(async () => []), { path: "/my-files" }, { walk: fakeWalk(nodes), status });
    assert.equal(r.sharedNodes, 130);
    assert.equal(r.audited, 100);
    assert.equal(r.capped, true);
    assert.ok(peak <= 4, `peak ${peak}`);
  });

  it("zero shared nodes", async () => {
    const r = await driveSharingAudit(new DriveService(async () => []), { path: "/my-files" }, { walk: fakeWalk([f("/my-files/a", 1)]), status: async () => { throw new Error("no"); } });
    assert.equal(r.sharedNodes, 0);
    assert.deepEqual(r.items, []);
  });
});
