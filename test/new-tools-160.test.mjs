// 1.6.0 tools: drive_recent_changes, drive_share_expiry_report, drive_read_many, and the drive_share_set_url safety check.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSince, recentFiles, diffSnapshots, driveRecentChanges, deleteChangeSnapshots, SNAPSHOT_NEEDS_INDEX } from "../dist/services/changes.js";
import { driveShareExpiryReport } from "../dist/services/analytics.js";
import { driveReadMany } from "../dist/services/readMany.js";
import { indexDir } from "../dist/services/walkIndex.js";
import { makeSandbox, startServer, nonVersionCalls } from "./helpers/mcp-client.mjs";
import { usePrivateTmp } from "./helpers/optional-deps.mjs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-01T12:00:00Z");
const iso = (days) => new Date(NOW - days * DAY).toISOString();
const f = (path, size, extra = {}) => ({ path, uid: "u" + path, type: "file", size, ...extra });
const walkOf = (nodes, extra = {}) => ({ root: "/my-files", nodes, complete: true, callsMade: 1, skipped: [], fromCache: false, ageMs: 0, ...extra });
const fakeWalk = (nodes, extra) => async () => walkOf(nodes, extra);

describe("parseSince / recentFiles", () => {
  it("parses relative ages and ISO dates and rejects junk", () => {
    assert.equal(parseSince("7d", NOW), NOW - 7 * DAY);
    assert.equal(parseSince("12h", NOW), NOW - 12 * 3_600_000);
    assert.equal(parseSince(" 2W ", NOW), NOW - 14 * DAY);
    assert.equal(parseSince("2026-10-01", NOW), Date.parse("2026-10-01"));
    assert.throws(() => parseSince("yesterday", NOW), /since must be/);
    assert.throws(() => parseSince("7 days ago", NOW), /since must be/);
  });

  it("uses the newer of mtime and uploadedAt, skips folders and undated files, sorts newest first", () => {
    const nodes = [
      f("/my-files/old", 1, { mtime: iso(30) }),
      f("/my-files/reuploaded", 2, { mtime: iso(300), uploadedAt: iso(1) }),
      f("/my-files/fresh", 3, { mtime: iso(0.5) }),
      f("/my-files/undated", 4),
      { path: "/my-files/dir", uid: "d", type: "folder", mtime: iso(0) },
    ];
    const r = recentFiles(nodes, NOW - 7 * DAY, 10);
    assert.deepEqual(r.items.map((i) => i.path), ["/my-files/fresh", "/my-files/reuploaded"]);
    assert.equal(r.total, 2);
    assert.equal(recentFiles(nodes, NOW - 7 * DAY, 1).items.length, 1);
  });
});

describe("diffSnapshots", () => {
  const e = (size, mtime, sha1) => ({ size, mtime, sha1 });
  it("reports added, removed, modified and moved (sha1+size, one to one)", () => {
    const prev = { "/a/keep": e(1, "t1", "aa"), "/a/edit": e(2, "t1", "bb"), "/a/gone": e(3, "t1", "cc"), "/a/mv": e(4, "t1", "dd"), "/a/dup1": e(5, "t1", "ee"), "/a/dup2": e(5, "t1", "ee") };
    const cur = { "/a/keep": e(1, "t1", "aa"), "/a/edit": e(2, "t2", "bb"), "/a/new": e(9, "t1", "ff"), "/b/mv": e(4, "t1", "dd"), "/b/dup1": e(5, "t1", "ee") };
    const d = diffSnapshots(prev, cur);
    assert.deepEqual(d.added.map((x) => x.path), ["/a/new"]);
    assert.deepEqual(d.modified.map((x) => x.path), ["/a/edit"]);
    assert.deepEqual(d.moved.map((x) => [x.from, x.to]).sort(), [["/a/dup1", "/b/dup1"], ["/a/mv", "/b/mv"]]);
    assert.deepEqual(d.removed.map((x) => x.path).sort(), ["/a/dup2", "/a/gone"]);
  });
  it("never pairs a move without a sha1, or with a different size", () => {
    const d = diffSnapshots({ "/a": { size: 1 }, "/c": { size: 2, sha1: "x" } }, { "/b": { size: 1 }, "/d": { size: 3, sha1: "x" } });
    assert.deepEqual(d.moved, []);
    assert.equal(d.added.length, 2);
    assert.equal(d.removed.length, 2);
  });
  it("a sha1 present on one side only is not a modification", () => {
    assert.deepEqual(diffSnapshots({ "/a": { size: 1, mtime: "t" } }, { "/a": { size: 1, mtime: "t", sha1: "x" } }).modified, []);
  });
});

describe("driveRecentChanges", () => {
  let tmp;
  usePrivateTmp(beforeEach, afterEach);
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pdchg-"));
    process.env.PROTON_DRIVE_INDEX = "1";
    process.env.PROTON_DRIVE_INDEX_DIR = join(tmp, "idx");
  });
  afterEach(() => {
    delete process.env.PROTON_DRIVE_INDEX;
    delete process.env.PROTON_DRIVE_INDEX_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });
  const acct = (k = "acct") => async () => k;
  const run = (nodes, o, extra = {}, deps = {}) => driveRecentChanges({}, { path: "/my-files", ...o }, { walk: fakeWalk(nodes, extra), now: NOW, accountKey: acct(), ...deps });

  it("since mode defaults to 7d, flags an incomplete walk, and needs no index", async () => {
    delete process.env.PROTON_DRIVE_INDEX;
    const nodes = [f("/my-files/a", 1, { mtime: iso(2) }), f("/my-files/b", 1, { mtime: iso(20) })];
    const r = await run(nodes, {}, { complete: false });
    assert.deepEqual(r.items.map((i) => i.path), ["/my-files/a"]);
    assert.equal(r.since, new Date(NOW - 7 * DAY).toISOString());
    assert.equal(r.complete, false);
    assert.equal((await run(nodes, { since: "30d" })).total, 2);
  });

  it("walks without the saved index and without a time budget", async () => {
    let seen;
    await driveRecentChanges({}, { path: "/my-files" }, { walk: async (_s, _r, opts) => { seen = opts; return walkOf([]); }, now: NOW });
    assert.equal(seen.noDisk, true);
    assert.equal(seen.budgetMs, 0);
  });

  it("rejects a bad since before walking, since+snapshot, and the root", async () => {
    let walked = false;
    const walk = async () => { walked = true; return walkOf([]); };
    await assert.rejects(driveRecentChanges({}, { path: "/my-files", since: "soon" }, { walk }), /since must be/);
    await assert.rejects(driveRecentChanges({}, { path: "/my-files", since: "7d", snapshot: "diff" }, { walk }), /cannot be combined/);
    await assert.rejects(driveRecentChanges({}, { path: "/" }, { walk }), /not '\/'/);
    assert.equal(walked, false);
  });

  it("snapshot modes refuse without PROTON_DRIVE_INDEX=1 and write nothing", async () => {
    delete process.env.PROTON_DRIVE_INDEX;
    await assert.rejects(run([], { snapshot: "save" }), (e) => e.message === SNAPSHOT_NEEDS_INDEX);
    await assert.rejects(run([], { snapshot: "diff" }), /PROTON_DRIVE_INDEX=1/);
    assert.equal(readdirSync(tmp).includes("idx"), false);
  });

  it("save then diff: added, removed, modified, moved; the file is private", async () => {
    const v1 = [f("/my-files/keep", 10, { mtime: "t1", sha1: "AA" }), f("/my-files/edit", 20, { mtime: "t1" }), f("/my-files/gone", 30, { mtime: "t1", sha1: "cc" }), f("/my-files/mv", 40, { mtime: "t1", sha1: "dd" })];
    const first = await run(v1, { snapshot: "save" });
    assert.equal(first.saved, true);
    assert.match(first.note, /baseline saved/);
    assert.equal(first.added, undefined);
    const file = join(indexDir(), "changes-snapshot.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(indexDir()).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(indexDir()), ["changes-snapshot.json"]);

    const v2 = [f("/my-files/keep", 10, { mtime: "t1", sha1: "aa" }), f("/my-files/edit", 21, { mtime: "t2" }), f("/my-files/sub/mv", 40, { mtime: "t1", sha1: "dd" }), f("/my-files/new", 5, { mtime: "t3" })];
    const d = await run(v2, { snapshot: "diff" });
    assert.equal(d.saved, false);
    assert.deepEqual(d.added.items.map((x) => x.path), ["/my-files/new"]);
    assert.deepEqual(d.removed.items.map((x) => x.path), ["/my-files/gone"]);
    assert.deepEqual(d.modified.items.map((x) => x.path), ["/my-files/edit"]);
    assert.deepEqual(d.moved.items.map((x) => [x.from, x.to]), [["/my-files/mv", "/my-files/sub/mv"]]);
    assert.ok(d.previousSnapshotAt);
    // diff did not change the baseline
    assert.deepEqual((await run(v2, { snapshot: "diff" })).added.items.map((x) => x.path), ["/my-files/new"]);
    // save compares and then moves the baseline
    assert.equal((await run(v2, { snapshot: "save" })).saved, true);
    const same = await run(v2, { snapshot: "diff" });
    assert.deepEqual([same.added.total, same.removed.total, same.modified.total, same.moved.total], [0, 0, 0, 0]);
  });

  it("a diff without an earlier snapshot says so instead of calling everything added", async () => {
    const r = await run([f("/my-files/a", 1)], { snapshot: "diff" });
    assert.equal(r.added, undefined);
    assert.match(r.note, /nothing to compare/);
    assert.equal(r.saved, false);
  });

  it("an incomplete or partial walk never overwrites a snapshot and omits removed/moved", async () => {
    const v1 = [f("/my-files/a", 1, { sha1: "x" }), f("/my-files/b", 2, { sha1: "y" })];
    await run(v1, { snapshot: "save" });
    const file = join(indexDir(), "changes-snapshot.json");
    const before = readFileSync(file, "utf8");
    for (const extra of [{ complete: false }, { partial: true, continuing: true, budgetMs: 25_000 }]) {
      const r = await run([f("/my-files/a", 1, { sha1: "x" })], { snapshot: "save" }, extra);
      assert.equal(r.saved, false);
      assert.equal("removed" in r, false);
      assert.equal("moved" in r, false);
      assert.match(r.note, /not saved/);
      assert.equal(readFileSync(file, "utf8"), before);
    }
  });

  it("ignores (and on save replaces) a snapshot of another account", async () => {
    await run([f("/my-files/a", 1)], { snapshot: "save" }, {}, { accountKey: acct("one") });
    const r = await run([f("/my-files/a", 1), f("/my-files/b", 1)], { snapshot: "diff" }, {}, { accountKey: acct("two") });
    assert.match(r.note, /another account/);
    assert.equal(r.added, undefined);
    assert.equal((await run([f("/my-files/b", 1)], { snapshot: "save" }, {}, { accountKey: acct("two") })).saved, true);
    const j = JSON.parse(readFileSync(join(indexDir(), "changes-snapshot.json"), "utf8"));
    assert.equal(j.accountKey, "two");
    assert.deepEqual(Object.keys(j.roots["/my-files"].files), ["/my-files/b"]);
  });

  it("keeps one snapshot per walked path and refuses when the account cannot be identified", async () => {
    const walkAt = (root) => async () => walkOf([f(`${root}/x`, 1)], { root });
    await driveRecentChanges({}, { path: "/my-files/A", snapshot: "save" }, { walk: walkAt("/my-files/A"), now: NOW, accountKey: acct() });
    await driveRecentChanges({}, { path: "/my-files/B", snapshot: "save" }, { walk: walkAt("/my-files/B"), now: NOW, accountKey: acct() });
    const j = JSON.parse(readFileSync(join(indexDir(), "changes-snapshot.json"), "utf8"));
    assert.deepEqual(Object.keys(j.roots).sort(), ["/my-files/A", "/my-files/B"]);
    await assert.rejects(run([], { snapshot: "save" }, {}, { accountKey: async () => undefined }), /identify the signed-in account/);
  });

  it("index clear removes the snapshot file", async () => {
    await run([f("/my-files/a", 1)], { snapshot: "save" });
    assert.equal(deleteChangeSnapshots(), true);
    assert.equal(deleteChangeSnapshots(), false);
    assert.equal((await run([f("/my-files/a", 1)], { snapshot: "diff" })).previousSnapshotAt, undefined);
  });

  it("caps each list at limit but reports the total", async () => {
    await run([], { snapshot: "save" });
    const many = Array.from({ length: 5 }, (_, i) => f(`/my-files/n${i}`, 1));
    const r = await run(many, { snapshot: "diff", limit: 2 });
    assert.equal(r.added.total, 5);
    assert.equal(r.added.items.length, 2);
  });
});

describe("driveShareExpiryReport", () => {
  const shared = (path) => ({ path, uid: "u" + path, type: "folder", isSharedByUrl: true });
  const st = (path, urlAccess) => ({ path, isShared: true, members: [], ...urlAccess });
  const statuses = {
    "/my-files/exp": st("/my-files/exp", { shareUrl: "u", shareUrlExpiresAt: new Date(NOW - 2 * DAY).toISOString(), shareUrlRole: "viewer", sharePasswordProtected: true }),
    "/my-files/soon": st("/my-files/soon", { shareUrl: "u", shareUrlExpiresAt: new Date(NOW + 5 * DAY).toISOString(), shareUrlRole: "editor", sharePasswordProtected: false }),
    "/my-files/later": st("/my-files/later", { shareUrl: "u", shareUrlExpiresAt: new Date(NOW + 40 * DAY).toISOString(), shareUrlRole: "viewer", sharePasswordProtected: false }),
    "/my-files/never": st("/my-files/never", { shareUrl: "u", shareUrlRole: "viewer", sharePasswordProtected: true }),
    "/my-files/memberonly": st("/my-files/memberonly", {}),
  };
  const nodes = Object.keys(statuses).map(shared);
  const deps = (extra = {}) => ({ walk: fakeWalk(nodes), status: async (p) => statuses[p], now: NOW, ...extra });

  it("lists links with daysLeft and flags, soonest expiry first, members-only items left out", async () => {
    const r = await driveShareExpiryReport({}, { path: "/my-files" }, deps());
    assert.deepEqual(r.items.map((i) => i.path), ["/my-files/exp", "/my-files/soon", "/my-files/later", "/my-files/never"]);
    const by = Object.fromEntries(r.items.map((i) => [i.path.split("/").pop(), i]));
    assert.deepEqual([by.exp.expired, by.exp.expiringSoon, by.exp.noExpiry, by.exp.hasPassword, by.exp.daysLeft], [true, false, false, true, -2]);
    assert.deepEqual([by.soon.expired, by.soon.expiringSoon, by.soon.daysLeft, by.soon.role, by.soon.hasPassword], [false, true, 5, "editor", false]);
    assert.deepEqual([by.later.expiringSoon, by.later.daysLeft], [false, 40]);
    assert.deepEqual([by.never.noExpiry, by.never.expired, by.never.expiringSoon, by.never.daysLeft, by.never.hasPassword], [true, false, false, undefined, true]);
    assert.deepEqual([r.links, r.expired, r.expiringSoon, r.noExpiry, r.withinDays], [4, 1, 1, 1, 14]);
    assert.equal(JSON.stringify(r).includes('"url"'), false);
  });

  it("withinDays moves the expiringSoon boundary", async () => {
    const r = await driveShareExpiryReport({}, { path: "/my-files", withinDays: 60 }, deps());
    assert.equal(r.expiringSoon, 2);
  });

  it("reports the 100-item cap as truncation", async () => {
    const many = Array.from({ length: 105 }, (_, i) => shared(`/my-files/s${String(i).padStart(3, "0")}`));
    const r = await driveShareExpiryReport({}, { path: "/my-files" }, { walk: fakeWalk(many), status: async (p) => st(p, { shareUrl: "u", shareUrlRole: "viewer" }), now: NOW });
    assert.equal(r.audited, 100);
    assert.equal(r.sharedNodes, 105);
    assert.equal(r.capped, true);
    assert.equal(r.links, 100);
    assert.match(r.note, /first 100 of 105/);
  });

  it("walks like the sharing audit (no saved index, no budget) and passes errors through", async () => {
    let seen;
    const r = await driveShareExpiryReport({}, { path: "/my-files" }, {
      walk: async (_s, _r, opts) => { seen = opts; return walkOf([shared("/my-files/x")]); },
      status: async () => { throw new Error("boom"); }, now: NOW,
    });
    assert.deepEqual([seen.noDisk, seen.budgetMs], [true, 0]);
    assert.deepEqual(r.errors, [{ path: "/my-files/x", error: "boom" }]);
    assert.equal(r.links, 0);
  });
});

describe("driveReadMany", () => {
  usePrivateTmp(beforeEach, afterEach);
  /** files: {path: text | Error}. Records the highest number of downloads in flight. */
  function fakeDrive(files, { delay = 0 } = {}) {
    const stats = { inFlight: 0, max: 0, downloads: [] };
    return {
      stats,
      info: async (p) => {
        if (!(p in files)) throw new Error(`Node not found: ${p}`);
        return { type: "file", mediaType: "text/plain", activeRevision: { claimedSize: 10 } };
      },
      download: async (p, dir) => {
        stats.inFlight++; stats.max = Math.max(stats.max, stats.inFlight); stats.downloads.push(p);
        try {
          if (delay) await new Promise((r) => setTimeout(r, delay));
          if (files[p] instanceof Error) throw files[p];
          writeFileSync(join(dir, "f"), files[p]);
          return { downloaded: 1, skipped: 0, failed: 0 };
        } finally { stats.inFlight--; }
      },
    };
  }

  it("reads in order, one failure does not fail the batch, never more than 2 downloads at once", async () => {
    const files = { "/my-files/a.txt": "alpha", "/my-files/b.txt": new Error("boom"), "/my-files/c.txt": "gamma", "/my-files/d.txt": "delta", "/my-files/e.txt": "eps" };
    const d = fakeDrive(files, { delay: 20 });
    const r = await driveReadMany(d, { paths: [...Object.keys(files), "/my-files/missing.txt"] });
    assert.deepEqual(r.results.map((x) => [x.path.split("/").pop(), x.ok]), [["a.txt", true], ["b.txt", false], ["c.txt", true], ["d.txt", true], ["e.txt", true], ["missing.txt", false]]);
    assert.equal(r.results[0].text, "alpha");
    assert.match(r.results[1].error, /boom|download failed/);
    assert.match(r.results[5].error, /not found/i);
    assert.equal(d.stats.max, 2);
    assert.match(r.note, /untrusted/);
  });

  it("caps text per file and flags truncation with nextOffset", async () => {
    const r = await driveReadMany(fakeDrive({ "/my-files/a.txt": "0123456789" }), { paths: ["/my-files/a.txt"], maxCharsPerFile: 4 });
    assert.deepEqual(r.results[0], { path: "/my-files/a.txt", ok: true, text: "0123", truncated: true, nextOffset: 4 });
    assert.match(r.note, /drive_read_content/);
  });

  it("caps the total and skips files once it is used up", async () => {
    const files = { "/my-files/a.txt": "aaaaaaaa", "/my-files/b.txt": "bbbbbbbb", "/my-files/c.txt": "cccccccc" };
    const r = await driveReadMany(fakeDrive(files), { paths: Object.keys(files), maxCharsPerFile: 8, maxTotalChars: 12 });
    // Which of the two files in flight finishes first is up to the scheduler, so assert the invariants only.
    assert.equal(r.totalChars, 12);
    assert.equal(r.results.map((x) => x.text ?? "").join("").length, 12);
    const skipped = r.results.filter((x) => !x.ok);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].error, /maxTotalChars/);
    assert.ok(r.results.some((x) => x.truncated));
  });

  it("validates its inputs before touching Drive", async () => {
    const d = fakeDrive({});
    await assert.rejects(driveReadMany(d, { paths: [] }), /1 to 10/);
    await assert.rejects(driveReadMany(d, { paths: Array.from({ length: 11 }, (_, i) => `/my-files/${i}`) }), /1 to 10/);
    await assert.rejects(driveReadMany(d, { paths: ["/my-files/a"], maxCharsPerFile: 20_001 }), /maxCharsPerFile/);
    await assert.rejects(driveReadMany(d, { paths: ["/my-files/a"], maxTotalChars: 0 }), /maxTotalChars/);
    assert.equal(d.stats.downloads.length, 0);
  });

  it("leaves no temp dir behind", async () => {
    await driveReadMany(fakeDrive({ "/my-files/a.txt": "x", "/my-files/b.txt": new Error("boom") }), { paths: ["/my-files/a.txt", "/my-files/b.txt"] });
    assert.deepEqual(readdirSync(tmpdir()).filter((n) => n.startsWith("pdmcp-read-")), []);
  });
});

describe("MCP server: new tools and the set_url safety check", () => {
  const LINK = (extra = {}) => JSON.stringify({ protonInvitations: [], nonProtonInvitations: [], members: [], urlAccess: { url: "https://drive.proton.me/urls/X#y", role: "viewer", ...extra } });
  const P = "/my-files/shared";
  async function withServer(mode, env, fn) {
    const sb = makeSandbox();
    const c = await startServer(mode, sb, env);
    try { await fn(c, sb); } finally { await c.close(); sb.cleanup(); }
  }
  const setUrlCalls = (sb) => nonVersionCalls(sb.argvLog).filter((a) => a[0] === "sharing" && a[1] === "set-url");

  it("refuses to drop an existing password or expiration, naming it, before any change", () =>
    withServer("json", { FAKE_STDOUT: LINK({ customPassword: "hunter2", expirationTime: "2026-12-01T00:00:00.000Z" }) }, async (c, sb) => {
      const r = await c.call("drive_share_set_url", { path: P, confirmed: true });
      assert.equal(r.isError, true);
      assert.match(r.text, /password and expiration \(2026-12-01/);
      assert.match(r.text, /REMOVED/);
      assert.match(r.text, /resetSettings=true/);
      assert.ok(!r.text.includes("hunter2"));
      assert.equal(setUrlCalls(sb).length, 0);
      const onlyPw = await c.call("drive_share_set_url", { path: P, password: "newpw123", confirmed: true });
      assert.equal(onlyPw.isError, true);
      assert.match(onlyPw.text, /expiration \(2026-12-01/);
      assert.ok(!/password and/.test(onlyPw.text));
      assert.equal(setUrlCalls(sb).length, 0);
    }));

  it("passes with resetSettings:true, or when the call passes everything the link has", () =>
    withServer("json", { FAKE_STDOUT: LINK({ customPassword: "hunter2", expirationTime: "2026-12-01T00:00:00.000Z" }) }, async (c, sb) => {
      assert.equal((await c.call("drive_share_set_url", { path: P, resetSettings: true, confirmed: true })).isError, false);
      assert.equal(setUrlCalls(sb).length, 1);
      assert.equal((await c.call("drive_share_set_url", { path: P, password: "pw12345678", expiration: "2027-01-01", confirmed: true })).isError, false);
      assert.equal(setUrlCalls(sb).length, 2);
    }));

  it("a link without password or expiration, and a path with no link, go through", () =>
    withServer("json", { FAKE_STDOUT: LINK() }, async (c, sb) => {
      assert.equal((await c.call("drive_share_set_url", { path: P, confirmed: true })).isError, false);
      assert.equal(setUrlCalls(sb).length, 1);
    }).then(() => withServer("json", {}, async (c, sb) => {
      assert.equal((await c.call("drive_share_set_url", { path: P, confirmed: true })).isError, false);
      assert.equal(setUrlCalls(sb).length, 1);
    })));

  it("refuses when the existing settings cannot be read, unless resetSettings:true", () =>
    withServer("fail-stderr", {}, async (c, sb) => {
      const r = await c.call("drive_share_set_url", { path: P, confirmed: true });
      assert.equal(r.isError, true);
      assert.match(r.text, /quota exceeded/);
      assert.equal(setUrlCalls(sb).length, 0);
    }));

  it("keeps the confirmed gate and rejects a non-boolean resetSettings", () =>
    withServer("json", {}, async (c) => {
      const r = await c.call("drive_share_set_url", { path: P });
      assert.equal(r.isError, true);
      assert.match(r.text, /confirmed=true/);
      const bad = await c.call("drive_share_set_url", { path: P, resetSettings: "yes", confirmed: true });
      assert.match(bad.text, /resetSettings must be a boolean/);
    }));

  it("PROTON_DRIVE_REMOTE_ROOTS applies to every drive_read_many path and to the walk tools' default path", () =>
    withServer("json", { PROTON_DRIVE_REMOTE_ROOTS: "/my-files/ok" }, async (c, sb) => {
      const before = nonVersionCalls(sb.argvLog).length;
      const r = await c.call("drive_read_many", { paths: ["/my-files/ok/a.txt", "/my-files/other/b.txt"] });
      assert.equal(r.isError, true);
      assert.match(r.text, /outside PROTON_DRIVE_REMOTE_ROOTS/);
      for (const [tool, args] of [["drive_recent_changes", {}], ["drive_share_expiry_report", {}], ["drive_recent_changes", { path: "/my-files/other" }]]) {
        const x = await c.call(tool, args);
        assert.equal(x.isError, true, tool);
        assert.match(x.text, /outside PROTON_DRIVE_REMOTE_ROOTS/);
      }
      assert.equal(nonVersionCalls(sb.argvLog).length, before);
    }));

  it("the new tools stay available in readonly mode; drive_recent_changes snapshot errors without the index", () =>
    withServer("json", { PROTON_DRIVE_MODE: "readonly" }, async (c) => {
      const names = (await c.listTools()).map((t) => t.name);
      for (const n of ["drive_read_many", "drive_share_expiry_report", "drive_recent_changes"]) assert.ok(names.includes(n), n);
      const r = await c.call("drive_recent_changes", { snapshot: "save" });
      assert.equal(r.isError, true);
      assert.match(r.text, /PROTON_DRIVE_INDEX=1/);
      const bad = await c.call("drive_read_many", { paths: [] });
      assert.equal(bad.isError, true);
    }));
});
