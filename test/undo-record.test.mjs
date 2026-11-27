// beginBatch (src/services/undoRecord.ts) on a stub drive: what is journalled and what the result says.
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginBatch } from "../dist/services/undoRecord.js";
import { createUndoJournal } from "../dist/utils/undoJournal.js";

let dir, journal;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "undo-record-"));
  journal = createUndoJournal({ dir: join(dir, "undo"), account: "acct-1" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const stub = () => ({
  listed: [],
  async listEntries(parent) {
    this.listed.push(parent);
    return ["a.jpg", "b.jpg"].map((name) => ({ item: { uid: `${parent}:${name}` }, file: { name, path: `${parent}/${name}` } }));
  },
  async listTrash() { return []; },
});
const begin = (drive, paths, over = {}) => beginBatch(drive, { journal }, { tool: "drive_trash", kind: "trash", paths, ...over });

describe("trashed photos are not undoable (they go to /photos-trash, which drive_undo never lists)", () => {
  it("a photo alone gets no undoId, writes no record and says why", async () => {
    const drive = stub();
    const b = await begin(drive, ["/photos/a.jpg"]);
    b.complete();
    const r = b.report();
    assert.equal(r.undoId, undefined);
    assert.equal(r.notUndoable, 1);
    assert.match(r.undo, /not undoable.*\/photos-trash/);
    assert.deepEqual(journal.list(), []);
    assert.deepEqual(b.uids, []);
    assert.deepEqual(drive.listed, []);
    assert.equal(await b.settleAfterError(), undefined);
  });

  it("in a mixed batch only the other items are recorded, and the photos are counted as not undoable", async () => {
    const b = await begin(stub(), ["/photos/a.jpg", "/my-files/docs/b.jpg", "/photos/b.jpg"], { tool: "drive_bulk_trash", checkTrash: true });
    const r = b.report();
    assert.equal(r.notUndoable, 2);
    assert.match(r.undo, /2 item\(s\) not undoable.*\/photos-trash/);
    assert.deepEqual(journal.get(r.undoId).items.map((i) => i.from), ["/my-files/docs/b.jpg"]);
  });

  it("a folder merely named like the photos root is recorded as usual", async () => {
    const r = (await begin(stub(), ["/my-files/photos/a.jpg"])).report();
    assert.match(r.undoId, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(r.notUndoable, undefined);
  });
});
