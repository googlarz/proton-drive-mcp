import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, delimiter, dirname } from "node:path";

import {
  resolveSyncPath,
  readSyncFile,
  writeSyncFile,
  syncFileExists,
} from "../dist/utils/syncfs.js";
import { assertLocalPathAllowed, assertApprovalDirUsable } from "../dist/utils/localguard.js";
import { validateDownloadTarget } from "../dist/utils/validation.js";

describe("syncfs hardening", () => {
  let base, root, outside;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), "syncguard-"));
    root = join(base, "root");
    outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "TOPSECRET");
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "ok.txt"), "fine");
    await symlink(outside, join(root, "escape-dir"));
    await symlink(join(outside, "secret.txt"), join(root, "escape-file"));
    await symlink(join(root, "real"), join(root, "inner-dir"));
    await symlink(join(root, "real", "ok.txt"), join(root, "inner-file"));
    await symlink(join(base, "does-not-exist"), join(root, "dangling"));
  });
  after(() => rm(base, { recursive: true, force: true }));

  it("read through escaping dir symlink is rejected", async () => {
    await assert.rejects(() => readSyncFile(root, "/escape-dir/secret.txt"), /outside sync root/);
  });

  it("read of escaping file symlink is rejected", async () => {
    await assert.rejects(() => readSyncFile(root, "/escape-file"), /outside sync root/);
  });

  it("read of dangling symlink is rejected", async () => {
    await assert.rejects(() => readSyncFile(root, "/dangling"), /outside sync root/);
  });

  it("write through escaping dir symlink is rejected and nothing is written", async () => {
    await assert.rejects(() => writeSyncFile(root, "/escape-dir/pwn.txt", "x"), /outside sync root/);
    await assert.rejects(() => stat(join(outside, "pwn.txt")), /ENOENT/);
  });

  it("mkdir through escaping symlink does not create dirs outside", async () => {
    await assert.rejects(() => writeSyncFile(root, "/escape-dir/newdir/f.txt", "x"), /outside sync root/);
    await assert.rejects(() => stat(join(outside, "newdir")), /ENOENT/);
  });

  it("write onto an existing symlink is refused (in-root and escaping)", async () => {
    await assert.rejects(() => writeSyncFile(root, "/escape-file", "x"), /outside sync root|symlink/);
    assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "TOPSECRET");
    await assert.rejects(() => writeSyncFile(root, "/inner-file", "x"), /symlink/);
    assert.equal(await readFile(join(root, "real", "ok.txt"), "utf8"), "fine");
  });

  it("in-root symlinked directory that stays inside works for read and write", async () => {
    assert.equal(await readSyncFile(root, "/inner-dir/ok.txt"), "fine");
    assert.equal(await readSyncFile(root, "/inner-file"), "fine");
    await writeSyncFile(root, "/inner-dir/new.txt", "hello");
    assert.equal(await readFile(join(root, "real", "new.txt"), "utf8"), "hello");
  });

  it("sync root that is itself a symlink works", async () => {
    const linkRoot = join(base, "root-link");
    await symlink(root, linkRoot);
    assert.equal(await readSyncFile(linkRoot, "/real/ok.txt"), "fine");
    await assert.rejects(() => readSyncFile(linkRoot, "/escape-dir/secret.txt"), /outside sync root/);
  });

  it("lexical traversal is still rejected", async () => {
    await assert.rejects(() => readSyncFile(root, "/../outside/secret.txt"), /outside sync root/);
    await assert.rejects(() => writeSyncFile(root, "/../outside/x.txt", "x"), /outside sync root/);
  });

  it("root '/' edge: resolveSyncPath does not reject valid or traversal-to-root paths", () => {
    assert.equal(resolveSyncPath("/", "/a/b"), "/a/b");
    assert.equal(resolveSyncPath("/", "/../a"), "/a");
    assert.equal(resolveSyncPath("/", "/"), "/");
  });

  it("sibling with shared prefix is not treated as inside", () => {
    assert.throws(() => resolveSyncPath("/tmp/sync", "/../sync-evil/x"), /outside sync root/);
  });

  it("read cap: 1MB ok, above 1MB rejected", async () => {
    await writeFile(join(root, "big-ok.txt"), "a".repeat(1024 * 1024));
    assert.equal((await readSyncFile(root, "/big-ok.txt")).length, 1024 * 1024);
    await writeFile(join(root, "big.txt"), "a".repeat(1024 * 1024 + 1));
    await assert.rejects(() => readSyncFile(root, "/big.txt"), /too large.*limit 1 MB/);
  });

  it("binary file still rejected", async () => {
    await writeFile(join(root, "b.bin"), Buffer.from([1, 0, 2]));
    await assert.rejects(() => readSyncFile(root, "/b.bin"), /binary file/);
  });

  it("reading a directory fails cleanly", async () => {
    await assert.rejects(() => readSyncFile(root, "/real"), /regular file|EISDIR/);
  });

  it("write cap: 5MB ok, above rejected", async () => {
    await writeSyncFile(root, "/w-ok.txt", "a".repeat(5 * 1024 * 1024));
    assert.equal((await stat(join(root, "w-ok.txt"))).size, 5 * 1024 * 1024);
    await assert.rejects(
      () => writeSyncFile(root, "/w-big.txt", "a".repeat(5 * 1024 * 1024 + 1)),
      /too large to write \(limit 5 MB\)/
    );
    await assert.rejects(() => stat(join(root, "w-big.txt")), /ENOENT/);
  });

  it("write overwrites existing regular file and creates nested dirs", async () => {
    await writeSyncFile(root, "/ow.txt", "one");
    await writeSyncFile(root, "/ow.txt", "two");
    assert.equal(await readSyncFile(root, "/ow.txt"), "two");
    await writeSyncFile(root, "/n/e/s/t.txt", "deep");
    assert.equal(await readSyncFile(root, "/n/e/s/t.txt"), "deep");
  });

  it("syncFileExists", async () => {
    assert.equal(await syncFileExists(root, "/real/ok.txt"), true);
    assert.equal(await syncFileExists(root, "/real/missing.txt"), false);
    assert.equal(await syncFileExists(root, "/no/such/dir/x"), false);
    assert.equal(await syncFileExists(root, "/inner-file"), true);
    await assert.rejects(() => syncFileExists(root, "/escape-file"), /outside sync root/);
    await assert.rejects(() => syncFileExists(root, "/escape-dir/secret.txt"), /outside sync root/);
    await assert.rejects(() => syncFileExists(root, "/../outside/secret.txt"), /outside sync root/);
  });
});

describe("assertLocalPathAllowed", () => {
  const saved = {};
  const KEYS = ["PROTON_DRIVE_LOCAL_ROOT", "PROTON_DRIVE_ALLOW_SENSITIVE_PATHS"];
  let base;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), "localguard-"));
  });
  after(() => rm(base, { recursive: true, force: true }));
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const home = homedir();
  const denied = [
    ".ssh/id_x",
    ".ssh",
    ".aws/credentials",
    ".gnupg/pubring.kbx",
    ".kube/config",
    ".docker/config.json",
    ".npmrc",
    ".netrc",
    ".pgpass",
    ".config/gcloud/credentials.db",
    ".claude/settings.json",
    ".claude.json",
    "Library/Keychains/login.keychain-db",
    "Library/Application Support/Claude/config.json",
  ];
  for (const rel of denied) {
    it(`denies ~/${rel}`, () => {
      assert.throws(() => assertLocalPathAllowed(join(home, rel)), /protected location|secret file/);
    });
  }

  for (const p of ["/etc/passwd", "/private/etc/hosts", "/var/root/x", "/etc"]) {
    it(`denies ${p}`, () => {
      assert.throws(() => assertLocalPathAllowed(p), /protected location/);
    });
  }

  for (const name of [
    ".env", ".env.local", ".env.production", "id_rsa", "id_rsa.pub", "id_ed25519",
    "cert.pem", "a.p12", "b.pfx", "login.keychain-db", "x.keychain",
  ]) {
    it(`denies basename ${name} anywhere`, () => {
      assert.throws(() => assertLocalPathAllowed(join(base, name)), /secret file/);
    });
  }

  it("allows normal files, including similar-looking names", () => {
    assertLocalPathAllowed(join(base, "report.pdf"));
    assertLocalPathAllowed(join(base, "environment.txt"));
    assertLocalPathAllowed(join(base, ".envrc-not"));
    assertLocalPathAllowed(join(home, ".sshfoo", "x"));
    assertLocalPathAllowed(join(home, "Documents", "a.txt"));
  });

  it("allows a nonexistent destination in a nonexistent dir", () => {
    assertLocalPathAllowed(join(base, "not", "yet", "there", "download.bin"));
  });

  it("rejects symlink pointing to a denied dir (existing target)", async () => {
    const link = join(base, "sshlink");
    await symlink(join(home, ".ssh"), link).catch(() => {});
    assert.throws(() => assertLocalPathAllowed(join(link, "id_foo")), /protected location|secret file/);
  });

  it("rejects symlink to a denied dir even when the destination file does not exist", async () => {
    const link = join(base, "etclink");
    await symlink("/etc", link);
    assert.throws(() => assertLocalPathAllowed(join(link, "newfile")), /protected location/);
  });

  it("rejects dangling symlink whose target is under a denied dir", async () => {
    const link = join(base, "dangling-ssh");
    await symlink(join(home, ".ssh", "no-such-key-file"), link);
    assert.throws(() => assertLocalPathAllowed(link), /protected location|secret file/);
  });

  it("rejects symlink to a .env file", async () => {
    const target = join(base, "real.env-holder");
    await writeFile(target, "x");
    const envTarget = join(base, ".env");
    await writeFile(envTarget, "S=1");
    const link = join(base, "innocent.txt");
    await symlink(envTarget, link);
    assert.throws(() => assertLocalPathAllowed(link), /secret file/);
  });

  it("PROTON_DRIVE_LOCAL_ROOT restricts to listed roots", async () => {
    const a = join(base, "rootA");
    const b = join(base, "rootB");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    process.env.PROTON_DRIVE_LOCAL_ROOT = [a, b].join(delimiter);
    assertLocalPathAllowed(join(a, "x.txt"));
    assertLocalPathAllowed(join(b, "deep", "y.txt"));
    assertLocalPathAllowed(a);
    assert.throws(() => assertLocalPathAllowed(join(base, "other.txt")), /outside PROTON_DRIVE_LOCAL_ROOT/);
    assert.throws(() => assertLocalPathAllowed(join(a, "..", "other.txt")), /outside PROTON_DRIVE_LOCAL_ROOT/);
    assert.throws(() => assertLocalPathAllowed(join(base, "rootA-evil", "x")), /outside PROTON_DRIVE_LOCAL_ROOT/);
  });

  it("PROTON_DRIVE_LOCAL_ROOT: symlink inside root pointing out is rejected", async () => {
    const a = join(base, "rootC");
    await mkdir(a, { recursive: true });
    await symlink(tmpdir(), join(a, "out"));
    process.env.PROTON_DRIVE_LOCAL_ROOT = a;
    assert.throws(() => assertLocalPathAllowed(join(a, "out", "f")), /outside PROTON_DRIVE_LOCAL_ROOT/);
  });

  it("PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 disables the denylist", () => {
    process.env.PROTON_DRIVE_ALLOW_SENSITIVE_PATHS = "1";
    assertLocalPathAllowed(join(home, ".ssh", "id_rsa"));
    assertLocalPathAllowed("/etc/hosts");
    assertLocalPathAllowed(join(base, ".env"));
  });

  it("scan mode rejects directories that CONTAIN protected locations; destinations are unaffected", async () => {
    for (const p of ["/", dirname(home), home]) {
      assert.throws(() => assertLocalPathAllowed(p, { scan: true }), /contains protected locations.*pick a subfolder/);
      assertLocalPathAllowed(p); // write destination (download folder): still allowed
    }
    const fakeHome = join(base, "fakehome");
    await mkdir(join(fakeHome, ".ssh"), { recursive: true });
    await mkdir(join(fakeHome, "Documents"), { recursive: true });
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      assert.throws(() => assertLocalPathAllowed(fakeHome, { scan: true }), /contains protected locations/);
      assertLocalPathAllowed(join(fakeHome, "Documents"), { scan: true });
      assertLocalPathAllowed(join(fakeHome, "Documents", "a.txt"), { scan: true });
      process.env.PROTON_DRIVE_ALLOW_SENSITIVE_PATHS = "1";
      assertLocalPathAllowed(fakeHome, { scan: true });
    } finally {
      process.env.HOME = savedHome;
    }
  });

  it("opt-out does not disable an explicit LOCAL_ROOT", async () => {
    const a = join(base, "rootD");
    await mkdir(a, { recursive: true });
    process.env.PROTON_DRIVE_LOCAL_ROOT = a;
    process.env.PROTON_DRIVE_ALLOW_SENSITIVE_PATHS = "1";
    assert.throws(() => assertLocalPathAllowed(join(home, ".ssh", "id_rsa")), /outside PROTON_DRIVE_LOCAL_ROOT/);
    assertLocalPathAllowed(join(a, "ok.txt"));
  });
});

describe("local path guard: case, start-up files, nested upload entries, write targets", () => {
  const KEYS = ["HOME", "PROTON_DRIVE_LOCAL_ROOT", "PROTON_DRIVE_ALLOW_SENSITIVE_PATHS", "PROTON_DRIVE_AUDIT_LOG", "PROTON_DRIVE_SYNC_PATH", "PROTON_DRIVE_APPROVAL_DIR", "XDG_CACHE_HOME"];
  const saved = {};
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const setPlatform = (value) => Object.defineProperty(process, "platform", { ...realPlatform, value });
  let base, fakeHome;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), "localguard2-"));
    fakeHome = join(base, "home");
    await mkdir(join(fakeHome, "Documents"), { recursive: true });
  });
  after(() => rm(base, { recursive: true, force: true }));
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS.slice(1)) delete process.env[k];
    process.env.HOME = fakeHome;
    // keep the default approvals folder (under HOME) out of the way of tests that download into HOME
    process.env.PROTON_DRIVE_APPROVAL_DIR = join(base, "default-approvals-elsewhere");
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", realPlatform);
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const entries = [
    ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".npmrc", ".netrc", ".pgpass", ".config/gcloud", ".claude", ".claude.json",
    "Library/Keychains", "Library/Application Support/Claude", "Library/LaunchAgents", "Library/LaunchDaemons",
    ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".bashrc", ".bash_profile", ".bash_login", ".profile", ".zlogout", ".bash_logout",
  ];

  for (const platform of ["darwin", "win32"]) {
    it(`${platform}: every home entry is denied in any letter case, existing or not`, async () => {
      setPlatform(platform);
      for (const rel of entries) {
        const upper = rel.toUpperCase();
        assert.throws(() => assertLocalPathAllowed(join(fakeHome, upper, "x")), /protected location|secret file/, upper);
        assert.throws(() => assertLocalPathAllowed(join(fakeHome, upper)), /protected location|secret file/, upper);
      }
      for (const a of ["/ETC/passwd", "/Private/Etc/hosts", "/VAR/root/x", "/library/launchagents/x.plist"]) {
        assert.throws(() => assertLocalPathAllowed(a), /protected location/, a);
      }
    });
  }

  // Case folding is faked off (linux) so only realpath.native can map the typed spelling to the on-disk one.
  // Needs a case-insensitive file system, i.e. a real macOS run.
  it("an existing directory is matched through its on-disk spelling (realpath.native, no case folding)", { skip: realPlatform.value !== "darwin" }, async () => {
    const h = await mkdtemp(join(base, "native-"));
    await mkdir(join(h, ".ssh"));
    process.env.HOME = h;
    setPlatform("linux");
    assert.throws(() => assertLocalPathAllowed(join(h, ".SSH", "config")), /protected location/);
  });

  it("linux: names stay case-sensitive (a home without .ssh does not deny .SSH)", async () => {
    const h = await mkdtemp(join(base, "linux-"));
    process.env.HOME = h;
    setPlatform("linux");
    assertLocalPathAllowed(join(h, ".SSH", "config"));
    assertLocalPathAllowed(join(h, ".AWS", "credentials"));
    assert.throws(() => assertLocalPathAllowed(join(h, ".ssh", "config")), /protected location/);
  });

  it("start-up files and autostart folders are denied in their normal case too", () => {
    for (const rel of [".zshrc", ".bash_profile", "Library/LaunchAgents/evil.plist", "Library/LaunchDaemons"]) {
      assert.throws(() => assertLocalPathAllowed(join(fakeHome, rel)), /protected location/, rel);
    }
  });

  it("download target: the remote name is checked inside the destination folder", async () => {
    await mkdir(join(fakeHome, "Library", "LaunchAgents"), { recursive: true });
    assert.throws(() => validateDownloadTarget(fakeHome, ["/my-files/.zshrc"]), /protected location/);
    assert.throws(() => validateDownloadTarget(fakeHome, ["/my-files/.ssh"]), /protected location/);
    assert.throws(() => validateDownloadTarget(join(fakeHome, "Library"), ["/my-files/LaunchAgents"]), /protected location/);
    assert.throws(() => validateDownloadTarget(fakeHome, ["/my-files/stuff/Library"]), /contains protected locations/);
    assert.throws(() => validateDownloadTarget(join(fakeHome, "Library", "LaunchAgents"), ["/my-files/a.plist"]), /protected location/);
    assert.equal(validateDownloadTarget(join(fakeHome, "Documents"), ["/my-files/report.pdf", "/photos/a.jpg"]), join(fakeHome, "Documents"));
  });

  it("the audit log file cannot be a write target but can still be read (scan)", async () => {
    const log = join(base, "logs", "audit.jsonl");
    process.env.PROTON_DRIVE_AUDIT_LOG = log;
    assert.throws(() => assertLocalPathAllowed(log), /audit log/);
    assert.throws(() => assertLocalPathAllowed(log + ".lock"), /audit log/);
    assert.throws(() => validateDownloadTarget(join(base, "logs"), ["/my-files/audit.jsonl"]), /audit log/);
    assertLocalPathAllowed(log, { scan: true });
    assertLocalPathAllowed(join(base, "logs", "other.txt"));
  });

  it("the approvals folder (PROTON_DRIVE_APPROVAL_DIR) cannot be written, held, or reached through a symlink", async () => {
    const t = join(base, "appr");
    const ap = join(t, "store", "approvals");
    await mkdir(join(ap, "pending"), { recursive: true });
    await mkdir(join(t, "sibling"), { recursive: true });
    process.env.PROTON_DRIVE_APPROVAL_DIR = ap;
    assert.throws(() => validateDownloadTarget(ap, ["/my-files/a.txt"]), /approvals folder/);
    assert.throws(() => validateDownloadTarget(join(ap, "pending"), ["/my-files/a.txt"]), /approvals folder/);
    assert.throws(() => validateDownloadTarget(join(t, "store"), ["/my-files/approvals"]), /approvals folder/);
    assert.throws(() => validateDownloadTarget(t, ["/my-files/store"]), /approvals folder/);
    assert.throws(() => validateDownloadTarget(t, ["/photos/"]), /approvals folder/);
    assert.throws(() => assertLocalPathAllowed(join(ap, "pending", "X.json")), /approvals folder/);
    assert.throws(() => assertLocalPathAllowed(ap), /approvals folder/);
    // reading (scan) stays possible, and a sibling folder is fine
    assertLocalPathAllowed(ap, { scan: true });
    assert.equal(validateDownloadTarget(join(t, "sibling"), ["/my-files/a.txt"]), join(t, "sibling"));
    assert.equal(validateDownloadTarget(join(t, "store"), ["/my-files/a.txt"]), join(t, "store"));
    // symlink into the folder
    const link = join(t, "sibling", "link");
    await symlink(ap, link);
    assert.throws(() => validateDownloadTarget(link, ["/my-files/a.txt"]), /approvals folder/);
    assert.throws(() => assertLocalPathAllowed(join(link, "pending", "n.json")), /approvals folder/);
  });

  it("the default approvals folder is protected (faked through HOME, mac and linux layouts)", async () => {
    const h = join(base, "home5");
    await mkdir(h, { recursive: true });
    process.env.HOME = h;
    delete process.env.PROTON_DRIVE_APPROVAL_DIR;
    const def = process.platform === "darwin"
      ? join(h, "Library", "Caches", "proton-drive-mcp", "approvals")
      : join(h, ".cache", "proton-drive-mcp", "approvals");
    await mkdir(def, { recursive: true });
    assert.throws(() => validateDownloadTarget(def, ["/my-files/a.txt"]), /approvals folder/);
    assert.throws(() => validateDownloadTarget(dirname(def), ["/my-files/approvals"]), /approvals folder/);
    assert.throws(() => validateDownloadTarget(h, ["/my-files/" + (process.platform === "darwin" ? "Library" : ".cache")]), /approvals folder/);
    assert.equal(validateDownloadTarget(join(h, "Documents"), ["/my-files/a.txt"]), join(h, "Documents"));
    process.env.XDG_CACHE_HOME = join(base, "xdg");
    if (process.platform !== "darwin") {
      assert.throws(() => assertLocalPathAllowed(join(base, "xdg", "proton-drive-mcp", "approvals", "x.json")), /approvals folder/);
    }
  });

  it("approvals folder case variants are refused on a darwin-faked platform", async () => {
    const t = join(base, "appr2");
    const ap = join(t, "Approvals");
    await mkdir(ap, { recursive: true });
    process.env.PROTON_DRIVE_APPROVAL_DIR = ap;
    setPlatform("darwin");
    assert.throws(() => assertLocalPathAllowed(join(t, "APPROVALS", "x.json")), /approvals folder/);
    assert.throws(() => assertLocalPathAllowed(join(t, "approvals")), /approvals folder/);
    assert.throws(() => validateDownloadTarget(t, ["/my-files/APPROVALS"]), /approvals folder/);
    setPlatform("linux");
    // case-sensitive: a differently-cased path is a different folder, unless the real file system folds it
    if (process.platform === "linux") assertLocalPathAllowed(join(t, "APPROVALS-other", "x.json"));
  });

  it("assertApprovalDirUsable refuses a folder inside the sync folder only", async () => {
    const sync = join(base, "sync3");
    await mkdir(join(sync, "in"), { recursive: true });
    const env = { PROTON_DRIVE_SYNC_PATH: sync };
    assert.throws(() => assertApprovalDirUsable(join(sync, "in", "approvals"), env), /outside PROTON_DRIVE_SYNC_PATH/);
    assert.throws(() => assertApprovalDirUsable(sync, env), /outside PROTON_DRIVE_SYNC_PATH/);
    const viaLink = join(base, "sync3-link");
    await symlink(sync, viaLink);
    assert.throws(() => assertApprovalDirUsable(join(viaLink, "approvals"), env), /outside PROTON_DRIVE_SYNC_PATH/);
    assertApprovalDirUsable(join(base, "elsewhere", "approvals"), env);
    assertApprovalDirUsable(join(base, "sync3-sibling"), env);
    assertApprovalDirUsable(join(sync, "in", "approvals"), {});
  });

  it("a .versions snapshot folder inside the sync folder cannot be a write target", async () => {
    const sync = join(base, "sync");
    await mkdir(join(sync, "docs", ".versions"), { recursive: true });
    process.env.PROTON_DRIVE_SYNC_PATH = sync;
    assert.throws(() => assertLocalPathAllowed(join(sync, "docs", ".versions")), /\.versions/);
    if (process.platform === "darwin" || process.platform === "win32") {
      // Case-insensitive file systems: .VERSIONS is the same folder. On Linux it is a different folder and stays allowed.
      assert.throws(() => assertLocalPathAllowed(join(sync, "docs", ".VERSIONS", "a.20261101")), /\.versions/i);
    }
    assertLocalPathAllowed(join(sync, "docs", "a.txt"));
    await assert.rejects(() => writeSyncFile(sync, "/my-files/docs/.versions/a.20261101T000000.000Z", "x"), /\.versions/);
  });

  it("a download target cannot contain the audit log, its lock, or a .versions folder of the sync folder", async () => {
    const t = join(base, "t");
    await mkdir(join(t, "logs"), { recursive: true });
    process.env.PROTON_DRIVE_AUDIT_LOG = join(t, "logs", "audit.jsonl");
    assert.throws(() => validateDownloadTarget(t, ["/my-files/logs"]), /audit log/);
    assert.throws(() => validateDownloadTarget(join(t, "logs"), ["/my-files/audit.jsonl"]), /audit log/);
    assert.throws(() => validateDownloadTarget(join(t, "logs"), ["/my-files/audit.jsonl.lock"]), /audit log/);
    assert.throws(() => validateDownloadTarget(base, ["/my-files/t"]), /audit log/);
    assert.equal(validateDownloadTarget(join(base, "elsewhere"), ["/my-files/logs"]), join(base, "elsewhere"));
    delete process.env.PROTON_DRIVE_AUDIT_LOG;

    const sync = join(base, "sync2");
    await mkdir(join(sync, "Docs", ".versions"), { recursive: true });
    await mkdir(join(sync, "Plain"), { recursive: true });
    process.env.PROTON_DRIVE_SYNC_PATH = sync;
    assert.throws(() => validateDownloadTarget(sync, ["/my-files/Docs"]), /\.versions/);
    assert.throws(() => validateDownloadTarget(base, ["/my-files/sync2"]), /\.versions/);
    assert.throws(() => validateDownloadTarget(join(base, "sync2", "Docs"), ["/my-files/.versions"]), /\.versions/);
    assert.equal(validateDownloadTarget(join(sync, "Plain"), ["/my-files/a.txt"]), join(sync, "Plain"));
  });

  it("an ordinary download is not refused only because the folder holds, or sits above, the log or a .versions folder", async () => {
    const h = join(base, "home3");
    await mkdir(join(h, "Proton", "Docs", ".versions"), { recursive: true });
    await mkdir(join(h, "logs"), { recursive: true });
    process.env.HOME = h;
    process.env.PROTON_DRIVE_SYNC_PATH = join(h, "Proton");
    process.env.PROTON_DRIVE_AUDIT_LOG = join(h, "logs", "audit.jsonl");
    // a.txt into $HOME (the sync folder and the log are below it), into the sync root (a .versions exists below it) and into logs/
    assert.equal(validateDownloadTarget(h, ["/my-files/a.txt"]), h);
    assert.equal(validateDownloadTarget(join(h, "Proton"), ["/my-files/a.txt"]), join(h, "Proton"));
    assert.equal(validateDownloadTarget(join(h, "Proton", "Docs"), ["/my-files/a.txt"]), join(h, "Proton", "Docs"));
    assert.equal(validateDownloadTarget(join(h, "logs"), ["/my-files/other.txt"]), join(h, "logs"));
    // but a remote folder Docs into the sync root lands on the local Docs/.versions, and a folder named like the log's folder on logs/
    assert.throws(() => validateDownloadTarget(join(h, "Proton"), ["/my-files/Docs"]), /\.versions/);
    assert.throws(() => validateDownloadTarget(h, ["/my-files/logs"]), /audit log/);
    assert.throws(() => validateDownloadTarget(h, ["/my-files/Proton"]), /\.versions/);
  });

  it("a downloaded drive root is written as <folder>/root, so that name and the folder itself are checked", async () => {
    const h = join(base, "home4");
    await mkdir(join(h, "Proton", ".versions"), { recursive: true });
    await mkdir(join(h, "dl"), { recursive: true });
    await mkdir(join(h, "logs"), { recursive: true });
    await mkdir(join(h, "root", "sub"), { recursive: true });
    process.env.HOME = h;
    // the local name is "root": a protected thing named root is caught (the derived name my-files would not be)
    process.env.PROTON_DRIVE_AUDIT_LOG = join(h, "root", "audit.jsonl");
    assert.throws(() => validateDownloadTarget(h, ["/my-files"]), /audit log/);
    assert.throws(() => validateDownloadTarget(h, ["/photos/"]), /audit log/);
    // a whole drive tree lands below the folder: a folder that holds the log or a .versions folder is refused
    process.env.PROTON_DRIVE_AUDIT_LOG = join(h, "logs", "audit.jsonl");
    assert.throws(() => validateDownloadTarget(h, ["/my-files"]), /audit log/);
    delete process.env.PROTON_DRIVE_AUDIT_LOG;
    process.env.PROTON_DRIVE_SYNC_PATH = join(h, "Proton");
    assert.throws(() => validateDownloadTarget(h, ["/my-files"]), /\.versions/);
    assert.throws(() => validateDownloadTarget(join(h, "Proton"), ["/trash"]), /\.versions/);
    // an ordinary folder is fine, and a single file still only checks its own name
    delete process.env.PROTON_DRIVE_SYNC_PATH;
    assert.equal(validateDownloadTarget(join(h, "dl"), ["/my-files"]), join(h, "dl"));
    assert.equal(validateDownloadTarget(h, ["/my-files/a.txt"]), h);
  });

  it("a remote path without an item name is refused", () => {
    assert.throws(() => validateDownloadTarget(join(base, "any"), ["/"]), /no item name/);
  });

  describe("folder upload: credential trees and names", () => {
    for (const rel of [".aws/credentials", ".ssh/authorized_keys", ".gnupg/pubring.kbx", ".kube/config", ".docker/config.json", ".config/gcloud/creds.db", "deep/er/.netrc", "x/.npmrc", ".pgpass", "k/id_ecdsa", "k/id_dsa.pub", ".git-credentials", "gc/credentials.db", "gc/access_tokens.db", "gc/application_default_credentials.json", "gc/legacy_credentials/x@y.com/adc.json"]) {
      it(`rejects a copied ${rel}`, async () => {
        const dir = join(base, "cred-" + rel.replace(/\W/g, "_"));
        await mkdir(join(dir, rel, ".."), { recursive: true });
        await writeFile(join(dir, rel), "x");
        assert.throws(() => assertLocalPathAllowed(dir, { scan: true, upload: true }), /protected or secret file/);
      });
    }
    it("allows ordinary project folders named .docker, .kube or gcloud, and a .config with other tools", async () => {
      const dir = join(base, "proj-ok");
      await mkdir(join(dir, ".docker", "php"), { recursive: true });
      await mkdir(join(dir, ".kube"), { recursive: true });
      await mkdir(join(dir, "deploy", "gcloud"), { recursive: true });
      await mkdir(join(dir, ".config", "git"), { recursive: true });
      await writeFile(join(dir, ".docker", "php", "Dockerfile"), "FROM php");
      await writeFile(join(dir, ".kube", "kustomization.yaml"), "x");
      await writeFile(join(dir, "deploy", "gcloud", "main.tf"), "x");
      await writeFile(join(dir, ".config", "git", "ignore"), "x");
      assertLocalPathAllowed(dir, { scan: true, upload: true });
    });

    it("also rejects an empty secret folder, and a hardlink named like a secret file", async () => {
      const dir = join(base, "cred-empty");
      await mkdir(join(dir, "x", ".ssh"), { recursive: true });
      assert.throws(() => assertLocalPathAllowed(dir, { scan: true, upload: true }), /protected or secret file.*\.ssh/);
      const dir2 = join(base, "cred-link");
      await mkdir(dir2, { recursive: true });
      await writeFile(join(base, "orig"), "x");
      const { link } = await import("node:fs/promises");
      await link(join(base, "orig"), join(dir2, ".netrc"));
      assert.throws(() => assertLocalPathAllowed(dir2, { scan: true, upload: true }), /protected or secret file/);
    });
  });

  describe("folder upload scan covers nested entries", () => {
    it("rejects a nested secret-file name", async () => {
      const dir = join(base, "up1");
      await mkdir(join(dir, "a", "b"), { recursive: true });
      await writeFile(join(dir, "a", "b", ".env"), "S=1");
      assert.throws(() => assertLocalPathAllowed(dir, { scan: true, upload: true }), /protected or secret file.*a.b..env/);
    });

    it("rejects a symlink that leads out of the folder, to a protected folder or anywhere else", async () => {
      const dir = join(base, "up2");
      await mkdir(join(fakeHome, ".ssh"), { recursive: true });
      await mkdir(join(dir, "n"), { recursive: true });
      await writeFile(join(dir, "n", "ok.txt"), "x");
      await symlink(join(fakeHome, ".ssh"), join(dir, "n", "keys"));
      assert.throws(() => assertLocalPathAllowed(dir, { scan: true, upload: true }), /symlink that points outside/);
      const dir2 = join(base, "up2b");
      await mkdir(dir2);
      await symlink(join(base, "up1"), join(dir2, "elsewhere"));
      assert.throws(() => assertLocalPathAllowed(dir2, { scan: true, upload: true }), /symlink that points outside/);
      const dir3 = join(base, "up2c");
      await mkdir(dir3);
      await symlink(join(base, "no-such-target"), join(dir3, "dangling"));
      assert.throws(() => assertLocalPathAllowed(dir3, { scan: true, upload: true }), /symlink that points outside/);
    });

    it("with PROTON_DRIVE_LOCAL_ROOT a symlink out of the folder is rejected too", async () => {
      const dir = join(base, "up3");
      await mkdir(dir, { recursive: true });
      await symlink(tmpdir(), join(dir, "out"));
      process.env.PROTON_DRIVE_LOCAL_ROOT = base;
      assert.throws(() => assertLocalPathAllowed(dir, { scan: true, upload: true }), /symlink that points outside/);
    });

    it("accepts a clean tree, including a symlink that stays inside it", async () => {
      const dir = join(base, "up4");
      await mkdir(join(dir, "docs"), { recursive: true });
      await writeFile(join(dir, "docs", "a.txt"), "x");
      await writeFile(join(dir, ".envrc-not"), "x");
      await symlink(join(dir, "docs"), join(dir, "alias"));
      assertLocalPathAllowed(dir, { scan: true, upload: true });
    });

    it("the opt-out switches the nested check off as well", async () => {
      process.env.PROTON_DRIVE_ALLOW_SENSITIVE_PATHS = "1";
      assertLocalPathAllowed(join(base, "up1"), { scan: true, upload: true });
    });
  });
});
