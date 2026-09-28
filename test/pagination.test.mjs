// Paging must not lose or duplicate items even though the real CLI returns a
// different order on every call (each page re-runs it). The fake CLI's
// "shuffle" mode reproduces that.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSandbox, startServer } from "./helpers/mcp-client.mjs";
import { DriveService } from "../dist/services/drive.js";

async function walk(items, tool, args, limit) {
  const sb = makeSandbox();
  const c = await startServer("shuffle", sb, { FAKE_STDOUT: JSON.stringify(items) });
  try {
    const seen = [];
    for (let offset = 0; ; offset += limit) {
      const r = await c.call(tool, { ...args, offset, limit });
      assert.equal(r.isError, false, r.text);
      seen.push(...r.data.items);
      if (!r.data.hasMore) return seen;
    }
  } finally {
    await c.close();
    sb.cleanup();
  }
}

const node = (i, extra = {}) => ({ uid: `u${i}`, name: { ok: true, value: `f${i % 40}.txt` }, type: "file", ...extra });

describe("pagination over an unstable CLI order", () => {
  it("drive_list yields every item exactly once (duplicate names included)", async () => {
    const items = Array.from({ length: 120 }, (_, i) => node(i));
    const seen = await walk(items, "drive_list", { path: "/my-files/x" }, 7);
    assert.equal(seen.length, 120);
    // names repeat, so check per-name multiplicity matches
    const count = (arr) => arr.reduce((m, n) => m.set(n, (m.get(n) ?? 0) + 1), new Map());
    assert.deepEqual(count(seen.map((f) => f.name)), count(items.map((f) => f.name.value)));
    const names = seen.map((f) => f.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  });

  it("drive_list_trash breaks trashedAt ties by uid (each item exactly once)", async () => {
    const items = Array.from({ length: 60 }, (_, i) => node(i, { trashTime: `2026-09-28T10:00:0${i % 3}.000Z` }));
    const seen = await walk(items, "drive_list_trash", {}, 7);
    assert.equal(new Set(seen.map((f) => f.uid)).size, 60);
    assert.equal(seen.length, 60);
    assert.equal(seen[0].trashedAt, "2026-09-28T10:00:02.000Z");
  });

  it("photos_list_timeline yields every photo exactly once, newest first", async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ nodeUid: `p${i}`, captureTime: `2026-01-0${1 + (i % 4)}T00:00:00.000Z` }));
    const seen = await walk(items, "photos_list_timeline", {}, 6);
    assert.equal(new Set(seen.map((p) => p.nodeUid)).size, 50);
    assert.equal(seen.length, 50);
    assert.equal(seen[0].captureTime, "2026-01-04T00:00:00.000Z");
  });

  it("photos_list_album_photos yields every photo exactly once", async () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ nodeUid: `p${i}`, captureTime: "2026-01-01T00:00:00.000Z" }));
    const seen = await walk(items, "photos_list_album_photos", { albumPath: "/albums/Trip" }, 9);
    assert.equal(new Set(seen.map((p) => p.nodeUid)).size, 40);
    assert.equal(seen.length, 40);
  });
});

describe("list() size", () => {
  it("reports the active revision's real size, not encrypted storage of all revisions", async () => {
    // Shape taken from real `proton-drive filesystem list --json` output (v0.8.0).
    const runner = async () => [
      {
        uid: "u1", name: { ok: true, value: "a.txt" }, type: "file", totalStorageSize: 208,
        activeRevision: { uid: "u1~r", state: "active", storageSize: 104, claimedSize: 26 },
      },
      { uid: "u2", name: { ok: true, value: "dir" }, type: "folder" },
    ];
    const [file, folder] = await new DriveService(runner).list("/my-files");
    assert.equal(file.size, 26);
    assert.equal(file.storageSize, 208);
    assert.equal(folder.size, undefined);
    assert.equal(folder.storageSize, undefined);
  });
});
