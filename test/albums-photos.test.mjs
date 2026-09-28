// Album/photo behaviour fixes confirmed live against CLI 0.8.0.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriveService } from "../dist/services/drive.js";
import { makeSandbox, fakeEnv, startServer, nonVersionCalls, DIST_CLI } from "./helpers/mcp-client.mjs";

function makeRunner() {
  const calls = [];
  const queued = [];
  const runner = async (args) => {
    calls.push([...args]);
    return queued.length ? queued.shift() : null;
  };
  return { runner, calls, queue: (...rs) => queued.push(...rs) };
}
const album = (name, photoCount) => ({ uid: `u-${name}`, name: { ok: true, value: name }, album: { photoCount } });

describe("deleteAlbum refuses a non-empty album unless force (CLI 0.8.0 deletes it without -f)", () => {
  it("refuses when the album still has photos and force is false", async () => {
    const t = makeRunner();
    t.queue([album("Trip", 3)], [album("Trip", 3)]);
    await assert.rejects(() => new DriveService(t.runner).deleteAlbum("/albums/Trip", false, false), /contains 3 photo/);
    assert.ok(!t.calls.some((c) => c[1] === "delete"), "must not call album delete");
  });

  it("deletes an empty album without force", async () => {
    const t = makeRunner();
    t.queue([album("Trip", 0)], [album("Trip", 0)]);
    await new DriveService(t.runner).deleteAlbum("/albums/Trip", false, false);
    assert.deepEqual(t.calls.at(-1), ["album", "delete", "/albums/Trip"]);
  });

  it("deletes a non-empty album with force, passing --force/--save through", async () => {
    const t = makeRunner();
    t.queue([album("Trip", 3)]);
    await new DriveService(t.runner).deleteAlbum("/albums/Trip", true, true);
    assert.deepEqual(t.calls.at(-1), ["album", "delete", "/albums/Trip", "--force", "--save"]);
  });
});

describe("photoDownload rejects /albums/ paths (CLI 0.8.0: 'Album not found: <album>/<photo>')", () => {
  it("throws before calling the CLI", async () => {
    const t = makeRunner();
    await assert.rejects(
      () => new DriveService(t.runner).photoDownload(["/photos/a.jpg", "/albums/Trip/a.jpg"], "/tmp/x"),
      /\/photos\/<name>/,
    );
    assert.equal(t.calls.length, 0);
  });
});

describe("rename reports the new album path", () => {
  let sb, c;
  before(async () => { sb = makeSandbox(); c = await startServer("json", sb); });
  after(async () => { await c?.close(); sb?.cleanup(); });

  it("MCP photos_update_album", async () => {
    const r = await c.call("photos_update_album", { albumPath: "/albums/Old", name: "New" });
    assert.match(JSON.stringify(r), /Album updated: \/albums\/New/);
  });

  it("MCP photos_update_album cover-only keeps the old path", async () => {
    const r = await c.call("photos_update_album", { albumPath: "/albums/Old", coverPhotoUid: "uid-1" });
    assert.match(JSON.stringify(r), /Album updated: \/albums\/Old/);
  });

  it("MCP photos_download refuses /albums/ paths", async () => {
    const before = nonVersionCalls(sb.argvLog).filter((a) => a[0] === "photo").length;
    const r = await c.call("photos_download", { photoPaths: ["/albums/Trip/a.jpg"], localFolder: join(tmpdir(), "ph") });
    assert.match(JSON.stringify(r), /\/photos\/<name>/);
    assert.equal(nonVersionCalls(sb.argvLog).filter((a) => a[0] === "photo").length, before);
  });

  it("CLI album update", async () => {
    const sb2 = makeSandbox();
    try {
      const stdout = await new Promise((resolve, reject) => {
        execFile(process.execPath, [DIST_CLI, "album", "update", "/albums/Old", "--name", "New"], { env: fakeEnv("json", sb2), timeout: 20_000 },
          (err, out, errOut) => (err ? reject(new Error(errOut)) : resolve(out)));
      });
      assert.match(stdout, /Album updated: \/albums\/New/);
    } finally { sb2.cleanup(); }
  });
});
