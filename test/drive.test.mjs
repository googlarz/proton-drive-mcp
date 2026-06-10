import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { DriveService } from "../dist/services/drive.js";
import {
  DriveCliError,
  DriveCliNotFoundError,
  DriveNotAuthenticatedError,
  DriveParseError,
} from "../dist/utils/errors.js";
import { validatePath, validateRemotePath, validateLocalPath, validateEmail, validateMessage } from "../dist/utils/validation.js";
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
    assert.equal(status.email, "alt@pm.me");
  });

  it("returns authenticated=false when CLI returns null", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    const status = await drive.authStatus();
    assert.equal(status.authenticated, false);
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

  it("returns unknown for both when result is empty object", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({});
    const v = await drive.version();
    assert.equal(v.cli, "unknown");
    assert.equal(v.sdk, "unknown");
  });

  it("throws DriveParseError when CLI returns null", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await assert.rejects(() => drive.version(), { name: "DriveParseError" });
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

  it("throws DriveParseError when CLI returns non-array", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ files: [] });
    await assert.rejects(() => drive.list("/my-files"), { name: "DriveParseError" });
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
    assert.ok(call.includes("--skip-thumbnails"));
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

  it("reports failed count in result", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ uploaded: 0, skipped: 0, failed: 2 });
    const result = await drive.upload("/a", "/b");
    assert.equal(result.failed, 2);
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
    assert.deepEqual(t.lastCall(), ["filesystem", "delete", "--confirm", "/my-files/old.pdf"]);
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

  it("throws DriveParseError when CLI returns null", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await assert.rejects(() => drive.shareStatus("/my-files/Reports"), { name: "DriveParseError" });
  });

  it("coerces unknown role to viewer", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ isShared: true, members: [{ email: "x@pm.me", role: "superadmin" }] });
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

  it("throws DriveParseError when CLI returns non-array", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult({ count: 0 });
    await assert.rejects(() => drive.listTrash(), { name: "DriveParseError" });
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
    assert.deepEqual(t.lastCall(), ["trash", "restore", "/my-files/old.pdf"]);
  });
});

describe("emptyTrash", () => {
  it("calls trash empty", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setResult(null);
    await drive.emptyTrash();
    assert.deepEqual(t.lastCall(), ["trash", "empty", "--confirm"]);
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

  it("propagates DriveNotAuthenticatedError", async () => {
    const t = makeRunner();
    const drive = new DriveService(t.runner);
    t.setError(new DriveNotAuthenticatedError());
    await assert.rejects(() => drive.authStatus(), { name: "DriveNotAuthenticatedError" });
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
