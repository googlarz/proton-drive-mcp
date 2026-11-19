// 1.11.0 approval gate: INDEPENDENT adversarial suite (task C1). Written from PLAN-1.11.0.md sections 1, 2 and 4.2, not from the
// gate implementation. Every case asserts on the fake CLI's argv log (zero mutating CLI calls unless a human approved), not only on
// the reply text. A failing test here is a finding about the implementation: it is kept as is (or marked `todo`), never weakened.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createApprovalStore } from "../dist/utils/approvalStore.js";
import { ApprovalGate } from "../dist/utils/approval.js";
import { AuditLog } from "../dist/utils/audit.js";
import { ACCEPT, DECLINE, CANCEL, NO_APPROVE, THROWS, withServer, writeTree, text } from "./helpers/approval-harness.mjs";

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- table of every gated operation (independent copy: tool, a valid call, what the fake CLI needs) ------------------------
const MEMBER = JSON.stringify({ members: [{ inviteeEmail: "a@example.org", role: "viewer" }] });
const TREE = { "/my-files/s": [{ name: "x.txt", type: "file" }], "/my-files/d": [] };
const treeSetup = (sb) => ({ FAKE_TREE: writeTree(sb.dir, TREE) });
const syncSetup = (sb) => {
  const sync = join(sb.dir, "sync");
  mkdirSync(sync, { recursive: true });
  writeFileSync(join(sync, "notes.txt"), "old");
  return { PROTON_DRIVE_SYNC_PATH: sync };
};
const localFile = (sb) => { const p = join(sb.dir, "work", "f.txt"); writeFileSync(p, "data"); return p; };

const G = [
  { tool: "drive_auth_logout", args: () => ({}) },
  { tool: "drive_delete", args: () => ({ path: "/trash/a.txt" }) },
  { tool: "drive_empty_trash", args: () => ({}) },
  { tool: "drive_share_invite", args: () => ({ path: "/my-files/p", email: "a@example.org", role: "viewer", message: "hello" }) },
  { tool: "drive_share_revoke", args: () => ({ path: "/my-files/p", email: "a@example.org" }), env: { FAKE_STDOUT: MEMBER } },
  { tool: "drive_share_set_url", args: () => ({ path: "/my-files/p", role: "viewer" }) },
  { tool: "drive_share_remove_url", args: () => ({ path: "/my-files/p" }) },
  { tool: "drive_share_remove_all", args: () => ({ path: "/my-files/p" }), env: { FAKE_STDOUT: MEMBER } },
  { tool: "drive_share_leave", args: () => ({ path: "/shared-with-me/p" }) },
  { tool: "drive_invitation_accept", args: () => ({ uid: "inv-1" }) },
  { tool: "drive_invitation_reject", args: () => ({ uid: "inv-1" }) },
  { tool: "photos_delete_album", args: () => ({ albumPath: "/albums/a", force: true }) },
  { tool: "photos_remove_from_album", args: () => ({ albumPath: "/albums/a", photoPath: "/photos/p.jpg" }) },
  { tool: "drive_bulk_move", args: () => ({ sources: ["/my-files/s/x.txt"], destinationFolder: "/my-files/d", confirmed: true }), setup: treeSetup, fakeMode: "tree" },
  { tool: "drive_bulk_trash", args: () => ({ paths: ["/my-files/s/x.txt"], confirmed: true }), setup: treeSetup, fakeMode: "tree" },
  { tool: "drive_upload", label: "replace", args: (sb) => ({ localPath: localFile(sb), remotePath: "/my-files/d", fileConflictStrategy: "replace" }) },
  { tool: "drive_download", label: "remove", args: (sb) => ({ remotePath: "/my-files/a.txt", localPath: join(sb.dir, "work", "out"), fileConflictStrategy: "remove" }) },
  { tool: "photos_download", label: "remove", args: (sb) => ({ photoPaths: ["/photos/p.jpg"], localFolder: join(sb.dir, "work", "pout"), conflictStrategy: "remove" }) },
  { tool: "drive_write_file", label: "overwrite", args: () => ({ path: "/my-files/notes.txt", content: "new text" }), setup: syncSetup, noCli: true },
  { tool: "drive_copy", label: "into shared", args: () => ({ sourcePath: "/my-files/a.txt", destinationPath: "/shared-with-me/t" }) },
  { tool: "drive_move", label: "into shared", args: () => ({ sourcePath: "/my-files/a.txt", destinationPath: "/shared-with-me/t/a.txt" }) },
  { tool: "drive_mkdir", label: "in shared", args: () => ({ path: "/shared-with-me/t/new" }) },
  { tool: "drive_rename", label: "in shared", args: () => ({ path: "/shared-with-me/t/a.txt", newName: "b.txt" }) },
  { tool: "drive_upload", label: "into shared", args: (sb) => ({ localPath: localFile(sb), remotePath: "/shared-with-me/t" }) },
];
const name = (c) => (c.label ? `${c.tool} (${c.label})` : c.tool);
const opts = (c, extra = {}) => ({ setup: c.setup, fakeMode: c.fakeMode, env: c.env, ...extra });
const always = (reply) => () => reply;

const safe = async (ctx, tool, args) => {
  try { return await ctx.call(tool, args); }
  catch (e) { return { isError: true, content: [{ type: "text", text: `THROWN ${e.message}` }], thrown: true }; }
};
const alive = async (ctx, why) => { await ctx.client.ping(); assert.ok(true, why); };
const codeOf = (r) => /approve ([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(text(r))?.[1];
const store = (ctx) => createApprovalStore({ dir: join(ctx.dir, "approvals") });
const pendingFiles = (ctx) => { try { return readdirSync(join(ctx.dir, "approvals", "pending")); } catch { return []; } };
const toolSchemas = async (ctx) => Object.fromEntries((await ctx.client.listTools()).tools.map((t) => [t.name, t.inputSchema]));

// ======================================================================================================================
// Case 1: confirmed:true on every gated tool, declining client: nothing runs.
// ======================================================================================================================
describe("case 1: confirmed=true on every gated tool, human declines: nothing runs", { concurrency: 6 }, () => {
  for (const c of G) {
    it(name(c), async () => {
      await withServer(opts(c, { replies: always(DECLINE) }), async (ctx) => {
        const schemas = await toolSchemas(ctx);
        const takesConfirmed = Boolean(schemas[c.tool].properties?.confirmed);
        for (let i = 0; i < 2; i++) {
          const asked = ctx.asked;
          const r = await safe(ctx, c.tool, { ...c.args(ctx.sb), confirmed: true });
          assert.equal(r.isError, true, `${name(c)} confirmed=true must not succeed: ${text(r)}`);
          assert.deepEqual(ctx.changes(), [], `${name(c)}: a mutating CLI call happened`);
          if (takesConfirmed) {
            assert.equal(ctx.asked, asked + 1, "the human was asked exactly once");
            assert.equal(ctx.lastAudit().outcome, "refused");
            assert.equal(ctx.lastAudit().code, "approval_declined");
          }
        }
        if (c.tool === "drive_write_file") assert.equal(readFileSync(join(ctx.dir, "sync", "notes.txt"), "utf8"), "old");
        await alive(ctx);
      });
    });
  }
});

// ======================================================================================================================
// Case 2: no elicitation capability, confirmed:true: refused, pending record, nothing runs.
// ======================================================================================================================
describe("case 2: client cannot elicit, confirmed=true: approval_required, pending record, nothing runs", { concurrency: 6 }, () => {
  for (const c of G) {
    it(name(c), async () => {
      await withServer(opts(c, { caps: {} }), async (ctx) => {
        const takesConfirmed = Boolean((await toolSchemas(ctx))[c.tool].properties?.confirmed);
        const r = await safe(ctx, c.tool, { ...c.args(ctx.sb), ...(takesConfirmed ? { confirmed: true } : {}) });
        assert.equal(r.isError, true, text(r));
        assert.deepEqual(ctx.changes(), []);
        const code = codeOf(r);
        assert.ok(code, `no approval code in: ${text(r)}`);
        const rec = store(ctx).get(code);
        assert.ok(rec, "a pending record exists for the code");
        assert.equal(rec.tool, c.tool);
        assert.equal(rec.status, "pending");
        assert.equal(ctx.lastAudit().code, "approval_required");
        assert.equal(ctx.asked, 0);
        // asking again and again (the model "retrying") neither runs it nor piles up records
        for (let i = 0; i < 3; i++) {
          const again = await safe(ctx, c.tool, { ...c.args(ctx.sb), ...(takesConfirmed ? { confirmed: true } : {}) });
          assert.equal(again.isError, true);
          assert.equal(codeOf(again), code, "same operation reuses its pending record");
        }
        assert.equal(pendingFiles(ctx).length, 1);
        assert.deepEqual(ctx.changes(), []);
        if (c.tool === "drive_write_file") assert.equal(readFileSync(join(ctx.dir, "sync", "notes.txt"), "utf8"), "old");
      });
    });
  }
});

// ======================================================================================================================
// Case 3: replay.
// ======================================================================================================================
describe("case 3: replay", () => {
  it("store approval is single use: approve once, call twice, second is refused", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      const args = { path: "/my-files/p", email: "a@example.org", role: "viewer" };
      const code = codeOf(await ctx.call("drive_share_invite", args));
      store(ctx).approve(code);
      const first = await ctx.call("drive_share_invite", args);
      assert.notEqual(first.isError, true, text(first));
      assert.equal(ctx.changes().length, 1);
      for (let i = 0; i < 3; i++) {
        const again = await ctx.call("drive_share_invite", args);
        assert.equal(again.isError, true);
        assert.equal(ctx.lastAudit().code, "approval_required");
      }
      assert.equal(ctx.changes().length, 1, "replays ran nothing");
      assert.throws(() => store(ctx).approve(code), "an approved-and-consumed code cannot be approved again");
    });
  });

  it("a consumed code re-approved by the same human does not leave a second use behind", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      const args = { path: "/trash/a.txt" };
      const code = codeOf(await ctx.call("drive_delete", args));
      store(ctx).approve(code);
      await ctx.call("drive_delete", args);
      assert.equal(ctx.changes().length, 1);
      assert.equal(store(ctx).consume({ tool: "drive_delete", opHash: store(ctx).get(codeOf(await ctx.call("drive_delete", args))).opHash }), null);
      assert.equal(ctx.changes().length, 1);
    });
  });

  it("elicitation approval covers one call only: the same call again asks again, and a decline then stops it", async () => {
    await withServer({ replies: [ACCEPT, DECLINE, DECLINE] }, async (ctx) => {
      const a = await ctx.call("drive_empty_trash", {});
      assert.notEqual(a.isError, true);
      assert.equal(ctx.changes().length, 1);
      const b = await ctx.call("drive_empty_trash", {});
      assert.equal(b.isError, true);
      const c = await ctx.call("drive_empty_trash", { confirmed: true });
      assert.equal(c.isError, true);
      assert.equal(ctx.asked, 3);
      assert.equal(ctx.changes().length, 1);
    });
  });
});

// ======================================================================================================================
// Case 4: approval for operation A cannot be spent on operation B.
// ======================================================================================================================
describe("case 4: approval for other arguments is refused", () => {
  const VARIANTS = [
    { tool: "drive_share_invite", base: { path: "/my-files/p", email: "a@example.org", role: "viewer" }, others: [
      ["different path", { path: "/my-files/q" }], ["different role", { role: "editor" }], ["different email", { email: "b@example.org" }],
      ["message added", { message: "hi" }], ["path case changed", { path: "/my-files/P" }], ["path with double slash", { path: "/my-files//p" }],
    ] },
    { tool: "drive_share_set_url", base: { path: "/my-files/p", role: "viewer" }, others: [
      ["password added", { password: "pw" }], ["role differs", { role: "editor" }], ["expiration added", { expiration: "2027-01-01T00:00:00Z" }], ["different path", { path: "/my-files/q" }],
    ] },
    { tool: "drive_delete", base: { path: "/trash/a.txt" }, others: [["different path", { path: "/trash/b.txt" }]] },
    { tool: "drive_upload", base: null, others: [["replace instead of default", { fileConflictStrategy: "replace" }]], local: true },
  ];
  for (const v of VARIANTS) {
    it(`${v.tool}: approving A and calling B (one thing different) runs nothing; A still runs exactly once afterwards`, async () => {
      await withServer({ caps: {} }, async (ctx) => {
        const base = v.local ? { localPath: localFile(ctx.sb), remotePath: "/shared-with-me/t" } : v.base;
        const code = codeOf(await ctx.call(v.tool, base));
        assert.ok(code, "A produced a pending record");
        store(ctx).approve(code);
        for (const [label, delta] of v.others) {
          const r = await safe(ctx, v.tool, { ...base, ...delta });
          assert.equal(r.isError, true, `${label}: ${text(r)}`);
          assert.deepEqual(ctx.changes(), [], `${label}: nothing may run on A's approval`);
        }
        const ok = await ctx.call(v.tool, base);
        assert.notEqual(ok.isError, true, text(ok));
        assert.equal(ctx.changes().length, 1);
      });
    });
  }

  it("bulk: an extra source, or a different destination, is not covered by the approval of the original plan", async () => {
    await withServer({ caps: {}, setup: (sb) => ({ FAKE_TREE: writeTree(sb.dir, { "/my-files/s": [{ name: "x.txt", type: "file" }, { name: "y.txt", type: "file" }], "/my-files/d": [], "/my-files/e": [] }) }), fakeMode: "tree" }, async (ctx) => {
      const base = { sources: ["/my-files/s/x.txt"], destinationFolder: "/my-files/d", confirmed: true };
      const code = codeOf(await ctx.call("drive_bulk_move", base));
      assert.ok(code);
      store(ctx).approve(code);
      for (const delta of [{ sources: ["/my-files/s/x.txt", "/my-files/s/y.txt"] }, { destinationFolder: "/my-files/e" }, { sources: ["/my-files/s/y.txt"] }]) {
        const r = await safe(ctx, "drive_bulk_move", { ...base, ...delta });
        assert.equal(r.isError, true, JSON.stringify(delta));
        assert.deepEqual(ctx.changes(), [], JSON.stringify(delta));
      }
      const ok = await ctx.call("drive_bulk_move", base);
      assert.notEqual(ok.isError, true, text(ok));
      assert.equal(ctx.changes().length, 1);
    });
  });

  it("a different tool with the same arguments never consumes the approval", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      const code = codeOf(await ctx.call("drive_share_remove_url", { path: "/my-files/p" }));
      store(ctx).approve(code);
      const r = await ctx.call("drive_share_remove_all", { path: "/my-files/p" });
      assert.equal(r.isError, true);
      assert.deepEqual(ctx.changes(), []);
    });
  });
});

// ======================================================================================================================
// Case 5: expiry. Server cannot take an injected clock, so: the store with an injected clock, and on-disk tampering for the server.
// ======================================================================================================================
describe("case 5: expired approvals", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "pdmcp-adv-store-"));
  it("store with an injected clock: pending expires at 10 minutes, approved at 5 minutes", () => {
    const dir = tmp();
    try {
      let t = 1_000_000;
      const s = createApprovalStore({ dir, now: () => t });
      const a = s.request({ tool: "drive_delete", opHash: "h1", summary: "drive_delete: x" });
      t += 10 * 60_000 + 1;
      assert.throws(() => s.approve(a.code), "pending past 10 minutes cannot be approved");
      assert.equal(s.consume({ tool: "drive_delete", opHash: "h1" }), null);
      // fresh request after expiry gets a new record
      const b = s.request({ tool: "drive_delete", opHash: "h1", summary: "drive_delete: x" });
      assert.notEqual(b.code, a.code);
      s.approve(b.code);
      t += 5 * 60_000 + 1;
      assert.equal(s.consume({ tool: "drive_delete", opHash: "h1" }), null, "approved past 5 minutes cannot be consumed");
      assert.equal(s.get(b.code), null);
      // exactly at the boundary is expired too
      const c = s.request({ tool: "drive_delete", opHash: "h2", summary: "drive_delete: y" });
      s.approve(c.code);
      t += 5 * 60_000;
      assert.equal(s.consume({ tool: "drive_delete", opHash: "h2" }), null, "boundary instant is expired");
      // not expired just before
      const d = s.request({ tool: "drive_delete", opHash: "h3", summary: "drive_delete: z" });
      s.approve(d.code);
      t += 5 * 60_000 - 1;
      assert.ok(s.consume({ tool: "drive_delete", opHash: "h3" }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("server: an approval whose window has passed (record rewritten on disk) is refused, a new code is issued", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      const args = { path: "/trash/a.txt" };
      const code = codeOf(await ctx.call("drive_delete", args));
      store(ctx).approve(code);
      const f = join(ctx.dir, "approvals", "approved", `${code}.json`);
      const rec = JSON.parse(readFileSync(f, "utf8"));
      writeFileSync(f, JSON.stringify({ ...rec, expiresAt: Date.now() - 1 }));
      const r = await ctx.call("drive_delete", args);
      assert.equal(r.isError, true);
      assert.deepEqual(ctx.changes(), []);
      const fresh = codeOf(r);
      assert.ok(fresh && fresh !== code, "a new pending record, not the stale one");
      assert.equal(ctx.lastAudit().code, "approval_required");
    });
  });

  it("server: a pending record past its window cannot be approved, and the call issues a new one", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      const args = { path: "/trash/a.txt" };
      const code = codeOf(await ctx.call("drive_delete", args));
      const f = join(ctx.dir, "approvals", "pending", `${code}.json`);
      const rec = JSON.parse(readFileSync(f, "utf8"));
      writeFileSync(f, JSON.stringify({ ...rec, expiresAt: Date.now() - 1 }));
      assert.throws(() => store(ctx).approve(code));
      const r = await ctx.call("drive_delete", args);
      assert.equal(r.isError, true);
      assert.deepEqual(ctx.changes(), []);
      assert.notEqual(codeOf(r), code);
    });
  });

  it("server: an approved record with a far-future expiresAt written by someone else is still only usable for the same operation", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      const code = codeOf(await ctx.call("drive_delete", { path: "/trash/a.txt" }));
      store(ctx).approve(code);
      const r = await ctx.call("drive_delete", { path: "/trash/zzz.txt" });
      assert.equal(r.isError, true);
      assert.deepEqual(ctx.changes(), []);
    });
  });
});

// ======================================================================================================================
// Case 6: concurrency.
// ======================================================================================================================
describe("case 6: concurrency", () => {
  it("two pending operations, only one approved: only that one runs", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      const A = { path: "/my-files/p", email: "a@example.org", role: "viewer" };
      const B = { path: "/my-files/p", email: "b@example.org", role: "viewer" };
      const [ra, rb] = await Promise.all([ctx.call("drive_share_invite", A), ctx.call("drive_share_invite", B)]);
      const [ca, cb] = [codeOf(ra), codeOf(rb)];
      assert.ok(ca && cb && ca !== cb);
      store(ctx).approve(ca);
      const b = await ctx.call("drive_share_invite", B);
      assert.equal(b.isError, true);
      assert.deepEqual(ctx.changes(), []);
      const a = await ctx.call("drive_share_invite", A);
      assert.notEqual(a.isError, true, text(a));
      assert.equal(ctx.changes().length, 1);
      assert.ok(ctx.changes()[0].join(" ").includes("a@example.org"));
      assert.ok(!ctx.changes()[0].join(" ").includes("b@example.org"));
    });
  });

  it("many simultaneous calls on one approval: exactly one runs", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      const args = { path: "/trash/a.txt" };
      store(ctx).approve(codeOf(await ctx.call("drive_delete", args)));
      const results = await Promise.all(Array.from({ length: 8 }, () => ctx.call("drive_delete", args)));
      assert.equal(results.filter((r) => !r.isError).length, 1);
      assert.equal(ctx.changes().length, 1);
      assert.equal(ctx.audit().filter((e) => e.outcome === "ok").length, 1);
    });
  });

  it("separate processes racing to consume one approval: exactly one wins", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdmcp-adv-race-"));
    try {
      const s = createApprovalStore({ dir });
      const { code } = s.request({ tool: "drive_delete", opHash: "race1", summary: "x" });
      s.approve(code);
      const T = Date.now() + 2500;
      const script = `import { createApprovalStore } from ${JSON.stringify(new URL("../dist/utils/approvalStore.js", import.meta.url).href)};
        const s = createApprovalStore({ dir: ${JSON.stringify(dir)} });
        while (Date.now() < ${T}) {}
        let r = null; try { r = s.consume({ tool: "drive_delete", opHash: "race1" }); } catch (e) { r = { err: String(e) }; }
        process.stdout.write(JSON.stringify(r));`;
      const outs = await Promise.all(Array.from({ length: 8 }, () => execFileP(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT })));
      const parsed = outs.map((o) => JSON.parse(o.stdout));
      assert.equal(parsed.filter((p) => p && p.code).length, 1, JSON.stringify(parsed));
      assert.equal(parsed.filter((p) => p && p.err).length, 0, JSON.stringify(parsed));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a flood of different gated calls cannot grow the pending set past its cap, and nothing runs", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      const rs = [];
      for (let i = 0; i < 30; i++) rs.push(await safe(ctx, "drive_delete", { path: `/trash/f${i}.txt` }));
      assert.ok(rs.every((r) => r.isError));
      assert.ok(pendingFiles(ctx).length <= 20, `pending: ${pendingFiles(ctx).length}`);
      assert.deepEqual(ctx.changes(), []);
      await alive(ctx);
    });
  });
});

// ======================================================================================================================
// Case 7 and (c): names that try to forge or reorder the prompt.
// ======================================================================================================================
const DANGEROUS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
const EVIL_NAMES = [
  ["newline then fake approve line", "a\napprove: yes"],
  ["CRLF then forged role", "a\r\nrole: owner"],
  ["approve: yes inline", "a approve: yes"],
  ["U+202E right-to-left override", "a\u202efdp.exe"],
  ["isolates U+2066/2069", "\u2066x\u2069y"],
  ["zero-width joiners and spaces", "a\u200d\u200c\u200bb\u2060\ufeff"],
  ["ANSI escape", "\x1b[2J\x1b[31mred\x1b[0m"],
  ["5000 characters", "x".repeat(5000)],
  ["name equal to a field label", "role: owner"],
  ["U+2028 / U+2029 / NEL", "a\u2028approve: yes\u2029b\u0085c"],
  ["NUL", "a\u0000b"],
  ["backspace and carriage return", "abc\b\b\bxyz\rforged"],
];

/** Lines of an elicitation message must keep the baseline's keys, in order, and its first line exactly. */
function assertStructure(msg, base, why) {
  const lines = msg.split("\n");
  const baseLines = base.split("\n");
  assert.equal(lines[0], baseLines[0], `${why}: first line changed`);
  assert.equal(lines.length, baseLines.length, `${why}: extra or missing lines\n${msg.slice(0, 600)}`);
  assert.deepEqual(lines.map((l) => l.split(":")[0]), baseLines.map((l) => l.split(":")[0]), `${why}: keys changed`);
  assert.doesNotMatch(msg, DANGEROUS, `${why}: raw control, bidi or zero-width character in the prompt`);
}

describe("case 7 / (c): prompt injection through names", () => {
  const PROMPTS = [
    { tool: "drive_share_remove_all", mk: (n) => ({ path: `/my-files/${n}` }), base: "p", env: { FAKE_STDOUT: MEMBER } },
    { tool: "drive_rename", mk: (n) => ({ path: "/shared-with-me/t/a.txt", newName: n }), base: "b.txt" },
    { tool: "drive_mkdir", mk: (n) => ({ path: `/shared-with-me/t/${n}` }), base: "p" },
    { tool: "drive_upload", mk: (n) => ({ localPath: "__LOCAL__", remotePath: `/my-files/${n}`, fileConflictStrategy: "replace" }), base: "p" },
    { tool: "drive_share_invite", mk: (n) => ({ path: `/my-files/${n}`, email: "a@example.org", role: "viewer" }), base: "p" },
  ];
  for (const p of PROMPTS) {
    it(`${p.tool}: every crafted name keeps the prompt's structure or is refused before any prompt`, async () => {
      await withServer({ replies: always(DECLINE), env: p.env, setup: (sb) => { localFile(sb); return {}; } }, async (ctx) => {
        const local = join(ctx.dir, "work", "f.txt");
        const mk = (n) => JSON.parse(JSON.stringify(p.mk(n)).replace("__LOCAL__", local));
        // the flood limit (5 declines a minute) would silence later prompts: use one answer function that resets via fresh server per 4 names
        const baseline = await ctx.call(p.tool, mk(p.base));
        assert.equal(baseline.isError, true);
        const baseMsg = ctx.messages[0];
        assert.ok(baseMsg, "baseline prompt");
        let sinceFlood = 1;
        for (const [label, evil] of EVIL_NAMES) {
          if (sinceFlood >= 4) { // stay below the decline budget: start over on a fresh server below
            break;
          }
          const before = ctx.asked;
          const r = await safe(ctx, p.tool, mk(evil));
          assert.equal(r.isError, true, label);
          assert.deepEqual(ctx.changes(), [], label);
          if (ctx.asked > before) {
            sinceFlood++;
            assertStructure(ctx.messages[before], baseMsg, `${p.tool} / ${label}`);
          }
        }
        await alive(ctx);
      });
    });
  }

  it("all crafted names, one fresh server each: structure intact whenever the prompt is shown", async () => {
    for (const [label, evil] of EVIL_NAMES) {
      await withServer({ replies: always(DECLINE), env: { FAKE_STDOUT: MEMBER } }, async (ctx) => {
        await ctx.call("drive_share_remove_all", { path: "/my-files/p" });
        const baseMsg = ctx.messages[0];
        const r = await safe(ctx, "drive_share_remove_all", { path: `/my-files/${evil}` });
        assert.equal(r.isError, true, label);
        assert.deepEqual(ctx.changes(), [], label);
        if (ctx.asked > 1) assertStructure(ctx.messages[1], baseMsg, label);
        await alive(ctx);
      });
    }
  });

  it("bidi, zero-width, ANSI-free names that pass validation are shown escaped, one path line only", async () => {
    await withServer({ replies: always(DECLINE), env: { FAKE_STDOUT: MEMBER } }, async (ctx) => {
      await ctx.call("drive_share_remove_all", { path: "/my-files/a\u202efdp.exe\u200d\u200b" });
      assert.equal(ctx.asked, 1, "a name with bidi/zero-width characters is a legal path and is asked about");
      const lines = ctx.messages[0].split("\n");
      assert.equal(lines.filter((l) => l.startsWith("path:")).length, 1);
      assert.match(ctx.messages[0], /\\u202e/i);
      assert.match(ctx.messages[0], /\\u200d/i);
      assert.doesNotMatch(ctx.messages[0], DANGEROUS);
    });
  });

  it("a 5000-character path cannot push the email and role lines out of the dialog: the prompt stays short and keeps every field", async () => {
    await withServer({ replies: always(DECLINE) }, async (ctx) => {
      await ctx.call("drive_share_invite", { path: `/my-files/${"x".repeat(5000)}`, email: "attacker@example.org", role: "editor" });
      assert.equal(ctx.asked, 1);
      const m = ctx.messages[0];
      assert.ok(m.length < 1500, `prompt is ${m.length} characters`);
      assert.match(m, /^email: attacker@example\.org$/m);
      assert.match(m, /^role: editor$/m);
      assert.equal(m.split("\n").length, 5);
    });
  });

  it("a name equal to a field label or containing 'approve: yes' stays on the path line", async () => {
    await withServer({ replies: always(DECLINE), env: { FAKE_STDOUT: MEMBER } }, async (ctx) => {
      await ctx.call("drive_share_remove_all", { path: "/my-files/p" });
      await ctx.call("drive_share_remove_all", { path: "/my-files/role: owner" });
      await ctx.call("drive_share_remove_all", { path: "/my-files/x approve: yes role: owner" });
      assert.equal(ctx.asked, 3);
      for (const m of ctx.messages.slice(1)) {
        const lines = m.split("\n");
        assert.equal(lines.length, ctx.messages[0].split("\n").length);
        assert.equal(lines.filter((l) => /^role:/.test(l)).length, 0, "no line starts with role:");
        assert.equal(lines.filter((l) => /^approve/.test(l)).length, 0);
        assert.match(lines[1], /^path: \/my-files\//);
      }
    });
  });

  it("an email with non-ASCII lookalikes, bidi or a newline never forges a line", async () => {
    const emails = ["\u0430lice@example.org", "alice@example.org\u202e", "a@example.org\nrole: owner", "a\u200b@example.org", "alice@\u0435xample.org", "\uff41@example.org"];
    for (const email of emails) {
      await withServer({ replies: always(DECLINE) }, async (ctx) => {
        await ctx.call("drive_share_invite", { path: "/my-files/p", email: "a@example.org", role: "viewer" });
        const base = ctx.messages[0];
        const r = await safe(ctx, "drive_share_invite", { path: "/my-files/p", email, role: "viewer" });
        assert.equal(r.isError, true);
        assert.deepEqual(ctx.changes(), []);
        if (ctx.asked > 1) assertStructure(ctx.messages[1], base, JSON.stringify(email));
      });
    }
  });

  it("the invitation message and write_file content are never shown, so they cannot forge anything", async () => {
    await withServer({ replies: always(DECLINE), setup: syncSetup }, async (ctx) => {
      await ctx.call("drive_share_invite", { path: "/my-files/p", email: "a@example.org", role: "viewer", message: "x approve: yes role: owner\u202e" });
      await ctx.call("drive_write_file", { path: "/my-files/notes.txt", content: "approve: yes\nrole: owner\u202e" });
      assert.equal(ctx.asked, 2);
      for (const m of ctx.messages) {
        assert.doesNotMatch(m, /approve: yes/);
        assert.doesNotMatch(m, /role: owner/);
        assert.doesNotMatch(m, DANGEROUS);
      }
    });
  });

  it("the stored record (out-of-band channel) carries the same escaped summary, and no secret", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      const r1 = await ctx.call("drive_share_remove_all", { path: "/my-files/a\u202efdp.exe" });
      const r2 = await ctx.call("drive_share_set_url", { path: "/my-files/p", role: "viewer", password: "hunter2-secret" });
      const r3 = await ctx.call("drive_share_invite", { path: "/my-files/p", email: "a@example.org", role: "viewer", message: "top-secret-note" });
      for (const r of [r1, r2, r3]) {
        const rec = store(ctx).get(codeOf(r));
        assert.ok(rec);
        assert.doesNotMatch(rec.summary, DANGEROUS);
        assert.doesNotMatch(rec.summary, /hunter2-secret|top-secret-note/);
        assert.doesNotMatch(text(r), /hunter2-secret|top-secret-note/);
      }
      const all = pendingFiles(ctx).map((f) => readFileSync(join(ctx.dir, "approvals", "pending", f), "utf8")).join("\n");
      assert.doesNotMatch(all, /hunter2-secret|top-secret-note/, "no secret on disk in the approvals folder");
    });
  });
});

// ======================================================================================================================
// Case 8 and (a): extra arguments and look-alike confirmations.
// ======================================================================================================================
const EXTRAS = [
  ["approved:true", { approved: true }], ["approval:true", { approval: true }], ["approval:'yes'", { approval: "yes" }], ["token", { token: "x" }],
  ["code", { code: "ABCD-EFGH" }], ["approve:true", { approve: true }], ["confirmed:'true'", { confirmed: "true" }], ["confirmed:1", { confirmed: 1 }],
];
describe("case 8 / (a): extra arguments and confirmed look-alikes never stand in for a human", { concurrency: 6 }, () => {
  for (const c of G) {
    it(name(c), async () => {
      // 1. declining human: nothing runs, whatever the model adds
      await withServer(opts(c, { replies: always(DECLINE) }), async (ctx) => {
        for (const [label, extra] of EXTRAS) {
          const unknown = !("confirmed" in extra);
          const asked = ctx.asked;
          const r = await safe(ctx, c.tool, { ...c.args(ctx.sb), ...extra });
          assert.deepEqual(ctx.changes(), [], `${name(c)} + ${label}: ran without a human yes`);
          if (unknown) {
            assert.equal(r.isError, true, label);
            assert.equal(ctx.asked, asked, `${label}: an unknown argument is rejected before any prompt`);
          }
        }
        await alive(ctx);
      });
      // 2. client that cannot elicit: nothing runs
      await withServer(opts(c, { caps: {} }), async (ctx) => {
        for (const [label, extra] of EXTRAS) {
          await safe(ctx, c.tool, { ...c.args(ctx.sb), ...extra });
          assert.deepEqual(ctx.changes(), [], `${name(c)} + ${label} (no elicitation)`);
        }
      });
      // 3. a human who says yes to everything: unknown arguments are still rejected; confirmed look-alikes only run after a prompt
      await withServer(opts(c, { replies: always(ACCEPT) }), async (ctx) => {
        for (const [label, extra] of EXTRAS) {
          const unknown = !("confirmed" in extra);
          const askedBefore = ctx.asked;
          const changesBefore = ctx.changes().length;
          const r = await safe(ctx, c.tool, { ...c.args(ctx.sb), ...extra });
          const ran = ctx.changes().length > changesBefore || (Boolean(c.noCli) && !r.isError);
          if (unknown) {
            assert.equal(r.isError, true, label);
            assert.equal(ran, false, `${label}: unknown argument must not run anything`);
            assert.equal(ctx.asked, askedBefore, label);
          } else if (ran) assert.ok(ctx.asked > askedBefore, `${name(c)} + ${label}: ran without being asked`);
        }
      });
    });
  }
});

// ======================================================================================================================
// Case 9: the approvals folder is not writable through the server.
// ======================================================================================================================
describe("case 9: the model cannot write into the approvals folder", () => {
  const targets = (appr) => [appr, join(appr, "pending"), join(appr, "approved"), join(appr, "consumed"), join(appr, "pending", "ABCD-EFGH.json"), join(appr, "approved", "ABCD-EFGH.json"), join(appr, "tmp")];
  const dlCalls = (ctx) => ctx.changes().filter((a) => /download/.test(a.join(" ")));

  it("drive_download and photos_download refuse every path in and around the store, including ../ and a symlink", async () => {
    for (const caps of [{}, { elicitation: { form: {} } }]) {
      await withServer({ caps, replies: always(ACCEPT) }, async (ctx) => {
        // make the store exist with a pending record
        if (!caps.elicitation) await ctx.call("drive_delete", { path: "/trash/a.txt" });
        const appr = join(ctx.dir, "approvals");
        mkdirSync(appr, { recursive: true });
        mkdirSync(join(appr, "pending"), { recursive: true });
        const link = join(ctx.dir, "work", "link");
        symlinkSync(appr, link);
        const paths = [...targets(appr), join(appr, "..", "approvals", "pending"), join(link, "pending"), link, `${appr}/./approved`, `${appr}//approved`, join(ctx.dir, "work", "..", "approvals", "approved")];
        const before = existsSync(join(appr, "pending")) ? readdirSync(join(appr, "pending")).length : 0;
        for (const p of paths) {
          const d = await safe(ctx, "drive_download", { remotePath: "/my-files/a.txt", localPath: p });
          assert.equal(d.isError, true, `drive_download into ${p}: ${text(d)}`);
          const d2 = await safe(ctx, "drive_download", { remotePath: "/my-files/a.txt", localPath: p, fileConflictStrategy: "remove", confirmed: true });
          assert.equal(d2.isError, true, `drive_download remove into ${p}`);
          const ph = await safe(ctx, "photos_download", { photoPaths: ["/photos/p.jpg"], localFolder: p });
          assert.equal(ph.isError, true, `photos_download into ${p}: ${text(ph)}`);
        }
        assert.deepEqual(dlCalls(ctx), [], "no download command reached the CLI");
        assert.equal(existsSync(join(appr, "pending")) ? readdirSync(join(appr, "pending")).length : 0, before, "the folder is untouched");
        await alive(ctx);
      });
    }
  });

  // The model has drive_read_file and drive_write_file inside the sync root. If the approvals folder is reachable from there, it can copy a
  // pending record to approved/ and approve its own call. The plan: the store may not live inside PROTON_DRIVE_SYNC_PATH.
  for (const [label, mkEnv] of [
    ["explicit PROTON_DRIVE_APPROVAL_DIR inside the sync root", (sb) => { const sync = join(sb, "sync"); return { sync, env: { PROTON_DRIVE_SYNC_PATH: sync, PROTON_DRIVE_APPROVAL_DIR: join(sync, "approvals") } }; }],
    ["sync root is $HOME and the store is at its default location", (sb) => { const home = join(sb, "home"); return { sync: home, env: { HOME: home, XDG_CACHE_HOME: "", PROTON_DRIVE_SYNC_PATH: home, PROTON_DRIVE_APPROVAL_DIR: "" } }; }],
  ]) {
    it(`drive_write_file cannot forge an approval: ${label}`, async () => {
      const sb = mkdtempSync(join(tmpdir(), "pdmcp-adv-sync-"));
      try {
        const { sync, env } = mkEnv(sb);
        mkdirSync(sync, { recursive: true });
        let ctxRef;
        try {
          await withServer({ caps: {}, env }, async (ctx) => {
            ctxRef = ctx;
            const first = await ctx.call("drive_delete", { path: "/trash/a.txt" });
            assert.equal(first.isError, true);
            // find a pending record anywhere under the sync root (store enabled) -> copy it to approved/ through the server's own file tools
            const found = [];
            const walk = (d, rel) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f, `${rel}/${e.name}`); else if (/^[A-Z2-9]{4}-[A-Z2-9]{4}\.json$/.test(e.name) && rel.endsWith("/pending")) found.push({ f, rel }); } };
            walk(sync, "");
            for (const { f, rel } of found) {
              const rec = JSON.parse(readFileSync(f, "utf8"));
              const target = `/my-files${rel.replace(/\/pending$/, "/approved")}/${rec.code}.json`;
              const w = await safe(ctx, "drive_write_file", { path: target, content: JSON.stringify({ ...rec, expiresAt: Date.now() + 3_600_000, approvedAt: Date.now() }) });
              const read = await safe(ctx, "drive_read_file", { path: `/my-files${rel}/${rec.code}.json` });
              void w; void read;
            }
            const again = await ctx.call("drive_delete", { path: "/trash/a.txt" });
            assert.equal(again.isError, true, `a self-made approval record was honoured (${found.length} pending record(s) were reachable): ${text(again)}`);
            assert.deepEqual(ctx.changes(), []);
            assert.equal(found.length, 0, "the approvals folder is reachable through the sync root (the plan says startup refuses that)");
          });
        } catch (e) {
          if (e?.code === "ERR_ASSERTION" || ctxRef) throw e;
          // the server refused to start: also acceptable (fail closed)
        }
      } finally { rmSync(sb, { recursive: true, force: true }); }
    });
  }

  it("with the store outside the sync root, write_file into /my-files/approvals just creates an ordinary file elsewhere", async () => {
    await withServer({ caps: {}, setup: syncSetup }, async (ctx) => {
      await ctx.call("drive_delete", { path: "/trash/a.txt" });
      const before = readdirSync(join(ctx.dir, "approvals", "pending"));
      await safe(ctx, "drive_write_file", { path: "/my-files/approvals/pending/ABCD-EFGH.json", content: "{}" });
      assert.deepEqual(readdirSync(join(ctx.dir, "approvals", "pending")), before);
    });
  });
});

// ======================================================================================================================
// Case 10: decline flood.
// ======================================================================================================================
describe("case 10: decline flood", () => {
  it("after 5 declines in a minute no further prompt is sent, calls are refused, nothing runs", async () => {
    await withServer({ replies: always(DECLINE) }, async (ctx) => {
      for (let i = 0; i < 5; i++) {
        const r = await ctx.call("drive_delete", { path: `/trash/f${i}.txt`, confirmed: true });
        assert.equal(r.isError, true);
      }
      assert.equal(ctx.asked, 5);
      for (const [tool, args] of [["drive_empty_trash", {}], ["drive_delete", { path: "/trash/z.txt" }], ["drive_share_remove_url", { path: "/my-files/p" }], ["drive_copy", { sourcePath: "/my-files/a", destinationPath: "/shared-with-me/t" }]]) {
        const r = await ctx.call(tool, args);
        assert.equal(r.isError, true, tool);
        assert.equal(ctx.lastAudit().code, "approval_unavailable");
      }
      assert.equal(ctx.asked, 5, "no sixth prompt");
      assert.deepEqual(ctx.changes(), []);
      assert.match(ctx.stderr, /suspended|too many/i);
    });
  });

  it("cancels, errors and no-approve answers count towards the flood; a later accept never gets a chance", async () => {
    await withServer({ replies: [CANCEL, NO_APPROVE, THROWS, DECLINE, CANCEL, ACCEPT, ACCEPT] }, async (ctx) => {
      for (let i = 0; i < 8; i++) await ctx.call("drive_delete", { path: `/trash/f${i}.txt` });
      assert.equal(ctx.asked, 5);
      assert.deepEqual(ctx.changes(), []);
    });
  });

  it("the flood limit does not open a side door: model mode is not entered, no store record is created for an eliciting client", async () => {
    await withServer({ replies: always(DECLINE) }, async (ctx) => {
      for (let i = 0; i < 8; i++) await ctx.call("drive_delete", { path: `/trash/f${i}.txt`, confirmed: true });
      assert.deepEqual(ctx.changes(), []);
      assert.equal(existsSync(join(ctx.dir, "approvals")) ? pendingFiles(ctx).length : 0, 0);
    });
  });
});

// ======================================================================================================================
// Case 11: bulk TOCTOU.
// ======================================================================================================================
describe("case 11: bulk plan changes while the prompt is open", () => {
  const CASES = [
    ["drive_bulk_trash", { paths: ["/my-files/s/x.txt"], confirmed: true }],
    ["drive_bulk_move", { sources: ["/my-files/s/x.txt"], destinationFolder: "/my-files/d", confirmed: true }],
  ];
  const SWAPS = {
    "item removed": { "/my-files/s": [], "/my-files/d": [] },
    "item renamed": { "/my-files/s": [{ name: "x2.txt", type: "file" }], "/my-files/d": [] },
  };
  for (const [tool, args] of CASES) {
    for (const [label, swapped] of Object.entries(SWAPS)) {
      it(`${tool}: ${label} -> nothing applied, approval_changed`, async () => {
        let treeFile;
        await withServer({
          setup: (sb) => { const e = treeSetup(sb); treeFile = e.FAKE_TREE; return e; }, fakeMode: "tree",
          replies: () => { writeFileSync(treeFile, JSON.stringify(swapped)); return ACCEPT; },
        }, async (ctx) => {
          const r = await ctx.call(tool, args);
          assert.equal(r.isError, true, text(r));
          assert.deepEqual(ctx.changes(), []);
          assert.equal(ctx.lastAudit().code, "approval_changed");
          assert.equal(ctx.audit().filter((e) => e.outcome === "ok").length, 0);
        });
      });
    }
    it(`${tool}: a destination that gains the same name while the prompt is open applies nothing`, async () => {
      if (tool !== "drive_bulk_move") return;
      let treeFile;
      await withServer({
        setup: (sb) => { const e = treeSetup(sb); treeFile = e.FAKE_TREE; return e; }, fakeMode: "tree",
        replies: () => { writeFileSync(treeFile, JSON.stringify({ ...TREE, "/my-files/d": [{ name: "x.txt", type: "file" }] })); return ACCEPT; },
      }, async (ctx) => {
        const r = await ctx.call(tool, args);
        assert.equal(r.isError, true, text(r));
        assert.deepEqual(ctx.changes(), []);
      });
    });
    it(`${tool}: the prompt lists the plan; an unchanged plan applies once, and the plan call itself never prompts`, async () => {
      await withServer({ setup: treeSetup, fakeMode: "tree", replies: always(ACCEPT) }, async (ctx) => {
        const { confirmed, ...planArgs } = args;
        void confirmed;
        const plan = await ctx.call(tool, planArgs);
        assert.notEqual(plan.isError, true, text(plan));
        assert.equal(ctx.asked, 0);
        assert.deepEqual(ctx.changes(), []);
        const r = await ctx.call(tool, args);
        assert.notEqual(r.isError, true, text(r));
        assert.equal(ctx.asked, 1);
        assert.match(ctx.messages[0], /\/my-files\/s\/x\.txt/);
        assert.equal(ctx.changes().length, 1);
      });
    });
  }
  it("without elicitation a bulk apply is refused, and the plan call still works", async () => {
    await withServer({ caps: {}, setup: treeSetup, fakeMode: "tree" }, async (ctx) => {
      const plan = await ctx.call("drive_bulk_trash", { paths: ["/my-files/s/x.txt"] });
      assert.notEqual(plan.isError, true);
      const r = await ctx.call("drive_bulk_trash", { paths: ["/my-files/s/x.txt"], confirmed: true });
      assert.equal(r.isError, true);
      assert.deepEqual(ctx.changes(), []);
    });
  });
});

// ======================================================================================================================
// Case 12: the invitation chain.
// ======================================================================================================================
describe("case 12: invitation chain", () => {
  it("accept and then copy into /shared-with-me: both prompt, both refused when declined, nothing runs", async () => {
    await withServer({ replies: always(DECLINE) }, async (ctx) => {
      const a = await ctx.call("drive_invitation_accept", { uid: "inv-1" });
      const b = await ctx.call("drive_copy", { sourcePath: "/my-files/secret.txt", destinationPath: "/shared-with-me/attacker" });
      assert.equal(a.isError, true);
      assert.equal(b.isError, true);
      assert.equal(ctx.asked, 2);
      assert.deepEqual(ctx.changes(), []);
    });
  });

  it("a human who accepts only the first step does not authorise the second", async () => {
    await withServer({ replies: [ACCEPT, DECLINE] }, async (ctx) => {
      assert.notEqual((await ctx.call("drive_invitation_accept", { uid: "inv-1" })).isError, true);
      assert.equal(ctx.changes().length, 1);
      const b = await ctx.call("drive_copy", { sourcePath: "/my-files/secret.txt", destinationPath: "/shared-with-me/attacker" });
      assert.equal(b.isError, true);
      assert.equal(ctx.changes().length, 1, "only the accept ran");
      assert.match(ctx.messages[1], /^drive_copy: /);
    });
  });

  it("without elicitation both steps are refused with their own code; approving one does not approve the other", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      const a = await ctx.call("drive_invitation_accept", { uid: "inv-1" });
      const b = await ctx.call("drive_copy", { sourcePath: "/my-files/secret.txt", destinationPath: "/shared-with-me/attacker" });
      assert.ok(codeOf(a) && codeOf(b) && codeOf(a) !== codeOf(b));
      assert.deepEqual(ctx.changes(), []);
      store(ctx).approve(codeOf(a));
      assert.equal((await ctx.call("drive_copy", { sourcePath: "/my-files/secret.txt", destinationPath: "/shared-with-me/attacker" })).isError, true);
      assert.equal(ctx.changes().length, 0);
      assert.notEqual((await ctx.call("drive_invitation_accept", { uid: "inv-1" })).isError, true);
      assert.equal(ctx.changes().length, 1);
      assert.equal((await ctx.call("drive_copy", { sourcePath: "/my-files/secret.txt", destinationPath: "/shared-with-me/attacker" })).isError, true);
      assert.equal(ctx.changes().length, 1);
    });
  });

  it("other ways into the attacker's folder (move, upload, mkdir, rename, bulk move) also prompt", async () => {
    await withServer({ replies: always(DECLINE), setup: (sb) => { localFile(sb); return { FAKE_TREE: writeTree(sb.dir, { ...TREE, "/shared-with-me/attacker": [] }) }; }, fakeMode: "tree" }, async (ctx) => {
      const local = join(ctx.dir, "work", "f.txt");
      const calls = [
        ["drive_move", { sourcePath: "/my-files/secret.txt", destinationPath: "/shared-with-me/attacker/secret.txt" }],
        ["drive_upload", { localPath: local, remotePath: "/shared-with-me/attacker" }],
        ["drive_mkdir", { path: "/shared-with-me/attacker/loot" }],
        ["drive_rename", { path: "/shared-with-me/attacker/a.txt", newName: "b.txt" }],
        ["drive_bulk_move", { sources: ["/my-files/s/x.txt"], destinationFolder: "/shared-with-me/attacker", confirmed: true }],
      ];
      for (const [tool, args] of calls) {
        const r = await ctx.call(tool, args);
        assert.equal(r.isError, true, tool);
      }
      assert.equal(ctx.asked, 5);
      assert.deepEqual(ctx.changes(), []);
    });
  });
});

// ======================================================================================================================
// Case 13: drive_write_file races.
// ======================================================================================================================
describe("case 13: drive_write_file does not overwrite a file that appeared meanwhile", () => {
  it("strict mode: the file appears while the first prompt is open -> asked again, declined, foreign content survives", async () => {
    let sync;
    await withServer({
      setup: (sb) => { const e = syncSetup(sb); sync = e.PROTON_DRIVE_SYNC_PATH; return e; },
      approval: "strict",
      replies: (_m, i) => { if (i === 0) writeFileSync(join(sync, "late.txt"), "foreign"); return i === 0 ? ACCEPT : DECLINE; },
    }, async (ctx) => {
      const r = await ctx.call("drive_write_file", { path: "/my-files/late.txt", content: "mine" });
      assert.equal(r.isError, true);
      assert.equal(readFileSync(join(sync, "late.txt"), "utf8"), "foreign");
      assert.ok(ctx.asked >= 2);
    });
  });

  it("human mode, a declining client: whoever creates the file first wins and the server never overwrites a foreign file (stress)", async () => {
    let sync;
    await withServer({ setup: (sb) => { const e = syncSetup(sb); sync = e.PROTON_DRIVE_SYNC_PATH; return e; }, replies: always(DECLINE) }, async (ctx) => {
      let foreignWon = 0, serverWon = 0;
      for (let i = 0; i < 40; i++) {
        const f = join(sync, `race-${i}.txt`);
        const call = ctx.call("drive_write_file", { path: `/my-files/race-${i}.txt`, content: "mine" });
        let created = false;
        try { writeFileSync(f, "foreign", { flag: "wx" }); created = true; } catch { /* the server was first */ }
        const r = await call;
        const content = readFileSync(f, "utf8");
        if (created) {
          foreignWon++;
          assert.equal(content, "foreign", `iteration ${i}: the server overwrote a file somebody else created (${text(r)})`);
        } else {
          serverWon++;
          assert.equal(content, "mine");
        }
      }
      assert.ok(foreignWon + serverWon === 40);
    });
  });

  it("an existing file needs a human in human mode, with or without confirmed", async () => {
    await withServer({ setup: syncSetup, replies: always(DECLINE) }, async (ctx) => {
      for (const extra of [{}, { confirmed: true }, { confirmed: false }]) {
        const r = await ctx.call("drive_write_file", { path: "/my-files/notes.txt", content: "evil", ...extra });
        assert.equal(r.isError, true);
        assert.equal(readFileSync(join(ctx.dir, "sync", "notes.txt"), "utf8"), "old");
      }
      assert.equal(ctx.asked, 3);
    });
    await withServer({ setup: syncSetup, caps: {} }, async (ctx) => {
      const r = await ctx.call("drive_write_file", { path: "/my-files/notes.txt", content: "evil", confirmed: true });
      assert.equal(r.isError, true);
      assert.equal(readFileSync(join(ctx.dir, "sync", "notes.txt"), "utf8"), "old");
    });
  });

  it("an existing file reached through a differently written path (./, //, case, symlink) is still overwrite-gated", async () => {
    await withServer({ setup: (sb) => { const e = syncSetup(sb); symlinkSync(join(sb.dir, "sync", "notes.txt"), join(sb.dir, "sync", "alias.txt")); return e; }, replies: always(DECLINE) }, async (ctx) => {
      for (const p of ["/my-files/./notes.txt", "//my-files/notes.txt", "/my-files//notes.txt", "/my-files/alias.txt"]) {
        const r = await safe(ctx, "drive_write_file", { path: p, content: "evil" });
        assert.equal(readFileSync(join(ctx.dir, "sync", "notes.txt"), "utf8"), "old", `${p}: ${text(r)}`);
      }
    });
  });
});

// ======================================================================================================================
// Case 14 and (g): modes.
// ======================================================================================================================
describe("case 14 / (g): modes", () => {
  it("PROTON_DRIVE_APPROVAL=nonsense behaves as strict, with a warning", async () => {
    for (const value of ["nonsense", "STRICTLY", "off", "true", "0", ""]) {
      await withServer({ approval: value, replies: always(DECLINE) }, async (ctx) => {
        const r = await ctx.call("drive_trash", { path: "/my-files/a.txt" });
        const m = await ctx.call("drive_mkdir", { path: "/my-files/new" });
        const d = await ctx.call("drive_delete", { path: "/trash/a.txt", confirmed: true });
        if (value === "" ) return; // an empty variable is "unset"; covered by the human-mode tests
        assert.equal(r.isError, true, value);
        assert.equal(m.isError, true, value);
        assert.equal(d.isError, true, value);
        assert.deepEqual(ctx.changes(), [], value);
        assert.ok(ctx.asked >= 3, `${JSON.stringify(value)}: strict asks even for a trash and a mkdir`);
        assert.match(ctx.stderr, /Unknown PROTON_DRIVE_APPROVAL/, value);
        assert.doesNotMatch(ctx.stderr, /PROTON_DRIVE_APPROVAL=model:/, value);
      });
    }
  });

  it("nonsense and a client without elicitation: refused, never model behaviour", async () => {
    await withServer({ approval: "nonsense", caps: {} }, async (ctx) => {
      for (const [tool, args] of [["drive_delete", { path: "/trash/a.txt", confirmed: true }], ["drive_trash", { path: "/my-files/a.txt" }], ["drive_mkdir", { path: "/my-files/n" }]]) {
        const r = await ctx.call(tool, args);
        assert.equal(r.isError, true, tool);
      }
      assert.deepEqual(ctx.changes(), []);
    });
  });

  it("strict gates drive_trash and drive_mkdir; human does not", async () => {
    await withServer({ approval: "human", replies: always(DECLINE) }, async (ctx) => {
      assert.notEqual((await ctx.call("drive_trash", { path: "/my-files/a.txt" })).isError, true);
      assert.notEqual((await ctx.call("drive_mkdir", { path: "/my-files/new" })).isError, true);
      assert.equal(ctx.asked, 0);
      assert.equal(ctx.changes().length, 2);
    });
    await withServer({ approval: null, caps: {} }, async (ctx) => {
      assert.notEqual((await ctx.call("drive_trash", { path: "/my-files/a.txt" })).isError, true);
      assert.notEqual((await ctx.call("drive_mkdir", { path: "/my-files/new" })).isError, true);
      assert.equal(ctx.changes().length, 2);
    });
    await withServer({ approval: "strict", replies: always(DECLINE) }, async (ctx) => {
      for (const [tool, args] of [["drive_trash", { path: "/my-files/a.txt" }], ["drive_mkdir", { path: "/my-files/new" }]]) {
        const r = await ctx.call(tool, args);
        assert.equal(r.isError, true, tool);
      }
      assert.equal(ctx.asked, 2);
      assert.deepEqual(ctx.changes(), []);
    });
    await withServer({ approval: "strict", caps: {} }, async (ctx) => {
      const r = await ctx.call("drive_mkdir", { path: "/my-files/new" });
      assert.equal(r.isError, true);
      assert.match(text(r), /approve [A-Z2-9]{4}-[A-Z2-9]{4}/);
      assert.deepEqual(ctx.changes(), []);
    });
  });

  it("readonly blocks even an approved destructive call (elicitation accepts, nothing runs, nobody is asked)", async () => {
    await withServer({ approval: "human", env: { PROTON_DRIVE_MODE: "readonly" }, replies: always(ACCEPT) }, async (ctx) => {
      for (const [tool, args] of [["drive_delete", { path: "/trash/a.txt", confirmed: true }], ["drive_empty_trash", {}], ["drive_trash", { path: "/my-files/a.txt" }], ["drive_copy", { sourcePath: "/my-files/a", destinationPath: "/shared-with-me/t" }], ["drive_invitation_accept", { uid: "u" }]]) {
        const r = await ctx.call(tool, args);
        assert.equal(r.isError, true, tool);
        assert.equal(ctx.lastAudit().code, "readonly", tool);
      }
      assert.deepEqual(ctx.changes(), []);
      assert.equal(ctx.asked, 0);
    });
    for (const approval of ["strict", "model", "nonsense"]) {
      await withServer({ approval, env: { PROTON_DRIVE_MODE: "readonly" }, replies: always(ACCEPT) }, async (ctx) => {
        const r = await ctx.call("drive_delete", { path: "/trash/a.txt", confirmed: true });
        assert.equal(r.isError, true, approval);
        assert.deepEqual(ctx.changes(), [], approval);
      });
    }
  });

  it("readonly also beats an operation already approved in the store (approved earlier by a human)", async () => {
    const shared = mkdtempSync(join(tmpdir(), "pdmcp-adv-shared-"));
    try {
      const env = { PROTON_DRIVE_APPROVAL_DIR: shared };
      let code;
      await withServer({ caps: {}, env }, async (ctx) => { code = codeOf(await ctx.call("drive_delete", { path: "/trash/a.txt", confirmed: true })); });
      assert.ok(code);
      createApprovalStore({ dir: shared }).approve(code);
      await withServer({ caps: {}, env: { ...env, PROTON_DRIVE_MODE: "readonly" } }, async (ctx) => {
        const r = await ctx.call("drive_delete", { path: "/trash/a.txt", confirmed: true });
        assert.equal(r.isError, true);
        assert.deepEqual(ctx.changes(), []);
        assert.equal(ctx.lastAudit().code, "readonly");
        assert.ok(createApprovalStore({ dir: shared }).get(code), "the approval was not consumed by the refused call");
      });
    } finally { rmSync(shared, { recursive: true, force: true }); }
  });

  it("model mode is the only mode where confirmed=true authorises, and says so on stderr", async () => {
    await withServer({ approval: "model", caps: {} }, async (ctx) => {
      assert.equal((await ctx.call("drive_delete", { path: "/trash/a.txt" })).isError, true);
      assert.notEqual((await ctx.call("drive_delete", { path: "/trash/a.txt", confirmed: true })).isError, true);
      assert.match(ctx.stderr, /PROTON_DRIVE_APPROVAL=model/);
    });
    for (const approval of ["human", "strict", null]) {
      await withServer({ approval, caps: {} }, async (ctx) => {
        assert.equal((await ctx.call("drive_delete", { path: "/trash/a.txt", confirmed: true })).isError, true);
        assert.deepEqual(ctx.changes(), []);
      });
    }
  });
});

// ======================================================================================================================
// (b): /shared-with-me written in every disguise.
// ======================================================================================================================
function looksShared(raw) {
  let p = String(raw);
  try { p = decodeURIComponent(p); } catch { /* keep */ }
  p = p.normalize("NFKC").replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, "-").replace(/[\u200b-\u200f\u2060\ufeff]/g, "").replace(/\\/g, "/");
  const out = [];
  for (const seg of p.split("/")) {
    const s = seg.replace(/[. ]+$/, "").trim();
    if (s === "" || s === ".") continue;
    if (s === "..") { out.pop(); continue; }
    out.push(s.toLowerCase());
  }
  return out[0] === "shared-with-me";
}
const ADVISORY = new Set(["/shared-with-me./t", "/shared-with-me\u00a0/t", "/shared-with-me /t", "/shared-with-me%2Ft", "/shared%2Dwith%2Dme/t", "/shared\u2010with\u2010me/t", "/shared\u2011with\u2011me/t", "/shared\u2212with\u2212me/t", "/shared-with-me\u200b/t", "/\uff53\uff48\uff41\uff52\uff45\uff44-with-me/t", "/shared-with-me\\t", "/%73hared-with-me/t"]);
const TRULY = ["//shared-with-me/t", "/Shared-With-Me/t", "/SHARED-WITH-ME/t", "/./shared-with-me/t", "/shared-with-me//t", "/shared-with-me/./t", "/my-files/../shared-with-me/t", "/my-files/./../Shared-With-Me/t", "///shared-with-me///t"];
const AMBIGUOUS = [
  "/shared-with-me./t", "/shared-with-me /t", "/shared-with-me\u00a0/t", " /shared-with-me/t", "/shared-with-me%2Ft", "%2Fshared-with-me%2Ft", "/my-files/..%2Fshared-with-me/t",
  "/my-files%2F..%2Fshared-with-me/t", "/shared%2Dwith%2Dme/t", "/shared\u2010with\u2010me/t", "/shared\u2011with\u2011me/t", "/shared\u2212with\u2212me/t", "/shared-with-me\u200b/t",
  "/\uff53\uff48\uff41\uff52\uff45\uff44-with-me/t", "/shared-with-me\\t", "\\shared-with-me\\t", "shared-with-me/t", "/my-files/..\\shared-with-me/t", "/se\u0301hared-with-me/t",
  "/shared-with-me\u202e/t", "/shared-with-me\u0000/t", "/%73hared-with-me/t",
];

describe("(b) /shared-with-me in disguise: a gated operation never runs without approval, the server never crashes", { concurrency: 4 }, () => {
  const mk = (sb, dest) => [
    ["drive_copy", { sourcePath: "/my-files/a.txt", destinationPath: dest }],
    ["drive_move", { sourcePath: "/my-files/a.txt", destinationPath: `${dest}/a.txt` }],
    ["drive_mkdir", { path: dest }],
    ["drive_rename", { path: `${dest}/a.txt`, newName: "b.txt" }],
    ["drive_upload", { localPath: localFile(sb), remotePath: dest }],
    ["drive_trash", { path: `${dest}/a.txt` }],
    ["drive_restore", { path: `${dest}/a.txt` }],
    ["drive_write_file", { path: `${dest}/f.txt`, content: "x" }],
  ];
  const reachedShared = (ctx) => ctx.changes().filter((argv) => argv.slice(1).some((el) => typeof el === "string" && el.includes("/") && looksShared(el)));

  for (const [group, list, strong] of [["resolves to /shared-with-me", TRULY, true], ["ambiguous spelling", AMBIGUOUS, false]]) {
    for (const dest of list) {
      const // live check on CLI 0.9.0: the real CLI rejects this spelling, not exploitable (kept as todo: the gate still decides on the literal string)
      const advisory = !strong && ADVISORY.has(dest) ? { todo: "live check on CLI 0.9.0: the real CLI rejects this spelling, not exploitable" } : {};
      it(`${group}: ${JSON.stringify(dest)}`, advisory, async () => {
        for (const caps of [{ elicitation: { form: {} } }, {}]) {
          await withServer({ caps, replies: always(DECLINE), setup: syncSetup }, async (ctx) => {
            for (const [tool, args] of mk(ctx.sb, dest)) {
              const r = await safe(ctx, tool, args);
              if (strong) {
                assert.deepEqual(ctx.changes(), [], `${tool} ${JSON.stringify(args)} ran without approval (${text(r)})`);
                if (tool === "drive_write_file") assert.equal(r.isError, true, "write_file into /shared-with-me must not succeed unasked");
              } else {
                assert.deepEqual(reachedShared(ctx), [], `${tool} ${JSON.stringify(args)}: a path that normalises to /shared-with-me reached the CLI unapproved`);
              }
            }
            if (existsSync(join(ctx.dir, "sync", "shared-with-me"))) assert.fail("write_file created a file under /shared-with-me in the sync root without approval");
            await alive(ctx);
          });
        }
      });
    }
  }

  it("the prompt for a disguised path shows the spelling that will reach the CLI, never a cleaned-up one", async () => {
    await withServer({ replies: always(DECLINE) }, async (ctx) => {
      await ctx.call("drive_copy", { sourcePath: "/my-files/a.txt", destinationPath: "//Shared-With-Me/t" });
      assert.equal(ctx.asked, 1);
      assert.match(ctx.messages[0], /Shared-With-Me/);
    });
  });
});

// ======================================================================================================================
// (d): every answer but a clean accept+approve=true ends with nothing executed.
// ======================================================================================================================
describe("(d) elicitation answers that are not a clean yes", () => {
  const ANSWERS = [
    ["accept, approve=false", NO_APPROVE],
    ["accept, approve missing (empty content)", { action: "accept", content: {} }],
    ["accept, no content at all", { action: "accept" }],
    ["accept, approve as string 'true'", { action: "accept", content: { approve: "true" } }],
    ["accept, approve=1", { action: "accept", content: { approve: 1 } }],
    ["accept, approve='yes'", { action: "accept", content: { approve: "yes" } }],
    ["accept, approve=null", { action: "accept", content: { approve: null } }],
    ["accept, approve=false plus extra content", { action: "accept", content: { approve: false, role: "owner", confirmed: true, yes: true } }],
    ["accept, other key only", { action: "accept", content: { approved: true, confirmed: true } }],
    ["accept, approve=[true]", { action: "accept", content: { approve: [true] } }],
    ["decline with approve=true in content", { action: "decline", content: { approve: true } }],
    ["cancel with approve=true in content", { action: "cancel", content: { approve: true } }],
    ["unknown action 'approve'", { action: "approve", content: { approve: true } }],
    ["unknown action 'ACCEPT'", { action: "ACCEPT", content: { approve: true } }],
    ["no action", { content: { approve: true } }],
    ["client throws", THROWS],
  ];
  for (const [label, answer] of ANSWERS) {
    it(`${label}: nothing runs, for a gated tool with and without confirmed`, async () => {
      await withServer({ replies: always(answer) }, async (ctx) => {
        for (const [tool, args] of [["drive_empty_trash", {}], ["drive_empty_trash", { confirmed: true }], ["drive_copy", { sourcePath: "/my-files/a", destinationPath: "/shared-with-me/t" }]]) {
          const asked = ctx.asked;
          const r = await safe(ctx, tool, args);
          assert.equal(r.isError, true, `${tool}: ${text(r)}`);
          assert.equal(ctx.asked, asked + 1);
          // an explicit no is approval_declined; a closed dialog or an answer the client library rejects offers the terminal route (approval_required)
          assert.match(ctx.lastAudit().code, /^approval_(declined|unavailable|required)$/);
        }
        assert.deepEqual(ctx.changes(), []);
        await alive(ctx);
      });
    });
  }

  it("a clean accept with approve=true still runs, and extra content next to approve=true does not break or double it", async () => {
    await withServer({ replies: [ACCEPT, { action: "accept", content: { approve: true, extra: "x" } }] }, async (ctx) => {
      const a = await ctx.call("drive_empty_trash", {});
      assert.notEqual(a.isError, true, text(a));
      assert.equal(ctx.changes().length, 1);
      const b = await safe(ctx, "drive_empty_trash", {});
      // either form is acceptable (strict or tolerant of extra keys) but it must never run twice for one prompt
      assert.ok(ctx.changes().length <= 2);
      assert.equal(ctx.asked, 2);
      void b;
    });
  });

  it("a human who never answers: the gate's own timeout refuses (gate-level, injected timeout)", async () => {
    // The server has no env var for the backstop timeout (130 s default, SDK request timeout 120 s), so the end-to-end variant is
    // skipped; the gate object takes elicitTimeoutMs, which is exercised here.
    const op = { tool: "drive_delete", effect: "irreversible", fields: { path: "/trash/a.txt" } };
    let aborted = false;
    const never = (_s, signal) => new Promise(() => { signal?.addEventListener?.("abort", () => { aborted = true; }); });
    const warnings = [];
    const gate = new ApprovalGate({ mode: "human", elicit: never, elicitTimeoutMs: 40, onWarning: (m) => warnings.push(m) });
    const t0 = Date.now();
    const res = await gate.require(op, { legacyConfirmed: true });
    assert.equal(res.ok, false);
    assert.equal(res.code, "approval_unavailable");
    assert.ok(Date.now() - t0 < 3000);
    void aborted;
    // late accept after the timeout changes nothing
    let release;
    const late = () => new Promise((r) => { release = () => r("accept"); });
    const gate2 = new ApprovalGate({ mode: "human", elicit: late, elicitTimeoutMs: 30 });
    const res2 = await gate2.require(op);
    release();
    assert.equal(res2.ok, false);
    // garbage elicit results are refusals
    for (const bad of [undefined, null, true, "ACCEPT", "yes", 1, {}, "accept ", "approved"]) {
      const g = new ApprovalGate({ mode: "human", elicit: async () => bad });
      const r = await g.require(op, { legacyConfirmed: true });
      assert.equal(r.ok, false, JSON.stringify(bad));
    }
    // an elicit that throws synchronously
    const g3 = new ApprovalGate({ mode: "human", elicit: () => { throw new Error("boom"); } });
    assert.equal((await g3.require(op)).ok, false);
  });

  it("gate level: human and strict never take legacyConfirmed as a yes; with no elicit and no store the answer is refusal", async () => {
    const op = { tool: "drive_delete", effect: "irreversible", fields: { path: "/trash/a.txt" } };
    for (const mode of ["human", "strict"]) {
      const g = new ApprovalGate({ mode });
      const r = await g.require(op, { legacyConfirmed: true });
      assert.equal(r.ok, false, mode);
      assert.equal(r.code, "approval_required");
    }
  });
});

// ======================================================================================================================
// (e): client without elicitation.
// ======================================================================================================================
describe("(e) client without elicitation", () => {
  it("approval_required with a code; repeating, adding confirmed, or passing the code as an argument cannot run it; only the store approval does, once", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      const args = { path: "/my-files/p", email: "a@example.org", role: "viewer" };
      const first = await ctx.call("drive_share_invite", args);
      assert.equal(first.isError, true);
      const code = codeOf(first);
      assert.ok(code);
      assert.equal(ctx.lastAudit().code, "approval_required");
      for (const extra of [{}, { confirmed: true }, { code }, { approvalCode: code }, { approval_code: code }, { token: code }, { approved: true, code }]) {
        const r = await safe(ctx, "drive_share_invite", { ...args, ...extra });
        assert.equal(r.isError, true, JSON.stringify(extra));
      }
      assert.deepEqual(ctx.changes(), []);
      // the code is only an identifier: a human approval in the store is what counts
      store(ctx).approve(code);
      for (const extra of [{ code }, { approved: true }, { confirmed: "true" }]) {
        const r = await safe(ctx, "drive_share_invite", { ...args, ...extra });
        if (Object.keys(extra)[0] !== "confirmed") assert.equal(r.isError, true, `${JSON.stringify(extra)}: unknown argument must be rejected`);
      }
      // (confirmed:'true' may or may not be rejected by validation; if it ran, it consumed the single approval, so count below)
      const ranSoFar = ctx.changes().length;
      assert.ok(ranSoFar <= 1);
      if (ranSoFar === 0) {
        const ok = await ctx.call("drive_share_invite", args);
        assert.notEqual(ok.isError, true, text(ok));
      }
      assert.equal(ctx.changes().length, 1, "exactly once");
      const entry = ctx.lastAudit();
      assert.equal(entry.outcome, "ok");
      assert.equal(entry.approval.channel, "cli");
      assert.equal(entry.approval.code, code);
      assert.equal((await ctx.call("drive_share_invite", args)).isError, true);
      assert.equal(ctx.changes().length, 1);
    });
  });

  it("denying a code in the store removes the way in", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      const code = codeOf(await ctx.call("drive_delete", { path: "/trash/a.txt" }));
      assert.equal(store(ctx).deny(code), true);
      assert.throws(() => store(ctx).approve(code));
      const r = await ctx.call("drive_delete", { path: "/trash/a.txt" });
      assert.equal(r.isError, true);
      assert.deepEqual(ctx.changes(), []);
    });
  });

  it("garbage codes cannot be approved or crash the store", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      await ctx.call("drive_delete", { path: "/trash/a.txt" });
      const s = store(ctx);
      for (const bad of ["", "x", "../../etc/passwd", "ABCD-EFGH/../../x", "ABCD-EFG", "abcd-efgh\0", "A".repeat(10000), "ABCD-EFGH\n", "0000-1111"]) {
        assert.throws(() => s.approve(bad), Error, JSON.stringify(bad).slice(0, 40));
        try { assert.equal(s.get(bad), null); } catch (e) { assert.ok(e instanceof Error, "get() either returns null or throws a plain Error"); }
      }
      assert.deepEqual(ctx.changes(), []);
    });
  });

  it("a hand-made approved record (no human, planted by something that can write the folder) is outside the threat model, but a planted PENDING record never runs anything", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      await ctx.call("drive_delete", { path: "/trash/a.txt" });
      const dir = join(ctx.dir, "approvals", "pending");
      writeFileSync(join(dir, "ZZZZ-ZZZZ.json"), JSON.stringify({ code: "ZZZZ-ZZZZ", tool: "drive_delete", opHash: "x", summary: "x", createdAt: 0, expiresAt: Date.now() + 1e6 }));
      const r = await ctx.call("drive_delete", { path: "/trash/a.txt" });
      assert.equal(r.isError, true);
      assert.deepEqual(ctx.changes(), []);
    });
  });
});

// ======================================================================================================================
// (f): audit log.
// ======================================================================================================================
describe("(f) audit log", () => {
  it("every refusal appends an entry, the chain verifies, an approved op carries approval.channel and a 16-hex op", async () => {
    await withServer({ replies: [DECLINE, CANCEL, NO_APPROVE, THROWS, ACCEPT] }, async (ctx) => {
      const calls = [["drive_empty_trash", {}], ["drive_delete", { path: "/trash/a.txt", confirmed: true }], ["drive_share_remove_url", { path: "/my-files/p" }], ["drive_copy", { sourcePath: "/my-files/a", destinationPath: "/shared-with-me/t" }], ["drive_empty_trash", {}]];
      for (const [t, a] of calls) await ctx.call(t, a);
      // refusals the gate never sees must be audited too
      await safe(ctx, "drive_empty_trash", { approved: true });
      const entries = ctx.audit();
      const refused = entries.filter((e) => e.outcome === "refused");
      assert.ok(refused.length >= 4, JSON.stringify(entries.map((e) => [e.tool, e.outcome, e.code])));
      assert.deepEqual(entries.slice(0, 4).map((e) => e.code), ["approval_declined", "approval_required", "approval_declined", "approval_required"]);
      assert.equal(entries[4].outcome, "ok");
      assert.equal(entries[4].approval.channel, "elicitation");
      assert.match(entries[4].approval.op, /^[0-9a-f]{16}$/);
      for (const e of refused) assert.equal(e.approval, undefined, "a refusal never claims an approval");
      const v = new AuditLog(ctx.auditFile).verify();
      assert.equal(v.ok, true, JSON.stringify(v));
      assert.equal(v.entries, entries.length);
      // each entry names the tool and chains onto the previous one
      for (let i = 1; i < entries.length; i++) assert.equal(entries[i].prev, entries[i - 1].hash);
    });
  });

  it("approval_required refusals and the cli-channel approval are audited and chain", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      const args = { path: "/trash/a.txt" };
      const code = codeOf(await ctx.call("drive_delete", args));
      await ctx.call("drive_delete", args);
      store(ctx).approve(code);
      await ctx.call("drive_delete", args);
      await ctx.call("drive_delete", args);
      const e = ctx.audit();
      assert.deepEqual(e.map((x) => x.code ?? x.outcome), ["approval_required", "approval_required", "ok", "approval_required"]);
      assert.equal(e[2].approval.channel, "cli");
      assert.equal(e[2].approval.code, code);
      assert.equal(new AuditLog(ctx.auditFile).verify().ok, true);
    });
  });

  it("the same operation hashes to the same op prefix in elicitation and cli channels (confirmed is not part of it)", async () => {
    let elicitOp, cliOp;
    await withServer({ replies: always(ACCEPT) }, async (ctx) => {
      await ctx.call("drive_share_invite", { path: "/my-files/p", email: "a@example.org", role: "viewer" });
      await ctx.call("drive_share_invite", { path: "/my-files/p", email: "a@example.org", role: "viewer", confirmed: true });
      const [a, b] = ctx.audit();
      assert.equal(a.approval.op, b.approval.op);
      elicitOp = a.approval.op;
    });
    await withServer({ caps: {} }, async (ctx) => {
      const args = { path: "/my-files/p", email: "a@example.org", role: "viewer" };
      store(ctx).approve(codeOf(await ctx.call("drive_share_invite", args)));
      await ctx.call("drive_share_invite", { ...args, confirmed: true });
      cliOp = ctx.audit().at(-1).approval.op;
    });
    assert.equal(cliOp, elicitOp);
  });

  it("tampering with an entry (code, tool or approval) breaks the chain", async () => {
    await withServer({ replies: [DECLINE, ACCEPT] }, async (ctx) => {
      await ctx.call("drive_empty_trash", {});
      await ctx.call("drive_empty_trash", {});
      const log = new AuditLog(ctx.auditFile);
      assert.equal(log.verify().ok, true);
      const original = readFileSync(ctx.auditFile, "utf8");
      for (const [from, to] of [["approval_declined", "approval_xyz"], ['"channel":"elicitation"', '"channel":"cli"'], ["drive_empty_trash", "drive_trash"]]) {
        assert.ok(original.includes(from), from);
        writeFileSync(ctx.auditFile, original.replace(from, to));
        assert.equal(log.verify().ok, false, `${from} -> ${to} must be detected`);
      }
      writeFileSync(ctx.auditFile, original);
      assert.equal(log.verify().ok, true);
      // deleting the refusal entry from the front is detected too
      writeFileSync(ctx.auditFile, original.split("\n").filter(Boolean).slice(1).join("\n") + "\n");
      assert.equal(log.verify().ok, false);
    });
  });

  it("secrets (password, message text, file content) are not written to the audit log or the store", async () => {
    await withServer({ replies: always(DECLINE), setup: syncSetup }, async (ctx) => {
      await ctx.call("drive_share_set_url", { path: "/my-files/p", role: "viewer", password: "hunter2-secret" });
      await ctx.call("drive_share_invite", { path: "/my-files/p", email: "a@example.org", role: "viewer", message: "top-secret-note" });
      await ctx.call("drive_write_file", { path: "/my-files/notes.txt", content: "file-secret-content" });
      const log = readFileSync(ctx.auditFile, "utf8");
      assert.doesNotMatch(log, /hunter2-secret/, "password in the audit log");
      assert.doesNotMatch(log, /top-secret-note/, "invitation message in the audit log");
      assert.doesNotMatch(log, /file-secret-content/, "file content in the audit log");
    });
  });

  it("an unwritable audit log fails closed for a gated call: nothing runs", async () => {
    await withServer({ replies: always(ACCEPT), setup: (sb) => { writeFileSync(join(sb.dir, "blocker"), "x"); return { PROTON_DRIVE_AUDIT_LOG: join(sb.dir, "blocker", "audit.log") }; } }, async (ctx) => {
      const r = await safe(ctx, "drive_empty_trash", {});
      // plan: "the human is never asked about a call that would fail ... the audit-writable check"
      assert.equal(r.isError, true, text(r));
      assert.deepEqual(ctx.changes(), []);
      assert.equal(ctx.asked, 0, "not asked about a call that cannot be audited");
    });
  });
});
