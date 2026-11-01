// Guard layer (1.6.0): PROTON_DRIVE_MODE, PROTON_DRIVE_REMOTE_ROOTS, PROTON_DRIVE_AUDIT_LOG, PROTON_DRIVE_SNAPSHOT_BEFORE_OVERWRITE.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { makeSandbox, startServer, nonVersionCalls, sleep, fakeEnv, DIST_INDEX } from "./helpers/mcp-client.mjs";
import {
  MUTATING_TOOL_NAMES, READ_TOOL_NAMES, REMOTE_PATH_ARGS, ROOT_UNSCOPED_TOOL_NAMES, ROOT_EXEMPT_TOOL_NAMES, resolveMode, rootsRefusal,
} from "../dist/index.js";
import { parseRemoteRoots, pathInRoots } from "../dist/utils/remoteroots.js";
import { AuditLog, redactArgs } from "../dist/utils/audit.js";

async function withServer(env, fn, mode = "json") {
  const sb = makeSandbox();
  const c = await startServer(mode, sb, env);
  try { return await fn(c, sb); } finally { await c.close(); sb.cleanup(); }
}
const names = (tools) => tools.map((t) => t.name);
const readLog = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("tool classification", () => {
  let tools;
  it("every tool is exactly one of read or mutating (a new tool cannot be forgotten)", async () => {
    tools = await withServer({}, (c) => c.listTools());
    for (const n of names(tools)) assert.equal(MUTATING_TOOL_NAMES.has(n) + READ_TOOL_NAMES.has(n), 1, `${n} must be in exactly one of MUTATING_TOOL_NAMES / READ_TOOL_NAMES`);
    for (const n of [...MUTATING_TOOL_NAMES, ...READ_TOOL_NAMES]) assert.ok(names(tools).includes(n), `stale name ${n}`);
  });

  it("every tool is exactly one of path-scoped, root-unscoped (fails closed) or exempt", () => {
    for (const n of names(tools)) {
      const k = (n in REMOTE_PATH_ARGS) + ROOT_UNSCOPED_TOOL_NAMES.has(n) + ROOT_EXEMPT_TOOL_NAMES.has(n);
      assert.equal(k, 1, `${n} must be in exactly one of REMOTE_PATH_ARGS / ROOT_UNSCOPED_TOOL_NAMES / ROOT_EXEMPT_TOOL_NAMES`);
    }
    for (const n of [...ROOT_UNSCOPED_TOOL_NAMES, ...ROOT_EXEMPT_TOOL_NAMES, ...Object.keys(REMOTE_PATH_ARGS)]) assert.ok(names(tools).includes(n), `stale name ${n}`);
  });

  it("every remote-path-looking argument of a scoped tool is checked; exempt tools have none", () => {
    const pathLike = /^(?!local)(\w*[pP]ath\w*|sources|\w*[fF]older)$/;
    for (const t of tools) {
      const props = Object.keys(t.inputSchema.properties).filter((p) => pathLike.test(p));
      if (t.name in REMOTE_PATH_ARGS) assert.deepEqual(props.sort(), REMOTE_PATH_ARGS[t.name].map((s) => s.arg).sort(), t.name);
      if (ROOT_EXEMPT_TOOL_NAMES.has(t.name)) assert.deepEqual(props, [], t.name);
    }
  });
});

describe("PROTON_DRIVE_MODE=readonly", () => {
  it("resolveMode: unset/blank/full -> full; readonly -> readonly; anything else fails closed", () => {
    assert.equal(resolveMode(undefined), "full");
    assert.equal(resolveMode("  "), "full");
    assert.equal(resolveMode("FULL"), "full");
    assert.equal(resolveMode(" ReadOnly "), "readonly");
    assert.equal(resolveMode("read-only"), "readonly");
    assert.equal(resolveMode("0"), "readonly");
  });

  it("hides every mutating tool and keeps every read tool", async () => {
    const tools = await withServer({ PROTON_DRIVE_MODE: "readonly" }, (c) => c.listTools());
    assert.deepEqual(names(tools).sort(), [...READ_TOOL_NAMES].sort());
    assert.equal(tools.length, 24);
  });

  it("refuses a mutating tool at call time, with a clear message, without touching the CLI", async () => {
    await withServer({ PROTON_DRIVE_MODE: "readonly" }, async (c, sb) => {
      for (const [tool, args] of [["drive_trash", { path: "/my-files/x" }], ["drive_empty_trash", { confirmed: true }], ["drive_auth_logout", { confirmed: true }]]) {
        const r = await c.call(tool, args);
        assert.equal(r.isError, true, tool);
        assert.match(r.text, /readonly mode.*PROTON_DRIVE_MODE=full/, tool);
      }
      await sleep(100);
      assert.deepEqual(nonVersionCalls(sb.argvLog), []);
    });
  });

  it("still serves reads and downloads", async () => {
    await withServer({ PROTON_DRIVE_MODE: "readonly" }, async (c, sb) => {
      assert.equal((await c.call("drive_version")).isError, false);
      assert.equal((await c.call("drive_list", { path: "/my-files" })).isError, false);
      const dl = await c.call("drive_download", { remotePath: "/my-files/a.txt", localPath: join(sb.dir, "out") });
      assert.doesNotMatch(dl.text, /readonly/);
    });
  });

  it("an invalid value fails closed (readonly) with one stderr warning; full still lists 51", async () => {
    await withServer({ PROTON_DRIVE_MODE: "bogus" }, async (c) => {
      assert.equal((await c.listTools()).length, 24);
      assert.equal((c.stderr.match(/PROTON_DRIVE_MODE/g) ?? []).length, 1);
    });
    await withServer({ PROTON_DRIVE_MODE: "full" }, async (c) => assert.equal((await c.listTools()).length, 51));
  });

  it("offers only prompts whose tools are all available", async () => {
    await withServer({ PROTON_DRIVE_MODE: "readonly" }, async (c) => {
      const prompts = (await c.request("prompts/list", {})).result.prompts.map((p) => p.name);
      assert.ok(!prompts.includes("organise-folder"), "needs drive_bulk_move and drive_trash");
      assert.ok(prompts.includes("find-files"));
      assert.ok(prompts.includes("storage-audit"));
    });
  });

  it("combines with the core tier", async () => {
    await withServer({ PROTON_DRIVE_MODE: "readonly", PROTON_DRIVE_TOOL_TIER: "core" }, async (c) => {
      const got = names(await c.listTools());
      assert.ok(got.includes("drive_list") && !got.includes("drive_mkdir") && !got.includes("drive_audit_log"));
    });
  });
});

describe("PROTON_DRIVE_REMOTE_ROOTS: matching", () => {
  it("parseRemoteRoots: unset/blank = unrestricted; entries split on the path delimiter; invalid entries are dropped (fail closed)", () => {
    assert.equal(parseRemoteRoots(undefined), null);
    assert.equal(parseRemoteRoots("  "), null);
    assert.deepEqual(parseRemoteRoots(["/my-files/A", "/my-files/B/"].join(delimiter)), ["/my-files/A", "/my-files/B"]);
    assert.deepEqual(parseRemoteRoots(["relative", "/my-files/../x", "/a//b", "/my-files/ok"].join(delimiter)), ["/my-files/ok"]);
    assert.deepEqual(parseRemoteRoots("relative"), []);
  });

  it("pathInRoots matches whole segments, case-sensitively, with no empty segments", () => {
    const roots = ["/my-files/A", "/my-files/Projects/X"];
    assert.ok(pathInRoots("/my-files/A", roots));
    assert.ok(pathInRoots("/my-files/A/b/c", roots));
    assert.ok(pathInRoots("/my-files/Projects/X/y", roots));
    for (const p of ["/my-files/AB", "/my-files/AB/x", "/my-files/a", "/my-files", "/", "/my-files/Projects", "/my-files/Projects/Xy", "/my-files/A//b", "/trash/A", "/my-files/A\\/b/../x"]) assert.ok(!pathInRoots(p, roots), p);
    assert.ok(!pathInRoots("/my-files/A", roots, true), "strict excludes the root itself");
    assert.ok(pathInRoots("/my-files/A/b", roots, true));
    assert.ok(pathInRoots("/anything", ["/"]));
    assert.ok(!pathInRoots("/", ["/"], true));
    assert.ok(!pathInRoots("/my-files/A", []));
  });

  it("rootsRefusal checks every path argument of a tool, including lists and defaults", () => {
    const roots = ["/my-files/A"];
    assert.equal(rootsRefusal("drive_bulk_move", { sources: ["/my-files/A/x"], destinationFolder: "/my-files/A/y" }, roots), undefined);
    assert.match(rootsRefusal("drive_bulk_move", { sources: ["/my-files/A/x", "/my-files/B/x"], destinationFolder: "/my-files/A/y" }, roots), /sources.*outside/);
    assert.match(rootsRefusal("drive_bulk_move", { sources: ["/my-files/A/x"], destinationFolder: "/my-files/B" }, roots), /destinationFolder.*outside/);
    assert.match(rootsRefusal("drive_tree", {}, roots), /path \/my-files is outside/, "the /my-files default is checked too");
    assert.match(rootsRefusal("drive_trash", { path: "/my-files/A" }, roots), /root folder itself/);
    assert.match(rootsRefusal("drive_share_leave", { path: "/my-files/A" }, roots), /root folder itself/, "leaving the root itself would take it out of scope");
    assert.equal(rootsRefusal("drive_share_leave", { path: "/my-files/A/sub" }, roots), undefined);
    assert.equal(rootsRefusal("drive_list", { path: "/my-files/A" }, roots), undefined);
    assert.match(rootsRefusal("drive_empty_trash", {}, roots), /cannot be limited/);
    assert.equal(rootsRefusal("drive_version", {}, roots), undefined);
    assert.throws(() => rootsRefusal("drive_list", { path: "/my-files/A/../B" }, roots), /'\.\.'/);
  });
});

describe("PROTON_DRIVE_REMOTE_ROOTS: server", () => {
  const ROOT = "/my-files/A";
  const TREE = {
    "/my-files": [{ uid: "1", type: "folder", name: { ok: true, value: "A" } }, { uid: "2", type: "folder", name: { ok: true, value: "AB" } }],
    "/my-files/A": [{ uid: "3", type: "file", name: { ok: true, value: "in.txt" }, activeRevision: { claimedSize: 5 } }, { uid: "4", type: "folder", name: { ok: true, value: "sub" } }],
    "/my-files/A/sub": [{ uid: "5", type: "file", name: { ok: true, value: "deep.txt" }, activeRevision: { claimedSize: 7 } }],
    "/my-files/AB": [{ uid: "6", type: "file", name: { ok: true, value: "secret.txt" }, activeRevision: { claimedSize: 9 } }],
  };
  // The fake reads FAKE_TREE from the server's env, so the tree file must exist before the process starts.
  const runTree = async (fn, extra = {}) => {
    const sb = makeSandbox();
    writeFileSync(join(sb.dir, "tree.json"), JSON.stringify(TREE));
    const c = await startServer("tree", sb, { FAKE_TREE: join(sb.dir, "tree.json"), PROTON_DRIVE_RETRY_BASE_MS: "1", PROTON_DRIVE_REMOTE_ROOTS: ROOT, ...extra });
    try { return await fn(c, sb); } finally { await c.close(); sb.cleanup(); }
  };

  it("serves paths inside the root and refuses siblings, parents, traversal and non-canonical spellings without a CLI call", async () => {
    await runTree(async (c, sb) => {
      const inside = await c.call("drive_list", { path: ROOT });
      assert.equal(inside.isError, false, inside.text);
      assert.deepEqual(inside.data.items.map((i) => i.path), ["/my-files/A/in.txt", "/my-files/A/sub"]);
      const before = nonVersionCalls(sb.argvLog).length;
      for (const path of ["/my-files/AB", "/my-files", "/", "/my-files/A/../AB", "/my-files//A/sub", "/trash"]) {
        const r = await c.call("drive_list", { path });
        assert.equal(r.isError, true, path);
      }
      const named = await c.call("drive_list", { path: "/my-files/AB" });
      assert.match(named.text, /outside PROTON_DRIVE_REMOTE_ROOTS \(allowed: \/my-files\/A\)/);
      assert.equal(nonVersionCalls(sb.argvLog).length, before);
    });
  });

  it("every scoped tool refuses an outside path argument, before any CLI call", async () => {
    const tools = await withServer({}, (c) => c.listTools());
    await runTree(async (c, sb) => {
      for (const t of tools.filter((x) => x.name in REMOTE_PATH_ARGS)) {
        const specs = REMOTE_PATH_ARGS[t.name];
        const args = {};
        for (const [k, p] of Object.entries(t.inputSchema.properties)) {
          if (!(t.inputSchema.required ?? []).includes(k) && !specs.some((s) => s.arg === k)) continue;
          const spec = specs.find((s) => s.arg === k);
          args[k] = spec ? (spec.list ? ["/my-files/Outside/x"] : "/my-files/Outside/x") : p.enum ? p.enum[0] : p.type === "boolean" ? true : p.type === "integer" ? 1 : p.type === "array" ? ["x"] : "x";
        }
        const r = await c.call(t.name, args);
        assert.equal(r.isError, true, t.name);
        assert.match(r.text, /outside PROTON_DRIVE_REMOTE_ROOTS/, t.name);
      }
      assert.deepEqual(nonVersionCalls(sb.argvLog), []);
    });
  });

  it("tools that cannot be scoped fail closed; exempt ones still work", async () => {
    const tools = await withServer({}, (c) => c.listTools());
    await runTree(async (c, sb) => {
      for (const t of tools.filter((x) => ROOT_UNSCOPED_TOOL_NAMES.has(x.name))) {
        const args = {};
        for (const k of t.inputSchema.required ?? []) {
          const p = t.inputSchema.properties[k];
          args[k] = p.type === "boolean" ? true : p.type === "array" ? ["x"] : p.type === "integer" ? 1 : "x";
        }
        const r = await c.call(t.name, args);
        assert.equal(r.isError, true, t.name);
        assert.match(r.text, /cannot be limited to PROTON_DRIVE_REMOTE_ROOTS/, t.name);
      }
      assert.deepEqual(nonVersionCalls(sb.argvLog), []);
      assert.equal((await c.call("drive_version")).isError, false);
    });
  });

  it("the root folder itself cannot be trashed, renamed or moved; its children can", async () => {
    await runTree(async (c, sb) => {
      for (const [tool, args] of [["drive_trash", { path: ROOT }], ["drive_rename", { path: ROOT, newName: "z" }], ["drive_move", { sourcePath: ROOT, destinationPath: "/my-files/A/z" }]]) {
        const r = await c.call(tool, args);
        assert.match(r.text, /root folder itself/, tool);
      }
      const ok = await c.call("drive_trash", { path: "/my-files/A/in.txt" });
      assert.equal(ok.isError, false, ok.text);
      assert.deepEqual(nonVersionCalls(sb.argvLog).at(-1).slice(0, 2), ["filesystem", "trash"]);
    });
  });

  it("one outside item refuses the whole bulk call", async () => {
    await runTree(async (c, sb) => {
      const r = await c.call("drive_bulk_trash", { paths: ["/my-files/A/in.txt", "/my-files/AB/secret.txt"] });
      assert.equal(r.isError, true);
      assert.match(r.text, /paths \/my-files\/AB\/secret\.txt is outside/);
      assert.deepEqual(nonVersionCalls(sb.argvLog), []);
    });
  });

  it("walk tools stay inside the root and never list outside it", async () => {
    await runTree(async (c, sb) => {
      const tree = await c.call("drive_tree", { path: ROOT, refresh: true });
      assert.equal(tree.isError, false, tree.text);
      assert.doesNotMatch(tree.text, /AB|secret/);
      const search = await c.call("drive_search", { path: ROOT, refresh: true });
      assert.deepEqual(search.data.items.map((i) => i.path).sort(), ["/my-files/A/in.txt", "/my-files/A/sub", "/my-files/A/sub/deep.txt"]);
      const usage = await c.call("drive_usage", { path: ROOT, refresh: true });
      assert.equal(usage.isError, false, usage.text);
      assert.doesNotMatch(usage.text, /secret/);
      const listed = nonVersionCalls(sb.argvLog).filter((a) => a[1] === "list").map((a) => a[2]);
      assert.ok(listed.length > 0 && listed.every((p) => p === ROOT || p.startsWith(ROOT + "/")), listed.join(", "));
      for (const t of ["drive_tree", "drive_search", "drive_usage", "drive_find_duplicates", "drive_sharing_audit"]) {
        const r = await c.call(t, {});
        assert.match(r.text, /path \/my-files is outside/, `${t} default path is /my-files`);
      }
      const outside = await c.call("drive_search", { path: "/my-files/AB" });
      assert.equal(outside.isError, true);
    });
  });

  it("a root list with no valid entry refuses every Drive path", async () => {
    await runTree(async (c) => {
      assert.equal((await c.call("drive_list", { path: "/my-files" })).isError, true);
      assert.equal((await c.call("drive_version")).isError, false);
    }, { PROTON_DRIVE_REMOTE_ROOTS: "not-absolute" });
  });

  it("several roots, each matched on its own", async () => {
    await runTree(async (c) => {
      assert.equal((await c.call("drive_list", { path: "/my-files/A" })).isError, false);
      assert.equal((await c.call("drive_list", { path: "/my-files/AB" })).isError, false);
      assert.equal((await c.call("drive_list", { path: "/my-files" })).isError, true);
    }, { PROTON_DRIVE_REMOTE_ROOTS: ["/my-files/A", "/my-files/AB"].join(delimiter) });
  });
});

describe("audit log: chain", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "pdmcp-audit-"));

  it("appends a verifiable hash chain, creates the directory 0700 and the file 0600, and continues across instances", () => {
    const d = tmp();
    try {
      const file = join(d, "sub", "audit.jsonl");
      const log = new AuditLog(file);
      for (const tool of ["a", "b"]) log.append({ tool, args: { path: "/x" }, outcome: "ok", durationMs: 1 });
      new AuditLog(file).append({ tool: "c", args: {}, outcome: "refused", code: "roots", durationMs: 0 });
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(join(d, "sub")).mode & 0o777, 0o700);
      const lines = readLog(file);
      assert.deepEqual(lines.map((l) => l.seq), [1, 2, 3]);
      assert.equal(lines[0].prev, "0".repeat(64));
      assert.equal(lines[1].prev, lines[0].hash);
      assert.equal(lines[2].prev, lines[1].hash);
      for (const k of ["ts", "seq", "tool", "args", "outcome", "durationMs", "prev", "hash"]) assert.ok(k in lines[0], k);
      assert.deepEqual(log.verify(), { ok: true, entries: 3, head: lines[2].hash });
      assert.deepEqual(log.last(2).map((e) => e.tool), ["b", "c"]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("detects an edited, a removed and a reordered entry, and reports the first broken seq", () => {
    const d = tmp();
    try {
      const file = join(d, "audit.jsonl");
      const log = new AuditLog(file);
      for (const tool of ["a", "b", "c", "d"]) log.append({ tool, args: {}, outcome: "ok", durationMs: 1 });
      const original = readFileSync(file, "utf8").split("\n").filter(Boolean);
      const check = (lines) => { writeFileSync(file, lines.join("\n") + "\n"); return log.verify(); };
      assert.deepEqual(check(original.map((l, i) => (i === 1 ? l.replace('"tool":"b"', '"tool":"x"') : l))).brokenSeq, 2);
      assert.deepEqual(check([original[0], original[2], original[3]]).brokenSeq, 2);
      assert.deepEqual(check([original[0], original[2], original[1], original[3]]).brokenSeq, 2);
      assert.equal(check(original.slice(0, 3)).ok, true, "dropping the newest entries is not detectable without an external anchor");
      assert.equal(check([...original.slice(0, 2), "not json"]).brokenSeq, 3);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("refuses to append after a torn or malformed tail, and a relative path", () => {
    const d = tmp();
    try {
      const file = join(d, "audit.jsonl");
      writeFileSync(file, '{"seq":1,"hash":"x"');
      assert.match(new AuditLog(file).checkWritable(), /newline/);
      writeFileSync(file, "garbage\n");
      assert.ok(new AuditLog(file).checkWritable());
      assert.match(new AuditLog("relative/audit.jsonl").checkWritable(), /absolute/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("redacts passwords and message bodies, and reduces file text to its length (no hash)", () => {
    const declared = { path: {}, content: {}, password: {}, message: {} };
    const r = redactArgs("drive_write_file", { path: "/my-files/a.txt", content: "top secret é", extra: "leak" }, declared);
    assert.deepEqual(r, { path: "/my-files/a.txt", content: "[redacted]", contentBytes: 13, extra: "[unknown argument]" });
    assert.deepEqual(redactArgs("drive_share_set_url", { path: "/p", password: "pw" }, declared), { path: "/p", password: "[redacted]" });
    assert.deepEqual(redactArgs("drive_share_invite", { path: "/p", message: "hello" }, declared), { path: "/p", message: "[redacted]" });
  });

  it("an argument named like an Object.prototype member is undeclared, not logged by value", () => {
    const r = redactArgs("drive_list", JSON.parse('{"path":"/p","toString":"SECRET","constructor":"SECRET2"}'), { path: {} });
    assert.deepEqual(r, { path: "/p", toString: "[unknown argument]", constructor: "[unknown argument]" });
  });

  it("two processes appending at once keep one unbroken chain with every seq present", async () => {
    const d = tmp();
    try {
      const file = join(d, "audit.jsonl");
      const script = `import { AuditLog } from ${JSON.stringify(pathToFileURL(join(dirname(DIST_INDEX), "utils", "audit.js")).href)};
        const log = new AuditLog(process.argv[1]);
        for (let i = 0; i < 60; i++) log.append({ tool: "t" + process.argv[2], args: {}, outcome: "ok", durationMs: 1 });`;
      const run = (id) => new Promise((resolve) => {
        const p = spawn(process.execPath, ["--input-type=module", "-e", script, file, id], { stdio: ["ignore", "ignore", "pipe"] });
        let err = ""; p.stderr.on("data", (x) => { err += x; });
        p.on("exit", (code) => resolve({ code, err }));
      });
      const results = await Promise.all([run("a"), run("b"), run("c")]);
      for (const r of results) assert.equal(r.code, 0, r.err);
      const v = new AuditLog(file).verify();
      assert.equal(v.ok, true, JSON.stringify(v));
      assert.equal(v.entries, 180);
      assert.deepEqual(readLog(file).map((e) => e.seq), Array.from({ length: 180 }, (_, i) => i + 1));
      assert.equal(existsSync(file + ".lock"), false, "the lock is released");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("a stale lock from a crashed process is taken over; a fresh one that never clears fails the write", () => {
    const d = tmp();
    try {
      const file = join(d, "audit.jsonl");
      const log = new AuditLog(file, { lockWaitMs: 300 });
      writeFileSync(file + ".lock", "");
      const old = new Date(Date.now() - 60_000);
      utimesSync(file + ".lock", old, old);
      log.append({ tool: "a", args: {}, outcome: "ok", durationMs: 1 });
      assert.equal(log.verify().ok, true);
      writeFileSync(file + ".lock", ""); // fresh, held by "someone else"
      assert.throws(() => log.append({ tool: "b", args: {}, outcome: "ok", durationMs: 1 }), /lock/);
      assert.match(log.checkWritable(), /lock/, "mutating tools are refused before they run");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("PROTON_DRIVE_AUDIT_LOG: server", () => {
  const withAudit = async (fn, extra = {}, mode = "json") => {
    const sb = makeSandbox();
    const file = join(sb.dir, "audit", "log.jsonl");
    const c = await startServer(mode, sb, { PROTON_DRIVE_AUDIT_LOG: file, ...extra });
    try { return await fn(c, sb, file); } finally { await c.close(); sb.cleanup(); }
  };

  it("records ok, error and refused calls with a code, and never the secrets", async () => {
    const sync = mkdtempSync(join(tmpdir(), "pdmcp-sync-"));
    try {
      await withAudit(async (c, sb, file) => {
        await c.call("drive_version");
        await c.call("drive_trash", { path: "/my-files/AB/x" }); // refused: roots
        await c.call("drive_share_set_url", { path: "/my-files/A/f", password: "hunter2-pw", confirmed: true });
        await c.call("drive_share_invite", { path: "/my-files/A/f", email: "a@b.co", role: "viewer", message: "private words", confirmed: true });
        await c.call("drive_write_file", { path: "/my-files/A/n.txt", content: "FILE-TEXT-SECRET" });
        await c.call("drive_empty_trash", { confirmed: true }); // refused: roots
        await c.call("drive_list", { path: 5 }); // invalid arguments
        await c.callRaw("drive_nope", { token: "t0ken" }); // unknown tool
        const text = readFileSync(file, "utf8");
        for (const secret of ["hunter2-pw", "private words", "FILE-TEXT-SECRET", "t0ken"]) assert.ok(!text.includes(secret), `${secret} leaked into the audit log`);
        const e = readLog(file);
        assert.deepEqual(e.map((x) => [x.tool, x.outcome, x.code]), [
          ["drive_version", "ok", undefined],
          ["drive_trash", "refused", "roots"],
          ["drive_share_set_url", "refused", "roots"],
          ["drive_share_invite", "refused", "roots"],
          ["drive_write_file", "refused", "roots"],
          ["drive_empty_trash", "refused", "roots"],
          ["drive_list", "error", "invalid"],
          ["drive_nope", "error", "unknown_tool"],
        ]);
        assert.ok(e.every((x) => Number.isInteger(x.durationMs) && x.ts && x.hash));
        assert.equal(statSync(file).mode & 0o777, 0o600);
      }, { PROTON_DRIVE_REMOTE_ROOTS: "/my-files/Elsewhere", PROTON_DRIVE_SYNC_PATH: sync });
    } finally { rmSync(sync, { recursive: true, force: true }); }
  });

  it("records the outcome of real calls: ok, cli error, readonly and confirmation refusals; write_file keeps only the length", async () => {
    const sync = mkdtempSync(join(tmpdir(), "pdmcp-sync-"));
    try {
      writeFileSync(join(sync, "old.txt"), "old");
      await withAudit(async (c, sb, file) => {
        await c.call("drive_write_file", { path: "/my-files/new.txt", content: "FILE-TEXT-SECRET" });
        await c.call("drive_write_file", { path: "/my-files/old.txt", content: "x" }); // needs confirmed
        await c.call("drive_list", { path: "/my-files" });
        const e = readLog(file);
        assert.deepEqual(e.map((x) => [x.tool, x.outcome, x.code]), [["drive_write_file", "ok", undefined], ["drive_write_file", "refused", "confirm"], ["drive_list", "ok", undefined]]);
        assert.equal(e[0].args.content, "[redacted]");
        assert.equal(e[0].args.contentBytes, 16);
        assert.equal(e[0].args.contentSha256, undefined);
        assert.ok(!readFileSync(file, "utf8").includes("FILE-TEXT-SECRET"));
      }, { PROTON_DRIVE_SYNC_PATH: sync });
    } finally { rmSync(sync, { recursive: true, force: true }); }
    await withAudit(async (c, sb, file) => {
      await c.call("drive_trash", { path: "/my-files/x" });
      assert.deepEqual(readLog(file).map((x) => [x.outcome, x.code]), [["refused", "readonly"]]);
    }, { PROTON_DRIVE_MODE: "readonly" });
  });

  it("an argument named toString/constructor is rejected as undeclared and never reaches the log", async () => {
    await withAudit(async (c, sb, file) => {
      for (const k of ["toString", "constructor", "hasOwnProperty"]) {
        const r = await c.call("drive_list", JSON.parse(`{"path":"/my-files","${k}":"SECRET"}`));
        assert.equal(r.isError, true);
        assert.match(r.text, new RegExp(`Unknown argument '${k}'`));
      }
      assert.ok(!readFileSync(file, "utf8").includes("SECRET"));
      assert.deepEqual(nonVersionCalls(sb.argvLog), []);
    });
  });

  it("drive_audit_log returns the newest entries with an intact chain, and notices tampering", async () => {
    await withAudit(async (c, sb, file) => {
      for (let i = 0; i < 4; i++) await c.call("drive_version");
      const r = await c.call("drive_audit_log", { limit: 3 });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.data.entries.length, 3);
      assert.deepEqual(r.data.entries.map((e) => e.seq), [2, 3, 4]);
      assert.equal(r.data.verification.ok, true);
      assert.doesNotMatch(r.text, /audit\/log\.jsonl/, "the log's location is not revealed");
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      lines[1] = lines[1].replace('"outcome":"ok"', '"outcome":"error"');
      writeFileSync(file, lines.join("\n") + "\n");
      const bad = await c.call("drive_audit_log", {});
      assert.deepEqual(bad.data.verification.ok, false);
      assert.equal(bad.data.verification.brokenSeq, 2);
    });
  });

  it("drive_audit_log defaults to 50 entries, is available in readonly, and errors when no log is configured", async () => {
    await withAudit(async (c) => {
      for (let i = 0; i < 52; i++) await c.call("drive_version");
      assert.equal((await c.call("drive_audit_log", {})).data.entries.length, 50);
    }, { PROTON_DRIVE_MODE: "readonly" });
    await withServer({ PROTON_DRIVE_MODE: "readonly" }, async (c) => {
      assert.ok(names(await c.listTools()).includes("drive_audit_log"));
      const r = await c.call("drive_audit_log", {});
      assert.equal(r.isError, true);
      assert.match(r.text, /PROTON_DRIVE_AUDIT_LOG/);
    });
  });

  it("is a full-tier tool only", async () => {
    await withServer({ PROTON_DRIVE_TOOL_TIER: "core" }, async (c) => {
      assert.ok(!names(await c.listTools()).includes("drive_audit_log"));
      assert.match((await c.call("drive_audit_log", {})).text, /tool tier/);
    });
  });

  it("an unwritable log refuses mutating tools (fail closed) but lets reads through, with a warning", async () => {
    for (const bad of [(sb) => { writeFileSync(join(sb.dir, "afile"), "x"); return join(sb.dir, "afile", "log.jsonl"); }, () => "relative/audit.jsonl"]) {
      const sb = makeSandbox();
      const c = await startServer("json", sb, { PROTON_DRIVE_AUDIT_LOG: bad(sb) });
      try {
        const r = await c.call("drive_mkdir", { path: "/my-files/new" });
        assert.equal(r.isError, true);
        assert.match(r.text, /audit log.*cannot be written.*Reads still work/);
        assert.equal((await c.call("drive_list", { path: "/my-files" })).isError, false);
        assert.deepEqual(nonVersionCalls(sb.argvLog).map((a) => a[1]), ["list"]);
        assert.match(c.stderr, /PROTON_DRIVE_AUDIT_LOG cannot be written/);
      } finally { await c.close(); sb.cleanup(); }
    }
  });

  it("a log that goes bad while running blocks the next mutation", async () => {
    await withAudit(async (c, sb, file) => {
      assert.equal((await c.call("drive_mkdir", { path: "/my-files/one" })).isError, false);
      writeFileSync(file, readFileSync(file, "utf8") + "torn"); // no trailing newline
      const r = await c.call("drive_mkdir", { path: "/my-files/two" });
      assert.equal(r.isError, true);
      assert.deepEqual(nonVersionCalls(sb.argvLog).map((a) => a[1]), ["create-folder"]);
    });
  });

  it("a second server process on the same file continues the same chain", async () => {
    const sb = makeSandbox();
    const file = join(sb.dir, "log.jsonl");
    try {
      for (let i = 0; i < 2; i++) {
        const c = await startServer("json", sb, { PROTON_DRIVE_AUDIT_LOG: file });
        await c.call("drive_version");
        await c.close();
      }
      const log = new AuditLog(file);
      assert.deepEqual(log.verify().entries, 2);
      assert.deepEqual(readLog(file).map((e) => e.seq), [1, 2]);
    } finally { sb.cleanup(); }
  });
});

describe("PROTON_DRIVE_SNAPSHOT_BEFORE_OVERWRITE", () => {
  const SNAP = { PROTON_DRIVE_SNAPSHOT_BEFORE_OVERWRITE: "1", PROTON_DRIVE_RETRY_BASE_MS: "1" };
  const file = { type: "file", name: { ok: true, value: "old.txt" } };

  async function withFs(info, env, fn) {
    const sb = makeSandbox();
    const sync = mkdtempSync(join(tmpdir(), "pdmcp-sync-"));
    const local = join(sb.dir, "local");
    mkdirSync(local);
    writeFileSync(join(sync, "old.txt"), "old");
    writeFileSync(join(sync, "folder"), "pretend this is a file locally");
    writeFileSync(join(local, "old.txt"), "new body");
    writeFileSync(join(sb.dir, "info.json"), JSON.stringify(info));
    const c = await startServer("fs", sb, { FAKE_INFO: join(sb.dir, "info.json"), PROTON_DRIVE_SYNC_PATH: sync, ...SNAP, ...env });
    try { return await fn(c, sb, { sync, local }); } finally { await c.close(); sb.cleanup(); rmSync(sync, { recursive: true, force: true }); }
  }
  const cli = (sb) => nonVersionCalls(sb.argvLog);

  it("write_file: copies the existing LOCAL file to <dir>/.versions/<name>.<UTC timestamp> in the sync folder, without touching the CLI", async () => {
    await withFs({}, {}, async (c, sb, { sync }) => { // no remote copy at all: the file was never uploaded
      writeFileSync(join(sync, "old.txt"), "unsynced local edit");
      const r = await c.call("drive_write_file", { path: "/my-files/old.txt", content: "fresh", confirmed: true });
      assert.equal(r.isError, false, r.text);
      assert.match(r.data.snapshot, /^\/my-files\/\.versions\/old\.txt\.\d{8}T\d{6}\.\d{3}Z$/);
      assert.equal(readFileSync(join(sync, "old.txt"), "utf8"), "fresh");
      assert.equal(readFileSync(join(sync, ".versions", r.data.snapshot.split("/").pop()), "utf8"), "unsynced local edit");
      assert.deepEqual(cli(sb), []);
    });
  });

  it("write_file: snapshots next to the file in a subfolder, and never clobbers an earlier snapshot", async () => {
    await withFs({}, {}, async (c, sb, { sync }) => {
      mkdirSync(join(sync, "sub"));
      writeFileSync(join(sync, "sub", "n.txt"), "v1");
      const r1 = await c.call("drive_write_file", { path: "/my-files/sub/n.txt", content: "v2", confirmed: true });
      assert.match(r1.data.snapshot, /^\/my-files\/sub\/\.versions\/n\.txt\./);
      await sleep(5);
      const r2 = await c.call("drive_write_file", { path: "/my-files/sub/n.txt", content: "v3", confirmed: true });
      assert.deepEqual(readdirSync(join(sync, "sub", ".versions")).length, 2);
      assert.equal(readFileSync(join(sync, "sub", ".versions", r1.data.snapshot.split("/").pop()), "utf8"), "v1");
      assert.equal(readFileSync(join(sync, "sub", ".versions", r2.data.snapshot.split("/").pop()), "utf8"), "v2");
    });
  });

  it("write_file: a failed snapshot copy refuses the overwrite and leaves the file untouched", async () => {
    await withFs({}, {}, async (c, sb, { sync }) => {
      writeFileSync(join(sync, ".versions"), "a file where the folder should be");
      const r = await c.call("drive_write_file", { path: "/my-files/old.txt", content: "fresh", confirmed: true });
      assert.equal(r.isError, true);
      assert.match(r.text, /refused: could not snapshot/);
      assert.equal(readFileSync(join(sync, "old.txt"), "utf8"), "old");
    });
  });

  it("write_file: a new file is written without a snapshot or a .versions folder", async () => {
    await withFs({}, {}, async (c, sb, { sync }) => {
      const r = await c.call("drive_write_file", { path: "/my-files/brand-new.txt", content: "x" });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.data.snapshot, undefined);
      assert.equal(existsSync(join(sync, ".versions")), false);
      assert.deepEqual(cli(sb), []);
    });
  });

  it("write_file: a folder at the target is refused when snapshots are on, nothing changes", async () => {
    await withFs({}, {}, async (c, sb, { sync }) => {
      mkdirSync(join(sync, "adir"));
      const r = await c.call("drive_write_file", { path: "/my-files/adir", content: "x", confirmed: true });
      assert.equal(r.isError, true);
      assert.match(r.text, /refused: could not snapshot/);
      assert.equal(statSync(join(sync, "adir")).isDirectory(), true);
    });
  });

  it("is off unless enabled", async () => {
    await withFs({ "/my-files/old.txt": file }, { PROTON_DRIVE_SNAPSHOT_BEFORE_OVERWRITE: "0" }, async (c, sb, { sync }) => {
      assert.equal((await c.call("drive_write_file", { path: "/my-files/old.txt", content: "x", confirmed: true })).isError, false);
      assert.deepEqual(cli(sb), []);
      assert.equal(existsSync(join(sync, ".versions")), false);
    });
  });

  it("upload with fileConflictStrategy=replace snapshots the target first; other strategies do not", async () => {
    await withFs({ "/my-files/Docs/old.txt": file }, {}, async (c, sb, { local }) => {
      const r = await c.call("drive_upload", { localPath: join(local, "old.txt"), remotePath: "/my-files/Docs", fileConflictStrategy: "replace", confirmed: true });
      assert.equal(r.isError, false, r.text);
      assert.match(r.data.snapshot, /^\/my-files\/Docs\/\.versions\/old\.txt\./);
      assert.deepEqual(cli(sb).map((a) => a[1]), ["info", "info", "create-folder", "copy", "upload"]);
    });
    await withFs({ "/my-files/Docs/old.txt": file }, {}, async (c, sb, { local }) => {
      await c.call("drive_upload", { localPath: join(local, "old.txt"), remotePath: "/my-files/Docs", fileConflictStrategy: "create-new-revision" });
      assert.deepEqual(cli(sb).map((a) => a[1]), ["upload"]);
    });
  });

  it("upload: a failed snapshot refuses the upload", async () => {
    await withFs({ "/my-files/Docs/old.txt": file }, { FAKE_FAIL_CMD: "copy" }, async (c, sb, { local }) => {
      const r = await c.call("drive_upload", { localPath: join(local, "old.txt"), remotePath: "/my-files/Docs", fileConflictStrategy: "replace", confirmed: true });
      assert.equal(r.isError, true);
      assert.match(r.text, /drive_upload refused: could not snapshot/);
      assert.ok(!cli(sb).some((a) => a[1] === "upload"));
    });
  });

  it("upload: replacing a FOLDER while snapshots are on is refused before anything is uploaded", async () => {
    await withFs({}, {}, async (c, sb, { local }) => {
      for (const extra of [{ folderConflictStrategy: "replace" }, { fileConflictStrategy: "replace" }]) {
        const r = await c.call("drive_upload", { localPath: local, remotePath: "/my-files/Docs", confirmed: true, ...extra });
        assert.equal(r.isError, true);
        assert.match(r.text, /drive_upload refused: .*folder.*not versioned.*PROTON_DRIVE_SNAPSHOT_BEFORE_OVERWRITE/);
      }
      assert.deepEqual(cli(sb), []);
    });
    await withFs({}, { PROTON_DRIVE_SNAPSHOT_BEFORE_OVERWRITE: "" }, async (c, sb, { local }) => {
      const r = await c.call("drive_upload", { localPath: local, remotePath: "/my-files/Docs", folderConflictStrategy: "replace", confirmed: true });
      assert.equal(r.isError, false, r.text);
      assert.deepEqual(cli(sb).map((a) => a[1]), ["upload"]);
    });
  });

  it("upload: a remote FOLDER at the replace target is refused, not warned about", async () => {
    await withFs({ "/my-files/Docs/old.txt": { type: "folder" } }, {}, async (c, sb, { local }) => {
      const r = await c.call("drive_upload", { localPath: join(local, "old.txt"), remotePath: "/my-files/Docs", fileConflictStrategy: "replace", confirmed: true });
      assert.equal(r.isError, true);
      assert.match(r.text, /drive_upload refused: could not snapshot.*folder/);
      assert.ok(!cli(sb).some((a) => a[1] === "upload"));
    });
  });

  it("upload: a missing CLI is not 'no remote file': the replace is refused (fail closed)", async () => {
    await withFs({ "/my-files/Docs/old.txt": file }, { PROTON_DRIVE_BIN: "/nonexistent/dir/proton-drive" }, async (c, sb, { local }) => {
      const r = await c.call("drive_upload", { localPath: join(local, "old.txt"), remotePath: "/my-files/Docs", fileConflictStrategy: "replace", confirmed: true });
      assert.equal(r.isError, true);
      assert.match(r.text, /drive_upload refused: could not snapshot.*CLI not found/);
    });
  });

  it("the .versions folder is vetted against PROTON_DRIVE_REMOTE_ROOTS (same parent, so it passes inside a root)", async () => {
    await withFs({}, { PROTON_DRIVE_REMOTE_ROOTS: "/my-files/A" }, async (c, sb, { sync }) => {
      mkdirSync(join(sync, "A"));
      writeFileSync(join(sync, "A", "old.txt"), "old");
      const r = await c.call("drive_write_file", { path: "/my-files/A/old.txt", content: "x", confirmed: true });
      assert.equal(r.isError, false, r.text);
      assert.match(r.data.snapshot, /^\/my-files\/A\/\.versions\//);
      assert.equal(readdirSync(join(sync, "A", ".versions")).length, 1);
    });
  });

  it("is audited as part of the call (refused: snapshot)", async () => {
    const sb = makeSandbox();
    const sync = mkdtempSync(join(tmpdir(), "pdmcp-sync-"));
    try {
      writeFileSync(join(sync, "old.txt"), "old");
      writeFileSync(join(sync, ".versions"), "blocks the snapshot folder");
      writeFileSync(join(sb.dir, "info.json"), JSON.stringify({}));
      const log = join(sb.dir, "audit.jsonl");
      const c = await startServer("fs", sb, { FAKE_INFO: join(sb.dir, "info.json"), PROTON_DRIVE_SYNC_PATH: sync, PROTON_DRIVE_AUDIT_LOG: log, ...SNAP });
      await c.call("drive_write_file", { path: "/my-files/old.txt", content: "x", confirmed: true });
      await c.close();
      assert.deepEqual(readLog(log).map((e) => [e.outcome, e.code]), [["refused", "snapshot"]]);
    } finally { sb.cleanup(); rmSync(sync, { recursive: true, force: true }); }
  });
});

describe("startup: stdout stays pure JSON-RPC with every guard configured", () => {
  it("warnings go to stderr only", async () => {
    const sb = makeSandbox();
    const p = spawn(process.execPath, [DIST_INDEX], {
      env: fakeEnv("json", sb, { PROTON_DRIVE_MODE: "bogus", PROTON_DRIVE_REMOTE_ROOTS: "relative", PROTON_DRIVE_AUDIT_LOG: "relative.log" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");
    await sleep(500);
    p.stdin.end();
    await new Promise((r) => p.on("exit", r));
    sb.cleanup();
    assert.ok(out.split("\n").filter(Boolean).every((l) => JSON.parse(l).jsonrpc === "2.0"));
    for (const k of ["PROTON_DRIVE_MODE", "PROTON_DRIVE_REMOTE_ROOTS", "PROTON_DRIVE_AUDIT_LOG"]) assert.match(err, new RegExp(k), k);
  });
});

describe("startup: PROTON_DRIVE_AUDIT_LOG inside PROTON_DRIVE_SYNC_PATH", () => {
  const start = async (sync, audit) => {
    const sb = makeSandbox();
    const p = spawn(process.execPath, [DIST_INDEX], { env: fakeEnv("json", sb, { PROTON_DRIVE_SYNC_PATH: sync, PROTON_DRIVE_AUDIT_LOG: audit }), stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    const exited = new Promise((r) => p.on("exit", r));
    await Promise.race([exited, sleep(1500)]);
    const code = p.exitCode;
    p.stdin.end();
    await exited;
    sb.cleanup();
    return { code, err };
  };

  it("refuses to start (exit 1, clear error) when the log is in the sync folder, also via a symlinked path", async () => {
    const sync = mkdtempSync(join(tmpdir(), "pdmcp-sync-"));
    try {
      for (const audit of [join(sync, "audit.jsonl"), join(sync, "sub", "deeper", "audit.jsonl")]) {
        const r = await start(sync, audit);
        assert.equal(r.code, 1, r.err);
        assert.match(r.err, /PROTON_DRIVE_AUDIT_LOG.*PROTON_DRIVE_SYNC_PATH/);
        assert.ok(!existsSync(audit), "nothing is written");
      }
      const link = sync + "-link";
      symlinkSync(sync, link);
      try {
        const r = await start(sync, join(link, "audit.jsonl"));
        assert.equal(r.code, 1, r.err);
      } finally { rmSync(link, { force: true }); }
    } finally { rmSync(sync, { recursive: true, force: true }); }
  });

  it("starts when the log is outside the sync folder (a sibling with a shared name prefix is outside)", async () => {
    const sync = mkdtempSync(join(tmpdir(), "pdmcp-sync-"));
    const other = sync + "-audit";
    mkdirSync(other);
    try {
      const r = await start(sync, join(other, "audit.jsonl"));
      assert.equal(r.code, null, r.err);
    } finally { rmSync(sync, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
  });
});
