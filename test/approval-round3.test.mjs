// 1.11.0 second review round: an approval record cannot outlive a decision, text neutralising (backslash, braille blank, wide spaces).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate, opHash, renderOperation } from "../dist/utils/approval.js";
import { createApprovalStore } from "../dist/utils/approvalStore.js";
import { showValueStrict } from "../dist/utils/text.js";
import { ACCEPT, CANCEL, withServer, text } from "./helpers/approval-harness.mjs";

const OP = { tool: "drive_share_set_url", effect: "outward", fields: { path: "/my-files/Tax" } };
const DELETE_OP = { tool: "drive_delete", effect: "irreversible", fields: { path: "/trash/a.txt" } };
const freshDir = () => mkdtempSync(join(tmpdir(), "pdmcp-r3-"));
const codeOf = (r) => /approve ([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(r.message ?? text(r))?.[1];

describe("item 1: a stale approved record never turns a closed dialog into a yes", () => {
  it("store.request({fresh}) removes an approved record for the same operation and creates a pending one", () => {
    const store = createApprovalStore({ dir: freshDir() });
    const first = store.request({ tool: OP.tool, opHash: opHash(OP), summary: "s" });
    store.approve(first.code);
    const again = store.request({ tool: OP.tool, opHash: opHash(OP), summary: "s", fresh: true });
    assert.equal(again.reused, false);
    assert.notEqual(again.code, first.code);
    assert.equal(store.get(first.code), null);
    assert.equal(store.get(again.code).status, "pending");
    assert.equal(store.consume({ tool: OP.tool, opHash: opHash(OP) }), null);
    // a pending record is still reused
    assert.equal(store.request({ tool: OP.tool, opHash: opHash(OP), summary: "s", fresh: true }).code, again.code);
  });

  it("store.discard removes pending and approved records for tool+hash only", () => {
    const store = createApprovalStore({ dir: freshDir() });
    const a = store.request({ tool: OP.tool, opHash: opHash(OP), summary: "s" });
    const b = store.request({ tool: DELETE_OP.tool, opHash: opHash(DELETE_OP), summary: "s" });
    store.approve(b.code);
    assert.equal(store.discard({ tool: OP.tool, opHash: opHash(OP) }), 1);
    assert.equal(store.discard({ tool: DELETE_OP.tool, opHash: opHash(DELETE_OP) }), 1);
    assert.deepEqual(store.list(), []);
    assert.equal(store.get(a.code), null);
  });

  it("gate: unconsumed terminal approval + dialog closed + same call again does not run", async () => {
    const store = createApprovalStore({ dir: freshDir() });
    const g0 = new ApprovalGate({ mode: "human", store });
    const r0 = await g0.require(OP);
    const stale = codeOf(r0);
    store.approve(stale);
    let asked = 0;
    const g = new ApprovalGate({ mode: "human", elicit: async () => { asked++; return "cancel"; }, store });
    const r1 = await g.require(OP);
    assert.equal(r1.ok, false);
    assert.equal(r1.code, "approval_required");
    assert.notEqual(codeOf(r1), stale);
    const r2 = await g.require(OP);
    assert.equal(r2.ok, false, "the second identical call must not consume the stale approval");
    assert.equal(asked, 2);
    assert.equal(store.get(stale), null);
  });

  it("gate: an accepted dialog discards any record for the same operation", async () => {
    const store = createApprovalStore({ dir: freshDir() });
    const r0 = await new ApprovalGate({ mode: "human", store }).require(OP);
    store.approve(codeOf(r0));
    const pendingOnly = await new ApprovalGate({ mode: "human", store }).require(DELETE_OP);
    assert.ok(codeOf(pendingOnly));
    const g = new ApprovalGate({ mode: "human", elicit: async () => "accept", store });
    assert.equal((await g.require(OP)).ok, true);
    assert.equal((await g.require(DELETE_OP)).ok, true);
    assert.deepEqual(store.list(), []);
  });

  const staleSetup = (sb) => {
    const store = createApprovalStore({ dir: join(sb.dir, "approvals") });
    const r = store.request({ tool: DELETE_OP.tool, opHash: opHash(DELETE_OP), summary: "old" });
    store.approve(r.code);
    return {};
  };

  it("server: a terminal-approved, unused record is not used after the user closes the dialog", async () => {
    await withServer({ setup: staleSetup, replies: [CANCEL, CANCEL] }, async (ctx) => {
      const store = createApprovalStore({ dir: join(ctx.dir, "approvals") });
      const stale = store.list()[0].code;
      const first = await ctx.call("drive_delete", { path: "/trash/a.txt" });
      assert.equal(first.isError, true);
      assert.deepEqual(ctx.changes(), []);
      const second = await ctx.call("drive_delete", { path: "/trash/a.txt" });
      assert.equal(second.isError, true, text(second));
      assert.deepEqual(ctx.changes(), []);
      assert.equal(ctx.asked, 2);
      assert.equal(store.get(stale), null);
    });
  });

  it("server: an accepted dialog leaves no record behind", async () => {
    await withServer({ setup: staleSetup, replies: [ACCEPT] }, async (ctx) => {
      const r = await ctx.call("drive_delete", { path: "/trash/a.txt" });
      assert.notEqual(r.isError, true, text(r));
      assert.equal(ctx.changes().length, 1);
      assert.deepEqual(createApprovalStore({ dir: join(ctx.dir, "approvals") }).list(), []);
    });
  });

  it("server: with no dialog, approve once in the terminal and the call runs once (unchanged)", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      const code = codeOf(await ctx.call("drive_delete", { path: "/trash/a.txt" }));
      createApprovalStore({ dir: join(ctx.dir, "approvals") }).approve(code);
      assert.notEqual((await ctx.call("drive_delete", { path: "/trash/a.txt" })).isError, true);
      assert.equal((await ctx.call("drive_delete", { path: "/trash/a.txt" })).isError, true);
      assert.equal(ctx.changes().length, 1);
    });
  });

  it("server: a working dialog does not create the approvals folder", async () => {
    await withServer({ replies: [ACCEPT] }, async (ctx) => {
      await ctx.call("drive_delete", { path: "/trash/a.txt" });
      const { existsSync } = await import("node:fs");
      assert.equal(existsSync(join(ctx.dir, "approvals")), false);
    });
  });
});

describe("item 3: a literal backslash sequence differs from the real character", () => {
  it("a name containing the text \\u200b renders differently from one containing a real zero-width space", () => {
    const literal = showValueStrict("a\\u200bb");
    const real = showValueStrict("a\u200bb");
    assert.notEqual(literal, real);
    assert.equal(literal, "a\\\\u200bb");
    assert.equal(real, "a\\u200bb");
  });
  it("a literal \\x1b differs from a real escape, and a lone backslash is doubled", () => {
    assert.notEqual(showValueStrict("a\\x1b[2Jb"), showValueStrict("a\u001b[2Jb"));
    assert.equal(showValueStrict("C:\\dir"), "C:\\\\dir");
  });
});

describe("item 4: braille blank and wide or non-breaking spaces are visible escapes in every field", () => {
  const cps = [0x2800, 0x00a0, 0x2000, 0x2003, 0x200a, 0x3000, 0x202f, 0x205f];
  for (const cp of cps) {
    it(`U+${cp.toString(16).toUpperCase().padStart(4, "0")} in path, newName, name and uid-less fields`, () => {
      const ch = String.fromCodePoint(cp);
      const hex = `\\u${cp.toString(16).padStart(4, "0")}`;
      assert.equal(showValueStrict(`Tax${ch}File`), `Tax${hex}File`);
      const out = renderOperation({ tool: "drive_rename", effect: "reversible", fields: { path: `/my-files/Tax${ch}`, newName: `New${ch}` } });
      assert.ok(out.split("\n").includes(`path: /my-files/Tax${hex}`), out);
      assert.ok(out.split("\n").includes(`newName: New${hex}`), out);
      assert.doesNotMatch(out, new RegExp(ch));
    });
  }
  it("an ordinary space is untouched", () => assert.equal(showValueStrict("My Files/a b"), "My Files/a b"));
});
