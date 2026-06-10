import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { DriveService } from "../dist/services/drive.js";
import {
  DriveCliError,
  DriveNotAuthenticatedError,
} from "../dist/utils/errors.js";

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

// ─── Auth ─────────────────────────────────────────────────────────────────────
describe("authStatus", () => {
  it("returns authenticated=true with email", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ authenticated: true, email: "user@pm.me" });
    const status = await drive.authStatus();
    assert.equal(status.authenticated, true);
    assert.equal(status.email, "user@pm.me");
    assert.deepEqual(t.lastCall(), ["auth", "status"]);
  });

  it("returns authenticated=false when not logged in", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ authenticated: false });
    const status = await drive.authStatus();
    assert.equal(status.authenticated, false);
    assert.equal(status.email, undefined);
  });

  it("handles loggedIn key alias", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ loggedIn: true, email: "alt@pm.me" });
    const status = await drive.authStatus();
    assert.equal(status.authenticated, true);
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
  it("returns cli and sdk from standard response", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ cli: "1.2.3", sdk: "4.5.6" });
    const v = await drive.version();
    assert.equal(v.cli, "1.2.3");
    assert.equal(v.sdk, "4.5.6");
    assert.deepEqual(t.lastCall(), ["version"]);
  });

  it("falls back to version key when cli key is absent", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ version: "2.0.0" });
    const v = await drive.version();
    assert.equal(v.cli, "2.0.0");
    assert.equal(v.sdk, "unknown");
  });
});

// ─── Filesystem ───────────────────────────────────────────────────────────────
describe("list", () => {
  it("returns parsed file list", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult([
      { name: "report.pdf", path: "/my-files/report.pdf", type: "file", size: 1024 },
      { name: "Archive", path: "/my-files/Archive", type: "folder" },
    ]);
    const files = await drive.list("/my-files");
    assert.equal(files.length, 2);
    assert.equal(files[0].name, "report.pdf");
    assert.equal(files[0].type, "file");
    assert.equal(files[0].size, 1024);
    assert.equal(files[1].type, "folder");
    assert.deepEqual(t.lastCall(), ["filesystem", "list", "/my-files"]);
  });

  it("returns empty array when CLI returns null", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    const files = await drive.list("/my-files");
    assert.deepEqual(files, []);
  });
});

describe("upload", () => {
  it("uses skip conflict strategy by default", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ uploaded: 1, skipped: 0, failed: 0 });
    const result = await drive.upload("/local/report.pdf", "/my-files/Reports");
    assert.equal(result.uploaded, 1);
    const call = t.lastCall();
    assert.equal(call[0], "filesystem");
    assert.equal(call[1], "upload");
    assert.equal(call[2], "/local/report.pdf");
    assert.equal(call[3], "/my-files/Reports");
    assert.ok(call.includes("--conflict-strategy"));
    assert.ok(call.includes("skip"));
  });

  it("passes overwrite conflict strategy", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ uploaded: 1, skipped: 0, failed: 0 });
    await drive.upload("/local/file.txt", "/my-files", "overwrite");
    assert.ok(t.lastCall().includes("overwrite"));
  });

  it("returns zeros when result is null", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    const result = await drive.upload("/a", "/b");
    assert.equal(result.uploaded, 0);
    assert.equal(result.failed, 0);
  });
});

describe("download", () => {
  it("calls filesystem download and returns localPath", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ downloaded: 3 });
    const result = await drive.download("/my-files/report.pdf", "/tmp/report.pdf");
    assert.equal(result.localPath, "/tmp/report.pdf");
    assert.equal(result.downloaded, 3);
    assert.deepEqual(t.lastCall(), [
      "filesystem", "download", "/my-files/report.pdf", "/tmp/report.pdf",
    ]);
  });
});

describe("mkdir", () => {
  it("calls filesystem mkdir", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.mkdir("/my-files/NewFolder");
    assert.deepEqual(t.lastCall(), ["filesystem", "mkdir", "/my-files/NewFolder"]);
  });
});

describe("move", () => {
  it("calls filesystem move", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.move("/my-files/old.pdf", "/my-files/new.pdf");
    assert.deepEqual(t.lastCall(), [
      "filesystem", "move", "/my-files/old.pdf", "/my-files/new.pdf",
    ]);
  });
});

describe("delete", () => {
  it("calls filesystem delete", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.delete("/my-files/old.pdf");
    assert.deepEqual(t.lastCall(), ["filesystem", "delete", "/my-files/old.pdf"]);
  });
});

// ─── Sharing ──────────────────────────────────────────────────────────────────
describe("shareStatus", () => {
  it("returns share status with members", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({
      isShared: true,
      members: [{ email: "alice@pm.me", role: "editor" }],
      shareUrl: "https://drive.proton.me/urls/abc123",
    });
    const status = await drive.shareStatus("/my-files/Reports");
    assert.equal(status.isShared, true);
    assert.equal(status.members.length, 1);
    assert.equal(status.members[0].email, "alice@pm.me");
    assert.equal(status.shareUrl, "https://drive.proton.me/urls/abc123");
    assert.deepEqual(t.lastCall(), ["sharing", "status", "/my-files/Reports"]);
  });

  it("infers isShared=true from non-empty members list", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ members: [{ email: "bob@pm.me", role: "viewer" }] });
    const status = await drive.shareStatus("/my-files/Reports");
    assert.equal(status.isShared, true);
  });

  it("returns not-shared with empty members", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ isShared: false, members: [] });
    const status = await drive.shareStatus("/my-files/Private");
    assert.equal(status.isShared, false);
    assert.equal(status.members.length, 0);
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
    const call = t.lastCall();
    assert.ok(call.includes("--message"));
    assert.ok(call.includes("Please review"));
    // path should still be last
    assert.equal(call[call.length - 1], "/my-files/Reports");
  });
});

describe("shareRevoke", () => {
  it("calls sharing revoke with user flag", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.shareRevoke("/my-files/Reports", "alice@pm.me");
    assert.deepEqual(t.lastCall(), [
      "sharing", "revoke", "--user", "alice@pm.me", "/my-files/Reports",
    ]);
  });
});

// ─── Trash ────────────────────────────────────────────────────────────────────
describe("listTrash", () => {
  it("returns parsed trash list", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult([
      { name: "old.pdf", path: "/trash/old.pdf", type: "file", size: 512 },
    ]);
    const items = await drive.listTrash();
    assert.equal(items.length, 1);
    assert.equal(items[0].name, "old.pdf");
    assert.deepEqual(t.lastCall(), ["trash", "list"]);
  });

  it("returns empty array when trash is empty", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult([]);
    const items = await drive.listTrash();
    assert.deepEqual(items, []);
  });
});

describe("trash", () => {
  it("calls trash with path", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.trash("/my-files/old.pdf");
    assert.deepEqual(t.lastCall(), ["trash", "/my-files/old.pdf"]);
  });
});

describe("restore", () => {
  it("calls restore with path", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.restore("/my-files/old.pdf");
    assert.deepEqual(t.lastCall(), ["restore", "/my-files/old.pdf"]);
  });
});

describe("emptyTrash", () => {
  it("calls trash empty", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.emptyTrash();
    assert.deepEqual(t.lastCall(), ["trash", "empty"]);
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

  it("propagates DriveNotAuthenticatedError", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setError(new DriveNotAuthenticatedError());
    await assert.rejects(() => drive.authStatus(), { name: "DriveNotAuthenticatedError" });
  });
});
