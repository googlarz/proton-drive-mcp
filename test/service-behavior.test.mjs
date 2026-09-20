import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DriveService } from "../dist/services/drive.js";
import { validateRemotePath, validateLocalPath } from "../dist/utils/validation.js";

function makeRunner() {
  const calls = [];
  const queued = [];
  const runner = async (args) => {
    calls.push([...args]);
    if (!queued.length) return null;
    const q = queued.shift();
    if (q instanceof Error) throw q;
    return q;
  };
  return { runner, calls, queue: (...rs) => queued.push(...rs) };
}

describe("list()", () => {
  it("lists the roots for '/' (they have a path but no name) instead of '[unnamed]' entries", async () => {
    const t = makeRunner();
    t.queue([{ path: "/my-files" }, { path: "/trash" }]);
    const files = await new DriveService(t.runner).list("/");
    assert.deepEqual(files.map((f) => [f.name, f.path, f.type]), [
      ["my-files", "/my-files", "folder"],
      ["trash", "/trash", "folder"],
    ]);
  });

  it("does not collapse a '..' name into the parent's path (posix.join did)", async () => {
    const t = makeRunner();
    t.queue([{ uid: "u", name: { ok: true, value: ".." }, type: "folder" }]);
    const [f] = await new DriveService(t.runner).list("/my-files/M");
    assert.equal(f.path, "/my-files/M/..");
  });

  it("lists children of the root without a double slash", async () => {
    const t = makeRunner();
    t.queue([{ uid: "u", name: { ok: true, value: "a" }, type: "file" }]);
    const [f] = await new DriveService(t.runner).list("/");
    assert.equal(f.path, "/a");
  });

  it("listTrash exposes uid and trash time so duplicate names can be told apart", async () => {
    const t = makeRunner();
    t.queue([
      { uid: "u1", name: { ok: true, value: "f1.txt" }, type: "file", trashTime: "2026-09-01T00:00:00Z" },
      { uid: "u2", name: { ok: true, value: "f1.txt" }, type: "file" },
    ]);
    const files = await new DriveService(t.runner).listTrash();
    assert.deepEqual(files.map((f) => f.uid), ["u1", "u2"]);
    assert.equal(files[0].trashedAt, "2026-09-01T00:00:00Z");
  });
});

describe("info()", () => {
  const node = {
    uid: "vol~n1",
    parentUid: "vol~p",
    name: { ok: true, value: "a.txt" },
    keyAuthor: { ok: true, value: "me@proton.me" },
    treeEventScopeId: "vol",
    activeRevision: { uid: "vol~n1~r1", contentAuthor: { ok: true, value: "me@proton.me" }, claimedDigests: { sha1: "x" }, storageSize: 5 },
  };

  it("unwraps verification wrappers and drops lossless noise by default", async () => {
    const t = makeRunner();
    t.queue(node);
    const out = await new DriveService(t.runner).info("/my-files/a.txt");
    assert.deepEqual(out, {
      uid: "vol~n1",
      name: "a.txt",
      activeRevision: { contentAuthor: "me@proton.me", storageSize: 5 },
    });
  });

  it("returns the raw node with verbose=true", async () => {
    const t = makeRunner();
    t.queue(node);
    assert.deepEqual(await new DriveService(t.runner).info("/my-files/a.txt", true), node);
  });
});

describe("mkdir()", () => {
  it("splits on the last unescaped slash", async () => {
    const t = makeRunner();
    await new DriveService(t.runner).mkdir("/my-files/new folder");
    assert.deepEqual(t.calls[0], ["filesystem", "create-folder", "/my-files", "new folder"]);
  });

  it("creates a top-level folder under '/'", async () => {
    const t = makeRunner();
    await new DriveService(t.runner).mkdir("/top");
    assert.deepEqual(t.calls[0], ["filesystem", "create-folder", "/", "top"]);
  });

  it("keeps a trailing space in the folder name", async () => {
    const t = makeRunner();
    await new DriveService(t.runner).mkdir("/my-files/trail ");
    assert.deepEqual(t.calls[0], ["filesystem", "create-folder", "/my-files", "trail "]);
  });
});

describe("copy()", () => {
  it("passes --name for a copy under a new name", async () => {
    const t = makeRunner();
    await new DriveService(t.runner).copy("/my-files/a.txt", "/my-files", "a copy.txt");
    assert.deepEqual(t.calls[0], ["filesystem", "copy", "--name", "a copy.txt", "/my-files/a.txt", "/my-files"]);
  });

  it("only mentions a name collision for actual collisions", async () => {
    const t = makeRunner();
    t.queue([{ uid: "n", ok: false, error: { name: "InvalidRequirementsAPIError", code: 2000, message: "cannot move into itself" } }]);
    await assert.rejects(
      () => new DriveService(t.runner).copy("/a", "/a/b"),
      (e) => /InvalidRequirementsAPIError \(code 2000\): cannot move into itself/.test(e.message) && !/name already exists/.test(e.message)
    );
  });
});

describe("shareRemoveAll()", () => {
  it("does not call the CLI and returns 0 for an unshared item", async () => {
    const t = makeRunner();
    t.queue(null);
    assert.equal(await new DriveService(t.runner).shareRemoveAll("/my-files/x"), 0);
    assert.equal(t.calls.length, 1);
  });

  it("removes everyone and returns the number of members + invitations", async () => {
    const t = makeRunner();
    t.queue({ members: [{ inviteeEmail: "a@pm.me" }], nonProtonInvitations: [{ inviteeEmail: "b@x.com" }] }, null);
    assert.equal(await new DriveService(t.runner).shareRemoveAll("/my-files/x"), 2);
    assert.deepEqual(t.calls[1], ["sharing", "remove", "--everyone", "/my-files/x"]);
  });
});

describe("shareStatus()", () => {
  it("reports link password protection (boolean only) and expiry, never the password", async () => {
    const t = makeRunner();
    t.queue({ urlAccess: { url: "https://u", customPassword: "hunter2", expirationTime: "2026-10-01T00:00:00Z" }, editorsCanShare: true });
    const s = await new DriveService(t.runner).shareStatus("/my-files/x");
    assert.equal(s.sharePasswordProtected, true);
    assert.equal(s.shareUrlExpiresAt, "2026-10-01T00:00:00Z");
    assert.equal(s.editorsCanShare, true);
    assert.ok(!JSON.stringify(s).includes("hunter2"));
  });
});

describe("albums", () => {
  const album = (name, uid) => ({ uid, name: { ok: true, value: name }, album: { photoCount: 0 } });

  it("listAlbums exposes uid", async () => {
    const t = makeRunner();
    t.queue([album("A", "u1")]);
    assert.equal((await new DriveService(t.runner).listAlbums())[0].uid, "u1");
  });

  it("createAlbum refuses a duplicate name (the CLI would create a second, ambiguous album)", async () => {
    const t = makeRunner();
    t.queue([album("Holiday", "u1")]);
    await assert.rejects(() => new DriveService(t.runner).createAlbum("Holiday"), /already exists/);
    assert.equal(t.calls.length, 1, "must not call album create");
  });

  it("createAlbum creates when the name is free", async () => {
    const t = makeRunner();
    t.queue([album("Other", "u1")], null);
    await new DriveService(t.runner).createAlbum("Holiday");
    assert.deepEqual(t.calls[1], ["album", "create", "Holiday"]);
  });

  for (const [label, run] of [
    ["updateAlbum", (d) => d.updateAlbum("/albums/X", "Y")],
    ["deleteAlbum", (d) => d.deleteAlbum("/albums/X", false, false)],
    ["listAlbumPhotos", (d) => d.listAlbumPhotos("/albums/X")],
    ["addPhotoToAlbum", (d) => d.addPhotoToAlbum("/albums/X", "/photos/p.jpg")],
    ["removePhotoFromAlbum", (d) => d.removePhotoFromAlbum("/albums/X", "/photos/p.jpg")],
  ]) {
    it(`${label} refuses an ambiguous /albums/<name> path — confirmed live: it acted on an arbitrary one of the duplicates`, async () => {
      const t = makeRunner();
      t.queue([album("X", "u1"), album("X", "u2")]);
      await assert.rejects(() => run(new DriveService(t.runner)), /Ambiguous album path/);
      assert.equal(t.calls.length, 1, "only the album listing may run");
    });
  }

  it("listAlbumPhotos passes --load-details and maps details", async () => {
    const t = makeRunner();
    t.queue([album("X", "u1")], [{ uid: "p1", name: { ok: true, value: "a.jpg" }, photo: { captureTime: "2026-01-01T00:00:00Z", tags: [1] } }]);
    const photos = await new DriveService(t.runner).listAlbumPhotos("/albums/X", true);
    assert.deepEqual(t.calls[1], ["album", "photos", "/albums/X", "--load-details"]);
    assert.equal(photos[0].name, "a.jpg");
    assert.equal(photos[0].captureTime, "2026-01-01T00:00:00Z");
  });
});

describe("failure results from the other {uid, ok, error} commands", () => {
  const bad = [{ uid: "n", ok: false, error: { name: "SomeError", code: 1 } }];
  for (const [label, run, re] of [
    ["shareLeave", (d) => d.shareLeave("/x"), /Leave failed/],
    ["invitationAccept", (d) => d.invitationAccept("uid"), /Accept invitation failed/],
    ["invitationReject", (d) => d.invitationReject("uid"), /Reject invitation failed/],
  ]) {
    it(`${label} surfaces ok:false`, async () => {
      const t = makeRunner();
      t.queue(bad);
      await assert.rejects(() => run(new DriveService(t.runner)), re);
    });
  }
});

describe("validateRemotePath()", () => {
  it("strips trailing slashes but keeps the root", () => {
    assert.equal(validateRemotePath("/my-files/a/"), "/my-files/a");
    assert.equal(validateRemotePath("/my-files/a//"), "/my-files/a");
    assert.equal(validateRemotePath("/"), "/");
  });
});

describe("validateLocalPath()", () => {
  it("rejects credential locations by default (upload of ~/.ssh would exfiltrate keys)", () => {
    assert.throws(() => validateLocalPath("/etc/passwd"));
  });
  it("accepts an ordinary absolute path", () => {
    assert.equal(validateLocalPath("/tmp/report.pdf"), "/tmp/report.pdf");
  });
});
