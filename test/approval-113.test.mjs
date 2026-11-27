// 1.13.0 approval fixes. Nothing here opens a dialog (the runner is injected) or runs the real CLI.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ApprovalGate, dialogLines, dialogText, renderOperation, requiresApproval, DIALOG_MAX_LINES } from "../dist/utils/approval.js";
import { describeOperation } from "../dist/utils/describeOperation.js";
import { DriveService } from "../dist/services/drive.js";
import { callContext, runDrive, timeoutFor } from "../dist/utils/subprocess.js";
import { DriveCliError } from "../dist/utils/errors.js";
import { makeSandbox, fakeEnv } from "./helpers/mcp-client.mjs";
import { ACCEPT, DECLINE, NO_APPROVE, withServer, writeTree, text, changes } from "./helpers/approval-harness.mjs";

const trashed = (name, uid, size, type = "file") => ({ name, uid, type, trashTime: "2026-11-01T10:00:00Z", ...(size === undefined ? {} : { activeRevision: { claimedSize: size } }) });
const trashTree = (items) => ({ fakeMode: "tree", setup: (sb) => ({ FAKE_TREE: writeTree(sb.dir, { "/trash": items }) }) });
const TWO = [trashed("old.txt", "u1", 100), trashed("Reports", "u2", undefined, "folder"), trashed("big.bin", "u3", 2000)];

describe("1: drive_empty_trash shows what will be deleted", () => {
  it("item count, total bytes and every name are in the approval; accept runs it once", () =>
    withServer({ ...trashTree(TWO), replies: [ACCEPT] }, async (ctx) => {
      const r = await ctx.call("drive_empty_trash", {});
      assert.ok(!r.isError, text(r));
      const m = ctx.messages[0];
      assert.match(m, /^itemCount: 3$/m);
      assert.match(m, /^totalBytes: 2100$/m);
      assert.match(m, /^trashItems \(3\):$/m);
      for (const n of ["old.txt", "Reports/", "big.bin"]) assert.ok(m.includes(`  - ${n}`), `${n}\n${m}`);
      assert.deepEqual(ctx.changes(), [["filesystem", "empty-trash", "--json"]]);
    }));

  it("more than 50 items and a long name: nothing is cut", () => {
    const long = "n".repeat(250);
    const items = [...Array.from({ length: 80 }, (_, i) => trashed(`f-${String(i).padStart(3, "0")}`, `u${i}`, 1)), trashed(long, "ul", 1)];
    return withServer({ ...trashTree(items), replies: [DECLINE] }, async (ctx) => {
      await ctx.call("drive_empty_trash", {});
      const m = ctx.messages[0];
      for (const it of items) assert.ok(m.includes(`  - ${it.name}`), it.name);
      assert.doesNotMatch(m, /not shown|only the first/);
      assert.deepEqual(ctx.changes(), []);
    });
  });

  for (const [label, after] of [
    ["an item was added", [...TWO, trashed("new.txt", "u9", 1)]],
    ["a same-named, same-size item replaced another", [trashed("old.txt", "other", 100), ...TWO.slice(1)]],
  ]) {
    it(`${label} while the question was open: approval_changed, nothing deleted`, () => {
      let file;
      return withServer({
        fakeMode: "tree", setup: (sb) => ({ FAKE_TREE: (file = writeTree(sb.dir, { "/trash": TWO })) }),
        replies: () => { writeFileSync(file, JSON.stringify({ "/trash": after })); return ACCEPT; },
      }, async (ctx) => {
        const r = await ctx.call("drive_empty_trash", {});
        assert.equal(r.isError, true);
        assert.match(text(r), /changed after the user approved/);
        assert.equal(ctx.lastAudit().code, "approval_changed");
        assert.deepEqual(ctx.changes(), []);
      });
    });
  }

  it("an unreadable trash refuses without asking", () =>
    withServer({ fakeMode: "tree", setup: (sb) => ({ FAKE_TREE: writeTree(sb.dir, {}) }), replies: [ACCEPT] }, async (ctx) => {
      assert.equal((await ctx.call("drive_empty_trash", {})).isError, true);
      assert.equal(ctx.asked, 0);
      assert.deepEqual(ctx.changes(), []);
    }));

  it("too many names to record: refused, never approved on a partial list", () => {
    // zero-width characters are shown escaped (6 columns each), so the listing stays small while the record does not
    const items = Array.from({ length: 70 }, (_, i) => trashed(`${"\u200b".repeat(250)}-${i}`, `u${i}`, 1));
    return withServer({ ...trashTree(items), replies: [ACCEPT] }, async (ctx) => {
      const r = await ctx.call("drive_empty_trash", {});
      assert.equal(r.isError, true);
      assert.match(text(r), /too many to list/);
      assert.equal(ctx.asked, 0);
      assert.deepEqual(ctx.changes(), []);
    });
  });

  it("the sentence says the photos trash is not emptied", () => {
    const op = { tool: "drive_empty_trash", effect: "irreversible", fields: { itemCount: 2, totalBytes: 1, trashItems: ["a", "b/"] } };
    assert.match(describeOperation(op), /holds 2 item\(s\).*photos trash is not emptied/);
  });

  it("model mode: the question the client shows lists the items too", () =>
    withServer({ ...trashTree(TWO), approval: "model", replies: [ACCEPT] }, async (ctx) => {
      assert.ok(!(await ctx.call("drive_empty_trash", { confirmed: false })).isError);
      assert.match(ctx.messages[0], /itemCount: 3[\s\S]*old\.txt/);
      assert.equal(ctx.changes().length, 1);
    }));
});

describe("2: model mode, a human Decline is final", () => {
  const DEL = { path: "/trash/a.txt" };
  for (const [label, reply] of [["decline", DECLINE], ["accept with the box unticked", NO_APPROVE]]) {
    it(`${label}: declined refusal, never "call again with confirmed=true", and confirmed=true alone no longer runs it`, () =>
      withServer({ approval: "model", replies: [reply, reply, ACCEPT] }, async (ctx) => {
        const first = await ctx.call("drive_delete", { ...DEL, confirmed: false });
        assert.equal(first.isError, true);
        assert.match(text(first), /declined.*Do not retry/);
        assert.doesNotMatch(text(first), /confirmed=true/);
        const again = await ctx.call("drive_delete", { ...DEL, confirmed: true });
        assert.equal(again.isError, true);
        assert.match(text(again), /declined.*Do not retry/);
        assert.equal(ctx.asked, 2);
        assert.equal(ctx.lastAudit().code, "approval_declined");
        assert.deepEqual(ctx.changes(), []);
        // the human, and only the human, can change their mind
        assert.ok(!(await ctx.call("drive_delete", { ...DEL, confirmed: true })).isError);
        assert.equal(ctx.asked, 3);
        assert.equal(ctx.changes().length, 1);
      }));
  }

  it("after the prompt budget is used up, nothing is downgraded to confirmed=true", () =>
    withServer({ approval: "model", replies: () => DECLINE }, async (ctx) => {
      for (let i = 0; i < 5; i++) await ctx.call("drive_delete", { ...DEL, confirmed: false });
      const r = await ctx.call("drive_share_leave", { path: "/shared-with-me/p", confirmed: false });
      assert.doesNotMatch(text(r), /confirmed=true/);
      assert.equal((await ctx.call("drive_share_leave", { path: "/shared-with-me/p", confirmed: true })).isError, true);
      assert.equal(ctx.asked, 5);
      assert.deepEqual(ctx.changes(), []);
    }));

  it("empty trash: a Decline is final too", () =>
    withServer({ ...trashTree(TWO), approval: "model", replies: [DECLINE, DECLINE] }, async (ctx) => {
      const first = await ctx.call("drive_empty_trash", { confirmed: false });
      assert.match(text(first), /declined.*Do not retry/);
      assert.equal((await ctx.call("drive_empty_trash", { confirmed: true })).isError, true);
      assert.equal(ctx.asked, 2);
      assert.deepEqual(ctx.changes(), []);
    }));

  it("bulk trash: a Decline is the same declined refusal", () =>
    withServer({ approval: "model", replies: [DECLINE], fakeMode: "tree", setup: (sb) => ({ FAKE_TREE: writeTree(sb.dir, { "/my-files/s": [{ name: "x.txt", type: "file" }] }) }) }, async (ctx) => {
      const r = await ctx.call("drive_bulk_trash", { paths: ["/my-files/s/x.txt"], confirmed: true });
      assert.match(text(r), /declined.*Do not retry/);
      assert.equal(ctx.lastAudit().code, "approval_declined");
      assert.deepEqual(ctx.changes(), []);
    }));
});

describe("3: uploads that overwrite need approval", () => {
  const local = (ctx) => { const p = join(ctx.dir, "work", "f.txt"); writeFileSync(p, "data"); return p; };

  it("gate: create-new-revision with any folder strategy", () => {
    for (const folderConflictStrategy of ["skip", "merge", "rename"]) {
      assert.equal(requiresApproval("drive_upload", { fileConflictStrategy: "create-new-revision", folderConflictStrategy }, "human"), true, folderConflictStrategy);
    }
    assert.equal(requiresApproval("drive_upload", { fileConflictStrategy: "skip", folderConflictStrategy: "merge" }, "human"), false);
    assert.equal(requiresApproval("drive_upload", { fileConflictStrategy: "rename", folderConflictStrategy: "merge" }, "human"), false);
  });

  it("human mode: asked, the sentence says existing files get new content, decline uploads nothing", () =>
    withServer({ replies: [DECLINE] }, async (ctx) => {
      const r = await ctx.call("drive_upload", { localPath: local(ctx), remotePath: "/my-files/d", fileConflictStrategy: "create-new-revision", folderConflictStrategy: "merge" });
      assert.equal(r.isError, true);
      assert.equal(ctx.asked, 1);
      assert.deepEqual(ctx.changes(), []);
    }));

  it("the sentence names the overwrite", () => {
    assert.match(describeOperation({ tool: "drive_upload", effect: "reversible", fields: { localPath: "/a/f", remotePath: "/my-files/d", fileConflictStrategy: "create-new-revision", folderConflictStrategy: "merge" } }), /new version/);
  });

  it("model mode: create-new-revision needs confirmed=true", () =>
    withServer({ approval: "model", caps: {} }, async (ctx) => {
      const args = { localPath: local(ctx), remotePath: "/my-files/d", fileConflictStrategy: "create-new-revision" };
      const r = await ctx.call("drive_upload", args);
      assert.equal(r.isError, true);
      assert.match(text(r), /confirmed=true/);
      assert.deepEqual(ctx.changes(), []);
      await ctx.call("drive_upload", { ...args, confirmed: true });
      assert.equal(ctx.changes().length, 1);
    }));
});

describe("4: drive_share_set_url never changes an existing link silently", () => {
  const status = (urlAccess) => ({ env: { FAKE_STDOUT: JSON.stringify({ urlAccess: { url: "https://drive.proton.me/urls/X", ...urlAccess } }) } });
  const setUrl = (ctx) => ctx.changes().find((a) => a[1] === "set-url");
  const roleOf = (argv) => argv[argv.indexOf("--role") + 1];

  for (const approval of ["human", "model"]) {
    it(`${approval}: an editor link stays editor when role is omitted`, () =>
      withServer({ ...status({ role: "editor" }), approval, replies: [ACCEPT] }, async (ctx) => {
        const r = await ctx.call("drive_share_set_url", { path: "/my-files/p", ...(approval === "model" ? { confirmed: true } : {}) });
        assert.ok(!r.isError, text(r));
        assert.equal(roleOf(setUrl(ctx)), "editor");
        if (approval === "human") assert.match(ctx.messages[0], /roleChange: editor -> editor/);
      }));
  }

  it("model mode with password and expiration given still keeps the role", () =>
    withServer({ ...status({ role: "editor" }), approval: "model", caps: {} }, async (ctx) => {
      await ctx.call("drive_share_set_url", { path: "/my-files/p", password: "pw-123456", expiration: "2026-12-31", confirmed: true });
      assert.equal(roleOf(setUrl(ctx)), "editor");
    }));

  it("an existing link whose role cannot be read is refused when role is omitted", () =>
    withServer({ ...status({}), replies: [ACCEPT] }, async (ctx) => {
      const r = await ctx.call("drive_share_set_url", { path: "/my-files/p" });
      assert.equal(r.isError, true);
      assert.match(text(r), /pass role/);
      assert.deepEqual(ctx.changes(), []);
    }));

  it("removals are named in the sentence and the fields, never the password", () =>
    withServer({ ...status({ role: "editor", customPassword: "s3cret-old", expirationTime: "2026-12-01T00:00:00Z" }), replies: [DECLINE] }, async (ctx) => {
      await ctx.call("drive_share_set_url", { path: "/my-files/p", role: "viewer", resetSettings: true });
      assert.match(ctx.messages[0], /^roleChange: editor -> viewer$/m);
      assert.match(ctx.messages[0], /^passwordChange: set -> not set \(REMOVED\)$/m);
      assert.match(ctx.messages[0], /^expirationChange: 2026-12-01T00:00:00Z -> not set \(REMOVED\)$/m);
      assert.doesNotMatch(ctx.messages[0], /s3cret/);
    }));

  it("the dialog sentence shows current -> new", () => {
    const op = { tool: "drive_share_set_url", effect: "outward", fields: { path: "/my-files/p", role: "viewer", replacesExistingLink: true }, display: { password: false, roleChange: "editor -> viewer", passwordChange: "set -> not set (REMOVED)", expirationChange: "2026-12-01 -> not set (REMOVED)" } };
    const s = describeOperation(op);
    assert.match(s, /Role: editor -> viewer/);
    assert.match(s, /Password: set -> not set \(REMOVED\)/);
    assert.match(s, /Expiry: 2026-12-01 -> not set \(REMOVED\)/);
  });

  it("a replaced password is said to be set -> set, without its value", () =>
    withServer({ ...status({ role: "viewer", customPassword: "s3cret-old" }), replies: [DECLINE] }, async (ctx) => {
      await ctx.call("drive_share_set_url", { path: "/my-files/p", password: "s3cret-new" });
      assert.match(ctx.messages[0], /^passwordChange: set -> set \(replaced\)$/m);
      assert.doesNotMatch(ctx.messages[0], /s3cret/);
    }));
});

describe("5: the checkbox starts unticked", () => {
  for (const approval of ["human", "model"]) {
    it(`${approval}: default false, the title says what leaving it unticked does`, async () => {
      const sb = makeSandbox();
      const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: { form: {} } } });
      let schema;
      client.setRequestHandler(ElicitRequestSchema, async (req) => { schema = req.params.requestedSchema; return DECLINE; });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))], env: fakeEnv("json", sb, { PROTON_DRIVE_APPROVAL: approval }) }));
      try {
        await client.callTool({ name: "drive_delete", arguments: { path: "/trash/a.txt" } });
        assert.equal(schema.properties.approve.default, false);
        assert.equal(schema.properties.approve.title, "Tick to allow. Leaving it unticked refuses.");
      } finally { await client.close(); sb.cleanup(); }
    });
  }
});

describe("6: dialog line measurement", () => {
  it("every non-ASCII code point takes two columns", () => {
    assert.equal(dialogLines("a".repeat(60)), 1);
    assert.equal(dialogLines("中".repeat(30)), 1);
    assert.equal(dialogLines("中".repeat(31)), 2);
    assert.equal(dialogLines("Ｗ".repeat(60)), 2);
    assert.equal(dialogLines("😀".repeat(31)), 2);
    assert.equal(dialogLines("é".repeat(61)), 3);
  });

  it("a long unbroken run starts its own line and is broken by columns; words wrap whole", () => {
    assert.equal(dialogLines(`  - ${"y".repeat(60)}`), 2);
    assert.equal(dialogLines(` ${"y".repeat(60)}`), 2);
    assert.equal(dialogLines(`  - ${"y".repeat(120)}`), 3);
    assert.equal(dialogLines(`${"a".repeat(31)} ${"b".repeat(31)} ${"c".repeat(31)}`), 3);
  });

  it("wide names push a destructive list out of the dialog: terminal route", () => {
    const paths = Array.from({ length: 12 }, (_, i) => `/my-files/${"漢".repeat(40)}${i}`);
    assert.equal(dialogText({ tool: "drive_bulk_trash", effect: "reversible", fields: { paths } }), null);
  });

  it("a destructive approval with an elided value does not use the dialog", () => {
    const op = { tool: "drive_delete", effect: "irreversible", fields: { path: `/trash/${"a".repeat(260)}` } };
    assert.ok(renderOperation(op).includes("…"));
    assert.equal(dialogText(op), null);
  });

  it("an ordinary destructive approval still fits", () => {
    const t = dialogText({ tool: "drive_delete", effect: "irreversible", fields: { path: "/trash/a" } });
    assert.ok(t && dialogLines(t) <= DIALOG_MAX_LINES);
  });
});

describe("7: a failed or instant-cancel elicitation falls back to the native dialog", () => {
  const OP = { tool: "drive_delete", effect: "irreversible", fields: { path: "/trash/a" } };
  const store = () => { const requests = []; return { requests, request: (p) => { requests.push(p); return { code: "K7Q2-M9XD", expiresAt: Date.now() + 600_000, reused: false }; }, consume: () => null, discard: () => 0 }; };
  const make = ({ reply, tookMs = 0, native = "accept" }) => {
    let t = 1000;
    const shown = [], s = store();
    const gate = new ApprovalGate({
      mode: "human", store: s, now: () => t,
      elicit: async () => { t += tookMs; if (reply instanceof Error) throw reply; return reply; },
      native: async (m) => { shown.push(m); return native; },
    });
    return { gate, shown, store: s };
  };

  for (const [label, o] of [["an error", { reply: "error" }], ["a throwing elicit", { reply: new Error("boom") }], ["a slow error", { reply: "error", tookMs: 5000 }], ["cancel after 0.999 s", { reply: "cancel", tookMs: 999 }]]) {
    it(`${label}: native dialog, Allow runs it`, async () => {
      const g = make(o);
      const r = await g.gate.require(OP);
      assert.equal(r.channel, "dialog");
      assert.equal(g.shown.length, 1);
    });
  }

  for (const [label, o, code] of [["cancel after 1 s", { reply: "cancel", tookMs: 1000 }, "approval_required"], ["a real decline", { reply: "decline" }, "approval_declined"]]) {
    it(`${label}: no native dialog`, async () => {
      const g = make(o);
      assert.equal((await g.gate.require(OP)).code, code);
      assert.equal(g.shown.length, 0);
    });
  }

  it("a decline in the native dialog is final: no terminal record", async () => {
    const g = make({ reply: "error", native: "decline" });
    assert.equal((await g.gate.require(OP)).code, "approval_declined");
    assert.equal(g.store.requests.length, 0);
  });

  it("native dialog unavailable too: terminal fallback, counted once", async () => {
    for (const native of ["error", "timeout"]) {
      const g = make({ reply: "cancel", native });
      for (let i = 0; i < 5; i++) assert.match((await g.gate.require(OP)).message, /proton-drive-cli approve/, native);
      assert.match((await g.gate.require(OP)).message, /too many approval requests/);
    }
  });

  it("too long for a dialog: terminal route with the whole list", async () => {
    const g = make({ reply: "error" });
    const paths = Array.from({ length: 80 }, (_, i) => `/my-files/f${i}`);
    const r = await g.gate.require({ tool: "drive_bulk_trash", effect: "reversible", fields: { paths } });
    assert.equal(r.code, "approval_required");
    assert.equal(g.shown.length, 0);
    for (const p of paths) assert.ok(g.store.requests[0].summary.includes(`  - ${p}\n`) || g.store.requests[0].summary.endsWith(`  - ${p}`), p);
  });

  it("a cancelled request does not open the native dialog", async () => {
    const g = make({ reply: "error" });
    const r = await g.gate.require(OP, { signal: AbortSignal.abort() });
    assert.equal(r.ok, false);
    assert.equal(g.shown.length, 0);
  });
});

describe("8: closing the client's stdin aborts a pending native dialog", () => {
  it("the dialog is killed, a late Allow does not count, nothing runs", async () => {
    const sb = makeSandbox();
    const log = join(sb.dir, "dialog.log");
    const child = spawn(process.execPath, [fileURLToPath(new URL("./helpers/dialog-server.mjs", import.meta.url))], {
      env: fakeEnv("tree", sb, { PROTON_DRIVE_APPROVAL: "human", FAKE_DIALOG_LOG: log, FAKE_DIALOG_ENV: "1", FAKE_DIALOG: "pending", FAKE_TREE: writeTree(sb.dir, { "/trash": TWO }) }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    const read = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
    const until = async (cond) => { for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(cond(), read()); };
    try {
      child.stdout.resume();
      child.stderr.resume();
      const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
      send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      send({ method: "notifications/initialized" });
      send({ id: 2, method: "tools/call", params: { name: "drive_empty_trash", arguments: {} } });
      await until(() => read().includes("osascript"));
      child.stdin.end();
      await until(() => read().includes('"killed"'));
      await exited;
      assert.deepEqual(changes(sb.argvLog), []);
    } finally { child.kill("SIGKILL"); sb.cleanup(); }
  });
});

describe("9: trashing photos is never described as undoable", () => {
  for (const [tool, fields] of [["drive_trash", { path: "/photos/p.jpg" }], ["drive_bulk_trash", { paths: ["/photos/p.jpg"] }]]) {
    it(`${tool}: approval text`, () =>
      withServer({ approval: "strict", replies: [DECLINE], fakeMode: "tree", setup: (sb) => ({ FAKE_TREE: writeTree(sb.dir, { "/photos": [{ name: "p.jpg", type: "file" }] }) }) }, async (ctx) => {
        await ctx.call(tool, { ...fields, ...(tool === "drive_bulk_trash" ? { confirmed: true } : {}) });
        assert.equal(ctx.asked, 1);
        assert.doesNotMatch(ctx.messages[0], /can be undone|can restore/);
        assert.match(ctx.messages[0], /undo is switched off or unavailable/);
      }));
  }

  it("the sentence", () => {
    for (const op of [{ tool: "drive_trash", fields: { path: "/photos/p.jpg" } }, { tool: "drive_bulk_trash", fields: { paths: ["/photos/p.jpg"] } }]) {
      const s = describeOperation({ ...op, effect: "reversible-no-undo" });
      assert.doesNotMatch(s, /can restore|can be undone/);
      assert.match(s, /Automatic undo is not available/);
    }
  });

  it("the result for a photo promises no undo", () =>
    withServer({ caps: {} }, async (ctx) => {
      const r = await ctx.call("drive_trash", { path: "/photos/p.jpg" });
      assert.ok(!r.isError, text(r));
      assert.doesNotMatch(text(r), /can be undone|can restore|undoId/);
    }));
});

describe("10: batch trash, restore, delete and empty-trash", () => {
  it("the timeout grows with the item count and is bounded", () => {
    const t = (sub, n) => timeoutFor(["filesystem", sub, ...Array.from({ length: n }, (_, i) => `/trash/${i}`)]);
    for (const sub of ["trash", "restore", "delete"]) {
      assert.ok(t(sub, 1) >= 60_000, sub);
      assert.ok(t(sub, 20) > t(sub, 2), sub);
      assert.equal(t(sub, 100_000), 600_000, sub);
    }
    assert.equal(timeoutFor(["filesystem", "empty-trash"]), 600_000);
    assert.ok(timeoutFor(["filesystem", "empty-trash"], { items: 1 }) > 60_000);
    assert.ok(timeoutFor(["filesystem", "empty-trash"], { items: 30 }) > timeoutFor(["filesystem", "empty-trash"], { items: 1 }));
    assert.equal(timeoutFor(["filesystem", "empty-trash"], { items: 1e6 }), 600_000);
    assert.equal(timeoutFor(["filesystem", "list", "/trash"]), 60_000);
  });

  it("emptyTrash passes the item count to the runner", async () => {
    const calls = [];
    await new DriveService(async (args, opts) => { calls.push([args, opts]); return null; }).emptyTrash(7);
    assert.deepEqual(calls, [[["filesystem", "empty-trash"], { items: 7 }]]);
  });

  it("an interrupted call says the outcome is unknown", async () => {
    const sb = makeSandbox();
    const saved = { ...process.env };
    Object.assign(process.env, fakeEnv("hang", sb));
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 150);
      await assert.rejects(callContext.run({ signal: ac.signal }, () => runDrive(["filesystem", "trash", "/my-files/a", "/my-files/b"])),
        (e) => e.interrupted === true && /outcome is unknown.*before retrying/i.test(e.message));
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      sb.cleanup();
    }
  });

  it("bulk trash: an interrupted batch never claims nothing was applied", async () => {
    const stop = new DriveCliError("CLI process timed out after 70s. The outcome is unknown.", "", true);
    await assert.rejects(new DriveService(async () => { throw stop; }).bulkTrash(["/my-files/a"]), (e) => !/before applying anything/.test(e.message) && /outcome is unknown/.test(e.message));
    await assert.rejects(new DriveService(async () => { throw new DriveCliError("boom"); }).bulkTrash(["/my-files/a"]), /before applying anything/);
  });
});
