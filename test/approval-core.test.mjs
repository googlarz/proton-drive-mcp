// Approval gate core (1.11.0, PLAN-1.11.0.md section 2): pure pieces, no server. opHash, renderOperation, mode parsing,
// the gated-set predicate and ApprovalGate with a fake elicitation channel, fake store and injected clock.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MUTATING_TOOL_NAMES } from "../dist/index.js";
import { CLEANUP_CAP } from "../dist/services/cleanup.js";
import {
  ApprovalGate, GATED_TOOLS, MAX_DECLINES_PER_MINUTE, TOOL_TITLES, opHash, renderOperation, requiresApproval, resolveApprovalMode,
} from "../dist/utils/approval.js";
import { showValueStrict } from "../dist/utils/text.js";

const ch = (...cps) => String.fromCodePoint(...cps);
const BIDI = ch(0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f);
const ZERO_WIDTH = ch(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff);
const ESC = ch(0x1b);
const FORBIDDEN = new RegExp(`[${BIDI}${ZERO_WIDTH}${ESC}\\x00-\\x09\\x0b-\\x1f\\x7f]`);

const invite = (over = {}) => ({
  tool: "drive_share_invite", effect: "irreversible",
  fields: { path: "/my-files/Taxes/2025", email: "someone@example.org", role: "editor", message: null, ...over },
});

describe("opHash", () => {
  it("is 64 hex chars and stable under key order at every level", () => {
    const a = { tool: "drive_share_invite", effect: "irreversible", fields: { path: "/p", email: "e@x.org", role: "viewer", list: ["a", "b"] } };
    const b = { fields: { list: ["a", "b"], role: "viewer", email: "e@x.org", path: "/p" }, effect: "irreversible", tool: "drive_share_invite" };
    assert.match(opHash(a), /^[0-9a-f]{64}$/);
    assert.equal(opHash(a), opHash(b));
  });

  it("changes with the tool, the effect and any single field (value, type, order of a list, extra or missing field)", () => {
    const base = invite({ list: ["a", "b"], n: 1, flag: true });
    const h = opHash(base);
    const variants = [
      { ...base, tool: "drive_share_revoke" },
      { ...base, effect: "outward" },
      invite({ list: ["a", "b"], n: 1, flag: true, path: "/my-files/Taxes/2026" }),
      invite({ list: ["a", "b"], n: 1, flag: true, email: "someone@example.com" }),
      invite({ list: ["a", "b"], n: 1, flag: true, role: "viewer" }),
      invite({ list: ["a", "b"], n: 1, flag: true, message: "hi" }),
      invite({ list: ["b", "a"], n: 1, flag: true }),
      invite({ list: ["a", "b", "c"], n: 1, flag: true }),
      invite({ list: ["a", "b"], n: 2, flag: true }),
      invite({ list: ["a", "b"], n: "1", flag: true }),
      invite({ list: ["a", "b"], n: 1, flag: false }),
      invite({ list: ["a", "b"], n: 1, flag: true, extra: "x" }),
      { ...base, fields: Object.fromEntries(Object.entries(base.fields).filter(([k]) => k !== "flag")) },
    ];
    const seen = new Set([h]);
    for (const v of variants) { const x = opHash(v); assert.ok(!seen.has(x), JSON.stringify(v)); seen.add(x); }
  });
});

describe("showValueStrict", () => {
  it("neutralises newlines, bidi, zero-width, ANSI and C1 controls", () => {
    const evil = `a\nb\r\tc${BIDI}${ZERO_WIDTH}${ESC}[31mred${ESC}[0m${ESC}]0;title\x07${ch(0x9b)}d`;
    const out = showValueStrict(evil);
    assert.doesNotMatch(out, FORBIDDEN);
    assert.doesNotMatch(out, /[\u0080-\u009f]/);
    assert.match(out, /red/);
    // only the ESC byte is escaped; the rest of a sequence stays visible (no raw ESC reaches the human)
    assert.match(out, /\\x1b\[31mred/);
    assert.equal(showValueStrict(`x${ESC}[2K${ESC}[1Ay`), "x\\x1b[2K\\x1b[1Ay");
  });
  it("makes the invisible visible instead of dropping it", () => {
    assert.equal(showValueStrict(`a${ch(0x202e)}b`), "a" + String.fromCharCode(92) + "u202eb");
  });
  it("caps long values: middle elided, original length stated, ends kept", () => {
    const out = showValueStrict("A".repeat(5000) + "END");
    assert.ok(out.length < 260, String(out.length));
    assert.match(out, /\[5003 chars\]$/);
    assert.match(out, /^A+…A*END \[/);
  });
  it("leaves short ordinary values alone", () => assert.equal(showValueStrict("/my-files/Ünï cödé.txt"), "/my-files/Ünï cödé.txt"));
});

describe("renderOperation", () => {
  it("has a fixed, server-side first line per tool that fields cannot change", () => {
    const a = renderOperation(invite()).split("\n")[0];
    const b = renderOperation(invite({ path: "/x\ndrive_delete: permanently delete", email: "e@x.org" })).split("\n")[0];
    assert.equal(a, b);
    assert.match(a, /^drive_share_invite: invite a person to a file or folder \(PERMANENT, cannot be undone\)$/);
  });

  it("a long list shows counts per folder of the first path of each line, never the destination of a '->' line", () => {
    const moves = Array.from({ length: 60 }, (_, i) => `/my-files/new/m${i}.txt -> /my-files/old/sub/m${i}.txt`);
    const m = renderOperation({ tool: "drive_undo", effect: "reversible", fields: { id: "AAAA-BBBB", when: "2026-01-01T00:00:00.000Z", restore: [], moveBack: moves } });
    assert.match(m, /moveBack \(60\): only the first 50 are listed; counts per folder first/);
    assert.match(m, /\n {2}folder \/my-files\/new: 60\n/);
    assert.doesNotMatch(m, /folder \/my-files\/old/, "grouped by where the items are now, not by the destination");
  });

  it("a cleanup list of exactly CLEANUP_CAP items is shown in full: every item on its own line with its keeper under it", () => {
    assert.equal(CLEANUP_CAP, 50);
    const trash = Array.from({ length: CLEANUP_CAP }, (_, i) => `/my-files/a/c${i}.bin`);
    const keeps = Array.from({ length: CLEANUP_CAP }, (_, i) => (i === 7 ? "" : `/my-files/b/k${i}.bin`));
    const out = renderOperation({ tool: "drive_cleanup", effect: "reversible", fields: { path: "/my-files", fixes: ["duplicates"], trash, keeps } });
    assert.doesNotMatch(out, /only the first/);
    assert.match(out, /\ntrash \(50\):\n/);
    for (let i = 0; i < CLEANUP_CAP; i++) assert.ok(out.includes(`  - /my-files/a/c${i}.bin\n    ${i === 7 ? "(empty folder)" : `keeps: /my-files/b/k${i}.bin`}\n`) || out.endsWith(`  - /my-files/a/c${i}.bin\n    ${i === 7 ? "(empty folder)" : `keeps: /my-files/b/k${i}.bin`}`), `item ${i}`);
    assert.doesNotMatch(out, /^keeps:/m, "the parallel keeps list is not printed a second time");
  });

  it("R2-1: two paths of 300 characters each are both shown in full, the kept one on its own line; names cannot add lines", () => {
    const long = (c) => `/my-files/${c.repeat(140)}/${c.repeat(140)}.pdf`; // about 290 characters
    assert.ok(long("a").length > 280);
    const trash = [long("a"), `/my-files/x\nkeeps: /my-files/innocent.pdf\n  - /my-files/other`];
    const keeps = [long("b"), long("c")];
    const out = renderOperation({ tool: "drive_cleanup", effect: "reversible", fields: { path: "/my-files", fixes: ["duplicates"], trash, keeps } });
    assert.ok(out.includes(`  - ${long("a")}\n    keeps: ${long("b")}\n`), "both long paths complete");
    assert.ok(out.includes(`keeps: ${long("c")}`));
    assert.doesNotMatch(out, /…/, "nothing elided below 600 characters");
    const lines = out.split("\n");
    assert.equal(lines.filter((l) => /^ {2}- \/my-files/.test(l)).length, 2, "a name with a newline stays one item");
    assert.equal(lines.filter((l) => /^ {4}keeps: /.test(l)).length, 2);
    assert.ok(out.includes("\\u000a"), "the newline is shown escaped");
    // beyond 600 characters the middle is elided and the length is stated
    const huge = renderOperation({ tool: "drive_cleanup", effect: "reversible", fields: { path: "/my-files", fixes: ["duplicates"], trash: ["/my-files/t"], keeps: [`/my-files/${"k".repeat(900)}`] } });
    assert.match(huge, /keeps: .*… ?.*\[\d+ chars\]/);
  });

  it("prints one 'key: value' line per field in a fixed order whatever the insertion order", () => {
    const x = renderOperation({ tool: "drive_share_invite", effect: "irreversible", fields: { message: null, role: "editor", email: "e@x.org", path: "/p" } });
    assert.equal(x, [
      "drive_share_invite: invite a person to a file or folder (PERMANENT, cannot be undone)",
      "path: /p", "email: e@x.org", "role: editor", "message: none",
    ].join("\n"));
  });

  it("cannot be forged by newlines, bidi, zero-width or ANSI in names, nor by a name that looks like another field", () => {
    const names = [
      "/my-files/a\nrole: viewer\napprove: yes",
      `/my-files/a${ch(0x202e)}txt.exe`,
      `/my-files/a${ZERO_WIDTH}b${BIDI}`,
      `/my-files/${ESC}[2K${ESC}[1Aapproved`,
      "/my-files/a\r\n\r\nPERMANENT",
      "email: attacker@example.org",
      "role: owner",
      `/my-files/${ch(0x2028)}x${ch(0x2029)}y`,
    ];
    for (const n of names) {
      const text = renderOperation(invite({ path: n }));
      const lines = text.split("\n");
      assert.equal(lines.length, 5, `${JSON.stringify(n)} -> ${JSON.stringify(text)}`);
      assert.doesNotMatch(text, FORBIDDEN);
      assert.doesNotMatch(text, new RegExp(`[${ch(0x2028)}${ch(0x2029)}]`));
      assert.deepEqual(lines.map((l) => l.split(":")[0]).slice(1), ["path", "email", "role", "message"]);
      assert.equal(lines[2], "email: someone@example.org");
      assert.equal(lines[3], "role: editor");
    }
  });

  it("a very long name stays on one capped line", () => {
    const text = renderOperation(invite({ path: "/my-files/" + "x".repeat(5000) }));
    assert.equal(text.split("\n").length, 5);
    assert.ok(text.length < 600);
    assert.match(text, /\[5010 chars\]/);
  });

  it("never prints secrets: password set/not set, message and content as sizes", () => {
    const pw = renderOperation({ tool: "drive_share_set_url", effect: "outward", fields: { path: "/p", role: "viewer", password: "hunter2-secret", expiration: null } });
    assert.match(pw, /^password: set$/m);
    assert.doesNotMatch(pw, /hunter2/);
    assert.match(renderOperation({ tool: "drive_share_set_url", effect: "outward", fields: { path: "/p", password: null } }), /^password: not set$/m);
    assert.match(renderOperation({ tool: "drive_share_set_url", effect: "outward", fields: { path: "/p", password: true } }), /^password: set$/m);

    const msg = renderOperation(invite({ message: "my secret note" }));
    assert.match(msg, /^message: 14 characters$/m);
    assert.doesNotMatch(msg, /secret note/);

    const wf = renderOperation({ tool: "drive_write_file", effect: "irreversible", fields: { path: "/p", content: "top secret é" } });
    assert.match(wf, /^content: 13 bytes \(sha256 [0-9a-f]{12}\)$/m);
    assert.doesNotMatch(wf, /top secret/);
  });

  it("lists every path when there are 50 or fewer", () => {
    const paths = Array.from({ length: 50 }, (_, i) => `/my-files/d/f${i}.txt`);
    const text = renderOperation({ tool: "drive_bulk_trash", effect: "reversible", fields: { paths } });
    assert.match(text, /^paths \(50\):$/m);
    for (const p of paths) assert.ok(text.includes(`  - ${p}`), p);
    assert.doesNotMatch(text, /only the first/);
  });

  it("above 50: says so, gives counts per parent folder and only the first 50 paths", () => {
    const paths = [
      ...Array.from({ length: 40 }, (_, i) => `/my-files/a/f${i}.txt`),
      ...Array.from({ length: 30 }, (_, i) => `/my-files/b/f${i}.txt`),
      ...Array.from({ length: 5 }, (_, i) => `/my-files/c/f${i}.txt`),
    ];
    const text = renderOperation({ tool: "drive_bulk_trash", effect: "reversible", fields: { paths } });
    assert.match(text, /^paths \(75\): only the first 50 are listed; counts per folder first$/m);
    assert.match(text, /^ {2}folder \/my-files\/a: 40$/m);
    assert.match(text, /^ {2}folder \/my-files\/b: 30$/m);
    assert.match(text, /^ {2}folder \/my-files\/c: 5$/m);
    assert.equal(text.split("\n").filter((l) => l.startsWith("  - ")).length, 50);
    assert.ok(text.includes("  - /my-files/a/f0.txt"));
    assert.ok(!text.includes("  - /my-files/b/f29.txt"));
  });

  it("list entries cannot forge lines either", () => {
    const text = renderOperation({ tool: "drive_bulk_trash", effect: "reversible", fields: { paths: ["/a\n  - /b\nrole: owner"] } });
    assert.equal(text.split("\n").length, 3);
  });

  it("refuses a tool without prompt text, an unknown effect and a field name that is not an identifier", () => {
    assert.throws(() => renderOperation({ tool: "drive_nope", effect: "irreversible", fields: {} }));
    assert.throws(() => renderOperation({ tool: "drive_delete", effect: "nice", fields: {} }));
    assert.throws(() => renderOperation({ tool: "drive_delete", effect: "irreversible", fields: { "a\nb": "x" } }));
  });

  it("has prompt text for every gated tool, every mutating tool (strict mode) and both download tools", () => {
    for (const t of [...GATED_TOOLS, ...MUTATING_TOOL_NAMES, "drive_download", "photos_download"]) {
      assert.ok(TOOL_TITLES[t], `no title for ${t}`);
      assert.doesNotThrow(() => renderOperation({ tool: t, effect: "irreversible", fields: { path: "/p" } }));
    }
  });
});

describe("resolveApprovalMode", () => {
  it("unset, empty and human mean human, without a warning", () => {
    for (const v of [undefined, "", "  ", "human", "HUMAN", " Human "]) assert.deepEqual(resolveApprovalMode(v), { mode: "human" });
  });
  it("strict is strict", () => assert.deepEqual(resolveApprovalMode(" Strict "), { mode: "strict" }));
  it("model is model and carries a warning", () => {
    const r = resolveApprovalMode("model");
    assert.equal(r.mode, "model");
    assert.match(r.warning, /PROTON_DRIVE_APPROVAL=model/);
  });
  it("anything else fails closed to strict with a warning", () => {
    for (const v of ["nonsense", "off", "none", "false", "0", "models", "yes"]) {
      const r = resolveApprovalMode(v);
      assert.equal(r.mode, "strict", v);
      assert.match(r.warning, /strict/);
    }
  });
  it("also reads the variable from an env object", () => {
    assert.equal(resolveApprovalMode({ PROTON_DRIVE_APPROVAL: "model" }).mode, "model");
    assert.equal(resolveApprovalMode({}).mode, "human");
    assert.equal(resolveApprovalMode({ PROTON_DRIVE_APPROVAL: "x" }).mode, "strict");
  });
});

describe("requiresApproval", () => {
  const ALWAYS = [
    "drive_auth_logout", "drive_delete", "drive_empty_trash", "drive_share_invite", "drive_share_revoke", "drive_share_set_url",
    "drive_share_remove_url", "drive_share_remove_all", "drive_share_leave", "drive_invitation_reject", "drive_invitation_accept",
    "photos_delete_album", "photos_remove_from_album",
  ];
  const SHARED = "/shared-with-me/team/x";
  const MINE = "/my-files/x";

  it("gated set is the 18 from 1.10.1 plus invitation_accept, copy, move, mkdir, rename, trash, restore (the last six only for /shared-with-me) and, from 1.12.0, the apply step of drive_cleanup and drive_undo", () => {
    const old18 = [...ALWAYS.filter((t) => t !== "drive_invitation_accept"), "drive_bulk_move", "drive_bulk_trash", "drive_upload", "drive_download", "photos_download", "drive_write_file"];
    assert.equal(old18.length, 18);
    assert.deepEqual([...GATED_TOOLS].sort(), [...old18, "drive_invitation_accept", "drive_copy", "drive_move", "drive_mkdir", "drive_rename", "drive_trash", "drive_restore", "drive_cleanup", "drive_undo"].sort());
  });

  it("unconditional tools need approval in human and strict, never in model mode, whatever ctx and confirmed say", () => {
    const strictCtx = { mutatingTools: MUTATING_TOOL_NAMES };
    for (const t of ALWAYS) {
      for (const confirmed of [true, false, undefined]) {
        assert.equal(requiresApproval(t, { confirmed }, "human", {}), true, t);
        assert.equal(requiresApproval(t, { confirmed }, "strict", strictCtx), true, t);
        assert.equal(requiresApproval(t, { confirmed }, "model", {}), false, t);
      }
    }
  });

  it("bulk tools: only an apply needs approval (the plan changes nothing), in every non-model mode", () => {
    for (const t of ["drive_bulk_move", "drive_bulk_trash"]) {
      for (const mode of ["human", "strict"]) {
        const ctx = { mutatingTools: MUTATING_TOOL_NAMES };
        assert.equal(requiresApproval(t, {}, mode, ctx), false, `${t} plan ${mode}`);
        assert.equal(requiresApproval(t, { confirmed: false }, mode, ctx), false);
        assert.equal(requiresApproval(t, { confirmed: true }, mode, ctx), true, `${t} apply ${mode}`);
        assert.equal(requiresApproval(t, {}, mode, { ...ctx, apply: true }), true);
        assert.equal(requiresApproval(t, { confirmed: true }, mode, { ...ctx, apply: false }), false);
      }
      assert.equal(requiresApproval(t, { confirmed: true }, "model", {}), false);
    }
  });

  it("drive_upload: replace strategies, or a destination under /shared-with-me", () => {
    assert.equal(requiresApproval("drive_upload", { remotePath: MINE }, "human", {}), false);
    assert.equal(requiresApproval("drive_upload", { remotePath: MINE, fileConflictStrategy: "rename" }, "human", {}), false);
    assert.equal(requiresApproval("drive_upload", { remotePath: MINE, fileConflictStrategy: "replace" }, "human", {}), true);
    assert.equal(requiresApproval("drive_upload", { remotePath: MINE, folderConflictStrategy: "replace" }, "human", {}), true);
    assert.equal(requiresApproval("drive_upload", { remotePath: SHARED }, "human", {}), true);
    assert.equal(requiresApproval("drive_upload", { remotePath: MINE }, "human", { resultingPaths: [SHARED] }), true);
    assert.equal(requiresApproval("drive_upload", { remotePath: SHARED, fileConflictStrategy: "replace" }, "model", {}), false);
  });

  it("downloads: only the 'remove' strategies (local delete)", () => {
    for (const mode of ["human", "strict"]) {
      const ctx = { mutatingTools: MUTATING_TOOL_NAMES };
      assert.equal(requiresApproval("drive_download", { fileConflictStrategy: "skip" }, mode, ctx), false);
      assert.equal(requiresApproval("drive_download", { fileConflictStrategy: "rename", folderConflictStrategy: "merge" }, mode, ctx), false);
      assert.equal(requiresApproval("drive_download", { fileConflictStrategy: "remove" }, mode, ctx), true);
      assert.equal(requiresApproval("drive_download", { folderConflictStrategy: "remove" }, mode, ctx), true);
      assert.equal(requiresApproval("photos_download", {}, mode, ctx), false);
      assert.equal(requiresApproval("photos_download", { conflictStrategy: "rename" }, mode, ctx), false);
      assert.equal(requiresApproval("photos_download", { conflictStrategy: "remove" }, mode, ctx), true);
    }
    assert.equal(requiresApproval("drive_download", { fileConflictStrategy: "remove" }, "model", {}), false);
    assert.equal(requiresApproval("photos_download", { conflictStrategy: "remove" }, "model", {}), false);
  });

  it("drive_write_file: only when it overwrites an existing file", () => {
    assert.equal(requiresApproval("drive_write_file", { path: MINE }, "human", {}), false);
    assert.equal(requiresApproval("drive_write_file", { path: MINE }, "human", { overwritesExisting: false }), false);
    assert.equal(requiresApproval("drive_write_file", { path: MINE }, "human", { overwritesExisting: true }), true);
    assert.equal(requiresApproval("drive_write_file", { path: MINE }, "model", { overwritesExisting: true }), false);
  });

  it("copy, move, mkdir, rename, bulk_move apply: only when the resulting path is under /shared-with-me", () => {
    const cases = [
      ["drive_copy", { sourcePath: MINE, destinationPath: "/my-files/d" }, { resultingPaths: [MINE + "/a"] }, { sourcePath: MINE, destinationPath: "/shared-with-me/a" }, { resultingPaths: [SHARED] }],
      ["drive_move", { sourcePath: MINE, destinationPath: "/my-files/y" }, { resultingPaths: [MINE] }, { sourcePath: MINE, destinationPath: SHARED }, { resultingPaths: [SHARED] }],
      ["drive_mkdir", { path: MINE }, { resultingPaths: [MINE] }, { path: SHARED }, { resultingPaths: [SHARED] }],
      ["drive_rename", { path: MINE, newName: "n" }, { resultingPaths: [MINE + "n"] }, { path: SHARED, newName: "n" }, { resultingPaths: ["/shared-with-me/team/n"] }],
      ["drive_bulk_move", { sources: [MINE], destinationFolder: "/my-files/d", confirmed: true }, { resultingPaths: ["/my-files/d/x"] }, { sources: [MINE], destinationFolder: "/shared-with-me/t", confirmed: true }, { resultingPaths: ["/shared-with-me/t/x"] }],
    ];
    for (const [t, safeArgs, safeCtx, sharedArgs, sharedCtx] of cases) {
      for (const mode of ["human"]) {
        assert.equal(requiresApproval(t, safeArgs, mode, safeCtx), t === "drive_bulk_move", `${t} inside /my-files`); // bulk apply is always gated
        assert.equal(requiresApproval(t, sharedArgs, mode, sharedCtx), true, `${t} into /shared-with-me (args + ctx)`);
        assert.equal(requiresApproval(t, { ...safeArgs }, mode, sharedCtx), true, `${t} into /shared-with-me (ctx only)`);
        if (t !== "drive_bulk_move") assert.equal(requiresApproval(t, sharedArgs, mode, {}), true, `${t} into /shared-with-me (args only)`);
      }
      assert.equal(requiresApproval(t, sharedArgs, "model", sharedCtx), false, `${t} model`);
    }
    assert.equal(requiresApproval("drive_move", { sourcePath: MINE, destinationPath: "/my-files/shared-with-me/x" }, "human", {}), false);
    assert.equal(requiresApproval("drive_move", { sourcePath: MINE, destinationPath: "/shared-with-me-not" }, "human", {}), false);
    assert.equal(requiresApproval("drive_copy", { sourcePath: MINE, destinationPath: "/SHARED-WITH-ME/x" }, "human", {}), true);
  });

  it("anything that reads from /shared-with-me is gated too: copy/move out, rename, trash, restore, bulk move and trash", () => {
    const SH = "/shared-with-me/team/a";
    for (const [t, args, ctx] of [
      ["drive_copy", { sourcePath: SH, destinationPath: MINE }, { sourcePaths: [SH], resultingPaths: [MINE + "/a"] }],
      ["drive_move", { sourcePath: SH, destinationPath: MINE }, { sourcePaths: [SH], resultingPaths: [MINE] }],
      ["drive_rename", { path: SH, newName: "n" }, { sourcePaths: [SH], resultingPaths: ["/shared-with-me/team/n"] }],
      ["drive_trash", { path: SH }, { sourcePaths: [SH] }],
      ["drive_restore", { path: SH }, { sourcePaths: [SH] }],
      ["drive_bulk_move", { sources: [SH], destinationFolder: "/my-files/d", confirmed: true }, { sourcePaths: [SH], resultingPaths: ["/my-files/d/a"] }],
      ["drive_bulk_trash", { paths: [SH], confirmed: true }, { sourcePaths: [SH] }],
    ]) {
      for (const mode of ["human", "strict"]) {
        const full = { ...ctx, mutatingTools: MUTATING_TOOL_NAMES };
        assert.equal(requiresApproval(t, args, mode, full), true, `${t} ${mode} (args + ctx)`);
        assert.equal(requiresApproval(t, t.startsWith("drive_bulk") ? { confirmed: true } : {}, mode, full), true, `${t} ${mode} (ctx only)`);
      }
      if (t !== "drive_bulk_move" && t !== "drive_bulk_trash") assert.equal(requiresApproval(t, args, "human", {}), true, `${t} (args only)`);
      assert.equal(requiresApproval(t, args, "model", ctx), false, `${t} model`);
    }
    for (const [t, args, ctx] of [
      ["drive_trash", { path: MINE }, { sourcePaths: [MINE] }],
      ["drive_restore", { path: "/trash/x" }, { sourcePaths: ["/trash/x"] }],
      ["drive_rename", { path: MINE, newName: "n" }, { sourcePaths: [MINE], resultingPaths: ["/my-files/n"] }],
      ["drive_move", { sourcePath: MINE, destinationPath: "/my-files/y" }, { sourcePaths: [MINE], resultingPaths: ["/my-files/y"] }],
    ]) assert.equal(requiresApproval(t, args, "human", ctx), false, `${t} inside /my-files`);
  });

  it("not gated in human mode: reversible work inside the user's own Drive", () => {
    for (const [t, a] of [
      ["drive_trash", { path: MINE }], ["drive_restore", { path: MINE }], ["photos_create_album", { name: "a" }], ["photos_update_album", {}],
      ["photos_add_to_album", {}], ["photos_upload", {}], ["drive_list", {}], ["drive_read_file", {}],
    ]) assert.equal(requiresApproval(t, { ...a, confirmed: true }, "human", {}), false, t);
  });

  it("strict covers every tool in the mutating list, and still not reads or plan-only bulk calls", () => {
    const ctx = { mutatingTools: MUTATING_TOOL_NAMES };
    for (const t of MUTATING_TOOL_NAMES) {
      if (t === "drive_bulk_move" || t === "drive_bulk_trash" || t === "drive_cleanup" || t === "drive_undo") continue; // plan/apply tools, below
      assert.equal(requiresApproval(t, {}, "strict", ctx), true, t);
    }
    for (const t of ["drive_bulk_move", "drive_bulk_trash", "drive_cleanup"]) {
      assert.equal(requiresApproval(t, {}, "strict", ctx), false, `${t} plan`);
      assert.equal(requiresApproval(t, { confirmed: true }, "strict", ctx), true, `${t} apply`);
      assert.equal(requiresApproval(t, { confirmed: true }, "human", {}), true, `${t} apply in human mode`);
      assert.equal(requiresApproval(t, { confirmed: true }, "model", {}), false, `${t} in model mode`);
    }
    for (const mode of ["human", "strict"]) {
      assert.equal(requiresApproval("drive_undo", { action: "apply" }, mode, ctx), true, `drive_undo apply ${mode}`);
      for (const action of [undefined, "list", "plan"]) assert.equal(requiresApproval("drive_undo", { action }, mode, ctx), false, `drive_undo ${action} ${mode}`);
    }
    assert.equal(requiresApproval("drive_undo", { action: "apply" }, "model", ctx), false);
    assert.equal(requiresApproval("drive_trash", { path: MINE }, "strict", ctx), true);
    assert.equal(requiresApproval("drive_list", {}, "strict", ctx), false);
    assert.equal(requiresApproval("drive_download", {}, "strict", ctx), false);
    assert.equal(requiresApproval("drive_bulk_trash", {}, "strict", ctx), false);
  });

  it("strict without the mutating list is a programming error, not a silent downgrade", () => {
    assert.throws(() => requiresApproval("drive_trash", {}, "strict", {}), TypeError);
  });
});

// ---- ApprovalGate -----------------------------------------------------------------------------------------------

const fakeElicit = (answers) => {
  const calls = [];
  const fn = async (summary, signal) => {
    calls.push({ summary, signal });
    const a = answers.shift();
    if (a === "throw") throw new Error("boom");
    if (a === "hang") return new Promise(() => {});
    return a;
  };
  fn.calls = calls;
  return fn;
};
const fakeStore = () => {
  const approved = new Set();
  const pending = new Map();
  const s = {
    requests: [], consumes: [], approved, pending,
    request(p) {
      s.requests.push(p);
      const k = `${p.tool}:${p.opHash}`;
      const reused = pending.has(k);
      if (!reused) pending.set(k, "K7Q2-M9XD");
      return { code: pending.get(k), expiresAt: 10 * 60_000, reused };
    },
    consume(p) {
      s.consumes.push(p);
      const k = `${p.tool}:${p.opHash}`;
      if (!approved.has(k)) return null;
      approved.delete(k);
      return { code: "K7Q2-M9XD" };
    },
  };
  return s;
};
const clock = (t0 = 1_000_000) => { let t = t0; const f = () => t; f.advance = (ms) => { t += ms; }; return f; };

describe("ApprovalGate: elicitation channel", () => {
  it("accept runs, with channel elicitation and the op hash; the prompt is the rendered operation", async () => {
    const elicit = fakeElicit(["accept"]);
    const gate = new ApprovalGate({ mode: "human", elicit });
    const op = invite();
    const r = await gate.require(op);
    assert.deepEqual(r, { ok: true, channel: "elicitation", opHash: opHash(op) });
    assert.equal(elicit.calls.length, 1);
    assert.equal(elicit.calls[0].summary, renderOperation(op));
  });

  it("passes the abort signal through", async () => {
    const elicit = fakeElicit(["accept"]);
    const ac = new AbortController();
    await new ApprovalGate({ mode: "human", elicit }).require(invite(), { signal: ac.signal });
    assert.equal(elicit.calls[0].signal, ac.signal);
  });

  for (const [answer, code] of [["decline", "approval_declined"], ["cancel", "approval_declined"], ["error", "approval_unavailable"], ["throw", "approval_unavailable"], ["garbage", "approval_unavailable"], [undefined, "approval_unavailable"]]) {
    it(`${String(answer)} refuses with ${code}, and tells the model not to retry`, async () => {
      for (const mode of ["human", "strict"]) {
        const gate = new ApprovalGate({ mode, elicit: fakeElicit([answer]) });
        const r = await gate.require(invite());
        assert.equal(r.ok, false);
        assert.equal(r.code, code);
        assert.equal(r.opHash, opHash(invite()));
        assert.match(r.message, /Do not retry/);
        assert.match(r.message, /Nothing was changed/);
      }
    });
  }

  it("a synchronously throwing elicit is a refusal, not an exception", async () => {
    const gate = new ApprovalGate({ mode: "human", elicit: () => { throw new Error("sync"); } });
    const r = await gate.require(invite());
    assert.equal(r.ok, false);
    assert.equal(r.code, "approval_unavailable");
  });

  it("a prompt that never settles is a timeout refusal", async () => {
    // The gate's backstop timer is unref'd on purpose (the server's stdio keeps the process alive). Keep the loop alive here, otherwise
    // Node 22's runner sees a pending promise with an empty event loop and cancels the rest of the file.
    const keepAlive = setInterval(() => {}, 1000);
    try {
      const gate = new ApprovalGate({ mode: "human", elicit: fakeElicit(["hang"]), elicitTimeoutMs: 20 });
      const r = await gate.require(invite());
      assert.equal(r.ok, false);
      assert.equal(r.code, "approval_unavailable");
      assert.match(r.message, /timed out/);
    } finally { clearInterval(keepAlive); }
  });

  it("asks every time: the same operation approved twice prompts twice", async () => {
    const elicit = fakeElicit(["accept", "accept"]);
    const gate = new ApprovalGate({ mode: "human", elicit });
    assert.equal((await gate.require(invite())).ok, true);
    assert.equal((await gate.require(invite())).ok, true);
    assert.equal(elicit.calls.length, 2);
  });

  it("the legacy confirmed flag changes nothing in human and strict: it still prompts, a decline still refuses, an accept still passes", async () => {
    for (const mode of ["human", "strict"]) {
      for (const legacyConfirmed of [true, false, undefined]) {
        const el = fakeElicit(["decline", "accept"]);
        const gate = new ApprovalGate({ mode, elicit: el });
        const d = await gate.require(invite(), { legacyConfirmed });
        assert.equal(d.ok, false); assert.equal(d.code, "approval_declined");
        const a = await gate.require(invite(), { legacyConfirmed });
        assert.equal(a.ok, true); assert.equal(a.channel, "elicitation");
        assert.equal(el.calls.length, 2);
      }
      // no channel at all: legacyConfirmed does not get a call through either
      const r = await new ApprovalGate({ mode }).require(invite(), { legacyConfirmed: true });
      assert.equal(r.ok, false);
      assert.equal(r.code, "approval_required");
    }
  });
});

describe("ApprovalGate: decline budget", () => {
  it(`after ${MAX_DECLINES_PER_MINUTE} declines within 60 s there are no more prompts and calls are refused with approval_unavailable`, async () => {
    const now = clock();
    const elicit = fakeElicit(Array(10).fill("decline"));
    const warnings = [];
    const gate = new ApprovalGate({ mode: "human", elicit, now, onWarning: (m) => warnings.push(m) });
    for (let i = 0; i < MAX_DECLINES_PER_MINUTE; i++) {
      assert.equal((await gate.require(invite())).code, "approval_declined");
      now.advance(1_000);
    }
    assert.equal(elicit.calls.length, 5);
    for (let i = 0; i < 3; i++) {
      const r = await gate.require(invite());
      assert.equal(r.code, "approval_unavailable");
      assert.match(r.message, /Do not retry/);
    }
    assert.equal(elicit.calls.length, 5, "no prompt while over budget");
    assert.ok(warnings.length >= 1);
  });

  it("even a call the human would accept is not shown while over budget", async () => {
    const now = clock();
    const elicit = fakeElicit([...Array(5).fill("decline"), "accept"]);
    const gate = new ApprovalGate({ mode: "human", elicit, now });
    for (let i = 0; i < 5; i++) await gate.require(invite());
    assert.equal((await gate.require(invite())).ok, false);
    assert.equal(elicit.calls.length, 5);
  });

  it("the window slides: prompts resume once the oldest decline is more than 60 s old", async () => {
    const now = clock();
    const elicit = fakeElicit([...Array(5).fill("decline"), "accept"]);
    const gate = new ApprovalGate({ mode: "human", elicit, now });
    for (let i = 0; i < 5; i++) await gate.require(invite());
    now.advance(59_000);
    assert.equal((await gate.require(invite())).code, "approval_unavailable");
    now.advance(2_000);
    const r = await gate.require(invite());
    assert.equal(r.ok, true);
    assert.equal(elicit.calls.length, 6);
  });

  it("declines spread over more than a minute never exhaust the budget", async () => {
    const now = clock();
    const elicit = fakeElicit(Array(20).fill("decline"));
    const gate = new ApprovalGate({ mode: "human", elicit, now });
    for (let i = 0; i < 20; i++) { assert.equal((await gate.require(invite())).code, "approval_declined"); now.advance(20_000); }
    assert.equal(elicit.calls.length, 20);
  });

  it("errors and timeouts count too, accepts do not", async () => {
    const now = clock();
    const elicit = fakeElicit(["accept", "accept", "error", "throw", "cancel", "decline", "decline", "accept"]);
    const gate = new ApprovalGate({ mode: "human", elicit, now });
    for (let i = 0; i < 7; i++) await gate.require(invite());
    assert.equal(elicit.calls.length, 7, "2 accepts + 5 failures; the 8th call is over budget");
    assert.equal((await gate.require(invite())).code, "approval_unavailable");
    assert.equal(elicit.calls.length, 7);
  });
});

describe("ApprovalGate: out-of-band store (client cannot elicit)", () => {
  it("first call records a pending request and refuses with the terminal instruction; the summary is the rendered operation", async () => {
    const store = fakeStore();
    const gate = new ApprovalGate({ mode: "human", store, now: () => 0 });
    const op = invite();
    const r = await gate.require(op);
    assert.equal(r.ok, false);
    assert.equal(r.code, "approval_required");
    assert.match(r.message, /proton-drive-cli approve K7Q2-M9XD/);
    assert.match(r.message, /same arguments/);
    assert.match(r.message, /10 minute/);
    assert.deepEqual(store.requests, [{ tool: "drive_share_invite", opHash: opHash(op), summary: renderOperation(op), fresh: true }]);
  });

  it("after the human approved, the same operation passes once with channel cli and the code; a replay is refused again", async () => {
    const store = fakeStore();
    const gate = new ApprovalGate({ mode: "human", store, now: () => 0 });
    const op = invite();
    await gate.require(op);
    store.approved.add(`drive_share_invite:${opHash(op)}`);
    const ok = await gate.require(invite());
    assert.deepEqual(ok, { ok: true, channel: "cli", opHash: opHash(op), code: "K7Q2-M9XD" });
    const again = await gate.require(invite());
    assert.equal(again.ok, false);
    assert.equal(again.code, "approval_required");
  });

  it("an approval for other arguments does not pass (different hash)", async () => {
    const store = fakeStore();
    const gate = new ApprovalGate({ mode: "human", store, now: () => 0 });
    store.approved.add(`drive_share_invite:${opHash(invite())}`);
    for (const other of [invite({ role: "viewer" }), invite({ path: "/my-files/Taxes/2026" }), invite({ message: "x" }), { ...invite(), tool: "drive_share_revoke" }]) {
      const r = await gate.require(other);
      assert.equal(r.ok, false);
    }
    assert.equal(store.approved.size, 1, "the approval was not spent by other operations");
  });

  it("consume is tried before request, so an approved operation does not create a new pending record", async () => {
    const store = fakeStore();
    store.approved.add(`drive_share_invite:${opHash(invite())}`);
    const r = await new ApprovalGate({ mode: "strict", store }).require(invite());
    assert.equal(r.ok, true);
    assert.equal(store.requests.length, 0);
  });

  it("elicitation wins when available: the store is not touched", async () => {
    const store = fakeStore();
    const r = await new ApprovalGate({ mode: "human", store, elicit: fakeElicit(["decline"]) }).require(invite());
    assert.equal(r.code, "approval_declined");
    assert.equal(store.consumes.length + store.requests.length, 0);
  });

  it("a store that throws refuses with approval_unavailable and warns", async () => {
    const warnings = [];
    const store = { request() { throw new Error("disk full"); }, consume() { return null; } };
    const r = await new ApprovalGate({ mode: "human", store, onWarning: (m) => warnings.push(m) }).require(invite());
    assert.equal(r.ok, false);
    assert.equal(r.code, "approval_unavailable");
    assert.match(warnings[0], /disk full/);
    const store2 = { request() { return { code: "X", expiresAt: 1, reused: false }; }, consume() { throw new Error("rename failed"); } };
    assert.equal((await new ApprovalGate({ mode: "human", store: store2 }).require(invite())).code, "approval_unavailable");
  });
});

describe("ApprovalGate: no channel, and model mode", () => {
  it("neither elicitation nor store: approval_required naming PROTON_DRIVE_APPROVAL=model as the knowing opt-out", async () => {
    for (const mode of ["human", "strict"]) {
      const r = await new ApprovalGate({ mode }).require(invite());
      assert.equal(r.ok, false);
      assert.equal(r.code, "approval_required");
      assert.match(r.message, /PROTON_DRIVE_APPROVAL=model/);
      assert.match(r.message, /do not retry/i);
    }
  });

  it("model mode passes only with legacyConfirmed: true, with channel model, and never prompts", async () => {
    const elicit = fakeElicit(["decline"]);
    const gate = new ApprovalGate({ mode: "model", elicit, store: fakeStore() });
    assert.deepEqual(await gate.require(invite(), { legacyConfirmed: true }), { ok: true, channel: "model", opHash: opHash(invite()) });
    for (const o of [undefined, {}, { legacyConfirmed: false }, { legacyConfirmed: "true" }]) {
      const r = await gate.require(invite(), o);
      assert.equal(r.ok, false);
      assert.equal(r.code, "approval_required");
      assert.match(r.message, /confirmed=true/);
    }
    assert.equal(elicit.calls.length, 0);
  });

  it("model mode does not need prompt text for the tool (the legacy path owns it)", async () => {
    const r = await new ApprovalGate({ mode: "model" }).require({ tool: "drive_trash", effect: "reversible", fields: {} }, { legacyConfirmed: true });
    assert.equal(r.ok, true);
  });
});
