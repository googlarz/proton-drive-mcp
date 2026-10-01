// Persistent walk index store: file safety, limits, opt-in default.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readdirSync, symlinkSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexEnabled, indexDir, indexPath, readIndex, writeIndex, deleteIndex, indexStatus, MAX_ENTRIES, MAX_BYTES } from "../dist/services/walkIndex.js";

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

  it("never chmods or writes into a pre-existing directory with group/other access; warns once", () => {
    mkdirSync(indexDir(), { recursive: true });
    chmodSync(indexDir(), 0o755);
    const warns = [];
    const orig = process.stderr.write;
    process.stderr.write = (m) => { warns.push(String(m)); return true; };
    let r1, r2;
    try { r1 = writeIndex(file([entry(1)])); r2 = writeIndex(file([entry(1)])); } finally { process.stderr.write = orig; }
    assert.equal(r1, "refused");
    assert.equal(r2, "refused");
    assert.equal(statSync(indexDir()).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(indexDir()), []);
    assert.equal(warns.filter((w) => w.includes(indexDir())).length, 1);
  });

  it("accepts a pre-existing 0700 directory", () => {
    mkdirSync(indexDir(), { recursive: true, mode: 0o700 });
    chmodSync(indexDir(), 0o700);
    assert.equal(writeIndex(file([entry(1)])), "ok");
  });

  for (const mask of [0o000, 0o022]) {
    it(`creates a new directory 0700 under umask ${mask.toString(8).padStart(3, "0")}, leaving parents alone`, () => {
      const old = process.umask(mask);
      try {
        process.env.PROTON_DRIVE_INDEX_DIR = join(tmp, "new-parent", "idx");
        assert.equal(writeIndex(file([entry(1)])), "ok");
        assert.equal(statSync(indexDir()).mode & 0o777, 0o700);
        assert.equal(statSync(indexPath()).mode & 0o777, 0o600);
        assert.equal(statSync(join(tmp, "new-parent")).mode & 0o777, 0o777 & ~mask);
      } finally { process.umask(old); }
    });
  }

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

  it("rejects a file with group/other permission bits (planted 0666)", () => {
    assert.equal(writeIndex(file([entry(1)])), "ok");
    chmodSync(indexPath(), 0o666);
    assert.equal(readIndex(), undefined);
    chmodSync(indexPath(), 0o640);
    assert.equal(readIndex(), undefined);
    chmodSync(indexPath(), 0o600);
    assert.ok(readIndex());
  });

  it("rejects a non-regular index file and an oversize one before reading it", () => {
    mkdirSync(indexPath(), { recursive: true, mode: 0o700 }); // a directory in the way
    assert.equal(readIndex(), undefined);
    rmSync(indexPath(), { recursive: true });
    writeFileSync(indexPath(), "", { mode: 0o600 });
    truncateSync(indexPath(), MAX_BYTES + 1); // sparse
    assert.equal(readIndex(), undefined);
  });

  it("rejects entries completed more than 5 minutes in the future; a small skew is fine", () => {
    assert.equal(writeIndex(file([{ ...entry(1), completedAt: Date.now() + 3_600_000 }])), "ok");
    assert.equal(readIndex(), undefined);
    assert.equal(writeIndex(file([{ ...entry(1), completedAt: Date.now() + 60_000 }])), "ok");
    assert.ok(readIndex());
    for (const bad of [null, "x", Infinity]) {
      writeFileSync(indexPath(), JSON.stringify(file([{ ...entry(1), completedAt: bad }])), { mode: 0o600 });
      assert.equal(readIndex(), undefined);
    }
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
