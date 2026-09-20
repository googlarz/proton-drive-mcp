import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, delimiter } from "node:path";

import {
  resolveSyncPath,
  readSyncFile,
  writeSyncFile,
  syncFileExists,
} from "../dist/utils/syncfs.js";
import { assertLocalPathAllowed } from "../dist/utils/localguard.js";

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

  it("opt-out does not disable an explicit LOCAL_ROOT", async () => {
    const a = join(base, "rootD");
    await mkdir(a, { recursive: true });
    process.env.PROTON_DRIVE_LOCAL_ROOT = a;
    process.env.PROTON_DRIVE_ALLOW_SENSITIVE_PATHS = "1";
    assert.throws(() => assertLocalPathAllowed(join(home, ".ssh", "id_rsa")), /outside PROTON_DRIVE_LOCAL_ROOT/);
    assertLocalPathAllowed(join(a, "ok.txt"));
  });
});
