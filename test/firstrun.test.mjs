import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join, delimiter } from "node:path";
import { findDriveCli, runDrive, checkCliAvailable } from "../dist/utils/subprocess.js";
import { DriveCliNotFoundError, DriveNotAuthenticatedError } from "../dist/utils/errors.js";
import { validateLocalPath, validateDownloadTarget, validateRemotePath } from "../dist/utils/validation.js";
import { ROOT, makeSandbox, startServer } from "./helpers/mcp-client.mjs";

const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "pdmcp-first-")); dirs.push(d); return d; };
const savedBin = process.env.PROTON_DRIVE_BIN;
afterEach(() => {
  if (savedBin === undefined) delete process.env.PROTON_DRIVE_BIN; else process.env.PROTON_DRIVE_BIN = savedBin;
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function script(dir, body = "exit 0", mode = 0o755) {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "proton-drive");
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, mode);
  return f;
}
/** A fake CLI that prints `stdout` and exits with `code`; becomes the configured binary. */
function fakeCli(stdout, code = 0) {
  const d = tmp();
  writeFileSync(join(d, "out"), stdout);
  const f = script(d, `cat "${join(d, "out")}"\nexit ${code}`);
  process.env.PROTON_DRIVE_BIN = f;
  return f;
}

describe("CLI auto-detect", { skip: process.platform === "win32" }, () => {
  const find = (path, home, wellKnownDirs) => findDriveCli({ path, home, wellKnownDirs });

  it("prefers PATH, then the well-known folders", () => {
    const onPath = script(tmp());
    const home = tmp();
    const local = script(join(home, ".local", "bin"));
    assert.deepEqual(find(dirnameOf(onPath), home), { path: onPath, viaFallback: false });
    assert.deepEqual(find("/nonexistent", home), { path: local, viaFallback: true });
  });

  it("searches the given well-known folders in order and returns undefined when empty", () => {
    const a = tmp(), b = script(tmp());
    assert.equal(find("", tmp(), [a, dirnameOf(b)]).path, b);
    assert.equal(find("", tmp(), [a]), undefined);
  });

  it("never uses relative or empty PATH entries or a relative home", () => {
    const d = tmp();
    script(d);
    script(join(d, "rel"));
    const cwd = process.cwd();
    process.chdir(d);
    try {
      assert.equal(find(["", ".", "rel", "./rel"].join(delimiter), "rel", []), undefined);
      assert.equal(find("", "rel"), findDriveCli({ path: "", home: "" }));
      assert.equal(find("", tmp(), [".", "rel", ""]), undefined);
    } finally {
      process.chdir(cwd);
    }
  });

  it("skips folders, non-executables, world-writable files and world-writable folders", () => {
    const asDir = tmp();
    mkdirSync(join(asDir, "proton-drive"));
    const noExec = script(tmp(), "exit 0", 0o644);
    const ww = script(tmp(), "exit 0", 0o757);
    const wwDirBin = script(tmp());
    chmodSync(dirnameOf(wwDirBin), 0o777);
    const linkDir = tmp();
    symlinkSync(wwDirBin, join(linkDir, "proton-drive"));
    const good = script(tmp());
    const all = [asDir, dirnameOf(noExec), dirnameOf(ww), dirnameOf(wwDirBin), linkDir];
    assert.equal(find(all.join(delimiter), tmp(), []), undefined);
    assert.equal(find([...all, dirnameOf(good)].join(delimiter), tmp(), []).path, good);
  });

  it("an empty PROTON_DRIVE_BIN runs the CLI found in ~/.local/bin", () => {
    const home = tmp();
    script(join(home, ".local", "bin"), `echo '{"ok":1}'`);
    const mod = join(ROOT, "dist", "utils", "subprocess.js");
    const out = execFileSync(process.execPath, ["--input-type=module", "-e",
      `const m = await import(${JSON.stringify(mod)}); console.log(JSON.stringify(await m.runDrive(["filesystem","info","/my-files"])));`],
      { env: { HOME: home, PATH: "/usr/bin:/bin", PROTON_DRIVE_BIN: "" }, encoding: "utf8" });
    assert.deepEqual(JSON.parse(out), { ok: 1 });
  });
});

function dirnameOf(f) { return f.slice(0, f.lastIndexOf("/")); }

describe("plain-language errors", { skip: process.platform === "win32" }, () => {
  const call = () => runDrive(["filesystem", "info", "/my-files"]);
  const SETTING = /"proton-drive CLI path"/;

  it("not found: names the setting field and the command", () => {
    const m = new DriveCliNotFoundError().message;
    assert.match(m, SETTING);
    assert.match(m, /which proton-drive/);
    assert.match(m, /Extensions/);
  });

  it("wrong path: says the configured path does not exist", async () => {
    process.env.PROTON_DRIVE_BIN = "/nonexistent/proton-drive";
    await assert.rejects(call, (e) => e.name === "DriveCliNotFoundError" && SETTING.test(e.message) && e.message.includes("/nonexistent/proton-drive") && /does not exist/.test(e.message) && /which proton-drive/.test(e.message));
    assert.deepEqual(await checkCliAvailable(), { available: false, reason: "not_found" });
  });

  for (const [label, make] of [["a folder", () => tmp()], ["a non-executable file", () => script(tmp(), "exit 0", 0o644)]]) {
    it(`wrong path (${label}): says it cannot be run`, async () => {
      process.env.PROTON_DRIVE_BIN = make();
      await assert.rejects(call, (e) => SETTING.test(e.message) && /cannot be run/.test(e.message) && !/no output/.test(e.message));
    });
  }

  it("a program that fails silently points at the setting", async () => {
    const f = fakeCli("", 1);
    await assert.rejects(call, (e) => SETTING.test(e.message) && e.message.includes(f) && /which proton-drive/.test(e.message));
  });

  it("not signed in: one command, using the configured program", async () => {
    const f = fakeCli("You need to login first", 1);
    await assert.rejects(call, (e) => e.name === "DriveNotAuthenticatedError" && e.message.includes(`'${f}' auth login`) && /not signed in/i.test(e.message));
    assert.match(new DriveNotAuthenticatedError().message, /`proton-drive auth login`/);
  });
});

describe("CLI output: secrets and trailing lines", { skip: process.platform === "win32" }, () => {
  const link = "https://drive.proton.me/urls/ABC123#s3cretKey";
  const secretJson = `{"urlAccess":{"url":"${link}","customPassword":"hunter2"}`; // truncated: unparsable
  const noLeak = (m) => { for (const s of ["hunter2", "s3cretKey", "ABC123"]) assert.ok(!m.includes(s), m); };

  async function failure(args, stdout, code = 0) {
    fakeCli(stdout, code);
    const written = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => { written.push(String(s)); return true; };
    try {
      await runDrive(args);
    } catch (e) {
      return `${e.message}\n${written.join("")}`;
    } finally {
      process.stderr.write = orig;
    }
    assert.fail("expected a failure");
  }

  it("sharing parse errors omit the output", async () => {
    const m = await failure(["sharing", "status", "/my-files/a"], secretJson);
    noLeak(m);
    assert.match(m, /Failed to parse CLI output/);
  });

  it("other parse errors redact password and url values, including a cut-off string", async () => {
    const m = await failure(["filesystem", "info", "/a"], `{"x":1,"password": "hunter2","url":"${link}","customPassword":"hunter2 and`);
    noLeak(m);
    assert.match(m, /\*\*\*/);
  });

  it("failed sharing commands do not leak through the error text", async () => {
    noLeak(await failure(["sharing", "set-url", "/a"], secretJson, 1));
    noLeak(await failure(["sharing", "set-url", "/a"], `{\n  customPassword: 'hunter2',\n  url: '${link}'\n}`, 1));
    noLeak(await failure(["sharing", "set-url", "/a"], `Error: could not update ${link}`, 1));
  });

  const run = (stdout) => { fakeCli(stdout); return runDrive(["filesystem", "info", "/a"]); };

  it("tolerates a trailing non-JSON line", async () => {
    assert.deepEqual(await run(`{"a":1}\nUpdate available: 0.9.1\n`), { a: 1 });
    assert.deepEqual(await run(`noise\n[\n  {"a":1}\n]\n\nUpdate available: 0.9.1\nRun proton-drive update\n`), [{ a: 1 }]);
    assert.equal(await run(`undefined\nUpdate available: 0.9.1\n`), null);
  });

  for (const [label, out] of [
    ["a second JSON value", `{"a":1}\n{"a":2}\nUpdate available`],
    ["a stray closer", `{"a":1}\n}\n`],
    ["an inner value of a cut-off document", `[\n{"a":1}\nUpdate available`],
    ["an inner value after a broken opener", `{"items":[\n{"a":1}\nUpdate available`],
    ["a continuation", `{"a":1}\n, "b": 2`],
    ["many trailing lines", `{"a":1}\n${"x\n".repeat(10)}`],
  ]) {
    it(`refuses ${label}`, async () => {
      await assert.rejects(() => run(out), { name: "DriveParseError" });
    });
  }
});

describe("~ in local paths", () => {
  const home = homedir();

  it("expands ~ and ~/ to the home folder", () => {
    assert.equal(validateLocalPath("~"), home);
    assert.equal(validateLocalPath("~/Downloads/x.txt"), `${home}/Downloads/x.txt`);
    assert.equal(validateDownloadTarget("~/Downloads", ["/my-files/a.pdf"]), `${home}/Downloads`);
  });

  for (const p of [
    "~/.ssh", "~/.SSH", "~/.Ssh/known_hosts", "~/.ssh/", "~//.ssh", "~/.aws/credentials", "~/.zshrc", "~/.ZSHRC",
    "~/Library/LaunchAgents/x.plist", "~/project/.env", "~/project/id_rsa", "~//etc/../x", "~/../", "~/..", "~/../.ssh", "~/Downloads/../.ssh", "~/./.ssh",
  ]) {
    it(`refuses ${p}`, () => {
      if (/\.SSH|\.Ssh|ZSHRC/.test(p) && !["darwin", "win32"].includes(process.platform)) return;
      assert.throws(() => validateLocalPath(p), /protected|secret|'\.' or '\.\.'/);
    });
  }

  it("applies scan, upload and download-target rules after expansion", () => {
    assert.throws(() => validateLocalPath("~", { scan: true }), /contains protected locations/);
    assert.throws(() => validateLocalPath("~/", { scan: true, upload: true }), /contains protected locations/);
    assert.throws(() => validateDownloadTarget("~", ["/my-files/.zshrc"]), /protected|secret/);
    assert.throws(() => validateDownloadTarget("~", ["/my-files/.ssh"]), /protected/);
  });

  it("does not expand ~user, a tilde later in the path, or remote paths", () => {
    for (const p of ["~root/x", "~other", "a/~/b", " ~/x"]) assert.throws(() => validateLocalPath(p), /must be absolute/);
    assert.equal(validateLocalPath("/tmp/~/b"), "/tmp/~/b");
    assert.throws(() => validateRemotePath("~/a"), /must be absolute/);
    assert.equal(validateRemotePath("/my-files/~/a"), "/my-files/~/a");
  });
});

describe("approval mode typos", () => {
  async function status(value, mode = "json") {
    const sb = makeSandbox();
    const c = await startServer(mode, sb, { PROTON_DRIVE_APPROVAL: value });
    try {
      const r = await c.call("drive_auth_status", {});
      return { data: r.data, stderr: c.stderr };
    } finally {
      await c.close();
      sb.cleanup();
    }
  }

  for (const v of ["off", "none"]) {
    it(`"${v}" stays strict, warns at startup and is explained in drive_auth_status`, async () => {
      const { data, stderr } = await status(v);
      assert.equal(data.approvalMode, "strict");
      assert.match(data.approvalHint, /not recognised/);
      assert.match(data.approvalHint, /"Who approves destructive operations/);
      assert.match(stderr, /not recognised/);
    });
  }

  it("a valid value has no hint", async () => {
    const { data, stderr } = await status("Strict");
    assert.equal(data.approvalMode, "strict");
    assert.equal(data.approvalHint, undefined);
    assert.doesNotMatch(stderr, /not recognised/);
  });

  it("signed out: drive_auth_status says what to run", async () => {
    const { data } = await status("human", "auth-fail");
    assert.equal(data.authenticated, false);
    assert.match(data.signInHint, /auth login/);
  });
});

describe("mcpb undo setting", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "mcpb", "manifest.json"), "utf8"));
  const launcher = readFileSync(join(ROOT, "mcpb", "launcher.mjs"), "utf8").split("// index.js only")[0];

  it("is a boolean, on by default, mapped to PROTON_DRIVE_UNDO and described plainly", () => {
    const c = manifest.user_config.undo_journal;
    assert.equal(c.type, "boolean");
    assert.equal(c.default, true);
    assert.equal(manifest.server.mcp_config.env.PROTON_DRIVE_UNDO, "${user_config.undo_journal}");
    assert.match(c.description, /file names/i);
    assert.doesNotMatch(c.description, /PROTON_DRIVE/);
  });

  it("only false turns the journal off; empty and unfilled values are dropped", () => {
    const run = (v) => {
      const env = { ...process.env };
      delete env.PROTON_DRIVE_UNDO;
      if (v !== undefined) env.PROTON_DRIVE_UNDO = v;
      return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
        `${launcher}\nconst { undoEnabled } = await import(${JSON.stringify(join(ROOT, "dist", "utils", "undoJournal.js"))});\nconsole.log(JSON.stringify([process.env.PROTON_DRIVE_UNDO ?? null, undoEnabled()]));`], { env, encoding: "utf8" }));
    };
    assert.deepEqual(run("false"), ["false", false]);
    assert.deepEqual(run("true"), ["true", true]);
    for (const v of ["", "  ", "${user_config.undo_journal}", undefined]) assert.deepEqual(run(v), [null, true], String(v));
  });
});
