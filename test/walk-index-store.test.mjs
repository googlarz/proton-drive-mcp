// Persistent walk index store: file safety, limits, opt-in default.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readdirSync, symlinkSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexEnabled, indexDir, indexPath, readIndex, writeIndex, deleteIndex, indexStatus, MAX_ENTRIES } from "../dist/services/walkIndex.js";

let tmp;
const entry = (i, nodes = 1) => ({
  key: `k${i}`, root: `/my-files/r${i}`, opts: { maxCalls: 300, exclude: [".git"] }, completedAt: 1000 + i,
  nodes: Array.from({ length: nodes }, (_, n) => ({ path: `/my-files/r${i}/f${n}`, uid: `u${i}-${n}`, type: "file" })),
});
const file = (entries, accountKey = "acct") => ({ version: 1, accountKey, savedAt: 5000, entries });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pdidx-"));
  process.env.PROTON_DRIVE_INDEX = "1";
  process.env.PROTON_DRIVE_INDEX_DIR = join(tmp, "idx");
});
afterEach(() => {
  delete process.env.PROTON_DRIVE_INDEX;
  delete process.env.PROTON_DRIVE_INDEX_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

describe("walk index store", () => {
  it("is disabled by default and writes nothing", () => {
    delete process.env.PROTON_DRIVE_INDEX;
    assert.equal(indexEnabled(), false);
    assert.equal(writeIndex(file([entry(1)])), "disabled");
    assert.equal(existsSync(join(tmp, "idx")), false);
    process.env.PROTON_DRIVE_INDEX = "0";
    assert.equal(indexEnabled(), false);
    process.env.PROTON_DRIVE_INDEX = "true";
    assert.equal(indexEnabled(), true);
    process.env.PROTON_DRIVE_INDEX = "1";
    assert.equal(indexEnabled(), true);
  });

  it("honours PROTON_DRIVE_INDEX_DIR and has a platform default", () => {
    assert.equal(indexDir(), join(tmp, "idx"));
    assert.equal(indexPath(), join(tmp, "idx", "walk-index.json"));
    delete process.env.PROTON_DRIVE_INDEX_DIR;
    assert.match(indexDir(), /proton-drive-mcp$/);
  });

  it("writes atomically with modes 0600 / 0700 and round-trips", () => {
    assert.equal(writeIndex(file([entry(1, 3)])), "ok");
    assert.equal(statSync(indexDir()).mode & 0o777, 0o700);
    assert.equal(statSync(indexPath()).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(indexDir()), ["walk-index.json"]); // no temp file left
    const back = readIndex();
    assert.equal(back.accountKey, "acct");
    assert.equal(back.entries[0].nodes.length, 3);
  });

  it("tightens a pre-existing loose directory", () => {
    mkdirSync(indexDir(), { recursive: true, mode: 0o755 });
    assert.equal(writeIndex(file([entry(1)])), "ok");
    assert.equal(statSync(indexDir()).mode & 0o077, 0);
  });

  it("refuses a symlinked directory", () => {
    const real = join(tmp, "real"); mkdirSync(real);
    symlinkSync(real, join(tmp, "idx"));
    assert.equal(writeIndex(file([entry(1)])), "refused");
    assert.deepEqual(readdirSync(real), []);
  });

  it("refuses a symlinked index file and never writes through it", () => {
    mkdirSync(indexDir(), { mode: 0o700, recursive: true });
    const victim = join(tmp, "victim.txt"); writeFileSync(victim, "keep");
    symlinkSync(victim, indexPath());
    assert.equal(writeIndex(file([entry(1)])), "refused");
    assert.equal(readFileSync(victim, "utf8"), "keep");
    assert.equal(readIndex(), undefined);
  });

  it("ignores a corrupt file, an unknown version, and a malformed shape, then overwrites", () => {
    mkdirSync(indexDir(), { mode: 0o700, recursive: true });
    for (const body of ["{not json", JSON.stringify({ ...file([]), version: 2 }), JSON.stringify({ version: 1, entries: "x" }), "null"]) {
      writeFileSync(indexPath(), body, { mode: 0o600 });
      assert.equal(readIndex(), undefined);
    }
    assert.equal(writeIndex(file([entry(1)])), "ok");
    assert.equal(readIndex().entries.length, 1);
  });

  it("keeps only the most recent entries", () => {
    const many = Array.from({ length: MAX_ENTRIES + 4 }, (_, i) => entry(i));
    assert.equal(writeIndex(file(many)), "ok");
    const back = readIndex().entries;
    assert.equal(back.length, MAX_ENTRIES);
    assert.deepEqual(back.map((e) => e.key), many.slice(-MAX_ENTRIES).reverse().map((e) => e.key));
  });

  it("skips writing above the size cap", () => {
    assert.equal(writeIndex(file([entry(1, 50)]), { maxBytes: 1000 }), "too-large");
    assert.equal(existsSync(indexPath()), false);
  });

  it("status and clear work and are safe when missing", () => {
    assert.equal(indexStatus().exists, false);
    assert.deepEqual(deleteIndex(), { path: indexPath(), deleted: false, bytes: 0 });
    writeIndex(file([entry(1, 2), entry(2, 5)]));
    const s = indexStatus();
    assert.equal(s.exists, true);
    assert.equal(s.enabled, true);
    assert.ok(s.bytes > 0);
    assert.deepEqual(s.entries.map((e) => [e.root, e.nodes]).sort(), [["/my-files/r1", 2], ["/my-files/r2", 5]]);
    const d = deleteIndex();
    assert.equal(d.deleted, true);
    assert.equal(existsSync(indexPath()), false);
  });
});
