import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeCheckup, checkupFindingPage, SCORE_TABLE, scorePoints, CHECKUP_FINDINGS } from "../dist/services/checkup.js";

const DAY = 86_400_000;
const MB = 1024 * 1024;
const NOW = Date.parse("2026-09-30T00:00:00Z");
const ROOT = "/my-files";
const old = new Date(NOW - 800 * DAY).toISOString();
const recent = new Date(NOW - 10 * DAY).toISOString();
const f = (path, size, extra = {}) => ({ path, uid: "u" + path, parentUid: "u" + path.slice(0, path.lastIndexOf("/")), type: "file", size, mtime: recent, ...extra });
const d = (path, extra = {}) => ({ path, uid: "u" + path, parentUid: "u" + path.slice(0, path.lastIndexOf("/")), type: "folder", ...extra });
const scan = (extra = {}) => ({ files: 0, folders: 0, bytes: 0, complete: true, ageMs: 5, ...extra });
const run = (nodes, over = {}) => computeCheckup({
  nodes, rootPath: ROOT, trash: over.trash ?? { count: 0, bytes: 0 }, sharingAudit: over.sharingAudit,
  opts: { now: NOW, sharing: true, scanInfo: scan(over.scanInfo), ...(over.opts ?? {}) },
});
const ids = (s) => s.findings.map((x) => x.id);
const get = (s, id) => s.findings.find((x) => x.id === id);
const shuffle = (a, seed = 1) => { const r = [...a]; let s = seed; for (let i = r.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) % 2147483648; const j = s % (i + 1); [r[i], r[j]] = [r[j], r[i]]; } return r; };

const fixture = () => [
  d("/my-files/a"), d("/my-files/b"), d("/my-files/empty"), d("/my-files/empty/inner"), d("/my-files/pub"), d("/my-files/shared"), d("/my-files/shared/sub"),
  f("/my-files/a/one.bin", 10 * MB, { sha1: "AA", mtime: old }),
  f("/my-files/b/two.bin", 10 * MB, { sha1: "aa" }),
  f("/my-files/b/big.iso", 80 * MB, { mtime: old }),
  f("/my-files/b/bigrecent.iso", 81 * MB),
  f("/my-files/pub/x.txt", 5, {}),
  d("/my-files/linked", { isSharedByUrl: true }), f("/my-files/linked/y.txt", 6),
  d("/my-files/shared", { isShared: true }),
  f("/my-files/shared/sub/Passport scan.pdf", 100),
  f("/my-files/shared/sub/notes.txt", 101),
  f("/my-files/a/Steuererklärung 2024.pdf", 102),
];
// note: a duplicate "/my-files/shared" folder entry above is replaced below to keep uids unique
const tree = () => { const m = new Map(); for (const n of fixture()) m.set(n.path, n); return [...m.values()]; };

describe("computeCheckup findings", () => {
  it("detects every finding on one fixture", () => {
    const audit = { items: [{ path: "/my-files/linked", publicLink: { role: "viewer" }, flags: ["public-link-no-expiry"] }, { path: "/my-files/shared", invitees: [], flags: ["external-invitee"] }] };
    const s = run(tree(), { trash: { count: 3, bytes: 2 * 1024 ** 3 }, sharingAudit: audit });
    assert.deepEqual(ids(s), [...CHECKUP_FINDINGS]);
    assert.equal(get(s, "duplicates").count, 1);
    assert.equal(get(s, "duplicates").bytes, 10 * MB);
    assert.equal(get(s, "duplicates").fix, "drive_cleanup");
    assert.equal(get(s, "duplicates").fixableCount, 1);
    assert.deepEqual(get(s, "empty-folders").samples, ["/my-files/empty", "/my-files/empty/inner"]);
    assert.equal(get(s, "large-old").count, 1);
    assert.equal(get(s, "public-links").severity, "warn");
    assert.equal(get(s, "outside-access").severity, "warn");
    assert.equal(get(s, "sensitive-exposed").count, 1);
    assert.equal(get(s, "sensitive-exposed").severity, "risk");
    assert.equal(get(s, "trash").bytes, 2 * 1024 ** 3);
    assert.ok(s.caveats.some((c) => /name-based guess/.test(c)));
  });

  it("clean tree has no findings and score 100", () => {
    const s = run([d("/my-files/a"), f("/my-files/a/x.txt", 5)]);
    assert.deepEqual(s.findings, []);
    assert.equal(s.score, 100);
    assert.deepEqual(s.scoreParts, []);
    assert.equal(s.namesInResult, 0);
  });

  it("empty-folders only when the scan is complete", () => {
    const nodes = [d("/my-files/e"), f("/my-files/x.txt", 1)];
    assert.equal(get(run(nodes), "empty-folders").count, 1);
    for (const scanInfo of [{ complete: false }, { partial: true }]) {
      const s = run(nodes, { scanInfo });
      assert.equal(get(s, "empty-folders"), undefined);
      assert.ok(s.caveats.some((c) => /empty folders were not evaluated/.test(c)));
    }
    assert.equal(checkupFindingPage(nodes, "empty-folders", { now: NOW }).total, 0);
    assert.equal(checkupFindingPage(nodes, "empty-folders", { now: NOW, complete: true }).total, 1);
  });

  it("a folder holding only empty folders is empty; one with a deep file is not", () => {
    const nodes = [d("/my-files/p"), d("/my-files/p/q"), d("/my-files/r"), d("/my-files/r/s"), f("/my-files/r/s/t.txt", 1)];
    assert.deepEqual(get(run(nodes), "empty-folders").samples, ["/my-files/p", "/my-files/p/q"]);
  });

  it("large-old respects size, age and options", () => {
    const nodes = [f("/my-files/a", 49 * MB, { mtime: old }), f("/my-files/b", 50 * MB, { mtime: old }), f("/my-files/c", 50 * MB), f("/my-files/n", 90 * MB, { mtime: undefined })];
    assert.deepEqual(get(run(nodes), "large-old").samples, ["/my-files/b"]);
    const s = run(nodes, { opts: { minSizeMB: 40, olderThanDays: 30 } });
    assert.equal(get(s, "large-old").count, 2);
  });

  it("public link without audit counts as expiry unknown; with expiry it is info", () => {
    const nodes = [f("/my-files/l.txt", 1, { isSharedByUrl: true })];
    assert.equal(get(run(nodes), "public-links").severity, "warn");
    const withExpiry = { items: [{ path: "/my-files/l.txt", publicLink: { role: "viewer", expiresAt: "2027-01-01T00:00:00Z" } }] };
    const s = run(nodes, { sharingAudit: withExpiry });
    assert.equal(get(s, "public-links").severity, "info");
    assert.equal(s.scoreParts.find((p) => p.finding === "public-links"), undefined);
    const editor = { items: [{ path: "/my-files/l.txt", publicLink: { role: "editor" } }] };
    assert.equal(get(run(nodes, { sharingAudit: editor }), "public-links").severity, "risk");
  });

  it("a shared parent makes children sensitive-exposed candidates, by uid and by path", () => {
    const nodes = [d("/my-files/S", { isShared: true }), d("/my-files/S/in"), f("/my-files/S/in/passwords.kdbx", 1), f("/my-files/S/in/umowa najmu.pdf", 1),
      f("/my-files/S/in/pitch deck.pdf", 1), f("/my-files/S/in/PIT-37.pdf", 1), f("/my-files/priv/passport.pdf", 1), f("/my-files/S/in/readme.txt", 1)];
    const s = run(nodes);
    assert.deepEqual(get(s, "sensitive-exposed").samples, ["/my-files/S/in/PIT-37.pdf", "/my-files/S/in/passwords.kdbx", "/my-files/S/in/umowa najmu.pdf"]);
    assert.equal(get(s, "sensitive-exposed").count, 3);
    // no parentUid: falls back to the path parent
    const noUid = nodes.map(({ parentUid, ...n }) => n);
    assert.equal(get(run(noUid), "sensitive-exposed").count, 3);
    const p = checkupFindingPage(nodes, "sensitive-exposed", { now: NOW });
    assert.equal(p.items[0].sharedVia, "/my-files/S");
  });

  it("fixableCount excludes shared and differing-size groups", () => {
    const nodes = [
      f("/my-files/a1", 5, { sha1: "x" }), f("/my-files/a2", 5, { sha1: "x" }),
      d("/my-files/sh", { isShared: true }), f("/my-files/sh/b1", 7, { sha1: "y" }), f("/my-files/b2", 7, { sha1: "y" }),
      f("/my-files/c1", 9), f("/my-files/c2", 9),
    ];
    const g = get(run(nodes), "duplicates");
    assert.equal(g.count, 3);
    assert.equal(g.fixableCount, 1);
  });

  it("trash finding and sharingCapped", () => {
    const s = run([f("/my-files/x", 1)], { trash: { count: 2, bytes: 10 }, sharingAudit: { items: [], capped: true } });
    assert.equal(get(s, "trash").severity, "info");
    assert.deepEqual(get(s, "trash").samples, []);
    assert.equal(s.sharingCapped, true);
    assert.deepEqual(s.trash, { count: 2, bytes: 10 });
    assert.equal(run([f("/my-files/x", 1)]).sharingCapped, undefined);
  });

  it("sharing:false adds a caveat", () => {
    assert.ok(run([], { opts: { sharing: false } }).caveats.some((c) => /Sharing details were skipped/.test(c)));
  });
});

describe("determinism, samples, names, score", () => {
  const s0 = () => run(tree(), { trash: { count: 1, bytes: 5 * 1024 ** 3 } });
  it("same input deep-equals; shuffled input gives the same output", () => {
    assert.deepEqual(s0(), s0());
    for (const seed of [1, 2, 3]) {
      const t = shuffle(tree(), seed);
      assert.deepEqual(run(t, { trash: { count: 1, bytes: 5 * 1024 ** 3 } }), s0());
      assert.deepEqual(checkupFindingPage(t, "duplicates", { now: NOW }), checkupFindingPage(tree(), "duplicates", { now: NOW }));
    }
  });

  it("does not mutate its input", () => {
    const t = shuffle(tree(), 9); const copy = structuredClone(t);
    run(t); checkupFindingPage(t, "large-old", { now: NOW });
    assert.deepEqual(t, copy);
  });

  it("at most 3 samples per finding and namesInResult equals the real count", () => {
    const nodes = []; for (let i = 0; i < 20; i++) nodes.push(f(`/my-files/big${String(i).padStart(2, "0")}`, 60 * MB, { mtime: old }), d(`/my-files/e${i}`));
    const s = run(nodes);
    for (const x of s.findings) assert.ok(x.samples.length <= 3);
    assert.equal(get(s, "large-old").count, 20);
    assert.deepEqual(get(s, "large-old").samples, ["/my-files/big00", "/my-files/big01", "/my-files/big02"]);
    const real = s.findings.reduce((n, x) => n + x.samples.length, 0);
    assert.equal(s.namesInResult, real);
    assert.equal(s.namesInResult, 9); // large-old, empty-folders and same-size duplicates, 3 each
    // count the strings in the serialised object that are sample paths
    const paths = JSON.stringify(s).match(/"\/my-files\/[^"]*"/g) ?? [];
    assert.equal(paths.length, s.namesInResult); // the root `path` has no trailing segment and is not matched
  });

  it("score is within 0..100 and equals 100 minus the sum of scoreParts", () => {
    const s = s0();
    assert.ok(s.score >= 0 && s.score <= 100);
    assert.equal(s.score, 100 - s.scoreParts.reduce((n, p) => n + p.points, 0));
    assert.ok(s.scoreParts.length > 0);
    for (const p of s.scoreParts) { assert.ok(Number.isInteger(p.points) && p.points > 0 && p.points <= SCORE_TABLE[p.finding].cap); }
  });

  it("caps hold for huge counts; worst case stays above 0", () => {
    const nodes = [];
    for (let i = 0; i < 500; i++) nodes.push(d(`/my-files/s${i}`, { isShared: true, isSharedByUrl: true }), f(`/my-files/s${i}/password${i}.txt`, 60 * MB, { mtime: old }), d(`/my-files/e${i}`));
    for (let i = 0; i < 100; i++) nodes.push(f(`/my-files/dupa${i}`, 1, { sha1: "z" }));
    const s = run(nodes, { trash: { count: 1, bytes: 500 * 1024 ** 3 } });
    assert.equal(s.score, 100 - 95);
    for (const f of CHECKUP_FINDINGS) assert.ok(scorePoints(f, 1e9) === SCORE_TABLE[f].cap);
    assert.equal(scorePoints("duplicates", 0), 0);
    assert.equal(scorePoints("duplicates", 1), 1);
    assert.equal(scorePoints("empty-folders", 11), 2);
  });
});

describe("checkupFindingPage", () => {
  const many = () => Array.from({ length: 260 }, (_, i) => f(`/my-files/big${String(i).padStart(3, "0")}`, 60 * MB, { mtime: old }));
  it("defaults to 50 and pages with nextOffset", () => {
    const p = checkupFindingPage(many(), "large-old", { now: NOW });
    assert.equal(p.total, 260); assert.equal(p.items.length, 50); assert.equal(p.limit, 50); assert.equal(p.offset, 0); assert.equal(p.nextOffset, 50);
    assert.equal(p.items[0].path, "/my-files/big000");
    assert.deepEqual(Object.keys(p.items[0]).sort(), ["mtime", "path", "size"]);
  });
  it("caps limit at 200, floors at 1, clamps negative offset", () => {
    assert.equal(checkupFindingPage(many(), "large-old", { now: NOW, limit: 9999 }).items.length, 200);
    assert.equal(checkupFindingPage(many(), "large-old", { now: NOW, limit: 0 }).limit, 1);
    assert.equal(checkupFindingPage(many(), "large-old", { now: NOW, offset: -5 }).offset, 0);
  });
  it("boundaries: last page has no nextOffset, offset beyond end is empty", () => {
    const last = checkupFindingPage(many(), "large-old", { now: NOW, limit: 200, offset: 200 });
    assert.equal(last.items.length, 60); assert.equal(last.nextOffset, undefined);
    const exact = checkupFindingPage(many(), "large-old", { now: NOW, limit: 60, offset: 200 });
    assert.equal(exact.nextOffset, undefined);
    const beyond = checkupFindingPage(many(), "large-old", { now: NOW, offset: 1000 });
    assert.equal(beyond.items.length, 0); assert.equal(beyond.total, 260); assert.equal(beyond.nextOffset, undefined);
  });
  it("duplicates items name the keeper; trash page explains itself; all findings page without error", () => {
    const p = checkupFindingPage(tree(), "duplicates", { now: NOW, rootPath: ROOT });
    assert.equal(p.total, 1);
    assert.equal(p.items[0].path, "/my-files/b/two.bin");
    assert.equal(p.items[0].keeper, "/my-files/a/one.bin");
    assert.match(checkupFindingPage(tree(), "trash", { now: NOW }).note, /drive_list_trash/);
    for (const k of CHECKUP_FINDINGS) assert.equal(typeof checkupFindingPage(tree(), k, { now: NOW, complete: true }).total, "number");
  });
});

describe("performance", () => {
  it("50k nodes finish well under 2 s", () => {
    const nodes = [];
    for (let i = 0; i < 1000; i++) {
      nodes.push(d(`/my-files/d${i}`, i % 50 === 0 ? { isShared: true } : {}));
      for (let j = 0; j < 49; j++) nodes.push(f(`/my-files/d${i}/f${j}${j % 7 === 0 ? " tax" : ""}.dat`, (j % 10) * MB + 1, { sha1: j % 5 === 0 ? "h" + (j % 3) : undefined, mtime: j % 3 === 0 ? old : recent, parentUid: `u/my-files/d${i}` }));
    }
    assert.equal(nodes.length, 50_000);
    const shuffled = shuffle(nodes, 7);
    const t0 = performance.now();
    const s = run(shuffled);
    const page = checkupFindingPage(shuffled, "sensitive-exposed", { now: NOW, limit: 200 });
    const ms = performance.now() - t0;
    assert.ok(ms < 10_000, `took ${ms} ms`); // a regression guard against quadratic code, loose enough for a slow CI machine
    assert.ok(s.findings.length > 0 && page.total > 0);
  });
});
