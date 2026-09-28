import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveSyncPath, readSyncFile, writeSyncFile } from "../dist/utils/syncfs.js";

describe("sync path mapping (/my-files -> sync root)", () => {
  let root;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "syncmap-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("maps /my-files/<rest> onto the sync root", () => {
    assert.equal(resolveSyncPath(root, "/my-files/a/b.txt"), join(resolve(root), "a", "b.txt"));
  });
  it("maps /my-files itself to the root", () => {
    assert.equal(resolveSyncPath(root, "/my-files"), resolve(root));
    assert.equal(resolveSyncPath(root, "/my-files/"), resolve(root));
  });
  it("keeps legacy root-relative paths", () => {
    assert.equal(resolveSyncPath(root, "/a/b.txt"), join(resolve(root), "a", "b.txt"));
  });
  it("does not treat /my-filesX as /my-files", () => {
    assert.equal(resolveSyncPath(root, "/my-filesX/a"), join(resolve(root), "my-filesX", "a"));
  });
  for (const p of ["/photos/x", "/albums/x", "/trash", "/photos-trash/x", "/shared-with-me/x", "/shared-by-me/x", "/devices/x"]) {
    it(`rejects non-synced root ${p}`, () => {
      assert.throws(() => resolveSyncPath(root, p), /only \/my-files is synced/);
    });
  }
  it("still rejects traversal via /my-files/..", () => {
    assert.throws(() => resolveSyncPath(root, "/my-files/../x"), /outside sync root/);
  });
  it("write+read via /my-files lands at root, not a my-files folder", async () => {
    await writeSyncFile(root, "/my-files/d/a.txt", "hi");
    assert.equal(await readFile(join(root, "d", "a.txt"), "utf8"), "hi");
    await assert.rejects(stat(join(root, "my-files")), { code: "ENOENT" });
    assert.equal(await readSyncFile(root, "/my-files/d/a.txt"), "hi");
  });
});

describe("text decoding", () => {
  let root;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "syncdec-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("rejects non-UTF-8 (Latin-1) with a drive_download hint", async () => {
    await writeFile(join(root, "l1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    await assert.rejects(readSyncFile(root, "/l1.txt"), /not valid UTF-8.*drive_download/);
  });
  it("accepts UTF-8 with Polish and emoji", async () => {
    const s = "Zażółć gęślą jaźń 🚀";
    await writeFile(join(root, "pl.txt"), s, "utf8");
    assert.equal(await readSyncFile(root, "/my-files/pl.txt"), s);
  });
  it("accepts a UTF-8 BOM file", async () => {
    await writeFile(join(root, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("ok", "utf8")]));
    const out = await readSyncFile(root, "/bom.txt");
    assert.ok(out.endsWith("ok"));
  });
});
