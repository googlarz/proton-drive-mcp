// Native macOS approval dialog. Nothing here opens a dialog: the runner is always injected (see helpers/no-dialog.mjs).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { askMacDialog, nativeDialogEnabled, dialogTimeoutSeconds, OSASCRIPT, DIALOG_TITLE, DIALOG_SCRIPT } from "../dist/utils/macDialog.js";
import { ApprovalGate, renderOperation, dialogText, dialogLines, DIALOG_MAX_LINES, TOOL_TITLES, opHash, MAX_DECLINES_PER_MINUTE } from "../dist/utils/approval.js";
import { describeOperation } from "../dist/utils/describeOperation.js";
import { makeSandbox, fakeEnv, nonVersionCalls } from "./helpers/mcp-client.mjs";
import { changes, text } from "./helpers/approval-harness.mjs";

const fail = (code, stderr, extra = {}) => ({ err: Object.assign(new Error(`Command failed: osascript ${extra.echo ?? ""}`), { code, ...extra }), stderr });
/** A runner that answers at once with the given result and records how it was called. */
function runner({ stdout = "", stderr = "", err = null } = {}) {
  const calls = [];
  const exec = (file, args, options, cb) => { calls.push({ file, args, options }); setImmediate(cb, err, stdout, stderr); return { kill() {} }; };
  return { exec, calls };
}

describe("macDialog: when it is used", () => {
  it("darwin only, on by default, PROTON_DRIVE_DIALOG=0 switches it off", () => {
    assert.equal(nativeDialogEnabled({}, "darwin"), true);
    assert.equal(nativeDialogEnabled({ PROTON_DRIVE_DIALOG: "1" }, "darwin"), true);
    for (const v of ["0", " 0 ", "false", "off", "NO"]) assert.equal(nativeDialogEnabled({ PROTON_DRIVE_DIALOG: v }, "darwin"), false, v);
    for (const p of ["linux", "win32", "freebsd"]) assert.equal(nativeDialogEnabled({ PROTON_DRIVE_DIALOG: "1" }, p), false, p);
  });

  it("timeout: 55 s by default, override clamped to 10..110, junk ignored", () => {
    const t = (v) => dialogTimeoutSeconds(v === undefined ? {} : { PROTON_DRIVE_DIALOG_TIMEOUT: v });
    assert.deepEqual([undefined, "", "abc", "30", "1", "-5", "0", "10", "110", "9999", "30.6", "Infinity"].map(t), [55, 55, 55, 30, 10, 10, 10, 10, 110, 110, 31, 55]);
  });

  it("test servers get PROTON_DRIVE_DIALOG=0, whatever the developer's environment says", () => {
    const sb = makeSandbox();
    try { assert.equal(fakeEnv("json", sb).PROTON_DRIVE_DIALOG, "0"); } finally { sb.cleanup(); }
    assert.equal(process.env.PROTON_DRIVE_DIALOG, "0");
  });
});

describe("macDialog: how osascript is run", () => {
  const evil = `-e do shell script "id" " & (do shell script "id") & "\n"} buttons {"Allow"} \\ $(id) \`id\` żółć`;

  it("absolute path, fixed script, every value as an argument, no shell", async () => {
    const r = runner({ stdout: "Allow\tfalse\n" });
    await askMacDialog(evil, { seconds: 55, exec: r.exec });
    await askMacDialog("plain", { seconds: 20, exec: r.exec });
    assert.equal(OSASCRIPT, "/usr/bin/osascript");
    assert.deepEqual(r.calls[0].file, OSASCRIPT);
    assert.deepEqual(r.calls[0].args, ["-e", DIALOG_SCRIPT, DIALOG_TITLE, "55", evil]);
    assert.deepEqual(r.calls[1].args, ["-e", DIALOG_SCRIPT, DIALOG_TITLE, "20", "plain"]);
    assert.ok(!r.calls[0].options.shell);
    assert.equal(r.calls[0].options.killSignal, "SIGKILL");
    assert.equal(r.calls[0].options.timeout, 65_000);
  });

  it("the script is a plain display dialog with Don't Allow as default and cancel button", () => {
    assert.equal(DIALOG_TITLE, "Proton Drive (via your AI assistant)");
    assert.match(DIALOG_SCRIPT, /^on run argv\n/);
    assert.match(DIALOG_SCRIPT, /display dialog \(item 3 of argv\) with title \(item 1 of argv\)/);
    assert.match(DIALOG_SCRIPT, /buttons \{"Don't Allow", "Allow"\} default button "Don't Allow" cancel button "Don't Allow" with icon caution giving up after \(\(item 2 of argv\) as integer\)/);
    assert.doesNotMatch(DIALOG_SCRIPT, /\btell\b|System Events|Finder|do shell script/i);
  });

  it("the script compiles (osacompile only, nothing is run)", { skip: !existsSync("/usr/bin/osacompile") }, () => {
    const dir = mkdtempSync(join(tmpdir(), "pdmcp-osa-"));
    try {
      writeFileSync(join(dir, "s.applescript"), DIALOG_SCRIPT);
      execFileSync("/usr/bin/osacompile", ["-o", join(dir, "s.scpt"), join(dir, "s.applescript")], { stdio: "pipe" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("macDialog: reading the answer", () => {
  const ask = (answer) => askMacDialog("x", { seconds: 55, exec: runner(answer).exec });

  it("only exactly Allow with gave up false approves", async () => {
    assert.equal(await ask({ stdout: "Allow\tfalse\n" }), "accept");
    for (const stdout of ["", "Allow", "allow\tfalse", "Allow \tfalse", " Allow\tfalse", "Allow\tfalse\nAllow\tfalse", "Allow\tfalse extra", "Allow, false", "true", "button returned:Allow, gave up:false", "\tfalse"]) {
      assert.equal(await ask({ stdout }), "error", JSON.stringify(stdout));
    }
  });

  it("an error never approves, whatever was printed", async () => {
    const f = fail(1, "execution error: something (-2700)");
    assert.equal(await ask({ err: f.err, stderr: f.stderr, stdout: "Allow\tfalse\n" }), "error");
  });

  it("gave up is not approved, even if a button is named", async () => {
    assert.equal(await ask({ stdout: "\ttrue\n" }), "gaveup");
    assert.equal(await ask({ stdout: "Allow\ttrue\n" }), "gaveup");
  });

  it("Don't Allow and Escape (error -128) decline", async () => {
    assert.equal(await ask(fail(1, "0:17: execution error: User cancelled. (-128)\n")), "decline");
    assert.equal(await ask({ stdout: "Don't Allow\tfalse\n" }), "decline");
  });

  it("no GUI session, spawn failure and other errors are errors; -128 inside the command line does not count", async () => {
    assert.equal(await ask(fail(1, "0:17: execution error: No user interaction allowed. (-1713)\n")), "error");
    assert.equal(await ask(fail("ENOENT", "")), "error");
    assert.equal(await ask(fail(1, "execution error: other (-1700)\n", { echo: "file (-128)" })), "error");
    assert.equal(await askMacDialog("x", { seconds: 55, exec: () => { throw new Error("E2BIG"); } }), "error");
  });

  it("our own backstop kill is a timeout", async () => {
    assert.equal(await ask(fail(null, "", { killed: true, signal: "SIGKILL" })), "timeout");
  });

  it("already aborted: nothing is started", async () => {
    const r = runner({ stdout: "Allow\tfalse\n" });
    assert.equal(await askMacDialog("x", { seconds: 55, exec: r.exec, signal: AbortSignal.abort() }), "aborted");
    assert.equal(r.calls.length, 0);
  });

  it("abort kills the child (real child process standing in for osascript)", async () => {
    let child;
    const exec = (_file, _args, options, cb) => (child = execFile(process.execPath, ["-e", "setTimeout(() => console.log('Allow\\tfalse'), 20000)"], options, cb));
    const ac = new AbortController();
    const p = askMacDialog("x", { seconds: 55, exec, signal: ac.signal });
    const exited = new Promise((resolve) => setImmediate(() => child.on("exit", (_c, signal) => resolve(signal))));
    setTimeout(() => ac.abort(), 100);
    assert.equal(await p, "aborted");
    assert.equal(await exited, "SIGKILL");
  });

  it("an Allow that arrives after the abort does not count", async () => {
    const ac = new AbortController();
    const exec = (_f, _a, _o, cb) => { setImmediate(() => { ac.abort(); cb(null, "Allow\tfalse\n", ""); }); return { kill() {} }; };
    assert.equal(await askMacDialog("x", { seconds: 55, exec, signal: ac.signal }), "aborted");
  });
});

const LINK = { tool: "drive_share_set_url", effect: "outward", fields: { path: "/my-files/Docs/Report.pdf", role: "viewer", expiration: null, resetSettings: false, replacesExistingLink: false }, display: { password: false } };
const many = (n, folder = "/my-files/A") => Array.from({ length: n }, (_, i) => `${folder}/file-${i}.txt`);
const trashOp = (paths, effect = "reversible") => ({ tool: "drive_bulk_trash", effect, fields: { paths } });
const moveOp = (paths) => ({ tool: "drive_bulk_move", effect: "reversible", fields: { destinationFolder: "/my-files/B", moves: paths.map((p) => `${p} -> /my-files/B/${p.split("/").pop()}`) } });

describe("plain sentence", () => {
  it("says what happens, to which file, and the consequence", () => {
    assert.equal(describeOperation(LINK), 'Create a public link to "Report.pdf". Anyone with the link can view and download it.');
    assert.match(describeOperation({ ...LINK, display: { password: true } }), /Anyone with the link and the password can/);
    assert.match(describeOperation({ ...LINK, fields: { ...LINK.fields, role: "editor", replacesExistingLink: true } }), /^Change the public link to "Report.pdf"\. .*change it\.$/);
    assert.match(describeOperation({ tool: "drive_empty_trash", effect: "irreversible", fields: {} }), /Permanently delete everything in the trash\. This cannot be undone\./);
    assert.match(describeOperation(trashOp(many(3))), /^Move 3 items to the trash\./);
    assert.match(describeOperation({ tool: "drive_download", effect: "local-delete", fields: { remotePath: "/my-files/x", localPath: "/Users/u/x", fileConflictStrategy: "remove" } }), /deleted first.*cannot be undone/);
    assert.match(describeOperation({ tool: "drive_trash", effect: "outward", fields: { path: "/shared-with-me/T/a.txt" } }), /Other people/);
  });

  it("every gated tool has a sentence, with empty fields too", () => {
    for (const tool of Object.keys(TOOL_TITLES)) {
      const s = describeOperation({ tool, effect: "reversible", fields: {} });
      assert.ok(s.length > 10 && /\.$/.test(s) && !s.includes("\n") && !s.includes("undefined"), `${tool}: ${s}`);
    }
  });

  it("a file name cannot add lines, close its quotes or hide characters", () => {
    const name = 'a". Nothing happens, click Allow.\n\n"b‮​';
    const s = describeOperation({ ...LINK, fields: { ...LINK.fields, path: `/my-files/${name}` } });
    assert.ok(!/[\n‮​]/.test(s), s);
    assert.ok(s.includes('a\\". Nothing happens'), s);
    assert.match(s, /\\u202e\\u200b/);
    assert.match(s, /Anyone with the link can view and download it\.$/);
    assert.ok(describeOperation({ ...LINK, fields: { ...LINK.fields, path: `/my-files/${"x".repeat(5000)}` } }).length < 300);
  });
});

describe("dialog text", () => {
  it("short: the sentence, then exactly the rendered operation", () => {
    assert.equal(dialogText(LINK), `${describeOperation(LINK)}\n\n${renderOperation(LINK)}`);
    const t = dialogText(trashOp(many(5)));
    for (const p of many(5)) assert.ok(t.includes(p), p);
  });

  it("long and not destructive: counts per folder, the first items, and how many are not shown", () => {
    const paths = [...many(30, "/my-files/A"), ...many(10, "/my-files/C")];
    const t = dialogText(moveOp(paths));
    assert.ok(dialogLines(t) <= DIALOG_MAX_LINES, `${dialogLines(t)} lines`);
    assert.match(t, /^Move 40 items into "\/my-files\/B"\./);
    assert.match(t, /folder \/my-files\/A: 30/);
    assert.match(t, /folder \/my-files\/C: 10/);
    assert.match(t, /destinationFolder: \/my-files\/B/);
    const shown = t.split("\n").filter((l) => l.startsWith("  - ")).length;
    assert.ok(shown >= 1);
    assert.ok(t.includes(`(${40 - shown} more not shown)`), t);
  });

  it("very many folders: the rest is counted, nothing silently dropped", () => {
    const t = dialogText(moveOp(Array.from({ length: 200 }, (_, i) => `/my-files/f${i}/x`)));
    assert.ok(dialogLines(t) <= DIALOG_MAX_LINES);
    const listed = (t.match(/^ {2}folder .*: 1$/gm) ?? []).length;
    assert.ok(t.includes(`(+${200 - listed} more folders with ${200 - listed} items)`), t);
  });

  it("long and destructive or outward: no dialog text at all", () => {
    assert.equal(dialogText(trashOp(many(40))), null);
    assert.equal(dialogText(trashOp(many(200))), null);
    assert.equal(dialogText({ ...moveOp(many(40)), effect: "outward" }), null);
    assert.equal(dialogText({ tool: "drive_cleanup", effect: "reversible", fields: { path: "/my-files", trash: many(20), keeps: many(20) } }), null);
    assert.equal(dialogText({ tool: "photos_upload", effect: "reversible", fields: { localPaths: many(60), conflictStrategy: "replace" } }), null);
  });

  it("wrapped lines count: a few very long paths are too long", () => {
    assert.equal(dialogText(trashOp(Array.from({ length: 12 }, (_, i) => `/my-files/${"y".repeat(170)}${i}`))), null);
  });
});

function memStore() {
  const approved = new Set(), requests = [], discarded = [];
  return {
    approved, requests, discarded,
    request(p) { requests.push(p); return { code: "K7Q2-M9XD", expiresAt: Date.now() + 600_000, reused: false }; },
    consume({ opHash: h }) { return approved.delete(h) ? { code: "K7Q2-M9XD" } : null; },
    discard(p) { discarded.push(p); approved.delete(p.opHash); return 0; },
  };
}
function gate(answers, { mode = "human", store = memStore(), elicit, ...rest } = {}) {
  const shown = [];
  const queue = [...answers];
  const native = async (message, signal) => { shown.push({ message, signal }); const a = queue.length > 1 ? queue.shift() : queue[0]; if (a instanceof Error) throw a; return typeof a === "function" ? a() : a; };
  return { gate: new ApprovalGate({ mode, native, store, elicit, ...rest }), shown, store };
}
const DEL = { tool: "drive_delete", effect: "irreversible", fields: { path: "/trash/a" } };

describe("gate: channel order", () => {
  it("a client whose dialog answers (yes, no, or closed by a person) never gets the native dialog", async () => {
    for (const answer of ["accept", "decline", "cancel"]) {
      let t = 0;
      const g = gate(["accept"], { now: () => t, elicit: async () => { t += 2000; return answer; } });
      const r = await g.gate.require(DEL);
      assert.equal(g.shown.length, 0, answer);
      assert.equal(r.ok, answer === "accept");
    }
  });

  it("otherwise the native dialog: Allow runs in the same call, no code, nothing stored", async () => {
    const g = gate(["accept"]);
    const ac = new AbortController();
    const r = await g.gate.require(DEL, { signal: ac.signal });
    assert.deepEqual(r, { ok: true, channel: "dialog", opHash: opHash(DEL) });
    assert.equal(g.shown[0].message, dialogText(DEL));
    assert.equal(g.shown[0].signal, ac.signal);
    assert.equal(g.store.requests.length, 0);
    assert.equal(g.store.discarded.length, 1);
  });

  it("strict mode uses it too; model mode never does", async () => {
    assert.equal((await gate(["accept"], { mode: "strict" }).gate.require(DEL)).channel, "dialog");
    const m = gate(["accept"], { mode: "model" });
    assert.equal((await m.gate.require(DEL)).ok, false);
    assert.equal(m.shown.length, 0);
  });

  it("decline is final", async () => {
    const g = gate(["decline"]);
    const r = await g.gate.require(DEL);
    assert.equal(r.code, "approval_declined");
    assert.match(r.message, /declined.*Do not retry/);
    assert.equal(g.store.requests.length, 0);
  });

  it("gave up: not approved, not declined, no code; call again only if the user asks", async () => {
    const g = gate(["gaveup", "accept"]);
    const r = await g.gate.require(DEL);
    assert.equal(r.ok, false);
    assert.equal(r.code, "approval_required");
    assert.match(r.message, /without an answer.*[Cc]all .* again only if the user asks/);
    assert.doesNotMatch(r.message, /declined|proton-drive-cli/);
    assert.equal(g.store.requests.length, 0);
    assert.equal((await g.gate.require(DEL)).channel, "dialog");
  });

  it("aborted: not approved, no code", async () => {
    const g = gate(["aborted"]);
    const r = await g.gate.require(DEL);
    assert.equal(r.code, "approval_unavailable");
    assert.equal(g.store.requests.length, 0);
  });

  for (const [label, answer] of [["error", "error"], ["a throwing runner", new Error("boom")], ["an unknown answer", "yes"], ["a backstop timeout", "timeout"]]) {
    it(`${label}: terminal store, approved there, then runs once`, async () => {
      const g = gate([answer]);
      const r = await g.gate.require(DEL);
      assert.equal(r.code, "approval_required");
      assert.match(r.message, /proton-drive-cli approve K7Q2-M9XD/);
      assert.deepEqual(g.store.requests, [{ tool: "drive_delete", opHash: opHash(DEL), summary: renderOperation(DEL), fresh: true }]);
      g.store.approved.add(opHash(DEL));
      assert.deepEqual(await g.gate.require(DEL), { ok: true, channel: "cli", opHash: opHash(DEL), code: "K7Q2-M9XD" });
      assert.equal((await g.gate.require(DEL)).ok, false);
    });
  }

  it("after a fallback, a terminal approval is used before a dialog that works again", async () => {
    const g = gate(["error", "decline"]);
    await g.gate.require(DEL);
    g.store.approved.add(opHash(DEL));
    assert.equal((await g.gate.require(DEL)).channel, "cli");
    assert.equal(g.shown.length, 1);
  });

  it("an approval approved in a terminal before a server restart still works when there is no dialog", async () => {
    const g = gate(["error"]);
    g.store.approved.add(opHash(DEL));
    assert.equal((await g.gate.require(DEL)).channel, "cli");
  });

  it("error with no store: refused as for a client that cannot ask", async () => {
    const g = gate(["error"], { store: null });
    const r = await g.gate.require(DEL);
    assert.equal(r.code, "approval_required");
    assert.match(r.message, /cannot ask them/);
  });

  it("one dialog at a time: a second gated call is refused, not queued", async () => {
    let answer;
    const g = gate([() => new Promise((resolve) => { answer = resolve; })]);
    const first = g.gate.require(DEL);
    await new Promise((r) => setImmediate(r));
    const second = await g.gate.require(LINK);
    assert.equal(second.code, "approval_unavailable");
    assert.match(second.message, /already waiting/);
    assert.equal(g.shown.length, 1);
    answer("accept");
    assert.equal((await first).ok, true);
  });

  for (const answer of ["decline", "gaveup", "aborted", "timeout"]) {
    it(`rate limit: after ${MAX_DECLINES_PER_MINUTE} x ${answer} no dialog opens for a minute`, async () => {
      let t = 1000;
      const g = gate([answer], { now: () => t });
      for (let i = 0; i < MAX_DECLINES_PER_MINUTE; i++) await g.gate.require(DEL);
      const r = await g.gate.require(DEL);
      assert.match(r.message, /too many approval requests/);
      assert.equal(g.shown.length, MAX_DECLINES_PER_MINUTE);
      t += 61_000;
      await g.gate.require(DEL);
      assert.equal(g.shown.length, MAX_DECLINES_PER_MINUTE + 1);
    });
  }

  it("no GUI session never uses up the limit: the terminal route keeps working", async () => {
    const g = gate(["error"]);
    for (let i = 0; i < 12; i++) assert.match((await g.gate.require(DEL)).message, /proton-drive-cli approve/);
  });

  it("too long and destructive: no dialog, the terminal record holds the full list", async () => {
    const op = trashOp(many(120));
    const g = gate(["accept"]);
    const r = await g.gate.require(op);
    assert.equal(r.code, "approval_required");
    assert.match(r.message, /too long to show in a dialog/);
    assert.equal(g.shown.length, 0);
    for (const p of many(120)) assert.ok(g.store.requests[0].summary.includes(`  - ${p}`), p);
    g.store.approved.add(opHash(op));
    assert.equal((await g.gate.require(op)).channel, "cli");
  });

  it("long and not destructive: the dialog shows the summary", async () => {
    const op = moveOp(many(120));
    const g = gate(["accept"]);
    assert.equal((await g.gate.require(op)).channel, "dialog");
    assert.equal(g.shown[0].message, dialogText(op));
  });

  it("terminal text: plain sentence first, says Node.js is needed", async () => {
    const r = await new ApprovalGate({ mode: "human", store: memStore() }).require(LINK);
    assert.ok(r.message.startsWith(describeOperation(LINK)), r.message);
    assert.match(r.message, /Node\.js/);
    assert.match(r.message, /proton-drive-cli approve K7Q2-M9XD/);
  });

  it("without a native channel (Linux, or switched off) the terminal route is as before", async () => {
    const store = memStore();
    const op = trashOp(many(120));
    const r = await new ApprovalGate({ mode: "human", store }).require(op);
    assert.match(r.message, /This client cannot ask the user\./);
    assert.equal(store.requests.length, 1);
    // a destructive record lists every item
    for (const p of many(120)) assert.ok(store.requests[0].summary.includes(`  - ${p}`), p);
  });
});

describe("server wiring (injected runner)", { concurrency: 4 }, () => {
  const SERVER = fileURLToPath(new URL("./helpers/dialog-server.mjs", import.meta.url));

  async function withDialogServer({ env = {}, elicit, approval = "human" }, fn) {
    const sb = makeSandbox();
    const log = join(sb.dir, "dialog.log");
    const auditFile = join(sb.dir, "audit.log");
    const client = new Client({ name: "dialog-test", version: "0" }, { capabilities: elicit ? { elicitation: { form: {} } } : {} });
    const requests = [];
    if (elicit) client.setRequestHandler(ElicitRequestSchema, async (req) => { requests.push(req.params); return elicit; });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [SERVER], stderr: "pipe",
      env: fakeEnv("json", sb, { PROTON_DRIVE_APPROVAL: approval, PROTON_DRIVE_AUDIT_LOG: auditFile, FAKE_DIALOG_LOG: log, FAKE_DIALOG_ENV: "1", ...env }),
    });
    await client.connect(transport);
    const read = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    try {
      return await fn({ call: (name, args) => client.callTool({ name, arguments: args }), dialogs: () => read(log), audit: () => read(auditFile), changes: () => changes(sb.argvLog), requests, calls: () => nonVersionCalls(sb.argvLog) });
    } finally { await client.close(); sb.cleanup(); }
  }
  const EMPTY = ["drive_empty_trash", { confirmed: true }];

  it("Allow: the same call runs, audited as channel dialog", () => withDialogServer({}, async (c) => {
    const r = await c.call(...EMPTY);
    assert.ok(!r.isError, text(r));
    assert.equal(c.dialogs().length, 1);
    assert.equal(c.dialogs()[0].file, "/usr/bin/osascript");
    assert.match(c.dialogs()[0].args.at(-1), /^Permanently delete everything in the trash\..*\n\ndrive_empty_trash: /s);
    assert.equal(c.dialogs()[0].args[3], "55");
    assert.equal(c.changes().length, 1);
    assert.equal(c.audit().at(-1).approval.channel, "dialog");
  }));

  it("PROTON_DRIVE_DIALOG_TIMEOUT reaches the dialog, clamped", () => withDialogServer({ env: { PROTON_DRIVE_DIALOG_TIMEOUT: "500" } }, async (c) => {
    await c.call(...EMPTY);
    assert.equal(c.dialogs()[0].args[3], "110");
  }));

  for (const [mode, code] of [["deny", /declined/], ["gaveup", /without an answer/], ["nogui", /proton-drive-cli approve/]]) {
    it(`${mode}: nothing changes`, () => withDialogServer({ env: { FAKE_DIALOG: mode } }, async (c) => {
      const r = await c.call(...EMPTY);
      assert.equal(r.isError, true);
      assert.match(text(r), code);
      assert.equal(c.changes().length, 0);
    }));
  }

  for (const [label, env] of [["linux", { FAKE_PLATFORM: "linux" }], ["PROTON_DRIVE_DIALOG=0", { FAKE_DIALOG_ENV: "0" }]]) {
    it(`${label}: no dialog, terminal route`, () => withDialogServer({ env }, async (c) => {
      assert.match(text(await c.call(...EMPTY)), /This client cannot ask the user\..*proton-drive-cli approve/s);
      assert.equal(c.dialogs().length, 0);
      assert.equal(c.changes().length, 0);
    }));
  }

  it("an eliciting client: elicitation only, checkbox unticked so only a deliberate tick approves", () => withDialogServer({ elicit: { action: "accept", content: { approve: true } } }, async (c) => {
    assert.ok(!(await c.call(...EMPTY)).isError);
    assert.equal(c.dialogs().length, 0);
    assert.equal(c.requests[0].requestedSchema.properties.approve.default, false);
  }));

  it("an eliciting client that unticks the box declines", () => withDialogServer({ elicit: { action: "accept", content: { approve: false } } }, async (c) => {
    assert.match(text(await c.call(...EMPTY)), /declined/);
    assert.equal(c.changes().length, 0);
  }));

  it("model mode: no native dialog; the old pre-prompt still asks through elicitation, unticked", async () => {
    await withDialogServer({ approval: "model" }, async (c) => {
      assert.ok(!(await c.call(...EMPTY)).isError);
      assert.equal(c.dialogs().length, 0);
    });
    await withDialogServer({ approval: "model", elicit: { action: "accept", content: { approve: true } } }, async (c) => {
      assert.ok(!(await c.call("drive_empty_trash", { confirmed: false })).isError);
      assert.equal(c.requests[0].requestedSchema.properties.approve.default, false);
      assert.equal(c.dialogs().length, 0);
    });
  });
});
