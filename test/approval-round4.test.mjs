// 1.11.0 third review round: control characters and escape sequences in names stay visible and distinct.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { showValueStrict } from "../dist/utils/text.js";
import { renderOperation } from "../dist/utils/approval.js";

const ESC = "\u001b";
const BS = String.fromCharCode(92);

describe("controls are escaped, not turned into a space", () => {
  it("a C1 control in a path renders differently from the same name with a space", () => {
    const withC1 = showValueStrict("/my-files/Tax\u0085File");
    assert.notEqual(withC1, showValueStrict("/my-files/Tax File"));
    assert.equal(withC1, `/my-files/Tax${BS}u0085File`);
    const op = (p) => renderOperation({ tool: "drive_trash", effect: "reversible", fields: { path: p } });
    assert.notEqual(op("/my-files/Tax\u0085File"), op("/my-files/Tax File"));
  });
  it("every C0 (except ESC, which has its own form), DEL and C1 character shows as \\uXXXX", () => {
    for (const cp of [0x00, 0x07, 0x09, 0x0a, 0x0d, 0x1f, 0x7f, 0x80, 0x9b, 0x9f]) {
      const out = showValueStrict(`a${String.fromCharCode(cp)}b`);
      assert.equal(out, `a${BS}u${cp.toString(16).padStart(4, "0")}b`, `U+${cp.toString(16)}`);
    }
  });
  it("the Ogham space mark is escaped", () => {
    assert.equal(showValueStrict("Tax File"), `Tax${BS}u1680File`);
  });
});

describe("only the ESC byte is escaped; the rest of an escape sequence stays visible", () => {
  it("ESC + F and ESC + G render differently (no letter is swallowed)", () => {
    assert.equal(showValueStrict(`Tax${ESC}File`), `Tax${BS}x1bFile`);
    assert.equal(showValueStrict(`Tax${ESC}Gile`), `Tax${BS}x1bGile`);
    assert.notEqual(showValueStrict(`Tax${ESC}File`), showValueStrict(`Tax${ESC}Gile`));
  });
  it("an unterminated OSC does not hide the rest of the name", () => {
    assert.equal(showValueStrict(`a${ESC}]0;title and the rest of the name`), `a${BS}x1b]0;title and the rest of the name`);
  });
  it("ESC + a lowercase letter is not a space", () => {
    assert.equal(showValueStrict(`a${ESC}xb`), `a${BS}x1bxb`);
    assert.notEqual(showValueStrict(`a${ESC}xb`), showValueStrict("a b"));
  });
  it("a CSI sequence shows its ESC and its text, so it cannot move the cursor", () => {
    const out = showValueStrict(`x${ESC}[2K${ESC}[1Ay`);
    assert.ok(!out.includes(ESC));
    assert.equal(out, `x${BS}x1b[2K${BS}x1b[1Ay`);
  });
});

// CodeQL js/insufficient-password-hash: the link password is part of the operation hash that is written to the approvals folder.
// A plain sha256 of a short password in there could be guessed offline, so it goes through a slow key-derivation function.
describe("the public-link password is not hashed with a plain fast hash", async () => {
  const { createHash } = await import("node:crypto");
  const { join } = await import("node:path");
  const { createApprovalStore } = await import("../dist/utils/approvalStore.js");
  const { opHash } = await import("../dist/utils/approval.js");
  const { withServer, text } = await import("./helpers/approval-harness.mjs");
  const codeOf = (r) => /approve ([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(text(r))?.[1];
  const args = (password) => ({ path: "/my-files/p", role: "viewer", password });

  it("the stored operation hash differs from one built with sha256(password), and the same password still matches on replay only", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      const store = createApprovalStore({ dir: join(ctx.dir, "approvals") });
      const code = codeOf(await ctx.call("drive_share_set_url", args("hunter2")));
      const plain = createHash("sha256").update("hunter2").digest("hex").slice(0, 32);
      const naive = opHash({ tool: "drive_share_set_url", effect: "outward", fields: { path: "/my-files/p", role: "viewer", passwordDigest: plain, expiration: null, resetSettings: false, replacesExistingLink: false } });
      assert.notEqual(store.get(code).opHash, naive);
      store.approve(code);
      assert.equal((await ctx.call("drive_share_set_url", args("other"))).isError, true);
      assert.deepEqual(ctx.changes(), []);
      assert.notEqual((await ctx.call("drive_share_set_url", args("hunter2"))).isError, true);
      assert.equal(ctx.changes().length, 1);
    });
  });
});
