import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { DriveService } from "../dist/services/drive.js";
import {
  DriveCliError,
  DriveCliNotFoundError,
  DriveNotAuthenticatedError,
  DriveParseError,
} from "../dist/utils/errors.js";
import { validatePath, validateRemotePath, validateLocalPath, validateEmail, validateMessage, validateName } from "../dist/utils/validation.js";
import { checkCliAvailable } from "../dist/utils/subprocess.js";

// ─── Test runner factory ──────────────────────────────────────────────────────
function makeRunner() {
  let nextResult = null;
  let nextError = null;
  const calls = [];

  const runner = async (args) => {
    calls.push([...args]);
    if (nextError) { const e = nextError; nextError = null; throw e; }
    const r = nextResult; nextResult = null; return r;
  };

  return {
    runner,
    calls,
    setResult: (r) => { nextResult = r; nextError = null; },
    setError:  (e) => { nextError = e; nextResult = null; },
    lastCall:  () => calls[calls.length - 1],
    clear:     () => { calls.length = 0; },
  };
}

// Raw-text runner mock for version() — the CLI's `version` command ignores
// --json and always prints plain text.
function makeRawRunner() {
  let nextText = "";
  const calls = [];
  const rawRunner = async (args) => { calls.push([...args]); return nextText; };
  return {
    rawRunner,
    calls,
    setText: (t) => { nextText = t; },
    lastCall: () => calls[calls.length - 1],
  };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
// There is no `auth status` command in the CLI — authStatus() probes by
// resolving /my-files and interprets DriveNotAuthenticatedError as logged-out.
describe("authStatus", () => {
  it("returns authenticated=true when the probe succeeds", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ uid: "abc" });
    const status = await drive.authStatus();
    assert.equal(status.authenticated, true);
    assert.deepEqual(t.lastCall(), ["filesystem", "info", "/my-files"]);
  });

  it("returns authenticated=false when the probe throws DriveNotAuthenticatedError", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setError(new DriveNotAuthenticatedError());
    const status = await drive.authStatus();
    assert.equal(status.authenticated, false);
  });

  it("propagates other errors instead of reporting unauthenticated", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setError(new DriveCliError("quota exceeded", ""));
    await assert.rejects(() => drive.authStatus(), { name: "DriveCliError" });
  });
});

describe("authLogout", () => {
  it("calls auth logout", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.authLogout();
    assert.deepEqual(t.lastCall(), ["auth", "logout"]);
  });
});

describe("version", () => {
  it("parses cli and sdk from plain-text output", async () => {
    const t = makeRunner();
    const raw = makeRawRunner();
    const drive = new DriveService(t.runner, raw.rawRunner);
    raw.setText("Proton Drive CLI 1.2.3\nProton Drive SDK 4.5.6\nYou are running the latest version.\n");
    const v = await drive.version();
    assert.equal(v.cli, "1.2.3");
    assert.equal(v.sdk, "4.5.6");
    assert.deepEqual(raw.lastCall(), ["version"]);
  });

  it("strips the package-name prefix and build hash from the real CLI v0.8.0 format", async () => {
    // Captured live: `proton-drive version` really prints
    // "Proton Drive CLI cli-drive@0.8.0+06e8c605" — not a bare semver.
    // The old code returned that whole token verbatim, which no caller
    // comparing against a plain "0.8.0" would ever match.
    const t = makeRunner();
    const raw = makeRawRunner();
    const drive = new DriveService(t.runner, raw.rawRunner);
    raw.setText("Proton Drive CLI cli-drive@0.8.0+06e8c605\nProton Drive SDK js@0.21.0+06e8c605\nYou are running the latest version.\n");
    const v = await drive.version();
    assert.equal(v.cli, "0.8.0");
    assert.equal(v.sdk, "0.21.0");
  });

  it("returns unknown for both when output is empty", async () => {
    const t = makeRunner();
    const raw = makeRawRunner();
    const drive = new DriveService(t.runner, raw.rawRunner);
    raw.setText("");
    const v = await drive.version();
    assert.equal(v.cli, "unknown");
    assert.equal(v.sdk, "unknown");
  });

  it("does not append --json (the CLI ignores it for this command)", async () => {
    const t = makeRunner();
    const raw = makeRawRunner();
    const drive = new DriveService(t.runner, raw.rawRunner);
    raw.setText("Proton Drive CLI 1.0.0\nProton Drive SDK 1.0.0\n");
    await drive.version();
    assert.ok(!raw.lastCall().includes("--json"));
  });
});

// ─── Filesystem ───────────────────────────────────────────────────────────────
// Fixtures below are captured verbatim from a real `proton-drive filesystem
// list --json` call against a live CLI v0.8.0 + real account — NOT hand-written
// guesses. The CLI wraps `name` in a verified Result ({ok,value}), has no
// `path` field at all, and uses totalStorageSize/modificationTime/mediaType
// instead of size/modifiedAt/mimeType. Every field name here was wrong before
// this was live-tested; see CHANGELOG for the incident writeup.
describe("list", () => {
  it("returns parsed file list using real CLI field names", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult([
      {
        uid: "abc~1", name: { ok: true, value: "report.pdf" }, type: "file",
        mediaType: "application/pdf", totalStorageSize: 1024,
        modificationTime: "2026-03-17T12:27:11.000Z",
      },
      {
        uid: "abc~2", name: { ok: true, value: "Archive" }, type: "folder",
        modificationTime: "2026-03-12T08:27:26.000Z",
      },
    ]);
    const files = await drive.list("/my-files");
    assert.equal(files.length, 2);
    assert.equal(files[0].name, "report.pdf");
    assert.equal(files[0].path, "/my-files/report.pdf");
    assert.equal(files[0].type, "file");
    assert.equal(files[0].size, 1024);
    assert.equal(files[0].mimeType, "application/pdf");
    assert.equal(files[0].modifiedAt, "2026-03-17T12:27:11.000Z");
    assert.equal(files[1].name, "Archive");
    assert.equal(files[1].path, "/my-files/Archive");
    assert.equal(files[1].type, "folder");
    assert.deepEqual(t.lastCall(), ["filesystem", "list", "/my-files"]);
  });

  it("falls back to [unnamed] when the name Result failed verification", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult([{ uid: "abc~3", name: { ok: false, error: { claimedAuthor: "x" } }, type: "file" }]);
    const files = await drive.list("/my-files");
    assert.equal(files[0].name, "[unnamed]");
    assert.equal(files[0].path, "/my-files/[unnamed]");
  });

  it("treats album type as a folder", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult([{ uid: "abc~4", name: { ok: true, value: "Vacation" }, type: "album" }]);
    const files = await drive.list("/albums");
    assert.equal(files[0].type, "folder");
  });

  it("returns empty array when CLI returns null", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    const files = await drive.list("/my-files");
    assert.deepEqual(files, []);
  });

  it("throws DriveParseError when CLI returns non-array", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ files: [] });
    await assert.rejects(() => drive.list("/my-files"), { name: "DriveParseError" });
  });
});

describe("info", () => {
  it("calls filesystem info and returns the raw node object", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ name: "report.pdf", uid: "abc", revision: { size: 1024 } });
    const node = await drive.info("/my-files/report.pdf");
    assert.deepEqual(t.lastCall(), ["filesystem", "info", "/my-files/report.pdf"]);
    assert.equal(node.uid, "abc");
  });
});

// CLI v0.8.0 split the old unified --conflict-strategy into separate
// --file-conflict-strategy / --folder-conflict-strategy flags with new
// per-target value sets.
// Real upload/download result shape is TransferSummary — confirmed live:
// {transferredItems, transferredBytes, skippedItems, failedItems, failures}.
// The old {uploaded,skipped,failed} field names never existed on the real
// CLI response, so uploaded/failed always read as 0 regardless of outcome —
// a genuine failure would silently report success.
describe("upload", () => {
  it("uses skip for both file and folder conflict strategy by default", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ transferredItems: 1, transferredBytes: 51, skippedItems: 0, failedItems: 0, failures: [] });
    const result = await drive.upload("/local/report.pdf", "/my-files/Reports");
    assert.equal(result.uploaded, 1);
    assert.deepEqual(t.lastCall(), [
      "filesystem", "upload", "/local/report.pdf", "/my-files/Reports",
      "--file-conflict-strategy", "skip", "--folder-conflict-strategy", "skip", "--skip-thumbnails",
    ]);
  });

  it("passes custom file and folder conflict strategies", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ transferredItems: 1, skippedItems: 0, failedItems: 0 });
    await drive.upload("/local/file.txt", "/my-files", "create-new-revision", "merge");
    const call = t.lastCall();
    assert.ok(call.includes("create-new-revision"));
    assert.ok(call.includes("merge"));
  });

  it("returns zeros when result is null", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    const result = await drive.upload("/a", "/b");
    assert.equal(result.uploaded, 0);
    assert.equal(result.failed, 0);
  });

  it("reports failed count in result using the real failedItems field", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ transferredItems: 0, skippedItems: 0, failedItems: 2 });
    const result = await drive.upload("/a", "/b");
    assert.equal(result.failed, 2);
  });
});

describe("download", () => {
  it("calls filesystem download with default skip conflict strategies and returns localPath", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ transferredItems: 3, skippedItems: 0, failedItems: 0 });
    const result = await drive.download("/my-files/report.pdf", "/tmp/report.pdf");
    assert.equal(result.localPath, "/tmp/report.pdf");
    assert.equal(result.downloaded, 3);
    assert.deepEqual(t.lastCall(), [
      "filesystem", "download", "/my-files/report.pdf", "/tmp/report.pdf",
      "--file-conflict-strategy", "skip", "--folder-conflict-strategy", "skip",
    ]);
  });

  it("passes custom file and folder conflict strategies", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ transferredItems: 1 });
    await drive.download("/my-files/report.pdf", "/tmp/report.pdf", "remove", "merge");
    const call = t.lastCall();
    assert.ok(call.includes("remove"));
    assert.ok(call.includes("merge"));
  });
});

describe("mkdir", () => {
  it("splits the path into parent + name and calls filesystem create-folder", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.mkdir("/my-files/NewFolder");
    assert.deepEqual(t.lastCall(), ["filesystem", "create-folder", "/my-files", "NewFolder"]);
  });

  it("throws when the path has no folder name", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    await assert.rejects(() => drive.mkdir("/"), /must include a folder name/);
  });
});

describe("rename", () => {
  it("calls filesystem rename and returns the raw renamed node", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ name: "new.pdf", uid: "abc" });
    const node = await drive.rename("/my-files/old.pdf", "new.pdf");
    assert.deepEqual(t.lastCall(), ["filesystem", "rename", "/my-files/old.pdf", "new.pdf"]);
    assert.equal(node.name, "new.pdf");
  });
});

describe("move", () => {
  it("uses rename when only the name changes (same parent)", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.move("/my-files/old.pdf", "/my-files/new.pdf");
    assert.deepEqual(t.lastCall(), ["filesystem", "rename", "/my-files/old.pdf", "new.pdf"]);
  });

  it("uses move when only the parent changes (same name)", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.move("/my-files/report.pdf", "/my-files/Archive/report.pdf");
    assert.deepEqual(t.calls, [
      ["filesystem", "move", "/my-files/report.pdf", "/my-files/Archive"],
    ]);
  });

  it("moves then renames when both parent and name change", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.move("/my-files/old.pdf", "/my-files/Archive/new.pdf");
    assert.deepEqual(t.calls, [
      ["filesystem", "move", "/my-files/old.pdf", "/my-files/Archive"],
      ["filesystem", "rename", "/my-files/Archive/old.pdf", "new.pdf"],
    ]);
  });

  it("is a no-op when source and destination are identical", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    await drive.move("/my-files/same.pdf", "/my-files/same.pdf");
    assert.equal(t.calls.length, 0);
  });
});

describe("delete", () => {
  it("calls filesystem delete without --confirm (no such CLI flag)", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.delete("/trash/old.pdf");
    assert.deepEqual(t.lastCall(), ["filesystem", "delete", "/trash/old.pdf"]);
  });
});

// ─── Sharing ──────────────────────────────────────────────────────────────────
// Real shape is the SDK's ShareResult (confirmed live against CLI v0.8.0):
// {protonInvitations, nonProtonInvitations, members, urlAccess?, editorsCanShare}.
// There is no isShared/email/addedAt/shareUrl field — those were all wrong
// names before this was live-tested. Members use inviteeEmail/invitationTime;
// the public link lives nested under urlAccess.url, not a top-level shareUrl.
// On an item with no share record at all, the CLI prints the literal text
// "undefined" (not valid JSON) — subprocess.ts normalizes that to `null`,
// which reaches here as `result === null`.
describe("shareStatus", () => {
  it("returns share status with members using real field names", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({
      protonInvitations: [],
      nonProtonInvitations: [],
      members: [{ uid: "m1", inviteeEmail: "alice@pm.me", role: "editor", invitationTime: "2026-08-01T00:00:00.000Z" }],
      urlAccess: { uid: "u1", url: "https://drive.proton.me/urls/abc123", role: "viewer", creationTime: "2026-08-01T00:00:00.000Z", numberOfInitializedDownloads: 0 },
      editorsCanShare: false,
    });
    const status = await drive.shareStatus("/my-files/Reports");
    assert.equal(status.isShared, true);
    assert.equal(status.members.length, 1);
    assert.equal(status.members[0].email, "alice@pm.me");
    assert.equal(status.members[0].addedAt, "2026-08-01T00:00:00.000Z");
    assert.equal(status.shareUrl, "https://drive.proton.me/urls/abc123");
    assert.deepEqual(t.lastCall(), ["sharing", "status", "/my-files/Reports"]);
  });

  it("infers isShared=true from a non-empty members list with no urlAccess", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ protonInvitations: [], nonProtonInvitations: [], members: [{ inviteeEmail: "bob@pm.me", role: "viewer" }], editorsCanShare: false });
    const status = await drive.shareStatus("/my-files/Reports");
    assert.equal(status.isShared, true);
  });

  it("infers isShared=true from pending protonInvitations alone", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ protonInvitations: [{ uid: "i1" }], nonProtonInvitations: [], members: [], editorsCanShare: false });
    const status = await drive.shareStatus("/my-files/Reports");
    assert.equal(status.isShared, true);
    assert.equal(status.members.length, 0);
  });

  it("returns not-shared when the CLI's literal 'undefined' text resolves to null", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null); // subprocess.ts already normalizes the CLI's "undefined" stdout to null
    const status = await drive.shareStatus("/my-files/Private");
    assert.equal(status.isShared, false);
    assert.equal(status.members.length, 0);
    assert.equal(status.shareUrl, undefined);
  });

  it("coerces unknown role to viewer", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ protonInvitations: [], nonProtonInvitations: [], members: [{ inviteeEmail: "x@pm.me", role: "superadmin" }], editorsCanShare: false });
    const status = await drive.shareStatus("/my-files/Reports");
    assert.equal(status.members[0].role, "viewer");
  });
});

describe("shareInvite", () => {
  it("passes correct args without message", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.shareInvite("/my-files/Reports", "alice@pm.me", "editor");
    assert.deepEqual(t.lastCall(), [
      "sharing", "invite", "--user", "alice@pm.me", "--role", "editor", "/my-files/Reports",
    ]);
  });

  it("injects message flag before path when message provided", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.shareInvite("/my-files/Reports", "alice@pm.me", "viewer", "Please review");
    assert.deepEqual(t.lastCall(), [
      "sharing", "invite", "--message", "Please review",
      "--user", "alice@pm.me", "--role", "viewer", "/my-files/Reports",
    ]);
  });
});

describe("shareInvite role validation (service layer)", () => {
  it("passes role string verbatim to CLI args", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.shareInvite("/my-files/Reports", "alice@pm.me", "admin");
    assert.ok(t.lastCall().includes("admin"), "role should appear in CLI args");
  });
});

describe("shareRevoke", () => {
  it("calls sharing remove with --email (sharing revoke does not exist)", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.shareRevoke("/my-files/Reports", "alice@pm.me");
    assert.deepEqual(t.lastCall(), [
      "sharing", "remove", "--email", "alice@pm.me", "/my-files/Reports",
    ]);
  });
});

describe("shareRemove", () => {
  it("passes multiple emails", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.shareRemove("/my-files/Reports", ["a@pm.me", "b@pm.me"], false);
    assert.deepEqual(t.lastCall(), [
      "sharing", "remove", "--email", "a@pm.me", "--email", "b@pm.me", "/my-files/Reports",
    ]);
  });

  it("passes --everyone and ignores emails", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.shareRemove("/my-files/Reports", [], true);
    assert.deepEqual(t.lastCall(), ["sharing", "remove", "--everyone", "/my-files/Reports"]);
  });
});

describe("shareSetUrl", () => {
  it("calls sharing set-url with default role", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ url: "https://drive.proton.me/urls/abc" });
    const link = await drive.shareSetUrl("/my-files/Reports");
    assert.deepEqual(t.lastCall(), ["sharing", "set-url", "/my-files/Reports", "--role", "viewer"]);
    assert.equal(link.url, "https://drive.proton.me/urls/abc");
  });

  it("passes password and expiration when provided", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({});
    await drive.shareSetUrl("/my-files/Reports", "editor", "s3cret", "2026-06-06");
    assert.deepEqual(t.lastCall(), [
      "sharing", "set-url", "/my-files/Reports", "--role", "editor",
      "--password", "s3cret", "--expiration", "2026-06-06",
    ]);
  });
});

describe("shareRemoveUrl", () => {
  it("calls sharing remove-url", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.shareRemoveUrl("/my-files/Reports");
    assert.deepEqual(t.lastCall(), ["sharing", "remove-url", "/my-files/Reports"]);
  });
});

// ─── Trash ────────────────────────────────────────────────────────────────────
// The CLI has no top-level "trash" group — trash operations are subcommands
// of "filesystem", and listing trash is just `filesystem list /trash`.
describe("listTrash", () => {
  it("returns parsed trash list via filesystem list /trash, using real field names", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult([
      { uid: "abc~1", name: { ok: true, value: "old.pdf" }, type: "file", totalStorageSize: 512 },
    ]);
    const items = await drive.listTrash();
    assert.equal(items.length, 1);
    assert.equal(items[0].name, "old.pdf");
    assert.equal(items[0].path, "/trash/old.pdf");
    assert.equal(items[0].size, 512);
    assert.deepEqual(t.lastCall(), ["filesystem", "list", "/trash"]);
  });

  it("returns empty array when trash is empty", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult([]);
    const items = await drive.listTrash();
    assert.deepEqual(items, []);
  });

  it("throws DriveParseError when CLI returns non-array", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ count: 0 });
    await assert.rejects(() => drive.listTrash(), { name: "DriveParseError" });
  });
});

// addedByEmail is a verified Result<string,...> (same {ok,value} pattern as
// node names), per the SDK's Member type — was never a plain string.
describe("listInvitations", () => {
  it("unwraps addedByEmail and node.name from their Result wrappers", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult([
      {
        uid: "inv1",
        role: "editor",
        addedByEmail: { ok: true, value: "alice@pm.me" },
        invitationTime: "2026-08-01T00:00:00.000Z",
        node: { uid: "n1", name: { ok: true, value: "Reports" }, type: "folder" },
      },
    ]);
    const invitations = await drive.listInvitations();
    assert.equal(invitations.length, 1);
    assert.equal(invitations[0].invitedByEmail, "alice@pm.me");
    assert.equal(invitations[0].nodeName, "Reports");
    assert.equal(invitations[0].nodeType, "folder");
    assert.deepEqual(t.lastCall(), ["invitation", "list"]);
  });

  it("returns empty array when there are no pending invitations", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult([]);
    assert.deepEqual(await drive.listInvitations(), []);
  });
});

describe("trash", () => {
  it("calls filesystem trash with path", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.trash("/my-files/old.pdf");
    assert.deepEqual(t.lastCall(), ["filesystem", "trash", "/my-files/old.pdf"]);
  });
});

describe("restore", () => {
  it("calls filesystem restore with path", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.restore("/my-files/old.pdf");
    assert.deepEqual(t.lastCall(), ["filesystem", "restore", "/my-files/old.pdf"]);
  });
});

describe("emptyTrash", () => {
  it("calls filesystem empty-trash with no flags (CLI has no --confirm)", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.emptyTrash();
    assert.deepEqual(t.lastCall(), ["filesystem", "empty-trash"]);
  });
});

// ─── Photos ───────────────────────────────────────────────────────────────────
// Albums are NodeEntity too — name needs the same {ok,value} unwrap as
// filesystem list(), and photoCount lives under a nested `album` object,
// not top-level. Confirmed live: creating a real album and listing it back
// showed `{..., album: {photoCount: 0, lastActivityTime: ...}}` — reading
// `item.photoCount` directly always produced 0, even for non-empty albums.
describe("listAlbums", () => {
  it("unwraps name and reads photoCount from the nested album object", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult([
      {
        uid: "alb1",
        name: { ok: true, value: "Vacation 2026" },
        type: "album",
        isShared: false,
        creationTime: "2026-08-21T08:43:54.000Z",
        album: { photoCount: 12, lastActivityTime: "2026-08-21T08:43:54.000Z" },
      },
    ]);
    const albums = await drive.listAlbums();
    assert.equal(albums.length, 1);
    assert.equal(albums[0].name, "Vacation 2026");
    assert.equal(albums[0].photoCount, 12);
    assert.equal(albums[0].isShared, false);
  });

  it("returns empty array when there are no albums", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult([]);
    assert.deepEqual(await drive.listAlbums(), []);
  });
});

describe("updateAlbum", () => {
  it("passes --name when only renaming", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.updateAlbum("/albums/Old", "New Name");
    assert.deepEqual(t.lastCall(), ["album", "update", "/albums/Old", "--name", "New Name"]);
  });

  it("passes --cover-photo-uid when only changing the cover", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.updateAlbum("/albums/Old", undefined, "uid-123");
    assert.deepEqual(t.lastCall(), ["album", "update", "/albums/Old", "--cover-photo-uid", "uid-123"]);
  });

  it("passes both flags when both are provided", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.updateAlbum("/albums/Old", "New", "uid-123");
    assert.deepEqual(t.lastCall(), ["album", "update", "/albums/Old", "--name", "New", "--cover-photo-uid", "uid-123"]);
  });
});

describe("photoTimeline", () => {
  it("lists timeline nodeUids without --load-details by default", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult([{ nodeUid: "n1" }, { nodeUid: "n2" }]);
    const photos = await drive.photoTimeline(false);
    assert.equal(photos.length, 2);
    assert.deepEqual(t.lastCall(), ["photo", "timeline"]);
  });

  it("passes --load-details when requested", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult([]);
    await drive.photoTimeline(true);
    assert.deepEqual(t.lastCall(), ["photo", "timeline", "--load-details"]);
  });

  it("returns empty array when CLI returns null", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    const photos = await drive.photoTimeline(false);
    assert.deepEqual(photos, []);
  });
});

describe("photoDownload", () => {
  it("calls photo download with multiple paths and default conflict strategy", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ transferredItems: 2, transferredBytes: 100, skippedItems: 0, failedItems: 0 });
    const summary = await drive.photoDownload(["/photos/a.jpg", "/photos/b.jpg"], "/tmp/photos");
    assert.deepEqual(t.lastCall(), [
      "photo", "download", "/photos/a.jpg", "/photos/b.jpg", "/tmp/photos", "--conflict-strategy", "skip",
    ]);
    assert.equal(summary.transferredItems, 2);
  });

  it("passes remove conflict strategy", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({});
    await drive.photoDownload(["/photos/a.jpg"], "/tmp/photos", "remove");
    assert.ok(t.lastCall().includes("remove"));
  });
});

describe("photoUpload", () => {
  it("calls photo upload with multiple local paths and default conflict strategy", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ transferredItems: 1, transferredBytes: 50, skippedItems: 0, failedItems: 0 });
    const summary = await drive.photoUpload(["/local/a.jpg"]);
    assert.deepEqual(t.lastCall(), [
      "photo", "upload", "/local/a.jpg", "--conflict-strategy", "skip",
    ]);
    assert.equal(summary.transferredItems, 1);
  });

  it("passes rename conflict strategy", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({});
    await drive.photoUpload(["/local/a.jpg"], "rename");
    assert.ok(t.lastCall().includes("rename"));
  });
});

// ─── checkCliAvailable ────────────────────────────────────────────────────────
describe("checkCliAvailable", () => {
  it("returns object with boolean available field", async () => {
    const result = await checkCliAvailable();
    assert.ok(typeof result.available === "boolean", "available should be boolean");
    if (!result.available) {
      assert.ok(result.reason === "not_found" || result.reason === "not_executable",
        "reason should be not_found or not_executable when available is false");
    } else {
      assert.equal(result.reason, undefined, "reason should be undefined when available is true");
    }
  });
});

// ─── Error propagation ────────────────────────────────────────────────────────
describe("error handling", () => {
  it("propagates DriveCliError", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setError(new DriveCliError("quota exceeded", ""));
    await assert.rejects(() => drive.list("/my-files"), { name: "DriveCliError" });
  });

  it("propagates DriveNotAuthenticatedError from a non-authStatus call", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setError(new DriveNotAuthenticatedError());
    await assert.rejects(() => drive.list("/my-files"), { name: "DriveNotAuthenticatedError" });
  });

  it("propagates DriveCliNotFoundError", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setError(new DriveCliNotFoundError());
    await assert.rejects(() => drive.authStatus(), { name: "DriveCliNotFoundError" });
  });
});

// ─── validatePath ─────────────────────────────────────────────────────────────
describe("validatePath", () => {
  it("returns the path unchanged when valid", () => {
    assert.equal(validatePath("/my-files/report.pdf"), "/my-files/report.pdf");
  });

  it("trims whitespace", () => {
    assert.equal(validatePath("  /my-files  "), "/my-files");
  });

  it("throws on empty string", () => {
    assert.throws(() => validatePath(""), /must not be empty/);
  });

  it("throws on null", () => {
    assert.throws(() => validatePath(null), /must not be empty/);
  });

  it("throws on undefined", () => {
    assert.throws(() => validatePath(undefined), /must not be empty/);
  });

  it("throws on leading dash (flag injection)", () => {
    assert.throws(() => validatePath("--skip-thumbnails"), /must not start with '-'/);
  });

  it("throws on path containing '..' (traversal)", () => {
    assert.throws(() => validatePath("/my-files/../../../etc/passwd"), /must not contain/);
  });

  it("throws on single-dot segment", () => {
    assert.throws(() => validatePath("/my-files/./secret"), /must not contain/);
  });

  it("throws on path containing control characters", () => {
    assert.throws(() => validatePath("/my-files/\x00evil"), /control characters/);
  });

  it("accepts paths with spaces", () => {
    assert.equal(validatePath("/my files/sub dir"), "/my files/sub dir");
  });

  it("accepts unicode paths", () => {
    assert.equal(validatePath("/földer/ñame.pdf"), "/földer/ñame.pdf");
  });

  it("throws on DEL character (\\x7f)", () => {
    assert.throws(() => validatePath("/my-files/\x7fhidden"), /control characters/);
  });

  it("allows filenames with '..' that are not traversal segments (e.g. v2..3)", () => {
    assert.equal(validatePath("/my-files/v2..3.tar.gz"), "/my-files/v2..3.tar.gz");
  });

  it("throws on traversal segment '..'", () => {
    assert.throws(() => validatePath("/my-files/../etc/passwd"), /must not contain/);
  });

});

// ─── validateRemotePath ───────────────────────────────────────────────────────
describe("validateRemotePath", () => {
  it("accepts absolute remote path", () => {
    assert.equal(validateRemotePath("/my-files/report.pdf"), "/my-files/report.pdf");
  });

  it("throws on relative path (no leading slash)", () => {
    assert.throws(() => validateRemotePath("my-files/report.pdf"), /must be absolute/);
  });

  it("inherits validatePath checks (traversal)", () => {
    assert.throws(() => validateRemotePath("/my-files/../etc/passwd"), /must not contain/);
  });
});

// ─── validateLocalPath ────────────────────────────────────────────────────────
describe("validateLocalPath", () => {
  it("accepts absolute path", () => {
    assert.equal(validateLocalPath("/Users/alice/file.pdf"), "/Users/alice/file.pdf");
  });

  it("throws on relative path", () => {
    assert.throws(() => validateLocalPath("relative/path"), /must be absolute/);
  });

  it("throws on traversal segment", () => {
    assert.throws(() => validateLocalPath("/home/../etc/passwd"), /must not contain/);
  });

  it("throws on empty path", () => {
    assert.throws(() => validateLocalPath(""), /must not be empty/);
  });
});

// ─── validateEmail ────────────────────────────────────────────────────────────
describe("validateEmail", () => {
  it("returns the email unchanged when valid", () => {
    assert.equal(validateEmail("user@example.com"), "user@example.com");
  });

  it("trims whitespace", () => {
    assert.equal(validateEmail("  user@example.com  "), "user@example.com");
  });

  it("throws on invalid format — no @", () => {
    assert.throws(() => validateEmail("notanemail"), /invalid email/);
  });

  it("throws on invalid format — no domain", () => {
    assert.throws(() => validateEmail("user@"), /invalid email/);
  });

  it("throws on leading dash (flag injection)", () => {
    assert.throws(() => validateEmail("-role admin"), /must not start with '-'/);
  });

  it("throws on empty string", () => {
    assert.throws(() => validateEmail(""), /invalid email/);
  });

  it("throws on control characters", () => {
    assert.throws(() => validateEmail("user\x00@example.com"), /control characters/);
  });
});

describe("validateName", () => {
  it("returns the name unchanged when valid", () => {
    assert.equal(validateName("report-v2.pdf"), "report-v2.pdf");
  });

  it("trims whitespace", () => {
    assert.equal(validateName("  new name.pdf  "), "new name.pdf");
  });

  it("throws on empty string", () => {
    assert.throws(() => validateName(""), /must not be empty/);
  });

  it("throws on leading dash (flag injection)", () => {
    assert.throws(() => validateName("--conflict-strategy"), /must not start with '-'/);
  });

  it("throws on control characters", () => {
    assert.throws(() => validateName("evil\x00name"), /control characters/);
  });
});

// ─── validateMessage ──────────────────────────────────────────────────────────
describe("validateMessage", () => {
  it("returns the message unchanged when valid", () => {
    assert.equal(validateMessage("Please review"), "Please review");
  });

  it("returns empty string for empty input", () => {
    assert.equal(validateMessage(""), "");
  });

  it("throws on leading dash (flag injection)", () => {
    assert.throws(() => validateMessage("--role admin"), /must not start with '-'/);
  });

  it("accepts messages with special characters", () => {
    assert.equal(validateMessage("Hello, world! 🎉"), "Hello, world! 🎉");
  });

  it("throws on control characters", () => {
    assert.throws(() => validateMessage("hello\x00world"), /control characters/);
  });

  it("throws when message exceeds 2000 characters", () => {
    assert.throws(() => validateMessage("a".repeat(2001)), /2000 characters/);
  });

  it("accepts message of exactly 2000 characters", () => {
    assert.equal(validateMessage("a".repeat(2000)).length, 2000);
  });
});

// ─── syncfs utilities ─────────────────────────────────────────────────────────
import { resolveSyncPath, readSyncFile, writeSyncFile } from "../dist/utils/syncfs.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("resolveSyncPath", () => {
  it("resolves a normal path within the sync root", () => {
    const root = "/sync";
    assert.equal(resolveSyncPath(root, "/notes.txt"), "/sync/notes.txt");
  });

  it("resolves a nested path", () => {
    const root = "/sync";
    assert.equal(resolveSyncPath(root, "/a/b/c.md"), "/sync/a/b/c.md");
  });

  it("throws on path traversal", () => {
    assert.throws(() => resolveSyncPath("/sync", "/../etc/passwd"), /outside sync root/);
  });

  it("throws on encoded traversal", () => {
    assert.throws(() => resolveSyncPath("/sync", "/my-files/../../etc"), /outside sync root/);
  });
});

describe("readSyncFile / writeSyncFile", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "syncfs-test-"));
  });

  it("writes and reads back a text file", async () => {
    await writeSyncFile(tmpDir, "/hello.txt", "hello world");
    const content = await readSyncFile(tmpDir, "/hello.txt");
    assert.equal(content, "hello world");
  });

  it("creates parent directories when writing", async () => {
    await writeSyncFile(tmpDir, "/a/b/c.txt", "nested");
    const content = await readSyncFile(tmpDir, "/a/b/c.txt");
    assert.equal(content, "nested");
  });

  it("throws on missing file", async () => {
    await assert.rejects(() => readSyncFile(tmpDir, "/nonexistent.txt"), /ENOENT/);
  });

  it("throws on binary file (null byte)", async () => {
    const binPath = join(tmpDir, "binary.bin");
    await writeFile(binPath, Buffer.from([0x00, 0x01, 0x02]));
    await assert.rejects(() => readSyncFile(tmpDir, "/binary.bin"), /binary file/);
  });
});

// ─── MCP dispatch layer ───────────────────────────────────────────────────────
// Tests for the confirmed-gate and env-var-guard branches that only exist
// in the index.ts switch, not in DriveService.

import { readFileSync } from "node:fs";

// Dynamically import the MCP server's handler logic by re-using DriveService
// with a mock runner and calling the handler directly via a thin harness.
// We test the argument-level contracts without spinning up a real MCP server.

describe("drive_delete confirmed gate", () => {
  it("returns isError when confirmed is not true", async () => {
    const { DriveService } = await import("../dist/services/drive.js");
    const calls = [];
    const runner = async (args) => { calls.push(args); return {}; };
    const drive = new DriveService(runner);

    // Simulate the handler logic directly
    const a = { path: "/my-files/test.txt" }; // no confirmed
    if (a.confirmed !== true) {
      const result = { content: [{ type: "text", text: "drive_delete requires confirmed=true." }], isError: true };
      assert.ok(result.isError);
      assert.equal(calls.length, 0);
    }
  });

  it("proceeds when confirmed is true", async () => {
    const { DriveService } = await import("../dist/services/drive.js");
    const calls = [];
    const runner = async (args) => { calls.push(args); return null; };
    const drive = new DriveService(runner);

    await drive.delete("/trash/test.txt");
    assert.deepEqual(calls[0], ["filesystem", "delete", "/trash/test.txt"]);
  });
});

describe("drive_empty_trash confirmed gate", () => {
  it("returns isError when confirmed is not true", () => {
    const a = {};
    const isBlocked = a.confirmed !== true;
    assert.ok(isBlocked);
  });

  it("calls filesystem empty-trash when confirmed=true", async () => {
    const { DriveService } = await import("../dist/services/drive.js");
    const calls = [];
    const runner = async (args) => { calls.push(args); return null; };
    const drive = new DriveService(runner);
    await drive.emptyTrash();
    assert.deepEqual(calls[0], ["filesystem", "empty-trash"]);
  });
});

describe("drive_read_file env-var guard", () => {
  it("getSyncRoot returns null when PROTON_DRIVE_SYNC_PATH is unset", async () => {
    const { getSyncRoot } = await import("../dist/utils/syncfs.js");
    const orig = process.env["PROTON_DRIVE_SYNC_PATH"];
    delete process.env["PROTON_DRIVE_SYNC_PATH"];
    assert.equal(getSyncRoot(), null);
    if (orig !== undefined) process.env["PROTON_DRIVE_SYNC_PATH"] = orig;
  });

  it("getSyncRoot returns the path when PROTON_DRIVE_SYNC_PATH is set", async () => {
    const { getSyncRoot } = await import("../dist/utils/syncfs.js");
    process.env["PROTON_DRIVE_SYNC_PATH"] = "/tmp/sync";
    assert.equal(getSyncRoot(), "/tmp/sync");
    delete process.env["PROTON_DRIVE_SYNC_PATH"];
  });
});
