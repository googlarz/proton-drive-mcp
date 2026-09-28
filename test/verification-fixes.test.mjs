// Fixes from the release-candidate verification round (2026-09-28).
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { join } from "node:path";
import { DriveService } from "../dist/services/drive.js";
import { makeSandbox, startServer, nonVersionCalls } from "./helpers/mcp-client.mjs";

function makeRunner() {
  const calls = [];
  const queued = [];
  const runner = async (args) => {
    calls.push([...args]);
    return queued.length ? queued.shift() : null;
  };
  return { runner, calls, queue: (...rs) => queued.push(...rs) };
}

const trashed = (name, uid) => ({ uid, name: { ok: true, value: name }, type: "file" });

describe("album delete guard fails closed", () => {
  it("refuses without force when the album can't be found in the album list", async () => {
    const t = makeRunner();
    // assertAlbumUnambiguous listing, then the emptiness-check listing: neither has the album.
    t.queue([], []);
    await assert.rejects(
      () => new DriveService(t.runner).deleteAlbum("/albums/Missing", false, false),
      /Could not find album \/albums\/Missing/,
    );
    assert.ok(!t.calls.some((c) => c[0] === "album" && c[1] === "delete"), "must not call album delete");
  });
});

describe("/photos-trash duplicate refusal", () => {
  it("refuses a /photos-trash path shared by two trashed photos, without a mutating call", async () => {
    const t = makeRunner();
    t.queue([trashed("IMG_1.jpg", "p1"), trashed("IMG_1.jpg", "p2")]);
    await assert.rejects(
      () => new DriveService(t.runner).delete("/photos-trash/IMG_1.jpg"),
      /2 trashed items share the path \/photos-trash\/IMG_1\.jpg: uid p1 .*uid p2/,
    );
    assert.deepEqual(t.calls, [["filesystem", "list", "/photos-trash"]]);
  });

  it("deletes a uniquely named /photos-trash item by path", async () => {
    const t = makeRunner();
    t.queue([trashed("IMG_1.jpg", "p1"), trashed("IMG_2.jpg", "p2")], [{ uid: "p1", ok: true }]);
    await new DriveService(t.runner).delete("/photos-trash/IMG_1.jpg");
    assert.deepEqual(t.calls.at(-1), ["filesystem", "delete", "/photos-trash/IMG_1.jpg"]);
  });
});

describe("drive_move onto an existing folder", () => {
  it("hints that destinationPath is the full new path when the destination is a folder", async () => {
    const t = makeRunner();
    // destination listing shows `Archive` as a folder; source info succeeds.
    t.queue([{ uid: "d1", name: { ok: true, value: "Archive" }, type: "folder" }], { uid: "s1" });
    await assert.rejects(
      () => new DriveService(t.runner).move("/my-files/in/report.pdf", "/my-files/Archive"),
      /Destination already exists: \/my-files\/Archive — it is a folder; to move into it, pass the full new path, e\.g\. \/my-files\/Archive\/report\.pdf/,
    );
  });

  it("keeps the plain message when the existing destination is a file", async () => {
    const t = makeRunner();
    t.queue([{ uid: "f1", name: { ok: true, value: "new.pdf" }, type: "file" }], { uid: "s1" });
    await assert.rejects(
      () => new DriveService(t.runner).move("/my-files/old.pdf", "/my-files/Archive/new.pdf"),
      (e) => /^Destination already exists: \/my-files\/Archive\/new\.pdf$/.test(e.message),
    );
  });
});

describe("retry on the CLI's 'database is locked' (real server, fake CLI)", () => {
  const sandboxes = [];
  const clients = [];
  after(async () => {
    for (const c of clients) await c.close();
    for (const s of sandboxes) s.cleanup();
  });

  async function server(lockedTimes) {
    const sb = makeSandbox();
    sandboxes.push(sb);
    const client = await startServer("locked-then-json", sb, {
      FAKE_COUNTER: join(sb.dir, "counter"),
      FAKE_LOCKED_TIMES: String(lockedTimes),
      FAKE_STDOUT: JSON.stringify([{ uid: "a", name: { ok: true, value: "a.txt" }, type: "file" }]),
      // version probe must not consume the lock budget
    });
    clients.push(client);
    return { client, sb };
  }

  it("retries a read-only command until the lock clears", async () => {
    const { client, sb } = await server(2);
    const res = await client.call("drive_list", { path: "/my-files" });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.data.total, 1);
    assert.equal(nonVersionCalls(sb.argvLog).length, 3, "two locked attempts + one success");
  });

  it("gives up after three attempts and reports the lock", async () => {
    const { client, sb } = await server(5);
    const res = await client.call("drive_list", { path: "/my-files" });
    assert.equal(res.isError, true);
    assert.match(res.text, /database is locked/);
    assert.equal(nonVersionCalls(sb.argvLog).length, 3);
  });

  it("does not retry a mutating command", async () => {
    const { client, sb } = await server(1);
    const res = await client.call("drive_mkdir", { path: "/my-files/new" });
    assert.equal(res.isError, true);
    assert.match(res.text, /database is locked/);
    assert.equal(nonVersionCalls(sb.argvLog).length, 1);
  });
});
