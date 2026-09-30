// Pure plan/diff logic for drive_sync_plan, drive_bulk_move, drive_bulk_trash.
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffTrees, makeIgnore, scanLocal, planBulkMove, planBulkTrash, foldersToList, syncPlan, sha1File } from "../dist/services/plan.js";

const walk = (nodes, extra = {}) => ({ root: "/my-files/p", nodes, complete: true, callsMade: 1, skipped: [], fromCache: false, ageMs: 0, ...extra });
const file = (rel, size, mtime, sha1) => ({ path: `/my-files/p/${rel}`, uid: "u" + rel, type: "file", size, mtime, sha1 });
const T = Date.parse("2026-09-01T00:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

describe("diffTrees", () => {
  it("classifies onlyLocal, onlyDrive, changed, identical", async () => {
    const d = await diffTrees(
      [{ path: "new.txt", size: 1, mtimeMs: T }, { path: "same.txt", size: 5, mtimeMs: T + 1500 }, { path: "big.txt", size: 9, mtimeMs: T }, { path: "touched.txt", size: 5, mtimeMs: T + 60_000 }],
      walk([file("same.txt", 5, iso(T)), file("big.txt", 7, iso(T)), file("touched.txt", 5, iso(T)), file("gone.txt", 3, iso(T)), { path: "/my-files/p/sub", uid: "f", type: "folder" }]),
    );
    assert.deepEqual(d.onlyLocal.map((i) => i.path), ["new.txt"]);
    assert.deepEqual(d.onlyDrive.map((i) => i.path), ["gone.txt"]);
    assert.deepEqual(d.changed.map((i) => [i.path, i.reason, i.newer]), [
      ["big.txt", "size differs", undefined],
      ["touched.txt", "maybe changed (same size, mtime differs)", "local"],
    ]);
    assert.equal(d.identicalCount, 1); // 1.5 s apart is inside the 2 s tolerance
  });

  it("treats a missing Drive mtime as identical when sizes match", async () => {
    const d = await diffTrees([{ path: "a", size: 1, mtimeMs: T }], walk([file("a", 1, undefined)]));
    assert.equal(d.identicalCount, 1);
  });

  it("sha1 mode: matching hash overrides an mtime difference; mismatch flags changed; no claimed sha1 falls back", async () => {
    const local = ["a", "b", "c"].map((p) => ({ path: p, size: 1, mtimeMs: T + 99_000 }));
    const nodes = [file("a", 1, iso(T), "AAAA"), file("b", 1, iso(T), "bbbb"), file("c", 1, iso(T))];
    const hashed = [];
    const d = await diffTrees(local, walk(nodes), { compare: "sha1", hashLocal: async (p) => { hashed.push(p); return p === "a" ? "aaaa" : "zzzz"; } });
    assert.deepEqual(hashed, ["a", "b"]);
    assert.deepEqual(d.changed.map((i) => [i.path, i.reason]), [["b", "sha1 differs"], ["c", "maybe changed (same size, mtime differs)"]]);
    assert.equal(d.identicalCount, 1);
  });

  it("applies the ignore predicate to both sides", async () => {
    const d = await diffTrees(
      [{ path: ".git/x", size: 1, mtimeMs: T }],
      walk([file("node_modules/y", 1, iso(T)), file("keep", 1, iso(T))]),
      { ignore: makeIgnore([".git", "node_modules"]) },
    );
    assert.deepEqual([d.onlyLocal.length, d.onlyDrive.map((i) => i.path)], [1, ["keep"]]); // local .git/x is not pre-filtered by diff itself
  });
});

describe("makeIgnore", () => {
  const ig = makeIgnore([".git", "*.log", "build/out", "docs/**/tmp"]);
  it("matches by segment, extension glob, and path prefixes", () => {
    for (const p of [".git/config", "a/.git/x", "x.log", "a/b/x.log", "build/out/a", "docs/a/b/tmp/f"]) assert.ok(ig(p), p);
    for (const p of ["src/a.ts", "build/in", "logs/a"]) assert.ok(!ig(p), p);
  });
});

describe("scanLocal and syncPlan (real temp dir, injected walk)", () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "plan-scan-"));
    mkdirSync(join(dir, "sub"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "a.txt"), "hello");
    writeFileSync(join(dir, "sub", "b.txt"), "bb");
    writeFileSync(join(dir, ".git", "HEAD"), "x");
    writeFileSync(join(dir, ".DS_Store"), "x");
    symlinkSync("/etc", join(dir, "link-out"));
    utimesSync(join(dir, "a.txt"), T / 1000, T / 1000);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("skips ignored names, counts symlinks without following them", () => {
    const s = scanLocal(dir, makeIgnore([".git", ".DS_Store"]));
    assert.deepEqual(s.files.map((f) => f.path).sort(), ["a.txt", "sub/b.txt"]);
    assert.equal(s.symlinksSkipped, 1);
    assert.equal(s.truncated, false);
  });

  it("is bounded: reports truncation", () => {
    const s = scanLocal(dir, () => false, 2);
    assert.equal(s.truncated, true);
    assert.ok(s.scanned <= 2);
  });

  it("syncPlan diffs, caps lists, flags incomplete walks, and never mutates", async () => {
    const calls = [];
    const svc = { list: async (...a) => { calls.push(a); return []; } };
    const fakeWalk = async () => walk([file("a.txt", 5, iso(T)), file("only.txt", 4, iso(T))], { root: "/my-files/p", complete: false, skipped: [{ path: "/my-files/p/x", reason: "maxCalls" }] });
    const r = await syncPlan(svc, { localPath: dir, drivePath: "/my-files/p", direction: "both", limit: 1 }, fakeWalk);
    assert.deepEqual(r.counts, { onlyLocal: 1, onlyDrive: 1, changed: 0, identical: 1 });
    assert.equal(r.onlyLocal[0].path, "sub/b.txt");
    assert.equal(r.bytes.upload, 2);
    assert.equal(r.bytes.download, 4);
    assert.equal(r.complete, false);
    assert.equal(r.local.symlinksSkipped, 1);
    assert.match(r.note, /walk incomplete/);
    assert.deepEqual(calls, []);
  });

  it("up direction reports no download bytes; sha1 equals node's hash of the content", async () => {
    const r = await syncPlan({}, { localPath: dir, drivePath: "/my-files/p" }, async () => walk([]));
    assert.equal("download" in r.bytes, false);
    assert.equal(await sha1File(join(dir, "a.txt")), "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
  });

  it("rejects parent directories of protected locations and prunes secret-named entries", async () => {
    for (const localPath of ["/", "/Users", process.env.HOME]) {
      await assert.rejects(syncPlan({}, { localPath, drivePath: "/my-files/p" }, async () => walk([])), /contains protected locations/);
    }
    const d = mkdtempSync(join(tmpdir(), "plan-prot-"));
    try {
      writeFileSync(join(d, "ok.txt"), "x");
      writeFileSync(join(d, ".env"), "SECRET");
      writeFileSync(join(d, "id_rsa"), "KEY");
      writeFileSync(join(d, "cert.pem"), "KEY");
      const s = scanLocal(d, () => false);
      assert.deepEqual(s.files.map((f) => f.path), ["ok.txt"]);
      assert.equal(s.protectedSkipped, 3);
      const r = await syncPlan({}, { localPath: d, drivePath: "/my-files/p" }, async () => walk([]));
      assert.equal(r.local.protectedSkipped, 3);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("applies the local path guard like upload does", async () => {
    await assert.rejects(syncPlan({}, { localPath: join(process.env.HOME, ".ssh"), drivePath: "/my-files/p" }, async () => walk([])), /protected location/);
    await assert.rejects(syncPlan({}, { localPath: "relative/dir", drivePath: "/my-files/p" }, async () => walk([])), /absolute/);
  });
});

const L = (o) => new Map(Object.entries(o).map(([k, v]) => [k, v === null ? null : new Set(v)]));

describe("planBulkMove", () => {
  it("plans keeping names when clean", () => {
    const p = planBulkMove(["/my-files/a/x.txt", "/my-files/b/y"], "/my-files/dst", L({ "/my-files/a": ["x.txt"], "/my-files/b": ["y"], "/my-files/dst": ["other"] }));
    assert.deepEqual(p, { plan: [{ source: "/my-files/a/x.txt", destination: "/my-files/dst/x.txt" }, { source: "/my-files/b/y", destination: "/my-files/dst/y" }], problems: [] });
  });

  it("detects every problem class and then plans nothing", () => {
    const listing = L({ "/my-files": ["dup", "src", "src2"], "/my-files/src": ["c"], "/my-files/dst": ["dup", "c2"], "/my-files/q": ["c2"] });
    const p = planBulkMove(
      ["/my-files/dup", "/my-files/dup", "/my-files/missing", "/my-files/src", "/my-files/src/c", "/my-files/q/c2", "/trash", "/my-files/src2"],
      "/my-files/dst", listing);
    const by = (s) => p.problems.filter((x) => x.source === s).map((x) => x.problem);
    assert.match(by("/my-files/dup")[0], /listed more than once/);
    assert.match(by("/my-files/missing")[0], /source not found/);
    assert.match(by("/my-files/src/c")[0], /inside another listed source/);
    assert.match(by("/my-files/q/c2")[0], /name collision/);
    assert.match(by("/trash")[0], /root/);
    assert.deepEqual(p.plan, []);
  });

  it("flags a missing destination folder, '/' and a missing parent folder", () => {
    assert.match(planBulkMove(["/my-files/a"], "/my-files/nope", L({ "/my-files": ["a"], "/my-files/nope": null })).problems[0].problem, /destination folder not found/);
    assert.match(planBulkMove(["/my-files/a"], "/", L({ "/my-files": ["a"] })).problems[0].problem, /not '\/'/);
    const p = planBulkMove(["/my-files/gone/a"], "/my-files/d", L({ "/my-files/gone": null, "/my-files/d": [] }));
    assert.match(p.problems[0].problem, /source not found/);
  });

  it("flags moving a folder into itself or a descendant, and into its current folder", () => {
    const l = L({ "/my-files": ["f"], "/my-files/f": ["g"] });
    assert.match(planBulkMove(["/my-files/f"], "/my-files/f", l).problems.at(-1).problem, /itself or inside/);
    assert.match(planBulkMove(["/my-files/f"], "/my-files/f/g", L({ "/my-files": ["f"], "/my-files/f/g": [] })).problems.at(-1).problem, /itself or inside/);
    assert.match(planBulkMove(["/my-files/f"], "/my-files", l).problems.at(-1).problem, /already in the destination/);
  });

  it("flags two sources that would land on the same name", () => {
    const p = planBulkMove(["/my-files/a/x", "/my-files/b/x"], "/my-files/d", L({ "/my-files/a": ["x"], "/my-files/b": ["x"], "/my-files/d": [] }));
    assert.match(p.problems[0].problem, /same name as \/my-files\/a\/x/);
  });

  it("keeps the escaped name when building the destination", () => {
    const p = planBulkMove(["/my-files/a/r\\/s"], "/my-files/d", L({ "/my-files/a": ["r\\/s"], "/my-files/d": [] }));
    assert.equal(p.plan[0].destination, "/my-files/d/r\\/s");
  });
});

describe("planBulkTrash / foldersToList", () => {
  it("plans clean paths and flags missing, duplicate, nested and root", () => {
    const l = L({ "/my-files": ["a", "d"], "/my-files/d": ["e"] });
    assert.deepEqual(planBulkTrash(["/my-files/a", "/my-files/d"], l), { plan: [{ source: "/my-files/a" }, { source: "/my-files/d" }], problems: [] });
    const bad = planBulkTrash(["/my-files/a", "/my-files/a", "/my-files/zzz", "/my-files/d", "/my-files/d/e", "/trash"], l);
    assert.equal(bad.problems.length, 4);
    assert.deepEqual(bad.plan, []);
  });

  it("lists each distinct parent once, plus the destination", () => {
    assert.deepEqual(foldersToList(["/my-files/a/x", "/my-files/a/y", "/my-files/z"], "/my-files/d"), ["/my-files/a", "/my-files", "/my-files/d"]);
    assert.deepEqual(foldersToList(["/my-files/z"]), ["/my-files"]);
  });
});
