// 1.11.0 final fixes after the review: look-alike characters, one dialog at a time, the terminal route when a dialog fails,
// uid lookups, bulk plan text, invisible characters, a misconfigured approvals folder.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApprovalStore } from "../dist/utils/approvalStore.js";
import { showValueStrict } from "../dist/utils/text.js";
import { renderOperation } from "../dist/utils/approval.js";
import { ACCEPT, DECLINE, CANCEL, NO_APPROVE, THROWS, withServer, writeTree, text } from "./helpers/approval-harness.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codeOf = (r) => /approve ([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(text(r))?.[1];

describe("item 7: invisible and default-ignorable characters are shown as \\uXXXX", () => {
  const cp = (...xs) => xs.map((x) => String.fromCodePoint(x));
  const SAMPLES = [
    ...cp(0x3164, 0x115f, 0x1160, 0x034f, 0xffa0, 0x180b, 0x180c, 0x180d, 0x180e, 0xfe00, 0xfe0f, 0xfff9, 0xfffa, 0xfffb, 0x1d173, 0x1d17a, 0xe0100, 0xe0001, 0x200b, 0x202e, 0x2066, 0x00ad, 0x061c, 0x0600, 0x110bd),
  ];
  for (const ch of SAMPLES) {
    const hex = ch.codePointAt(0).toString(16).padStart(4, "0");
    it(`U+${hex.toUpperCase().padStart(4, "0")} never reaches the human as a raw character`, () => {
      const out = showValueStrict(`/my-files/a${ch}b`);
      assert.ok(!out.includes(ch), `raw character left in ${JSON.stringify(out)}`);
      assert.ok(out.includes(`\\u${hex}`), out);
    });
  }
  it("ordinary text, accents and emoji sequences keep their letters", () => {
    assert.equal(showValueStrict("/my-files/Zażółć gęślą jaźń.txt"), "/my-files/Zażółć gęślą jaźń.txt");
  });
});

describe("item 1: non-ASCII characters in the names a human must recognise are listed", () => {
  const op = (fields, display) => ({ tool: "drive_share_invite", effect: "outward", fields: { path: "/my-files/p", role: "viewer", ...fields }, ...(display ? { display } : {}) });

  it("a Cyrillic а and о in an invite e-mail are marked with their code points", () => {
    const lookalike = "bоb@exаmple.org";
    const out = renderOperation(op({ email: lookalike }));
    assert.match(out, /^email: bоb@exаmple\.org \(contains non-ASCII: U\+043E U\+0430\)$/m);
    assert.doesNotMatch(renderOperation(op({ email: "bob@example.org" })), /non-ASCII/);
  });

  it("the same for the inviter and the item shown for an invitation or a trashed uid", () => {
    const out = renderOperation({ tool: "drive_invitation_accept", effect: "outward", fields: { uid: "u1" }, display: { inviter: "aа@example.org", invitedFolder: "Tаx (folder)", item: "/trash/а" } });
    assert.match(out, /^inviter: aа@example\.org \(contains non-ASCII: U\+0430\)$/m);
    assert.match(out, /^invitedFolder: Tаx \(folder\) \(contains non-ASCII: U\+0430\)$/m);
    assert.match(out, /^item: \/trash\/а \(contains non-ASCII: U\+0430\)$/m);
  });

  it("end to end through the server", async () => {
    await withServer({ replies: [DECLINE] }, async (ctx) => {
      await ctx.call("drive_share_invite", { path: "/my-files/p", email: "bоb@example.org", role: "viewer" });
      assert.match(ctx.messages[0], /^email: bоb@example\.org \(contains non-ASCII: U\+043E\)$/m);
    });
  });

  it("an ordinary non-ASCII file name is not flagged (only recognition fields are)", () => {
    assert.doesNotMatch(renderOperation({ tool: "drive_delete", effect: "irreversible", fields: { path: "/trash/Zażółć.txt" } }), /non-ASCII/);
  });
});

describe("item 2: one dialog at a time", () => {
  it("12 parallel gated calls show exactly one dialog; the others are refused with approval_unavailable, not queued", async () => {
    await withServer({ replies: async () => { await sleep(500); return DECLINE; } }, async (ctx) => {
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => ctx.call("drive_delete", { path: `/trash/f${i}.txt` })));
      assert.equal(ctx.asked, 1);
      assert.ok(results.every((r) => r.isError === true));
      const busy = results.filter((r) => /already waiting for the user's answer/.test(text(r)));
      assert.equal(busy.length, 11);
      assert.deepEqual(ctx.changes(), []);
      const codes = ctx.audit().map((e) => e.code).sort();
      assert.equal(codes.filter((c) => c === "approval_unavailable").length, 11);
      assert.equal(codes.filter((c) => c === "approval_declined").length, 1);
    });
  });

  it("busy refusals do not use up the decline budget, and a later call is asked normally", async () => {
    await withServer({ replies: async () => { await sleep(300); return DECLINE; } }, async (ctx) => {
      await Promise.all(Array.from({ length: 8 }, (_, i) => ctx.call("drive_delete", { path: `/trash/f${i}.txt` })));
      assert.equal(ctx.asked, 1);
      const later = await ctx.call("drive_delete", { path: "/trash/later.txt" });
      assert.equal(ctx.asked, 2);
      assert.match(text(later), /declined/);
    });
  });

  it("an accept still runs exactly once while the others are turned away", async () => {
    await withServer({ replies: async () => { await sleep(300); return ACCEPT; } }, async (ctx) => {
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => ctx.call("drive_delete", { path: `/trash/g${i}.txt` })));
      assert.equal(results.filter((r) => !r.isError).length, 1);
      assert.equal(ctx.changes().length, 1);
    });
  });
});

describe("item 3: a cancelled or failed dialog falls back to the terminal route; an explicit no is final", () => {
  const args = { path: "/my-files/p", email: "a@example.org", role: "viewer" };
  const storeOf = (ctx) => createApprovalStore({ dir: join(ctx.dir, "approvals") });

  for (const [label, reply] of [["cancel", CANCEL], ["the client throws", THROWS]]) {
    it(`${label}: approval_required with a code (both spellings of the command), approved in a terminal then runs once`, async () => {
      await withServer({ replies: [reply] }, async (ctx) => {
        const first = await ctx.call("drive_share_invite", args);
        assert.equal(first.isError, true);
        const code = codeOf(first);
        assert.ok(code, text(first));
        assert.match(text(first), new RegExp(`npx -y -p proton-drive-mcp proton-drive-cli approve ${code}`));
        assert.equal(ctx.lastAudit().code, "approval_required");
        assert.deepEqual(ctx.changes(), []);
        const store = storeOf(ctx);
        assert.equal(store.get(code).tool, "drive_share_invite");
        store.approve(code);
        // the client can still ask, but the approval given in the terminal is used first, once
        const second = await ctx.call("drive_share_invite", args);
        assert.notEqual(second.isError, true, text(second));
        assert.equal(ctx.asked, 1);
        assert.equal(ctx.changes().length, 1);
        assert.equal(ctx.lastAudit().approval.channel, "cli");
        const third = await ctx.call("drive_share_invite", args);
        assert.equal(third.isError, true);
        assert.equal(ctx.changes().length, 1);
      });
    });
  }

  for (const [label, reply] of [["decline", DECLINE], ["accept with approve=false", NO_APPROVE]]) {
    it(`${label} is final: approval_declined, no pending record`, async () => {
      await withServer({ replies: [reply] }, async (ctx) => {
        const r = await ctx.call("drive_share_invite", args);
        assert.equal(ctx.lastAudit().code, "approval_declined");
        assert.doesNotMatch(text(r), /proton-drive-cli approve/);
        assert.deepEqual(storeOf(ctx).list(), []);
      });
    });
  }

  it("an approval for a different operation does not ride on the fallback record", async () => {
    await withServer({ replies: [CANCEL, DECLINE] }, async (ctx) => {
      const code = codeOf(await ctx.call("drive_share_invite", args));
      storeOf(ctx).approve(code);
      const other = await ctx.call("drive_share_invite", { ...args, role: "editor" });
      assert.equal(other.isError, true);
      assert.deepEqual(ctx.changes(), []);
    });
  });

  it("without a usable store a cancel is a plain refusal, as before", async () => {
    await withServer({
      replies: [CANCEL, THROWS],
      setup: (sb) => { writeFileSync(join(sb.dir, "blocker"), "x"); return { PROTON_DRIVE_APPROVAL_DIR: join(sb.dir, "blocker", "sub") }; },
    }, async (ctx) => {
      const a = await ctx.call("drive_delete", { path: "/trash/a.txt" });
      assert.equal(a.isError, true);
      assert.equal(ctx.lastAudit().code, "approval_declined");
      const b = await ctx.call("drive_delete", { path: "/trash/b.txt" });
      assert.equal(ctx.lastAudit().code, "approval_unavailable");
      assert.deepEqual(ctx.changes(), []);
    });
  });

  it("the store is not touched for a client whose dialog works", async () => {
    await withServer({ replies: [DECLINE, ACCEPT] }, async (ctx) => {
      await ctx.call("drive_delete", { path: "/trash/a.txt" });
      await ctx.call("drive_delete", { path: "/trash/b.txt" });
      const { existsSync } = await import("node:fs");
      assert.equal(existsSync(join(ctx.dir, "approvals")), false);
    });
  });
});

describe("item 5: operations addressed by uid show a name the human can recognise", () => {
  const INVITATIONS = JSON.stringify([{ uid: "inv-1", role: "editor", addedByEmail: { ok: true, value: "bоb@example.org" }, node: { name: { ok: true, value: "Quarterly numbers" }, type: "folder" } }]);

  it("invitation accept and reject show who invited me, to what and as which role; the uid stays in the line", async () => {
    await withServer({ replies: [DECLINE, DECLINE], env: { FAKE_STDOUT: INVITATIONS } }, async (ctx) => {
      await ctx.call("drive_invitation_accept", { uid: "inv-1" });
      await ctx.call("drive_invitation_reject", { uid: "inv-1", confirmed: true });
      for (const m of ctx.messages) {
        assert.match(m, /^uid: inv-1$/m);
        assert.match(m, /^inviter: bоb@example\.org \(contains non-ASCII: U\+043E\)$/m);
        assert.match(m, /^invitedFolder: Quarterly numbers \(folder\)$/m);
        assert.match(m, /^role: editor$/m);
      }
    });
  });

  it("an unknown uid, an empty list and a failing CLI all say (name not resolved) and still ask", async () => {
    for (const [fakeMode, env] of [["json", { FAKE_STDOUT: "[]" }], ["json", { FAKE_STDOUT: INVITATIONS }], ["fail-stderr", {}]]) {
      await withServer({ fakeMode, env, replies: [DECLINE] }, async (ctx) => {
        const r = await ctx.call("drive_invitation_accept", { uid: fakeMode === "json" && env.FAKE_STDOUT === INVITATIONS ? "other-uid" : "inv-1" });
        assert.equal(r.isError, true);
        assert.equal(ctx.asked, 1);
        assert.match(ctx.messages[0], /^inviter: \(name not resolved\)$/m);
        assert.match(ctx.messages[0], /^invitedFolder: \(name not resolved\)$/m);
      });
    }
  });

  it("drive_delete by uid shows the trashed item's path; by path it does not look anything up", async () => {
    const trash = (sb) => ({ FAKE_TREE: writeTree(sb.dir, { "/trash": [{ uid: "u-1", name: { ok: true, value: "secret.txt" }, type: "file" }] }) });
    await withServer({ fakeMode: "tree", setup: trash, replies: [DECLINE, DECLINE, DECLINE] }, async (ctx) => {
      await ctx.call("drive_delete", { uid: "u-1" });
      assert.match(ctx.messages[0], /^uid: u-1$/m);
      assert.match(ctx.messages[0], /^item: \/trash\/secret\.txt$/m);
      await ctx.call("drive_delete", { uid: "u-9" });
      assert.match(ctx.messages[1], /^item: \(name not resolved\)$/m);
      await ctx.call("drive_delete", { path: "/trash/secret.txt" });
      assert.doesNotMatch(ctx.messages[2], /^item:/m);
    });
    await withServer({ fakeMode: "fail-stderr", replies: [DECLINE] }, async (ctx) => {
      await ctx.call("drive_delete", { uid: "u-1" });
      assert.match(ctx.messages[0], /^item: \(name not resolved\)$/m);
    });
  });

  it("the uid is part of the identity: another uid is another operation (store channel)", async () => {
    await withServer({ caps: {}, env: { FAKE_STDOUT: INVITATIONS } }, async (ctx) => {
      const code = codeOf(await ctx.call("drive_invitation_accept", { uid: "inv-1" }));
      createApprovalStore({ dir: join(ctx.dir, "approvals") }).approve(code);
      const other = await ctx.call("drive_invitation_accept", { uid: "inv-2" });
      assert.equal(other.isError, true);
      assert.deepEqual(ctx.changes(), []);
    });
  });
});

describe("item 6: the bulk plan tells the model the server asks the user", () => {
  const tree = (sb) => ({ FAKE_TREE: writeTree(sb.dir, { "/my-files/s": [{ name: "x.txt", type: "file" }], "/my-files/d": [] }) });
  for (const [tool, args] of [["drive_bulk_trash", { paths: ["/my-files/s/x.txt"] }], ["drive_bulk_move", { sources: ["/my-files/s/x.txt"], destinationFolder: "/my-files/d" }]]) {
    it(`${tool}: human and strict say so, model keeps the 1.10.1 text`, async () => {
      for (const approval of ["human", "strict"]) {
        await withServer({ approval, fakeMode: "tree", setup: tree, caps: {} }, async (ctx) => {
          const r = await ctx.call(tool, args);
          assert.match(JSON.parse(text(r)).next, /^Call again with confirmed=true to apply; the server will ask the user for approval itself/);
        });
      }
      await withServer({ approval: "model", fakeMode: "tree", setup: tree, caps: {} }, async (ctx) => {
        assert.equal(JSON.parse(text(await ctx.call(tool, args))).next, "Get user approval, then confirmed=true.");
      });
    });
  }
});

describe("item 8: a misconfigured approvals folder", () => {
  it("is reported on stderr at startup, and refusals blame the server setup, not a missing terminal", async () => {
    await withServer({
      caps: {},
      setup: (sb) => { const sync = join(sb.dir, "sync"); mkdirSync(sync, { recursive: true }); return { PROTON_DRIVE_SYNC_PATH: sync, PROTON_DRIVE_APPROVAL_DIR: join(sync, "approvals") }; },
    }, async (ctx) => {
      for (let i = 0; i < 40 && !/approval store unusable/.test(ctx.stderr); i++) await sleep(50);
      assert.match(ctx.stderr, /approval store unusable.*outside PROTON_DRIVE_SYNC_PATH/);
      const r = await ctx.call("drive_delete", { path: "/trash/a.txt", confirmed: true });
      assert.equal(r.isError, true);
      assert.match(text(r), /misconfigured/);
      assert.doesNotMatch(text(r), /no terminal approval is set up/);
      assert.equal(ctx.lastAudit().code, "approval_unavailable");
      assert.deepEqual(ctx.changes(), []);
    });
  });

  it("a healthy setup prints no such warning, and model mode does not check at all", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      await ctx.call("drive_list", { path: "/my-files" });
      assert.doesNotMatch(ctx.stderr, /approval store unusable/);
    });
    await withServer({
      caps: {}, approval: "model",
      setup: (sb) => { const sync = join(sb.dir, "sync"); mkdirSync(sync, { recursive: true }); return { PROTON_DRIVE_SYNC_PATH: sync, PROTON_DRIVE_APPROVAL_DIR: join(sync, "approvals") }; },
    }, async (ctx) => {
      await ctx.call("drive_list", { path: "/my-files" });
      assert.doesNotMatch(ctx.stderr, /approval store unusable/);
    });
  });
});
