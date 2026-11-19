// 1.11.0 approval gate wired into the server (PLAN-1.11.0.md WP-A): the built server on the fake CLI, with an MCP client that
// can answer (or refuse, or lack) elicitation. Zero changes reach the CLI unless a human said yes to that exact operation.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createApprovalStore } from "../dist/utils/approvalStore.js";
import { AuditLog } from "../dist/utils/audit.js";
import { MUTATING_TOOL_NAMES, READ_TOOL_NAMES } from "../dist/index.js";
import { GATED_TOOLS, requiresApproval, underShared } from "../dist/utils/approval.js";
import { ACCEPT, DECLINE, CANCEL, NO_APPROVE, THROWS, withServer, writeTree, text } from "./helpers/approval-harness.mjs";
import { driveSetup, file, folder, seedJournal } from "./helpers/drive-state.mjs";

// ---- the gated set: one entry per way a tool can be gated -------------------------------------------------------------
const MEMBER = JSON.stringify({ members: [{ inviteeEmail: "a@example.org", role: "viewer" }] });
const TREE = { "/my-files/s": [{ name: "x.txt", type: "file" }], "/my-files/d": [] };
const treeSetup = (sb) => ({ FAKE_TREE: writeTree(sb.dir, TREE) });
const syncSetup = (sb) => {
  const sync = join(sb.dir, "sync");
  mkdirSync(sync, { recursive: true });
  writeFileSync(join(sync, "notes.txt"), "old");
  return { PROTON_DRIVE_SYNC_PATH: sync };
};
const both = (...fns) => (sb) => Object.assign({}, ...fns.map((f) => f(sb)));
const localFile = (sb) => { const p = join(sb.dir, "work", "f.txt"); writeFileSync(p, "data"); return p; };

/** `plan`: without confirmed=true the call is only a plan (bulk tools), so nothing is asked. */
const GATED_CASES = [
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
  { tool: "drive_bulk_move", args: () => ({ sources: ["/my-files/s/x.txt"], destinationFolder: "/my-files/d" }), plan: true, setup: treeSetup, fakeMode: "tree" },
  { tool: "drive_bulk_trash", args: () => ({ paths: ["/my-files/s/x.txt"] }), plan: true, setup: treeSetup, fakeMode: "tree" },
  { tool: "drive_upload", args: (sb) => ({ localPath: localFile(sb), remotePath: "/my-files/d", fileConflictStrategy: "replace" }) },
  { tool: "drive_download", args: (sb) => ({ remotePath: "/my-files/a.txt", localPath: join(sb.dir, "work", "out"), fileConflictStrategy: "remove" }) },
  { tool: "photos_download", args: (sb) => ({ photoPaths: ["/photos/p.jpg"], localFolder: join(sb.dir, "work", "pout"), conflictStrategy: "remove" }) },
  { tool: "drive_write_file", args: () => ({ path: "/my-files/notes.txt", content: "new text" }), setup: syncSetup, noCli: true },
  // new in 1.11.0: anything that ends up under /shared-with-me
  { tool: "drive_copy", args: () => ({ sourcePath: "/my-files/a.txt", destinationPath: "/shared-with-me/t" }) },
  { tool: "drive_move", args: () => ({ sourcePath: "/my-files/a.txt", destinationPath: "/shared-with-me/t/a.txt" }) },
  { tool: "drive_mkdir", args: () => ({ path: "/shared-with-me/t/new" }) },
  { tool: "drive_rename", args: () => ({ path: "/shared-with-me/t/a.txt", newName: "b.txt" }) },
  { tool: "drive_upload", label: "into /shared-with-me", args: (sb) => ({ localPath: localFile(sb), remotePath: "/shared-with-me/t" }) },
  { tool: "drive_bulk_move", label: "into /shared-with-me", args: () => ({ sources: ["/my-files/s/x.txt"], destinationFolder: "/shared-with-me/t" }), plan: true, setup: (sb) => ({ FAKE_TREE: writeTree(sb.dir, { ...TREE, "/shared-with-me/t": [] }) }), fakeMode: "tree" },
  // anything that reads from /shared-with-me is gated as well
  { tool: "drive_copy", label: "out of /shared-with-me", args: () => ({ sourcePath: "/shared-with-me/t/a.txt", destinationPath: "/my-files/d" }) },
  { tool: "drive_move", label: "out of /shared-with-me", args: () => ({ sourcePath: "/shared-with-me/t/a.txt", destinationPath: "/my-files/a.txt" }) },
  { tool: "drive_rename", label: "inside /shared-with-me (//)", args: () => ({ path: "//shared-with-me/t/a.txt", newName: "b.txt" }) },
  { tool: "drive_trash", label: "from /shared-with-me", args: () => ({ path: "/shared-with-me/t/a.txt" }) },
  { tool: "drive_restore", label: "from /shared-with-me", args: () => ({ path: "/Shared-With-Me/t/a.txt" }) },
  { tool: "drive_bulk_trash", label: "from /shared-with-me", args: () => ({ paths: ["/shared-with-me/t/a.txt"] }), plan: true, setup: (sb) => ({ FAKE_TREE: writeTree(sb.dir, { "/shared-with-me/t": [{ name: "a.txt", type: "file" }] }) }), fakeMode: "tree" },
  { tool: "drive_bulk_move", label: "out of /shared-with-me", args: () => ({ sources: ["/shared-with-me/t/a.txt"], destinationFolder: "/my-files/d" }), plan: true, setup: (sb) => ({ FAKE_TREE: writeTree(sb.dir, { "/shared-with-me/t": [{ name: "a.txt", type: "file" }], "/my-files/d": [] }) }), fakeMode: "tree" },
];
// 1.12.0: drive_cleanup (plan/apply like the bulk tools) and drive_undo (action apply) on the stateful fake Drive.
const DUPES = [folder("d1", "root", "docs"), folder("d2", "root", "inbox"), file("f1", "d1", "a.pdf", { size: 5000, sha1: "S1", mtime: "2020-01-01T00:00:00Z" }), file("f2", "d2", "a (1).pdf", { size: 5000, sha1: "S1", mtime: "2024-01-01T00:00:00Z" })];
GATED_CASES.push(
  { tool: "drive_cleanup", args: () => ({ path: "/my-files", fixes: ["duplicates"] }), plan: true, setup: driveSetup(DUPES), fakeMode: "drive" },
  {
    tool: "drive_undo", args: () => ({ action: "apply" }), once: true, fakeMode: "drive",
    setup: (sb) => {
      const env = driveSetup([folder("d1", "root", "docs"), file("f1", "d1", "a.txt", { trashTime: "2026-11-19T10:00:00Z" })])(sb);
      seedJournal(sb, { items: [{ uid: "f1", from: "/my-files/docs/a.txt", name: "a.txt", restorable: true }] });
      return env;
    },
  },
);
const caseName = (c) => (c.label ? `${c.tool} ${c.label}` : c.tool);
const CONFIRMED = [["true", { confirmed: true }], ["false", { confirmed: false }], ["absent", {}]];

/** Calls once per prompt-less/prompted call and returns {r, delta} where delta = CLI calls that are not reads. */
// These tools have no `confirmed` argument at all (the schema rejects it), so there is only the "absent" variant.
const NO_CONFIRMED_ARG = new Set(["drive_undo", "drive_copy", "drive_move", "drive_mkdir", "drive_rename", "drive_trash", "drive_restore", "drive_invitation_accept"]);
async function callCase(ctx, c, confirmedArgs) {
  const before = ctx.changes().length;
  const r = await ctx.call(c.tool, { ...c.args(ctx.sb), ...(NO_CONFIRMED_ARG.has(c.tool) ? {} : confirmedArgs) });
  return { r, delta: ctx.changes().slice(before) };
}
const opts = (c, extra = {}) => ({ setup: c.setup, fakeMode: c.fakeMode, env: c.env, ...extra });

describe("A1/A2: gated operations x confirmed x human answer (client can elicit)", { concurrency: 6 }, () => {
  // 4 refusing answers x 3 confirmed values = 12 refusals per case; the gate stops asking after 5 refusals a minute, so they are split over servers.
  const REFUSALS = [["decline", DECLINE, "approval_declined"], ["cancel", CANCEL, "approval_required"], ["accept with approve=false", NO_APPROVE, "approval_declined"], ["client throws", THROWS, "approval_required"]];
  const combos = REFUSALS.flatMap((x) => CONFIRMED.map((y) => [x, y]));
  const chunks = [combos.slice(0, 4), combos.slice(4, 8), combos.slice(8)];

  for (const c of GATED_CASES) {
    it(`${caseName(c)}: a refusing human means zero changes and the matching audit code`, async () => {
      for (const chunk of chunks) {
        // a plan call (bulk tool without confirmed=true) never reaches the human, so it consumes no answer
        const asking = c.plan ? chunk.filter(([, [cLabel]]) => cLabel === "true") : chunk;
        await withServer(opts(c, { replies: asking.map(([[, reply]]) => reply) }), async (ctx) => {
          for (const [[label, , code], [cLabel, cArgs]] of chunk) {
            const planOnly = c.plan && cLabel !== "true";
            const asked = ctx.asked;
            const { r, delta } = await callCase(ctx, c, cArgs);
            const why = `${caseName(c)} / ${label} / confirmed ${cLabel}`;
            assert.deepEqual(delta, [], why);
            if (planOnly) {
              assert.notEqual(r.isError, true, why);
              assert.equal(ctx.asked, asked, `${why}: a plan is never asked about`);
              continue;
            }
            assert.equal(r.isError, true, why);
            assert.equal(ctx.asked, asked + 1, `${why}: asked exactly once`);
            assert.equal(ctx.lastAudit().outcome, "refused", why);
            assert.equal(ctx.lastAudit().code, code, why);
            assert.equal(ctx.lastAudit().approval, undefined, why);
          }
        });
      }
    });

    it(`${caseName(c)}: an accepting human runs it exactly once and the audit entry names the channel`, async () => {
      await withServer(opts(c, { replies: () => ACCEPT }), async (ctx) => {
        const ops = new Set();
        for (const [cLabel, cArgs] of CONFIRMED) {
          if (c.plan && cLabel !== "true") continue; // only the apply call changes anything
          if (c.once && ops.size > 0) continue; // a recorded batch can be undone once
          const asked = ctx.asked;
          const { r, delta } = await callCase(ctx, c, cArgs);
          assert.equal(ctx.asked, asked + 1, `${caseName(c)} confirmed ${cLabel}: asked once`);
          if (c.noCli) assert.notEqual(r.isError, true, text(r));
          else assert.ok(delta.length >= 1, `${caseName(c)} confirmed ${cLabel}: reached the CLI (${JSON.stringify(delta)}) ${text(r)}`);
          const entry = ctx.lastAudit();
          if (!r.isError) {
            assert.equal(entry.outcome, "ok");
            assert.equal(entry.approval.channel, "elicitation");
            assert.match(entry.approval.op, /^[0-9a-f]{16}$/);
            ops.add(entry.approval.op);
          }
        }
        // confirmed is not part of the operation: the same call hashes the same whatever it says
        assert.ok(ops.size <= 1, `${caseName(c)}: ${[...ops]}`);
      });
    });

    it(`${caseName(c)}: a client without elicitation is refused (approval_required), zero changes`, async () => {
      await withServer(opts(c, { caps: {} }), async (ctx) => {
        for (const [cLabel, cArgs] of CONFIRMED) {
          const planOnly = c.plan && cLabel !== "true";
          const { r, delta } = await callCase(ctx, c, cArgs);
          assert.deepEqual(delta, [], `${caseName(c)} confirmed ${cLabel}`);
          if (planOnly) { assert.notEqual(r.isError, true); continue; }
          assert.equal(r.isError, true);
          assert.match(text(r), /proton-drive-cli approve [A-Z2-9]{4}-[A-Z2-9]{4}/, `${caseName(c)} confirmed ${cLabel}`);
          assert.equal(ctx.lastAudit().code, "approval_required");
          assert.equal(ctx.asked, 0);
        }
      });
    });
  }
});

// ---- A8: nothing is in neither list ------------------------------------------------------------------------------------
describe("A8: every tool is classified, and every gated tool is exercised", () => {
  it("each mutating tool is in exactly one of: gated, or covered by the strict table; reads are never gated", () => {
    const covered = new Set(GATED_CASES.map((c) => c.tool));
    for (const t of MUTATING_TOOL_NAMES) {
      const inGated = GATED_TOOLS.has(t);
      const inUngated = UNGATED_CASES.some((c) => c.tool === t);
      assert.ok(inGated || inUngated, `${t} is a mutating tool that is in neither the gated table nor the ungated table`);
      if (inGated) assert.ok(covered.has(t), `${t} is gated but the gate table above has no case for it`);
    }
    for (const t of GATED_TOOLS) assert.ok(MUTATING_TOOL_NAMES.has(t) || READ_TOOL_NAMES.has(t), `${t} is gated but unknown`);
    for (const t of READ_TOOL_NAMES) {
      if (t === "drive_download" || t === "photos_download") continue; // gated only with strategy 'remove'
      assert.equal(GATED_TOOLS.has(t), false, `${t} is a read tool`);
      assert.equal(requiresApproval(t, {}, "strict", { mutatingTools: MUTATING_TOOL_NAMES }), false, `${t} must not be gated even in strict mode`);
    }
  });
});

// ---- the other tables: ungated mutating tools -------------------------------------------------------------------------
const UNGATED_CASES = [
  { tool: "drive_trash", args: () => ({ path: "/my-files/a.txt" }) },
  { tool: "drive_restore", args: () => ({ path: "/trash/a.txt" }) },
  { tool: "drive_mkdir", args: () => ({ path: "/my-files/new" }) },
  { tool: "drive_rename", args: () => ({ path: "/my-files/a.txt", newName: "b.txt" }) },
  { tool: "drive_move", args: () => ({ sourcePath: "/my-files/a.txt", destinationPath: "/my-files/d/a.txt" }) },
  { tool: "drive_copy", args: () => ({ sourcePath: "/my-files/a.txt", destinationPath: "/my-files/d" }) },
  { tool: "drive_upload", args: (sb) => ({ localPath: localFile(sb), remotePath: "/my-files/d" }) },
  { tool: "drive_write_file", args: () => ({ path: "/my-files/brand-new.txt", content: "x" }), setup: syncSetup, noCli: true },
  { tool: "photos_create_album", args: () => ({ name: "Trip" }) },
  { tool: "photos_update_album", args: () => ({ albumPath: "/albums/a", name: "B" }) },
  { tool: "photos_add_to_album", args: () => ({ albumPath: "/albums/a", photoPath: "/photos/p.jpg" }) },
  { tool: "photos_upload", args: (sb) => ({ localPaths: [localFile(sb)] }) },
  // the strict mode also asks about the apply step of every bulk tool and the sticky ones above; these two are plan calls in default mode
];

describe("ungated mutating tools: no prompt in human mode, a prompt in strict mode", { concurrency: 6 }, () => {
  for (const c of UNGATED_CASES) {
    it(`${c.tool}: runs without a prompt in human mode, even for a client that cannot elicit`, async () => {
      for (const caps of [{ elicitation: { form: {} } }, {}]) {
        await withServer({ ...opts(c), caps, replies: () => DECLINE }, async (ctx) => {
          const { r, delta } = await callCase(ctx, c, {});
          assert.equal(ctx.asked, 0);
          if (c.noCli) assert.notEqual(r.isError, true, text(r));
          else assert.ok(delta.length >= 1, `${c.tool} reached the CLI: ${text(r)}`);
          assert.equal(ctx.lastAudit().approval, undefined);
        });
      }
    });

    it(`${c.tool}: strict mode asks, and a decline stops it`, async () => {
      await withServer({ ...opts(c), approval: "strict", replies: [DECLINE, ACCEPT] }, async (ctx) => {
        const first = await callCase(ctx, c, {});
        assert.equal(ctx.asked, 1);
        assert.equal(first.r.isError, true);
        assert.deepEqual(first.delta, []);
        assert.equal(ctx.lastAudit().code, "approval_declined");
        const second = await callCase(ctx, c, {});
        assert.equal(ctx.asked, 2);
        if (c.noCli) assert.notEqual(second.r.isError, true, text(second.r));
        else assert.ok(second.delta.length >= 1);
      });
    });
  }

  it("strict mode asks for the bulk apply but not for its plan, and still honours readonly", async () => {
    await withServer({ setup: treeSetup, fakeMode: "tree", approval: "strict", replies: [DECLINE] }, async (ctx) => {
      const plan = await ctx.call("drive_bulk_trash", { paths: ["/my-files/s/x.txt"] });
      assert.notEqual(plan.isError, true);
      assert.equal(ctx.asked, 0);
      const apply = await ctx.call("drive_bulk_trash", { paths: ["/my-files/s/x.txt"], confirmed: true });
      assert.equal(apply.isError, true);
      assert.equal(ctx.asked, 1);
    });
    await withServer({ approval: "strict", env: { PROTON_DRIVE_MODE: "readonly" }, replies: [ACCEPT] }, async (ctx) => {
      const r = await ctx.call("drive_trash", { path: "/my-files/a.txt" });
      assert.equal(r.isError, true);
      assert.equal(ctx.asked, 0);
      assert.equal(ctx.lastAudit().code, "readonly");
    });
  });

  it("non-mutating reads and plain downloads never prompt, even in strict mode", async () => {
    await withServer({ approval: "strict", replies: () => DECLINE }, async (ctx) => {
      await ctx.call("drive_list", { path: "/my-files" });
      await ctx.call("drive_download", { remotePath: "/my-files/a.txt", localPath: join(ctx.dir, "work", "o") });
      assert.equal(ctx.asked, 0);
    });
  });
});

// ---- modes ------------------------------------------------------------------------------------------------------------
describe("modes", () => {
  it("no PROTON_DRIVE_APPROVAL variable at all means human mode: confirmed=true alone is not enough", async () => {
    await withServer({ approval: null, caps: {} }, async (ctx) => {
      const r = await ctx.call("drive_delete", { path: "/trash/a.txt", confirmed: true });
      assert.equal(r.isError, true);
      assert.match(text(r), /needs the user's approval/);
      assert.deepEqual(ctx.changes(), []);
      assert.equal(ctx.lastAudit().code, "approval_required");
      assert.doesNotMatch(ctx.stderr, /PROTON_DRIVE_APPROVAL=model/);
    });
  });

  it("model mode is the 1.10.1 behaviour: confirmed=true is enough, with a startup warning; elicitation only upgrades a refusal", async () => {
    await withServer({ approval: "model", caps: {} }, async (ctx) => {
      const refused = await ctx.call("drive_delete", { path: "/trash/a.txt", confirmed: false });
      assert.equal(refused.isError, true);
      assert.match(text(refused), /confirmed=true/);
      assert.equal(ctx.lastAudit().code, "confirm");
      assert.deepEqual(ctx.changes(), []);
      const ran = await ctx.call("drive_delete", { path: "/trash/a.txt", confirmed: true });
      assert.notEqual(ran.isError, true);
      assert.equal(ctx.changes().length, 1);
      assert.equal(ctx.lastAudit().approval.channel, "model");
      assert.match(ctx.stderr, /PROTON_DRIVE_APPROVAL=model/);
    });
    await withServer({ approval: "model", replies: [ACCEPT, DECLINE] }, async (ctx) => {
      const up = await ctx.call("drive_delete", { path: "/trash/a.txt", confirmed: false });
      assert.notEqual(up.isError, true);
      assert.equal(ctx.changes().length, 1);
      const no = await ctx.call("drive_delete", { path: "/trash/b.txt", confirmed: false });
      assert.equal(no.isError, true);
      assert.equal(ctx.changes().length, 1);
    });
    // accepting an invitation and copying into /shared-with-me are not gated in model mode
    await withServer({ approval: "model", caps: {} }, async (ctx) => {
      assert.notEqual((await ctx.call("drive_invitation_accept", { uid: "u" })).isError, true);
      assert.notEqual((await ctx.call("drive_copy", { sourcePath: "/my-files/a", destinationPath: "/shared-with-me/t" })).isError, true);
    });
  });

  it("an unknown value is strict, with a warning", async () => {
    await withServer({ approval: "nonsense", replies: [DECLINE] }, async (ctx) => {
      assert.equal((await ctx.call("drive_trash", { path: "/my-files/a.txt" })).isError, true); // strict asks even for a trash
      assert.equal(ctx.asked, 1);
      assert.match(ctx.stderr, /Unknown PROTON_DRIVE_APPROVAL/);
    });
  });

  it("an extra argument such as approved or token is rejected by schema validation and never read", async () => {
    await withServer({ replies: () => DECLINE }, async (ctx) => {
      for (const extra of [{ approved: true }, { approval: "x" }, { token: "t" }, { code: "ABCD-EFGH" }]) {
        const r = await ctx.call("drive_empty_trash", extra);
        assert.equal(r.isError, true);
        assert.match(text(r), /Unknown argument/);
      }
      assert.equal(ctx.asked, 0);
    });
  });
});

// ---- tool texts per mode -----------------------------------------------------------------------------------------------
describe("tools/list per mode", () => {
  const list = (approval) => withServer({ approval, caps: {} }, async (ctx) => (await ctx.client.listTools()).tools);

  it("58 tools in every mode; human/strict stop telling the model to pass confirmed=true and no longer require it", async () => {
    const model = await list("model");
    for (const mode of ["human", "strict"]) {
      const tools = await list(mode);
      assert.equal(tools.length, 58);
      assert.deepEqual(tools.map((t) => t.name), model.map((t) => t.name));
      for (const t of tools) {
        const where = `${mode} ${t.name}`;
        assert.ok(!(t.inputSchema.required ?? []).includes("confirmed"), where);
        if (["drive_bulk_move", "drive_bulk_trash", "drive_cleanup"].includes(t.name)) {
          assert.match(t.description, /Without confirmed: plan/);
          assert.match(t.description, /asks the user to approve the exact list/);
          assert.ok(t.inputSchema.properties.confirmed, where);
          continue;
        }
        assert.doesNotMatch(t.description, /confirmed=true|Requires confirmed|unless confirmed/, where);
        assert.doesNotMatch(JSON.stringify(t.inputSchema.properties.confirmed ?? {}), /Must be true/, where);
      }
      for (const t of ["drive_delete", "drive_empty_trash", "drive_share_remove_all", "photos_delete_album", "drive_share_invite", "drive_upload", "drive_write_file"]) {
        const d = tools.find((x) => x.name === t);
        assert.match(d.description, /server asks the user|server first asks|approval, which the server asks for itself/, t);
      }
      assert.ok(tools.find((t) => t.name === "drive_delete").inputSchema.properties.confirmed, "confirmed stays in the schema");
    }
    // model mode keeps the 1.10.1 schemas
    assert.deepEqual(model.find((t) => t.name === "drive_delete").inputSchema.required, ["confirmed"]);
    assert.match(model.find((t) => t.name === "drive_delete").description, /Requires confirmed=true/);
  });

  it("annotations and titles are the same in every mode", async () => {
    const [m, h] = [await list("model"), await list("human")];
    for (let i = 0; i < m.length; i++) {
      assert.deepEqual(h[i].annotations, m[i].annotations, m[i].name);
      assert.equal(h[i].title, m[i].title, m[i].name);
    }
  });

  it("the prompts no longer tell the model to set confirmed", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      const r = await ctx.client.getPrompt({ name: "organise-folder", arguments: { path: "/my-files/Docs" } });
      assert.doesNotMatch(r.messages[0].content.text, /confirmed=true/);
    });
  });
});

// ---- the prompt text is composed by the server -------------------------------------------------------------------------
describe("what the human is shown", () => {
  it("is built from the validated operation: first line fixed, secrets never shown, link state read first", async () => {
    await withServer({ replies: () => DECLINE, fakeMode: "json", env: { FAKE_STDOUT: JSON.stringify({ urlAccess: { url: "https://x/y", customPassword: "pw", expirationTime: "2027-01-01T00:00:00Z", role: "viewer" } }) } }, async (ctx) => {
      await ctx.call("drive_share_set_url", { path: "/my-files/p", role: "editor", password: "hunter2-secret", expiration: "2027-01-01T00:00:00Z" });
      const msg = ctx.messages[0];
      assert.match(msg, /^drive_share_set_url: create or replace a PUBLIC link \(/);
      assert.match(msg, /^replaces an existing link: yes$/m);
      assert.match(msg, /^password: set$/m);
      assert.match(msg, /^role: editor$/m);
      assert.doesNotMatch(msg, /hunter2/);
    });
    await withServer({ replies: () => DECLINE }, async (ctx) => {
      await ctx.call("drive_share_set_url", { path: "/my-files/p" });
      assert.match(ctx.messages[0], /^replaces an existing link: no$/m);
      await ctx.call("drive_share_invite", { path: "/my-files/p", email: "a@example.org", role: "viewer", message: "secret note" });
      assert.match(ctx.messages[1], /^message: 11 characters$/m);
      assert.doesNotMatch(ctx.messages[1], /secret note/);
    });
  });

  it("a name with a newline, a bidi override or an ANSI escape cannot forge or reorder a line", async () => {
    // Control characters (newline, ESC) are already refused by path validation; bidi and zero-width characters are not.
    const evil = "/my-files/a\u202Efdp.exe\u200b\u2066";
    await withServer({ replies: () => DECLINE }, async (ctx) => {
      await ctx.call("drive_share_remove_all", { path: evil });
      const lines = ctx.messages[0].split("\n");
      assert.equal(lines.length, 2);
      assert.equal(lines[1], "path: /my-files/a\\u202efdp.exe\\u200b\\u2066");
      const bad = await ctx.call("drive_share_remove_all", { path: "/my-files/a\nrole: viewer" });
      assert.equal(bad.isError, true);
      assert.equal(ctx.asked, 1); // refused by validation before any question
    });
  });

  it("the write_file prompt shows the size, not the content", async () => {
    await withServer({ setup: syncSetup, replies: () => DECLINE }, async (ctx) => {
      await ctx.call("drive_write_file", { path: "/my-files/notes.txt", content: "top secret é" });
      assert.match(ctx.messages[0], /^content: 13 bytes$/m);
      assert.match(ctx.messages[0], /^overwrites an existing file: yes$/m);
      assert.doesNotMatch(ctx.messages[0], /top secret/);
    });
  });
});

// ---- /shared-with-me normalisation -------------------------------------------------------------------------------------
describe("/shared-with-me is recognised however the path is written", () => {
  it("underShared normalises empty and '.' segments and ignores case", () => {
    for (const p of ["/shared-with-me", "/shared-with-me/x", "//shared-with-me/x", "/Shared-With-Me/x", "/./shared-with-me/x", "///SHARED-WITH-ME", "/shared-with-me/../x"]) {
      assert.equal(underShared(p), true, p);
    }
    for (const p of ["/my-files/shared-with-me/x", "/shared-with-me-not", "/shared-with-mex/x", "/", "", "/my-files"]) {
      assert.equal(underShared(p), false, p);
    }
  });

  for (const dest of ["//shared-with-me/t", "/Shared-With-Me/t", "///SHARED-WITH-ME/t"]) {
    it(`drive_copy into ${dest} prompts and a decline stops it`, async () => {
      await withServer({ replies: [DECLINE] }, async (ctx) => {
        const r = await ctx.call("drive_copy", { sourcePath: "/my-files/a.txt", destinationPath: dest });
        assert.equal(r.isError, true);
        assert.equal(ctx.asked, 1);
        assert.deepEqual(ctx.changes(), []);
      });
    });
  }

  it("trash, restore, rename and move out of /shared-with-me prompt as 'outward'; the same on /my-files do not", async () => {
    await withServer({ replies: () => DECLINE }, async (ctx) => {
      await ctx.call("drive_trash", { path: "/shared-with-me/t/a.txt" });
      await ctx.call("drive_move", { sourcePath: "/shared-with-me/t/a.txt", destinationPath: "/my-files/a.txt" });
      await ctx.call("drive_rename", { path: "/shared-with-me/t/a.txt", newName: "b.txt" });
      assert.equal(ctx.asked, 3);
      for (const m of ctx.messages) assert.match(m.split("\n")[0], /\(affects other people/);
      assert.deepEqual(ctx.changes(), []);
    });
    await withServer({ replies: () => DECLINE }, async (ctx) => {
      await ctx.call("drive_trash", { path: "/my-files/a.txt" });
      await ctx.call("drive_move", { sourcePath: "/my-files/a.txt", destinationPath: "/my-files/b.txt" });
      await ctx.call("drive_rename", { path: "/my-files/a.txt", newName: "b.txt" });
      await ctx.call("drive_restore", { path: "/trash/a.txt" });
      assert.equal(ctx.asked, 0);
      assert.equal(ctx.changes().length, 4);
    });
  });

  it("the invitation chain: accept, then copy into /shared-with-me, both prompt", async () => {
    await withServer({ replies: [ACCEPT, ACCEPT] }, async (ctx) => {
      assert.notEqual((await ctx.call("drive_invitation_accept", { uid: "inv-1" })).isError, true);
      assert.equal(ctx.asked, 1);
      assert.match(ctx.messages[0], /^drive_invitation_accept: /);
      assert.notEqual((await ctx.call("drive_copy", { sourcePath: "/my-files/secret.txt", destinationPath: "/shared-with-me/attacker" })).isError, true);
      assert.equal(ctx.asked, 2);
      assert.match(ctx.messages[1], /^drive_copy: /);
      assert.match(ctx.messages[1], /\(affects other people/);
    });
    await withServer({ replies: [DECLINE] }, async (ctx) => {
      const r = await ctx.call("drive_invitation_accept", { uid: "inv-1", confirmed: true });
      assert.equal(r.isError, true);
      assert.deepEqual(ctx.changes(), []);
    });
  });
});

// ---- bulk: the plan after approval must equal the approved plan --------------------------------------------------------
describe("A6: bulk apply is bound to the approved plan", () => {
  for (const [tool, args] of [
    ["drive_bulk_trash", { paths: ["/my-files/s/x.txt"], confirmed: true }],
    ["drive_bulk_move", { sources: ["/my-files/s/x.txt"], destinationFolder: "/my-files/d", confirmed: true }],
  ]) {
    it(`${tool}: Drive changes while the prompt is open, nothing is applied (approval_changed)`, async () => {
      let treeFile;
      await withServer({
        setup: (sb) => { const e = treeSetup(sb); treeFile = e.FAKE_TREE; return e; }, fakeMode: "tree",
        replies: () => { writeFileSync(treeFile, JSON.stringify({ "/my-files/s": [], "/my-files/d": [] })); return ACCEPT; },
      }, async (ctx) => {
        const r = await ctx.call(tool, args);
        assert.equal(r.isError, true);
        assert.match(text(r), /Drive changed after the user approved/);
        assert.deepEqual(ctx.changes(), []);
        assert.equal(ctx.lastAudit().code, "approval_changed");
        assert.equal(ctx.asked, 1);
      });
    });

    it(`${tool}: an unchanged plan is applied once, the prompt lists every path`, async () => {
      await withServer({ setup: treeSetup, fakeMode: "tree", replies: () => ACCEPT }, async (ctx) => {
        const r = await ctx.call(tool, args);
        assert.notEqual(r.isError, true, text(r));
        assert.equal(ctx.changes().length, 1);
        assert.match(ctx.messages[0], /\/my-files\/s\/x\.txt/);
        assert.equal(ctx.lastAudit().approval.channel, "elicitation");
      });
    });
  }
});

// ---- drive_write_file: a file that appears between the check and the write is never overwritten without the gate ---------
describe("drive_write_file race", () => {
  it("a new file is created exclusively; a file that appeared meanwhile goes through the gate", async () => {
    // new file in human mode: no prompt, created
    await withServer({ setup: syncSetup, caps: {} }, async (ctx) => {
      const r = await ctx.call("drive_write_file", { path: "/my-files/new.txt", content: "hello" });
      assert.notEqual(r.isError, true, text(r));
      assert.equal(readFileSync(join(ctx.dir, "sync", "new.txt"), "utf8"), "hello");
      assert.equal(ctx.lastAudit().approval, undefined);
    });
  });

  it("the exclusive-create primitive refuses an existing file and leaves it alone", async () => {
    const { writeSyncFile, SyncFileExistsError } = await import("../dist/utils/syncfs.js");
    await withServer({ setup: syncSetup, caps: {} }, async (ctx) => {
      const root = join(ctx.dir, "sync");
      await assert.rejects(writeSyncFile(root, "/my-files/notes.txt", "overwritten", { exclusive: true }), SyncFileExistsError);
      assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "old");
      await writeSyncFile(root, "/my-files/fresh.txt", "ok", { exclusive: true });
      assert.equal(readFileSync(join(root, "fresh.txt"), "utf8"), "ok");
      await writeSyncFile(root, "/my-files/notes.txt", "plain");
      assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "plain");
    });
  });

  it("existing file: prompt, decline keeps it, accept overwrites it", async () => {
    await withServer({ setup: syncSetup, replies: [DECLINE, ACCEPT] }, async (ctx) => {
      const file = join(ctx.dir, "sync", "notes.txt");
      const no = await ctx.call("drive_write_file", { path: "/my-files/notes.txt", content: "changed", confirmed: true });
      assert.equal(no.isError, true);
      assert.equal(readFileSync(file, "utf8"), "old");
      const yes = await ctx.call("drive_write_file", { path: "/my-files/notes.txt", content: "changed" });
      assert.notEqual(yes.isError, true, text(yes));
      assert.equal(readFileSync(file, "utf8"), "changed");
    });
  });

  it("the file appears after the existence check (strict mode: during the first prompt): the second write is asked about again", async () => {
    let sync;
    await withServer({
      setup: (sb) => { const e = syncSetup(sb); sync = e.PROTON_DRIVE_SYNC_PATH; return e; },
      approval: "strict",
      replies: (_m, i) => { if (i === 0) writeFileSync(join(sync, "late.txt"), "someone else's"); return i === 0 ? ACCEPT : DECLINE; },
    }, async (ctx) => {
      const r = await ctx.call("drive_write_file", { path: "/my-files/late.txt", content: "mine" });
      assert.equal(r.isError, true);
      assert.equal(ctx.asked, 2);
      assert.match(ctx.messages[1], /^overwrites an existing file: yes$/m);
      assert.equal(readFileSync(join(sync, "late.txt"), "utf8"), "someone else's");
    });
  });
});

// ---- channel 2: out-of-band approval through the store (client without elicitation) ----------------------------------------
describe("approval store channel", () => {
  it("first call: approval_required with a code; approved in the store: second call runs once; third call is refused", async () => {
    await withServer({ caps: {} }, async (ctx) => {
      const dir = join(ctx.dir, "approvals");
      const args = { path: "/my-files/p", email: "a@example.org", role: "viewer" };
      const first = await ctx.call("drive_share_invite", args);
      assert.equal(first.isError, true);
      const code = /approve ([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(text(first))?.[1];
      assert.ok(code, text(first));
      assert.deepEqual(ctx.changes(), []);
      // a different operation does not ride on this approval
      const store = createApprovalStore({ dir });
      const rec = store.get(code);
      assert.equal(rec.tool, "drive_share_invite");
      assert.match(rec.summary, /^drive_share_invite: /);
      assert.match(rec.summary, /^email: a@example\.org$/m);
      store.approve(code);
      const other = await ctx.call("drive_share_invite", { ...args, role: "editor" });
      assert.equal(other.isError, true);
      assert.deepEqual(ctx.changes(), []);
      const second = await ctx.call("drive_share_invite", args);
      assert.notEqual(second.isError, true, text(second));
      assert.equal(ctx.changes().length, 1);
      const entry = ctx.lastAudit();
      assert.equal(entry.approval.channel, "cli");
      assert.equal(entry.approval.code, code);
      const third = await ctx.call("drive_share_invite", args);
      assert.equal(third.isError, true);
      assert.equal(ctx.changes().length, 1);
      assert.equal(ctx.lastAudit().code, "approval_required");
    });
  });

  it("the store is not created for a client that can elicit, nor in model mode", async () => {
    for (const [approval, caps] of [["human", { elicitation: { form: {} } }], ["model", {}]]) {
      await withServer({ approval, caps, replies: () => DECLINE }, async (ctx) => {
        await ctx.call("drive_delete", { path: "/trash/a.txt", confirmed: approval === "model" });
        assert.equal(existsSync(join(ctx.dir, "approvals")), false, approval);
      });
    }
  });

  it("an unusable approvals folder refuses with approval_required and runs nothing", async () => {
    await withServer({ caps: {}, setup: (sb) => { writeFileSync(join(sb.dir, "blocker"), "x"); return { PROTON_DRIVE_APPROVAL_DIR: join(sb.dir, "blocker", "sub") }; } }, async (ctx) => {
      const r = await ctx.call("drive_delete", { path: "/trash/a.txt", confirmed: true });
      assert.equal(r.isError, true);
      assert.deepEqual(ctx.changes(), []);
      assert.match(ctx.lastAudit().code, /^approval_(required|unavailable)$/);
    });
  });
});

// ---- audit: the chain and the 1.10.1 format ----------------------------------------------------------------------------
describe("audit log with approval entries", () => {
  it("refusal codes and approval fields are recorded and the chain verifies", async () => {
    await withServer({ replies: [DECLINE, ACCEPT, THROWS] }, async (ctx) => {
      await ctx.call("drive_empty_trash", {});
      await ctx.call("drive_empty_trash", {});
      await ctx.call("drive_empty_trash", {});
      const entries = ctx.audit();
      assert.deepEqual(entries.map((e) => [e.outcome, e.code]), [["refused", "approval_declined"], ["ok", undefined], ["refused", "approval_required"]]);
      assert.equal(entries[1].approval.channel, "elicitation");
      assert.equal(entries[0].approval, undefined);
      const v = new AuditLog(ctx.auditFile).verify();
      assert.equal(v.ok, true, JSON.stringify(v));
      assert.equal(v.entries, 3);
    });
  });

  it("a log written by 1.10.1 (no approval field) still verifies, and new entries chain onto it", async () => {
    // Fixed fixture: three entries in the 1.10.1 format (hash = sha256(prev + canonical JSON of the entry without its hash)).
    const OLD_LOG = [
      '{"ts":"2026-11-10T09:00:00.000Z","seq":1,"tool":"drive_delete","args":{"path":"/trash/a.txt","confirmed":true},"outcome":"ok","durationMs":12,"prev":"0000000000000000000000000000000000000000000000000000000000000000","hash":"e2a2b6f689f53c94f427e8050b0f063e384f18d3468f7a228d18d46d3e422358"}',
      '{"ts":"2026-11-10T09:00:01.000Z","seq":2,"tool":"drive_empty_trash","args":{"confirmed":false},"outcome":"refused","code":"confirm","durationMs":1,"prev":"e2a2b6f689f53c94f427e8050b0f063e384f18d3468f7a228d18d46d3e422358","hash":"304ac6118e258baf30d5457f59a689a849b2daebd12e1dd1cc4c1b45865cc429"}',
      '{"ts":"2026-11-10T09:00:02.000Z","seq":3,"tool":"drive_trash","args":{"path":"/my-files/x"},"outcome":"ok","durationMs":40,"prev":"304ac6118e258baf30d5457f59a689a849b2daebd12e1dd1cc4c1b45865cc429","hash":"db7bce1eaaabe52e264ec20c39e48b6c592c05f83676926216f8a1f7d4fbdc3f"}',
    ];
    const prev = "db7bce1eaaabe52e264ec20c39e48b6c592c05f83676926216f8a1f7d4fbdc3f";
    const lines = OLD_LOG;
    await withServer({ caps: {}, replies: [] }, async (ctx) => {
      mkdirSync(join(ctx.dir, "audit"), { recursive: true });
      writeFileSync(ctx.auditFile, lines.join("\n") + "\n");
      const log = new AuditLog(ctx.auditFile);
      assert.deepEqual(log.verify(), { ok: true, entries: 3, head: prev });
      await ctx.call("drive_trash", { path: "/my-files/y" });
      const v = log.verify();
      assert.equal(v.ok, true, JSON.stringify(v));
      assert.equal(v.entries, 4);
      // tampering with an old entry still breaks the chain
      writeFileSync(ctx.auditFile, readFileSync(ctx.auditFile, "utf8").replace("/trash/a.txt", "/trash/b.txt"));
      assert.equal(log.verify().ok, false);
    });
  });
});
