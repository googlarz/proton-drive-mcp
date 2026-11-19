// 1.12.0 drive_checkup / drive_cleanup / drive_undo: INDEPENDENT adversarial suite (task A1). Written from PLAN-1.12.0.md sections 3 and
// 5.2 and the task brief, not from the implementation. Every case asserts on the fake CLI's argv log and/or the stateful fake Drive's
// state file, not only on reply text. A failing test is a finding about the implementation: it is kept as is (marked `todo` only when
// the expectation is certain per the plan), never weakened.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, chmodSync, statSync } from "node:fs";
import { join, delimiter } from "node:path";
import { ACCEPT, DECLINE, CANCEL, NO_APPROVE, THROWS, withServer, writeTree, text } from "./helpers/approval-harness.mjs";
import { driveSetup, file, folder, readNodes, patchState, treeShape, trashedUids, journalIds, readJournal, undoDir, seedJournal } from "./helpers/drive-state.mjs";
import { nonVersionCalls, FAKE_CLI } from "./helpers/mcp-client.mjs";

const OLD = "2020-01-01T00:00:00Z";
const MID = "2022-01-01T00:00:00Z";
const NEW = "2024-01-01T00:00:00Z";
const MB = 1024 * 1024;
const DAY = 86_400_000;
const CONC = { concurrency: 4 };

// ---- helpers ------------------------------------------------------------------------------------------------------------------
const json = (r) => JSON.parse(text(r));
const subCalls = (ctx, sub) => ctx.changes().filter((a) => a[0] === "filesystem" && a[1] === sub);
const trashCalls = (ctx) => subCalls(ctx, "trash");
const restoreCalls = (ctx) => subCalls(ctx, "restore");
const moveCalls = (ctx) => subCalls(ctx, "move");
const renameCalls = (ctx) => subCalls(ctx, "rename");
const argPaths = (call) => call.slice(2).filter((a) => a !== "--json");
/** Every CLI call that is neither a read nor a download. */
const writes = (ctx) => ctx.changes().filter((a) => !(a[0] === "filesystem" && a[1] === "download"));
const alive = async (ctx) => { assert.ok((await ctx.client.listTools()).tools.length > 10, "server still answers"); };
const STACK = /\n\s+at\s.+:\d+:\d+|\bTypeError\b|\bReferenceError\b|\bRangeError\b|\bSyntaxError\b|Cannot read propert|is not a function|is not iterable/;
const DANGEROUS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
const CLEAN = { path: "/my-files", fixes: ["duplicates", "empty-folders"] };

const BASE = [
  folder("d1", "root", "docs"), folder("d2", "root", "inbox"), folder("d3", "root", "empty"), folder("d4", "d3", "inner"),
  file("f1", "d1", "a.pdf", { size: 5000, sha1: "S1", mtime: OLD }),
  file("f2", "d2", "a (1).pdf", { size: 5000, sha1: "S1", mtime: NEW }),
  file("f3", "d1", "unique.txt", { size: 3000, sha1: "U1", mtime: OLD }),
];
const opts = (nodes = BASE, o = {}) => ({ fakeMode: "drive", setup: driveSetup(nodes, o.setupEnv ?? {}), replies: () => ACCEPT, ...o.rest, ...(o.env ? { env: o.env } : {}) });
const o2 = (nodes, rest = {}, env) => opts(nodes, { rest, env });

/**
 * The dialog's "<header> (n):" section: {n, lines}. The cleanup dialog (1.12.0 R2-1) prints each item as "  - <path>" followed by
 * "    keeps: <kept path>" or "    (empty folder)"; those two lines are joined back into "  - <path>  (keeps <kept>)" /
 * "  - <path>  (empty folder)" so the assertions below read the same as for the older one-line format.
 */
function dialogList(msg, header = "trash") {
  const lines = msg.split("\n");
  const i = lines.findIndex((l) => new RegExp(`^${header} \\(\\d+\\):$`).test(l));
  assert.ok(i >= 0, `no "${header} (n):" section in\n${msg.slice(0, 500)}`);
  const n = Number(lines[i].match(/\((\d+)\)/)[1]);
  const rest = [];
  for (let k = i + 1; k < lines.length && /^ {2}- /.test(lines[k]); k++) {
    const sub = header === "trash" ? lines[k + 1] : undefined;
    if (sub !== undefined && /^ {4}keeps: /.test(sub)) { rest.push(`${lines[k]}  (keeps ${sub.slice(11)})`); k++; }
    else if (sub !== undefined && sub === "    (empty folder)") { rest.push(`${lines[k]}  (empty folder)`); k++; }
    else rest.push(lines[k]);
  }
  return { n, lines: rest, all: lines };
}

/** Wraps the stateful fake CLI: `filesystem download <remote> <dir>` writes WRAP_CONTENT[remote] into <dir>; everything else is the fake. */
const wrapperSource = () => [
  "#!/usr/bin/env node",
  'import { appendFileSync, writeFileSync } from "node:fs";',
  'import { spawnSync } from "node:child_process";',
  'import { join } from "node:path";',
  "const argv = process.argv.slice(2);",
  'if (argv[0] === "filesystem" && argv[1] === "download") {',
  "  if (process.env.FAKE_ARGV_LOG) appendFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify({ argv, pid: process.pid }) + '\\n');",
  "  const c = JSON.parse(process.env.WRAP_CONTENT || '{}');",
  "  const body = c[argv[2]];",
  "  if (body === undefined) { process.stderr.write('Item not found: ' + argv[2] + '\\n'); process.exit(1); }",
  "  writeFileSync(join(argv[3], argv[2].split('/').pop()), body);",
  "  process.stdout.write(JSON.stringify({ transferredItems: 1, transferredBytes: body.length, skippedItems: 0, failedItems: 0, failures: [] }) + '\\n');",
  "  process.exit(0);",
  "}",
  `const r = spawnSync(process.execPath, [${JSON.stringify(FAKE_CLI)}, ...argv], { stdio: "inherit" });`,
  "process.exit(r.status ?? 1);",
].join("\n");
const wrapSetup = (nodes, contents, extra = {}) => (sb) => {
  const base = driveSetup(nodes, extra)(sb);
  const w = join(sb.dir, "wrap-cli.mjs");
  writeFileSync(w, wrapperSource());
  chmodSync(w, 0o755);
  return { ...base, PROTON_DRIVE_BIN: w, WRAP_CONTENT: JSON.stringify(contents) };
};

/** Seeded PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random Drive: /my-files/scope (cleaned) and /my-files/outside (never to be touched), shared folders, empty chains, trash collisions. */
function genTree(seed) {
  const r = rng(seed);
  const int = (n) => Math.floor(r() * n);
  const pick = (a) => a[int(a.length)];
  const nodes = [folder("scope", "root", "scope"), folder("out", "root", "outside")];
  const depth = { scope: 0, out: 0 };
  const folders = ["scope", "out"];
  const used = new Map([["scope", new Set()], ["out", new Set()]]);
  for (let i = 0, n = 4 + int(8); i < n; i++) {
    const parent = pick(folders.filter((f) => depth[f] < 3));
    const uid = `F${i}`;
    const flag = r() < 0.18 ? { shared: true } : r() < 0.07 ? { sharedByUrl: true } : {};
    nodes.push(folder(uid, parent, `f${i}`, flag));
    depth[uid] = depth[parent] + 1;
    folders.push(uid);
    used.set(uid, new Set());
  }
  const shas = ["H0", "H1", "H2", "H3", "H4", "H5"];
  for (let i = 0, n = 10 + int(30); i < n; i++) {
    const parent = pick(folders);
    let name = `n${int(12)}.dat`;
    if (used.get(parent).has(name)) name = `u${i}.dat`;
    used.get(parent).add(name);
    const dupe = r() < 0.7;
    const sha = dupe ? pick(shas) : `U${i}`;
    let size = dupe ? 2048 + Number(sha.slice(1)) * 10 : 3000 + i;
    if (r() < 0.1) size += 1; // same claimed sha1, different size
    if (r() < 0.08) size = int(1000); // tiny
    nodes.push(file(`X${i}`, parent, name, {
      size, ...(r() < 0.9 ? { sha1: sha } : {}), ...(r() < 0.8 ? { mtime: pick([OLD, MID, NEW, MID]) } : {}),
      mediaType: pick(["application/pdf", "application/pdf", "text/plain"]), ...(r() < 0.07 ? { shared: true } : {}),
    }));
  }
  nodes.push(folder("E1", "scope", "chain"), folder("E2", "E1", "c2"), folder("E3", "E2", "c3"));
  for (let k = 0; k < 3; k++) nodes.push(file(`T${k}`, "root", `n${int(12)}.dat`, { size: 10, trashTime: "2026-01-01T00:00:00Z" }));
  nodes.push(file("anchor", "scope", "anchor.txt", { size: 5, sha1: "ANCH" }));
  return nodes;
}

// =====================================================================================================================================
// (a) the model cannot name files: every extra property is rejected by the schema, nothing runs
// =====================================================================================================================================
describe("(a) extra arguments are rejected by the schema, nothing runs", CONC, () => {
  const EXTRAS = [
    ["paths", { paths: ["/my-files/inbox/a (1).pdf"] }], ["items", { items: [{ uid: "f1" }] }], ["uids", { uids: ["f1"] }],
    ["keep", { keep: "/my-files/inbox/a (1).pdf" }], ["exclude", { exclude: ["/my-files/docs/a.pdf"] }], ["force", { force: true }],
    ["approve", { approve: true }], ["approved", { approved: true }], ["trash", { trash: ["f1"] }], ["unknown", { surprise: 1 }],
    ["dryRun", { dryRun: false }],
  ];
  const TOOLS = [["drive_cleanup", CLEAN], ["drive_undo", {}], ["drive_checkup", {}]];
  for (const [tool, base] of TOOLS) {
    it(`${tool}: ${EXTRAS.length} different extra properties, plan and apply form, never reach the CLI`, async () => {
      await withServer(o2(BASE, { replies: () => ACCEPT }), async (ctx) => {
        const before = nonVersionCalls(ctx.sb.argvLog).length;
        for (const [label, extra] of EXTRAS) {
          for (const confirmed of [undefined, true]) {
            const args = { ...base, ...extra, ...(confirmed ? (tool === "drive_undo" ? { action: "apply" } : tool === "drive_cleanup" ? { confirmed } : {}) : {}) };
            const r = await ctx.call(tool, args);
            assert.equal(r.isError, true, `${tool} ${label} ${confirmed}: ${text(r).slice(0, 200)}`);
            assert.match(text(r), /unknown|additional|unexpected|not allowed|unrecognized/i, `${tool} ${label}`);
          }
        }
        assert.equal(ctx.asked, 0, "no dialog was shown");
        assert.equal(nonVersionCalls(ctx.sb.argvLog).length, before, "not a single CLI call (not even a read) came out of a rejected call");
        assert.deepEqual(trashedUids(ctx), []);
        assert.deepEqual(journalIds(ctx), []);
      });
    });
  }

  it("a __proto__ / constructor smuggle is rejected or ignored without effect, never read as a file list", async () => {
    await withServer(o2(BASE), async (ctx) => {
      for (const raw of ['{"path":"/my-files","fixes":["duplicates"],"__proto__":{"paths":["/my-files/docs/a.pdf"]}}', '{"path":"/my-files","fixes":["duplicates"],"constructor":{"prototype":{"keep":"x"}}}']) {
        const r = await ctx.client.callTool({ name: "drive_cleanup", arguments: JSON.parse(raw) });
        void r;
      }
      assert.deepEqual(trashCalls(ctx), []);
      assert.deepEqual(trashedUids(ctx), []);
      await alive(ctx);
    });
  });

  it("the published schemas are closed and offer no way to name an item", async () => {
    await withServer(o2(BASE), async (ctx) => {
      const tools = (await ctx.client.listTools()).tools;
      for (const name of ["drive_cleanup", "drive_undo", "drive_checkup"]) {
        const t = tools.find((x) => x.name === name);
        assert.ok(t, name);
        assert.equal(t.inputSchema.additionalProperties, false, name);
        for (const [k, v] of Object.entries(t.inputSchema.properties)) {
          assert.ok(!/^(paths?|items?|uids?|keep|exclude|files?|sources?)$/i.test(k) || (name === "drive_cleanup" && k === "path") || (name === "drive_checkup" && k === "path"), `${name}.${k}`);
          if (v.type === "array") assert.ok(v.items?.enum, `${name}.${k}: an array property must be an enum (no free-form lists)`);
        }
      }
      assert.deepEqual(Object.keys(tools.find((x) => x.name === "drive_undo").inputSchema.properties).sort(), ["action", "id"]);
    });
  });
});

// =====================================================================================================================================
// 5.2 case 1 + (f): the gate. cleanup apply is gated on the first call, with every kind of client
// =====================================================================================================================================
describe("case 1 and (f): drive_cleanup apply is gated", CONC, () => {
  const firstCallDialog = async (pairs) => {
    const nodes = [folder("a", "root", "keep"), folder("b", "root", "dups"), folder("e", "root", "e0")];
    for (let i = 0; i < pairs; i++) {
      nodes.push(file(`k${i}`, "a", `orig-${String(i).padStart(2, "0")}.bin`, { size: 4000 + i, sha1: `K${i}`, mtime: OLD }));
      nodes.push(file(`c${i}`, "b", `copy-${String(i).padStart(2, "0")}.bin`, { size: 4000 + i, sha1: `K${i}`, mtime: NEW }));
    }
    let c, trashedAtDialog = -1;
    await withServer(o2(nodes, { replies: () => { trashedAtDialog = trashCalls(c).length; return ACCEPT; } }), async (ctx) => {
      c = ctx;
      const r = await ctx.call("drive_cleanup", { ...CLEAN, confirmed: true });
      assert.notEqual(r.isError, true, text(r));
      assert.equal(ctx.asked, 1);
      assert.equal(trashedAtDialog, 0, "nothing had reached the CLI when the human was asked");
      const { n, lines } = dialogList(ctx.messages[0]);
      assert.equal(n, pairs + 1, `${pairs} duplicates and the empty folder`);
      assert.equal(lines.length, pairs + 1, "the dialog lists every item, none is cut off");
      for (let i = 0; i < pairs; i++) {
        const l = lines.find((x) => x.includes(`copy-${String(i).padStart(2, "0")}.bin`));
        assert.ok(l, `copy ${i} is in the dialog`);
        assert.ok(l.endsWith(`(keeps /my-files/keep/orig-${String(i).padStart(2, "0")}.bin)`), `keeper on line ${i}: ${l}`);
      }
      assert.ok(lines.some((l) => /\/my-files\/e0 {2}\(empty folder\)$/.test(l)));
      // the list shown is the list executed
      const calls = trashCalls(ctx);
      assert.equal(calls.length, 1);
      assert.equal(argPaths(calls[0]).length, pairs + 1);
      const shown = new Set(lines.map((l) => l.replace(/^ {2}- /, "").replace(/ {2}\((keeps .*|empty folder)\)$/, "")));
      assert.deepEqual(new Set(argPaths(calls[0])), shown);
      assert.equal(trashedUids(ctx).length, pairs + 1);
      for (let i = 0; i < pairs; i++) assert.equal(readNodes(ctx)[`k${i}`].trashTime, undefined, `keeper ${i} untouched`);
    });
  };

  it("confirmed:true as the very first call: the dialog shows the whole list (41 items) with a keeper on every duplicate line BEFORE any trash call", () => firstCallDialog(40));

  it("a list of 61 eligible items: one call plans and shows at most 50 (the dialog's full-list limit), every one with its keeper; the rest is left for the next call", async () => {
    const nodes = [folder("a", "root", "keep"), folder("b", "root", "dups"), folder("e", "root", "e0")];
    for (let i = 0; i < 60; i++) nodes.push(file(`k${i}`, "a", `orig-${String(i).padStart(2, "0")}.bin`, { size: 4000 + i, sha1: `K${i}`, mtime: OLD }), file(`c${i}`, "b", `copy-${String(i).padStart(2, "0")}.bin`, { size: 4000 + i, sha1: `K${i}`, mtime: NEW }));
    await withServer(o2(nodes), async (ctx) => {
      const r = json(await ctx.call("drive_cleanup", { ...CLEAN, confirmed: true }));
      assert.equal(r.trashed, 50);
      assert.equal(r.remaining, 11);
      const m = ctx.messages[0];
      assert.doesNotMatch(m, /only the first/);
      const { n, lines } = dialogList(m);
      assert.equal(n, 50);
      assert.equal(lines.length, 50, "every item of the call is in the dialog");
      for (const l of lines) assert.match(l, /\((keeps \/my-files\/keep\/orig-\d\d\.bin|empty folder)\)$/, l);
      assert.equal(argPaths(trashCalls(ctx)[0]).length, 50);
      assert.deepEqual(new Set(argPaths(trashCalls(ctx)[0])), new Set(lines.map((l) => l.replace(/^ {2}- /, "").replace(/ {2}\((keeps .*|empty folder)\)$/, ""))));
    });
  });


  it("decline, cancel, a throwing client, accept without approve, accept with look-alike approve values: zero trash calls, no journal", async () => {
    const replies = [
      ["decline", DECLINE], ["cancel", CANCEL], ["client error", THROWS], ["approve=false", NO_APPROVE],
      ["accept without content", { action: "accept" }], ["empty content", { action: "accept", content: {} }],
      ["approve as string", { action: "accept", content: { approve: "true" } }], ["approve as 1", { action: "accept", content: { approve: 1 } }],
      ["unknown action", { action: "maybe", content: { approve: true } }],
    ];
    for (const [label, reply] of replies) {
      await withServer(o2(BASE, { replies: [reply] }), async (ctx) => {
        const r = await ctx.call("drive_cleanup", { ...CLEAN, confirmed: true });
        assert.equal(r.isError, true, label);
        assert.equal(ctx.asked, 1, label);
        assert.deepEqual(trashCalls(ctx), [], label);
        assert.deepEqual(writes(ctx), [], label);
        assert.deepEqual(trashedUids(ctx), [], label);
        assert.deepEqual(journalIds(ctx), [], label);
        assert.doesNotMatch(text(r), STACK, label);
      });
    }
  });

  it("a client that cannot show a dialog: zero trash calls, no journal; the plan form still works", async () => {
    await withServer(o2(BASE, { caps: {} }), async (ctx) => {
      const plan = await ctx.call("drive_cleanup", CLEAN);
      assert.notEqual(plan.isError, true, text(plan));
      const r = await ctx.call("drive_cleanup", { ...CLEAN, confirmed: true });
      assert.equal(r.isError, true);
      assert.deepEqual(trashCalls(ctx), []);
      assert.deepEqual(writes(ctx), []);
      assert.deepEqual(trashedUids(ctx), []);
      assert.deepEqual(journalIds(ctx), []);
    });
  });

  it("accept: trashes exactly the planned items once, one journal batch with their uids, and undo restores them by uid", async () => {
    await withServer(o2(BASE), async (ctx) => {
      const before = readNodes(ctx);
      const beforeShape = treeShape(ctx);
      const r = json(await ctx.call("drive_cleanup", { ...CLEAN, confirmed: true }));
      assert.equal(r.applied, true);
      assert.equal(trashCalls(ctx).length, 1, "one batched call");
      assert.deepEqual(argPaths(trashCalls(ctx)[0]).sort(), ["/my-files/empty", "/my-files/inbox/a (1).pdf"]);
      assert.deepEqual(trashedUids(ctx), ["d3", "f2"]);
      assert.equal(readNodes(ctx).f1.trashTime, undefined, "the keeper stays");
      assert.equal(readNodes(ctx).d4.trashTime, undefined, "only the top of an empty tree is proposed or its child is harmless; inner was not trashed separately");
      assert.deepEqual(journalIds(ctx), [r.undoId]);
      const j = readJournal(ctx, r.undoId);
      assert.equal(j.v, 1);
      assert.equal(j.kind, "trash");
      assert.equal(j.status, "applied");
      assert.deepEqual(j.items.map((i) => i.uid).sort(), ["d3", "f2"]);
      // the same plan again never proposes anything it already trashed (the emptied 'inbox' folder is a new, legitimate find)
      const again = json(await ctx.call("drive_cleanup", CLEAN));
      assert.equal(again.counts.duplicates, 0);
      assert.ok(!again.samples.some((x) => /a \(1\)\.pdf|my-files\/empty /.test(x)), JSON.stringify(again.samples));
      assert.equal(trashCalls(ctx).length, 1);
      // undo
      const u = json(await ctx.call("drive_undo", { action: "apply", id: r.undoId }));
      assert.equal(u.status, "undone");
      assert.deepEqual(treeShape(ctx), beforeShape);
      assert.deepEqual(trashedUids(ctx), []);
      for (const uid of ["f1", "f2", "f3", "d1", "d2", "d3", "d4"]) {
        assert.equal(readNodes(ctx)[uid].parentUid, before[uid].parentUid, uid);
        assert.equal(readNodes(ctx)[uid].name, before[uid].name, uid);
        assert.equal(readNodes(ctx)[uid].trashTime, undefined, uid);
      }
    });
  });

  it("the decline budget applies to drive_cleanup and drive_undo: a flood stops being asked, still zero changes", async () => {
    await withServer(o2(BASE, { replies: () => DECLINE }), async (ctx) => {
      for (let i = 0; i < 9; i++) {
        const r = await ctx.call("drive_cleanup", { ...CLEAN, confirmed: true });
        assert.equal(r.isError, true);
      }
      assert.ok(ctx.asked <= 5, `asked ${ctx.asked} times after nine declined calls`);
      assert.deepEqual(trashCalls(ctx), []);
    });
    const trashed = [folder("d1", "root", "docs"), file("f1", "d1", "a.txt", { trashTime: "2026-11-19T10:00:00Z" })];
    await withServer({
      ...o2(trashed, { replies: () => DECLINE }),
      setup: (sb) => { const env = driveSetup(trashed)(sb); seedJournal(sb, { items: [{ uid: "f1", parentUid: "d1", from: "/my-files/docs/a.txt", name: "a.txt", restorable: true }] }); return env; },
    }, async (ctx) => {
      for (let i = 0; i < 9; i++) assert.equal((await ctx.call("drive_undo", { action: "apply" })).isError, true);
      assert.ok(ctx.asked <= 5, `asked ${ctx.asked} times for undo`);
      assert.deepEqual(restoreCalls(ctx), []);
      assert.deepEqual(trashedUids(ctx), ["f1"]);
    });
  });

  it("modes: strict asks too; model mode lets confirmed:true through only for the plan it computed; core tier hides and refuses all three", async () => {
    await withServer(o2(BASE, { replies: [DECLINE, ACCEPT] }, { PROTON_DRIVE_APPROVAL: "strict" }), async (ctx) => {
      assert.equal((await ctx.call("drive_cleanup", { ...CLEAN, confirmed: true })).isError, true);
      assert.deepEqual(trashCalls(ctx), []);
      assert.notEqual((await ctx.call("drive_cleanup", { ...CLEAN, confirmed: true })).isError, true);
      assert.equal(trashCalls(ctx).length, 1);
    });
    await withServer({ ...o2(BASE, { caps: {} }), approval: "model" }, async (ctx) => {
      const r = await ctx.call("drive_cleanup", { ...CLEAN, confirmed: true });
      assert.notEqual(r.isError, true, text(r));
      assert.equal(trashCalls(ctx).length, 1);
      assert.deepEqual(trashedUids(ctx), ["d3", "f2"]);
    });
    await withServer(o2(BASE, {}, { PROTON_DRIVE_TOOL_TIER: "core" }), async (ctx) => {
      const names = (await ctx.client.listTools()).tools.map((t) => t.name);
      for (const n of ["drive_cleanup", "drive_undo", "drive_checkup"]) assert.ok(!names.includes(n), `${n} hidden in core`);
      for (const [n, a] of [["drive_cleanup", { ...CLEAN, confirmed: true }], ["drive_undo", { action: "apply" }], ["drive_checkup", {}]]) {
        const r = await ctx.call(n, a);
        assert.equal(r.isError, true, n);
      }
      assert.deepEqual(writes(ctx), []);
      assert.equal(ctx.asked, 0);
    });
  });
});

// =====================================================================================================================================
// 5.2 case 2 + (e): Drive changes between plan and approval
// =====================================================================================================================================
describe("case 2 and (e): Drive changes while the dialog is open -> nothing applied, approval_changed", CONC, () => {
  const NODES = [...BASE, folder("d5", "root", "deep"), folder("d6", "d5", "deeper"), file("t1", "d1", "third-a.bin", { size: 7000, sha1: "T", mtime: OLD }), file("t2", "d2", "third-b.bin", { size: 7000, sha1: "T", mtime: NEW })];
  const MUTATIONS = [
    ["a file lands in an 'empty' folder", (n) => { n.late = file("late", "d3", "late.txt", { size: 1 }); }],
    ["a file lands in the nested inner folder", (n) => { n.late = file("late", "d4", "late.txt", { size: 1 }); }],
    ["a file lands in the deepest of a chain of empties", (n) => { n.late = file("late", "d6", "late.txt", { size: 1 }); }],
    ["the duplicate changes size", (n) => { n.f2.size = 5001; }],
    ["the duplicate's claimed sha1 changes", (n) => { n.f2.sha1 = "DIFFERENT"; }],
    ["the keeper is trashed by someone else", (n) => { n.f1.trashTime = "2026-11-19T11:00:00Z"; }],
    ["the keeper's date changes so the keeper FLIPS to the other copy", (n) => { n.f1.mtime = "2030-01-01T00:00:00Z"; }],
    ["the copy to be trashed becomes older than the keeper (keeper flips)", (n) => { n.f2.mtime = "2000-01-01T00:00:00Z"; }],
    ["a third identical copy appears", (n) => { n.f9 = file("f9", "d1", "a-third.pdf", { size: 5000, sha1: "S1", mtime: "2010-01-01T00:00:00Z" }); }],
    ["a listed empty folder gets shared", (n) => { n.d3.shared = true; }],
    ["the folder holding the copy gets shared", (n) => { n.d2.shared = true; }],
    ["the copy is moved to another folder (same uid)", (n) => { n.f2.parentUid = "d1"; }],
    ["the copy is renamed", (n) => { n.f2.name = "renamed.pdf"; }],
    ["a same-named item appears in the trash (collision)", (n) => { n.zz = file("zz", "root", "a (1).pdf", { trashTime: "2026-11-19T11:00:00Z" }); }],
    ["the empty folder is trashed by someone else", (n) => { n.d3.trashTime = "2026-11-19T11:00:00Z"; }],
  ];
  for (const [label, mutate] of MUTATIONS) {
    it(label, async () => {
      let c;
      await withServer(o2(NODES, { replies: () => { patchState(c, mutate); return ACCEPT; } }), async (ctx) => {
        c = ctx;
        const r = await ctx.call("drive_cleanup", { ...CLEAN, confirmed: true });
        assert.equal(r.isError, true, `${label}: ${text(r)}`);
        assert.equal(ctx.lastAudit().code, "approval_changed", label);
        assert.deepEqual(trashCalls(ctx), [], `${label}: nothing may be trashed`);
        assert.deepEqual(writes(ctx), [], label);
        assert.deepEqual(journalIds(ctx), [], label);
        // the only trashed items are the ones the mutation itself trashed
        const own = Object.values(readNodes(ctx)).filter((x) => x.trashTime).map((x) => x.uid).sort();
        assert.ok(own.every((u) => ["f1", "d3", "zz"].includes(u)), `${label}: unexpected trashed ${own}`);
        assert.equal(readNodes(ctx).f2.trashTime, undefined);
      });
    });
  }

  for (const [label, mutate] of [
    ["a file takes the name of the trashed item", (n) => { n.squat = file("squat", "d2", "a (1).pdf"); }],
    ["the trashed item leaves the trash (emptied)", (n) => { delete n.f2; }],
    ["the original folder is trashed", (n) => { n.d2.trashTime = "2026-11-19T12:00:00Z"; }],
    ["another item of the same name lands in the trash", (n) => { n.other = file("other", "d1", "a (1).pdf", { trashTime: "2026-11-19T12:00:00Z" }); }],
  ]) {
    it(`undo: while the undo dialog is open, ${label} -> nothing restored, approval_changed, batch stays undoable`, async () => {
      let c, armed = false, mutated;
      await withServer(o2(BASE, { replies: () => { if (armed) { patchState(c, mutate); mutated = JSON.stringify(readNodes(c)); } return ACCEPT; } }), async (ctx) => {
        c = ctx;
        const b = json(await ctx.call("drive_bulk_trash", { paths: ["/my-files/inbox/a (1).pdf"], confirmed: true }));
        armed = true;
        const r = await ctx.call("drive_undo", { action: "apply", id: b.undoId });
        assert.equal(r.isError, true, text(r));
        assert.equal(ctx.lastAudit().code, "approval_changed");
        assert.deepEqual(restoreCalls(ctx), []);
        assert.equal(JSON.stringify(readNodes(ctx)), mutated, "Drive exactly as the third party left it: undo changed nothing");
        assert.equal(readJournal(ctx, b.undoId).status, "applied");
      });
    });
  }
});

// =====================================================================================================================================
// 5.2 case 3 + (b): forged sha1 in a shared folder
// =====================================================================================================================================
describe("case 3 and (b): a forged duplicate in a shared folder never costs the owner's real file", CONC, () => {
  const FORGE = [
    folder("own", "root", "private"), folder("team", "root", "team", { shared: true }), folder("sub", "team", "sub"),
    file("real", "own", "real-report.pdf", { size: 4000, sha1: "HH", mtime: NEW }),
    file("fake", "team", "planted.pdf", { size: 4000, sha1: "HH", mtime: "2005-01-01T00:00:00Z" }),
  ];
  const variants = [
    ["planted file directly in a shared folder", FORGE],
    ["planted file in a subfolder of a shared folder", [...FORGE.filter((n) => n.uid !== "fake"), file("fake", "sub", "planted.pdf", { size: 4000, sha1: "HH", mtime: "2005-01-01T00:00:00Z" })]],
    ["planted file that is itself shared by link", [...FORGE.filter((n) => n.uid !== "fake" && n.uid !== "team"), folder("team", "root", "team"), file("fake", "team", "planted.pdf", { size: 4000, sha1: "HH", mtime: "2005-01-01T00:00:00Z", sharedByUrl: true })]],
    ["planted file that is itself shared", [...FORGE.filter((n) => n.uid !== "fake" && n.uid !== "team"), folder("team", "root", "team"), file("fake", "team", "planted.pdf", { size: 4000, sha1: "HH", mtime: "2005-01-01T00:00:00Z", shared: true })]],
  ];
  for (const [label, nodes] of variants) {
    it(`${label}: without verify nothing is proposed or trashed (both files stay)`, async () => {
      await withServer(o2(nodes), async (ctx) => {
        const plan = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"] }));
        assert.equal(plan.counts.duplicates, 0, JSON.stringify(plan));
        assert.deepEqual(plan.samples, []);
        const r = await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"], confirmed: true });
        assert.deepEqual(trashCalls(ctx), []);
        assert.equal(readNodes(ctx).real.trashTime, undefined, "the owner's real file is still there");
        assert.equal(readNodes(ctx).fake.trashTime, undefined);
        assert.deepEqual(trashedUids(ctx), []);
        assert.deepEqual(journalIds(ctx), []);
        void r;
      });
    });
  }

  it("with verify, the forgery (different content) is not equal: both files stay and nothing is trashed", async () => {
    await withServer({ ...o2(FORGE), setup: wrapSetup(FORGE, { "/my-files/private/real-report.pdf": "the real thing", "/my-files/team/planted.pdf": "FORGED payload" }) }, async (ctx) => {
      const plan = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"], verify: true }));
      assert.equal(plan.counts.duplicates, 0, JSON.stringify(plan));
      const r = await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"], verify: true, confirmed: true });
      void r;
      assert.deepEqual(trashCalls(ctx), []);
      assert.deepEqual(trashedUids(ctx), []);
      assert.ok(ctx.changes().some((a) => a[1] === "download"), "verify really downloaded the candidates");
    });
  });

  it("with verify and one member that cannot be downloaded: nothing is trashed", async () => {
    await withServer({ ...o2(FORGE), setup: wrapSetup(FORGE, { "/my-files/private/real-report.pdf": "same" }) }, async (ctx) => {
      await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"], verify: true, confirmed: true });
      assert.deepEqual(trashCalls(ctx), []);
      assert.deepEqual(trashedUids(ctx), []);
    });
  });

  it("with verify and PROVEN equal content: exactly one of the two is trashed, never both", async () => {
    await withServer({ ...o2(FORGE), setup: wrapSetup(FORGE, { "/my-files/private/real-report.pdf": "identical bytes", "/my-files/team/planted.pdf": "identical bytes" }) }, async (ctx) => {
      const plan = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"], verify: true }));
      assert.equal(plan.counts.duplicates, 1, JSON.stringify(plan));
      const r = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"], verify: true, confirmed: true }));
      assert.equal(r.applied, true);
      assert.equal(trashCalls(ctx).length, 1);
      assert.equal(argPaths(trashCalls(ctx)[0]).length, 1);
      assert.equal(trashedUids(ctx).length, 1);
      assert.equal([readNodes(ctx).real, readNodes(ctx).fake].filter((x) => x.trashTime === undefined).length, 1, "one copy survives");
    });
  });

  it("same-size files WITHOUT a claimed sha1 are only a guess: never trashed without verify; with verify only if the bytes match", async () => {
    const nodes = [
      folder("a", "root", "one"), folder("b", "root", "two"),
      file("g1", "a", "x.bin", { size: 4000, mediaType: "application/octet-stream", mtime: OLD }), file("g2", "b", "y.bin", { size: 4000, mediaType: "application/octet-stream", mtime: NEW }),
    ];
    await withServer(o2(nodes), async (ctx) => {
      const plan = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"] }));
      assert.equal(plan.counts.duplicates, 0, JSON.stringify(plan));
      await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"], confirmed: true });
      assert.deepEqual(trashCalls(ctx), []);
      assert.deepEqual(trashedUids(ctx), []);
    });
    await withServer({ ...o2(nodes), setup: wrapSetup(nodes, { "/my-files/one/x.bin": "AAAA", "/my-files/two/y.bin": "BBBB" }) }, async (ctx) => {
      await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"], verify: true, confirmed: true });
      assert.deepEqual(trashCalls(ctx), [], "same size, different bytes");
      assert.deepEqual(trashedUids(ctx), []);
    });
    await withServer({ ...o2(nodes), setup: wrapSetup(nodes, { "/my-files/one/x.bin": "AAAA", "/my-files/two/y.bin": "AAAA" }) }, async (ctx) => {
      await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"], verify: true, confirmed: true });
      assert.equal(trashedUids(ctx).length, 1, "proven equal: one copy goes");
    });
  });

  it("a claimed sha1 with a different size is not an exact duplicate: not proposed", async () => {
    const nodes = [folder("a", "root", "one"), folder("b", "root", "two"), file("g1", "a", "x.bin", { size: 4000, sha1: "Q", mtime: OLD }), file("g2", "b", "y.bin", { size: 4001, sha1: "Q", mtime: NEW })];
    await withServer(o2(nodes), async (ctx) => {
      assert.equal(json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"] })).counts.duplicates, 0);
      await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"], confirmed: true });
      assert.deepEqual(trashedUids(ctx), []);
    });
  });

  it("three members, one of them planted in a shared folder: the owner always keeps at least one real copy and the planted file is never trashed", async () => {
    const nodes = [
      folder("own", "root", "private"), folder("own2", "root", "private2"), folder("team", "root", "team", { shared: true }),
      file("r1", "own", "r1.pdf", { size: 4000, sha1: "HH", mtime: "2023-01-01T00:00:00Z" }), file("r2", "own2", "r2.pdf", { size: 4000, sha1: "HH", mtime: NEW }),
      file("fake", "team", "planted.pdf", { size: 4000, sha1: "HH", mtime: "2001-01-01T00:00:00Z" }),
    ];
    await withServer(o2(nodes), async (ctx) => {
      await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"], confirmed: true });
      assert.equal(readNodes(ctx).fake.trashTime, undefined, "nothing in the shared folder is touched without verify");
      assert.ok([readNodes(ctx).r1, readNodes(ctx).r2].some((x) => x.trashTime === undefined), "a real copy survives");
    });
  });
});

// =====================================================================================================================================
// 5.2 case 4 + (d): incomplete / partial / stale walks and nodes without uid
// =====================================================================================================================================
describe("case 4 and (d): an unreliable walk refuses cleanup and trashes nothing", CONC, () => {
  it("a folder that fails to list: plan and apply are refused, even for the fix that does not need that folder; the unlisted folder is never called empty", async () => {
    const nodes = [...BASE, folder("d9", "root", "unreadable"), file("hidden", "d9", "inside.txt", { size: 9 })];
    await withServer(o2(nodes, {}, { FAKE_FAIL_LIST_UIDS: "d9", PROTON_DRIVE_RETRY_BASE_MS: "1" }), async (ctx) => {
      for (const args of [CLEAN, { path: "/my-files", fixes: ["empty-folders"] }, { path: "/my-files", fixes: ["duplicates"] }, { ...CLEAN, confirmed: true }, { path: "/my-files/unreadable", fixes: ["empty-folders"], confirmed: true }]) {
        const r = await ctx.call("drive_cleanup", args);
        assert.equal(r.isError, true, JSON.stringify(args) + " -> " + text(r).slice(0, 200));
      }
      assert.deepEqual(trashCalls(ctx), []);
      assert.deepEqual(trashedUids(ctx), []);
      assert.equal(ctx.asked, 0, "refused before any dialog");
      assert.deepEqual(journalIds(ctx), []);
    });
  });

  it("the checkup of the same drive is honest: complete:false and no folder is called empty on the incomplete scan", async () => {
    const nodes = [...BASE, folder("d9", "root", "unreadable"), file("hidden", "d9", "inside.txt", { size: 9 })];
    await withServer(o2(nodes, {}, { FAKE_FAIL_LIST_UIDS: "d9", PROTON_DRIVE_RETRY_BASE_MS: "1" }), async (ctx) => {
      const r = await ctx.call("drive_checkup", {});
      if (r.isError) return; // refusing is as honest as reporting
      const d = json(r);
      assert.equal(d.scanned.complete, false);
      const empties = (d.findings.find((f) => f.id === "empty-folders")?.samples ?? []).join("|");
      assert.doesNotMatch(empties, /unreadable/);
      assert.deepEqual(writes(ctx), []);
    });
  });

  it("a slow walk with a short budget: cleanup either refuses or plans on the COMPLETE walk; a folder whose listing was not finished is never called empty", async () => {
    // tree mode honours FAKE_SLEEP_MS: every listing takes 400 ms, the walk budget is 100 ms (plan 3.2 rule 2: cleanup has no time budget)
    const raw = (uid, parentUid, name, type, o = {}) => ({ uid, parentUid, name: { ok: true, value: name }, type, isShared: false, isSharedByUrl: false, activeRevision: type === "file" ? { claimedSize: o.size ?? 10, ...(o.sha1 ? { claimedDigests: { sha1: o.sha1 } } : {}) } : undefined });
    const tree = {
      "/my-files": [raw("d1", "root", "docs", "folder"), raw("d2", "root", "empty", "folder"), raw("d3", "root", "late", "folder")],
      "/my-files/docs": [raw("f1", "d1", "a.bin", "file", { size: 5000, sha1: "S" })], "/my-files/empty": [],
      "/my-files/late": [raw("d4", "d3", "deep", "folder")], "/my-files/late/deep": [raw("f9", "d4", "x.bin", "file", { size: 5 })], "/trash": [],
    };
    await withServer({ fakeMode: "tree", replies: () => ACCEPT, setup: (sb) => ({ FAKE_TREE: writeTree(sb.dir, tree), FAKE_SLEEP_MS: "400", PROTON_DRIVE_WALK_BUDGET_MS: "100" }) }, async (ctx) => {
      for (const args of [{ ...CLEAN }, { ...CLEAN, confirmed: true }]) {
        const r = await ctx.call("drive_cleanup", args);
        if (r.isError) continue; // refusing a partial walk is allowed
        const d = json(r);
        if (!args.confirmed) {
          assert.ok(!d.samples.some((x) => /my-files\/late/.test(x)), `'late' holds a file two levels down: ${d.samples}`);
          assert.equal(d.counts.emptyFolders, 1, "the one truly empty folder is found on the complete walk");
        }
      }
      for (const c of trashCalls(ctx)) assert.deepEqual(argPaths(c), ["/my-files/empty"]);
    });
  });

  it("stale data: a checkup warms the cache, Drive changes, and cleanup plans on the CURRENT Drive (new file in the 'empty' folder; new twin)", async () => {
    await withServer(o2(BASE), async (ctx) => {
      const warm = await ctx.call("drive_checkup", {});
      assert.notEqual(warm.isError, true, text(warm));
      patchState(ctx, (n) => {
        n.late = file("late", "d3", "late.txt", { size: 2 }); // d3/inner is no longer empty
        n.twin = file("twin", "d1", "a-twin.pdf", { size: 5000, sha1: "S1", mtime: "2021-06-01T00:00:00Z" });
      });
      const plan = json(await ctx.call("drive_cleanup", CLEAN));
      assert.ok(!plan.samples.includes("trash /my-files/empty (empty folder)"), `the folder that now holds a file must not be proposed: ${plan.samples}`);
      assert.ok(plan.samples.some((s) => /a-twin\.pdf/.test(s)) || plan.counts.duplicates >= 2, `the new twin shows up: ${JSON.stringify(plan)}`);
      const r = await ctx.call("drive_cleanup", { ...CLEAN, confirmed: true });
      void r;
      assert.equal(readNodes(ctx).d3.trashTime, undefined, "the folder with the late file survives");
      assert.equal(readNodes(ctx).late.trashTime, undefined);
    });
  });

  const rawNode = (uid, parentUid, name, type, o = {}) => ({
    ...(uid ? { uid } : {}), parentUid, name: { ok: true, value: name }, type,
    activeRevision: type === "file" ? { claimedSize: o.size ?? 10, claimedModificationTime: o.mtime ?? OLD, ...(o.sha1 ? { claimedDigests: { sha1: o.sha1 } } : {}) } : undefined,
    isShared: false, isSharedByUrl: false,
  });
  const uidTree = (extra) => ({
    "/my-files": [rawNode("d1", "root", "docs", "folder"), rawNode("d2", "root", "inbox", "folder"), rawNode("d3", "root", "empty", "folder"), ...extra.top],
    "/my-files/docs": [rawNode("f1", "d1", "a.pdf", "file", { size: 5000, sha1: "S1" }), ...extra.docs], "/my-files/inbox": [rawNode("f2", "d2", "a (1).pdf", "file", { size: 5000, sha1: "S1", mtime: NEW })],
    "/my-files/empty": [], "/my-files/ghost": [], "/trash": [],
  });
  const uidCases = [
    ["a stray file without uid", () => uidTree({ top: [], docs: [rawNode(null, "d1", "stray.txt", "file", { size: 3 })] })],
    ["a duplicate member without uid (older than the keeper)", () => uidTree({ top: [], docs: [rawNode(null, "d1", "a-twin.pdf", "file", { size: 5000, sha1: "S1", mtime: "2010-01-01T00:00:00Z" })] })],
    ["a folder without uid", () => uidTree({ top: [rawNode(null, "root", "ghost", "folder")], docs: [] })],
  ];
  for (const [label, mk] of uidCases) {
    it(`${label}: cleanup refuses (plan and apply) and trashes nothing`, async () => {
      await withServer({ fakeMode: "tree", replies: () => ACCEPT, setup: (sb) => ({ FAKE_TREE: writeTree(sb.dir, mk()) }) }, async (ctx) => {
        for (const args of [CLEAN, { ...CLEAN, confirmed: true }]) {
          const r = await ctx.call("drive_cleanup", args);
          assert.equal(r.isError, true, `${label}: ${text(r).slice(0, 300)}`);
        }
        assert.deepEqual(trashCalls(ctx), [], label);
        assert.deepEqual(journalIds(ctx), [], label);
      });
    });
  }

  it("data loss guard: a folder whose only content is a node without uid (a file, or a folder holding files) is never trashed as 'empty'", async () => {
    const tree = {
      "/my-files": [rawNode("d1", "root", "docs", "folder"), rawNode("d3", "root", "looks-empty", "folder"), rawNode("d4", "root", "holds-uidless-folder", "folder")],
      "/my-files/docs": [rawNode("f1", "d1", "a.pdf", "file", { size: 5000, sha1: "S1" })],
      "/my-files/looks-empty": [rawNode(null, "d3", "precious.txt", "file", { size: 99 })],
      "/my-files/holds-uidless-folder": [rawNode(null, "d4", "sub", "folder")], "/my-files/holds-uidless-folder/sub": [rawNode("z", "x", "real.txt", "file", { size: 5 })],
      "/trash": [],
    };
    await withServer({ fakeMode: "tree", replies: () => ACCEPT, setup: (sb) => ({ FAKE_TREE: writeTree(sb.dir, tree) }) }, async (ctx) => {
      await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["empty-folders"], confirmed: true });
      const trashed = trashCalls(ctx).flatMap(argPaths);
      assert.ok(!trashed.includes("/my-files/looks-empty"), `trashed ${trashed}: 'precious.txt' was inside`);
      assert.ok(!trashed.includes("/my-files/holds-uidless-folder"), `trashed ${trashed}: 'real.txt' was inside`);
    });
  });
});

// =====================================================================================================================================
// 5.2 case 5 + (k): names that try to forge the dialog
// =====================================================================================================================================
describe("case 5 and (k): the dialog survives hostile names, keeper on every line", CONC, () => {
  const EVIL = [
    ["newline + fake line", "x\n  - /my-files/docs/real.pdf  (empty folder)"],
    ["CRLF", "x\r\n  - /my-files/docs/real.pdf  (keeps /my-files/docs/other.pdf)"],
    ["U+2028 U+2029 NEL", "a\u2028  - /my-files/docs/real.pdf\u2029b\u0085c"],
    ["bidi override", "gpj.\u202etxt.exe"],
    ["bidi isolates", "\u2066abc\u2069\u2067def\u2069"],
    ["zero-width", "a\u200b\u200c\u200d\u2060\ufeffb"],
    ["ANSI escape", "\x1b[2J\x1b[31mred\x1b[0m"],
    ["NUL and backspace", "a\u0000b\b\bc"],
    ["imitated keeps suffix", "innocent.pdf  (keeps /my-files/docs/real.pdf)"],
    ["imitated header", "trash (1):"],
    ["imitated field", "fixes (2):\n  - duplicates"],
    ["very long", "L".repeat(3000)],
  ];
  for (const [label, evil] of EVIL) {
    it(`duplicate named ${label}: line structure intact, keeper last on the line, no raw control characters`, async () => {
      const nodes = [
        folder("d1", "root", "docs"), folder("d2", "root", "inbox"),
        file("k", "d1", "real.pdf", { size: 5000, sha1: "S", mtime: OLD }), file("v", "d2", evil, { size: 5000, sha1: "S", mtime: NEW }),
        file("w", "d2", "plain.pdf", { size: 5000, sha1: "S", mtime: NEW }),
      ];
      await withServer(o2(nodes, { replies: [DECLINE] }), async (ctx) => {
        const r = await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"], confirmed: true });
        assert.equal(r.isError, true);
        assert.deepEqual(trashCalls(ctx), []);
        const m = ctx.messages[0];
        assert.ok(m, "a dialog was shown");
        assert.doesNotMatch(m, DANGEROUS, "no raw control, bidi or zero-width character");
        const { n, lines, all } = dialogList(m);
        assert.equal(n, 2);
        assert.equal(lines.length, 2, `exactly the two planned lines\n${m.slice(0, 700)}`);
        assert.equal(all.filter((l) => /^trash \(\d+\):$/.test(l)).length, 1, "one trash header");
        assert.equal(all.filter((l) => /^fixes \(\d+\):$/.test(l)).length, 1, "one fixes header");
        assert.equal(all.filter((l) => /^path: /.test(l)).length, 1);
        for (const l of lines) assert.match(l, /^ {2}- \/my-files\/.* {2}\(keeps \/my-files\/docs\/real\.pdf\)( \[\d+ chars\])?$/, l.slice(0, 200));
        assert.equal(all.length, all.filter((l) => l === "" || /^(drive_cleanup:|path:|fixes \(|trash \(|verify|bytes|id:)/.test(l) || /^ {2}- /.test(l) || /^ {4}(keeps: |\(empty folder\)$)/.test(l)).length, "every line is a header, a field or a list entry");
      });
    });
  }

  it("every line carries its keeper, empty folders are marked as such, and the executed argv equals the shown list (also for evil keepers)", async () => {
    const evilKeeper = "keeper\n  - /my-files/inbox/x  (empty folder)\u202e";
    const nodes = [
      folder("d1", "root", "docs"), folder("d2", "root", "inbox"), folder("d3", "root", "empty"),
      file("k", "d1", evilKeeper, { size: 5000, sha1: "S", mtime: OLD }), file("v1", "d2", "copy1.pdf", { size: 5000, sha1: "S", mtime: NEW }), file("v2", "d2", "copy2.pdf", { size: 5000, sha1: "S", mtime: NEW }),
    ];
    await withServer(o2(nodes), async (ctx) => {
      const r = json(await ctx.call("drive_cleanup", { ...CLEAN, confirmed: true }));
      assert.equal(r.applied, true);
      const m = ctx.messages[0];
      assert.doesNotMatch(m, DANGEROUS);
      const { n, lines } = dialogList(m);
      assert.equal(n, 3);
      assert.equal(lines.length, 3);
      for (const l of lines) assert.match(l, /\((keeps .+|empty folder)\)$/, l);
      assert.equal(lines.filter((l) => /\(empty folder\)$/.test(l)).length, 1, "only the real empty folder carries that marker");
      assert.equal(lines.filter((l) => /\(keeps /.test(l)).length, 2);
      assert.equal(argPaths(trashCalls(ctx)[0]).length, 3);
      assert.equal(readNodes(ctx).k.trashTime, undefined);
      assert.deepEqual(trashedUids(ctx), ["d3", "v1", "v2"]);
    });
  });

  it("the undo dialog is structured the same way: one line per restored item, no raw characters, no forged sections", async () => {
    const nodes = [
      folder("d1", "root", "docs"), folder("d2", "root", "inbox"),
      file("k", "d1", "real.pdf", { size: 5000, sha1: "S", mtime: OLD }), file("v", "d2", "a\n  - /my-files/docs/real.pdf\u202e", { size: 5000, sha1: "S", mtime: NEW }),
    ];
    await withServer(o2(nodes), async (ctx) => {
      const c = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"], confirmed: true }));
      const r = json(await ctx.call("drive_undo", { action: "apply", id: c.undoId }));
      assert.equal(r.status, "undone");
      const m = ctx.messages[1];
      assert.doesNotMatch(m, DANGEROUS);
      const { n, lines } = dialogList(m, "restore");
      assert.equal(n, 1);
      assert.equal(lines.length, 1, m);
      assert.equal(m.split("\n").filter((l) => /^restore \(/.test(l)).length, 1);
      assert.equal(m.split("\n").filter((l) => /^moveBack \(/.test(l)).length, 1);
      assert.deepEqual(trashedUids(ctx), []);
    });
  });
});

// =====================================================================================================================================
// 5.2 case 7: the 200 cap
// =====================================================================================================================================
describe("case 7: more than 50 eligible items (CLEANUP_CAP: the number of items the approval dialog lists in full)", () => {
  it("duplicates: 55 pairs are capped at 50 per call with a correct 'remaining', the second call continues, and every group keeps exactly one member", async () => {
    const nodes = [folder("a", "root", "keep"), folder("b", "root", "dups")];
    for (let i = 0; i < 55; i++) {
      const id = String(i).padStart(3, "0");
      nodes.push(file(`k${i}`, "a", `o${id}.bin`, { size: 3000 + i, sha1: `P${i}`, mtime: OLD }), file(`c${i}`, "b", `c${id}.bin`, { size: 3000 + i, sha1: `P${i}`, mtime: NEW }));
    }
    await withServer(o2(nodes), async (ctx) => {
      const plan = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"] }));
      assert.equal(plan.counts.duplicates, 50);
      assert.equal(plan.remaining, 5);
      assert.ok(plan.samples.length <= 10);
      const one = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"], confirmed: true }));
      assert.equal(one.trashed, 50);
      assert.equal(one.remaining, 5);
      assert.equal(trashCalls(ctx).length, 1);
      assert.equal(argPaths(trashCalls(ctx)[0]).length, 50, "never more than the cap in one CLI call");
      assert.equal(trashedUids(ctx).length, 50);
      const nextPlan = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"] }));
      assert.equal(nextPlan.counts.duplicates, 5);
      assert.equal(nextPlan.remaining, 0);
      const two = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"], confirmed: true }));
      assert.equal(two.trashed, 5);
      assert.equal(trashedUids(ctx).length, 55);
      for (let i = 0; i < 55; i++) {
        assert.equal(readNodes(ctx)[`k${i}`].trashTime, undefined, `keeper ${i}`);
        assert.notEqual(readNodes(ctx)[`c${i}`].trashTime, undefined, `copy ${i}`);
      }
      assert.equal(journalIds(ctx).length, 2);
      // undo the second batch, then the first: the tree is whole again
      assert.equal(json(await ctx.call("drive_undo", { action: "apply" })).undone, 5);
      assert.equal(json(await ctx.call("drive_undo", { action: "apply" })).undone, 50);
      assert.deepEqual(trashedUids(ctx), []);
    });
  });

  it("empty folders and duplicates together: the cap is shared, the total never exceeds 50", async () => {
    const nodes = [folder("a", "root", "keep"), folder("b", "root", "dups")];
    for (let i = 0; i < 120; i++) nodes.push(folder(`e${i}`, "root", `empty-${String(i).padStart(3, "0")}`));
    for (let i = 0; i < 120; i++) {
      nodes.push(file(`k${i}`, "a", `o${i}.bin`, { size: 3000 + i, sha1: `P${i}`, mtime: OLD }), file(`c${i}`, "b", `c${i}.bin`, { size: 3000 + i, sha1: `P${i}`, mtime: NEW }));
    }
    await withServer(o2(nodes), async (ctx) => {
      const plan = json(await ctx.call("drive_cleanup", CLEAN));
      assert.ok(plan.counts.duplicates + plan.counts.emptyFolders <= 50, JSON.stringify(plan.counts));
      assert.equal(plan.remaining, 240 - (plan.counts.duplicates + plan.counts.emptyFolders));
      await ctx.call("drive_cleanup", { ...CLEAN, confirmed: true });
      assert.ok(argPaths(trashCalls(ctx)[0]).length <= 50);
    });
  });
});

// =====================================================================================================================================
// 5.2 case 8: per-item failure with exit code 0
// =====================================================================================================================================
describe("case 8: a CLI that reports failures with exit 0", CONC, () => {
  it("the journal holds exactly what reached the trash (state compared), status partial, and undo restores exactly those", async () => {
    const nodes = [folder("a", "root", "keep"), folder("b", "root", "dups")];
    for (let i = 0; i < 6; i++) nodes.push(file(`k${i}`, "a", `o${i}.bin`, { size: 3000 + i, sha1: `P${i}`, mtime: OLD }), file(`c${i}`, "b", `c${i}.bin`, { size: 3000 + i, sha1: `P${i}`, mtime: NEW }));
    await withServer(o2(nodes, {}, { FAKE_FAIL_TRASH_UIDS: "c1,c4" }), async (ctx) => {
      const r = await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"], confirmed: true });
      assert.equal(r.isError, true, "a partial failure is reported as a failure");
      assert.match(text(r), /4 of 6/);
      assert.deepEqual(trashedUids(ctx), ["c0", "c2", "c3", "c5"]);
      const [id] = journalIds(ctx);
      assert.ok(id, "a batch exists for what did go through");
      const j = readJournal(ctx, id);
      assert.deepEqual(j.items.map((i) => i.uid).sort(), trashedUids(ctx), "the journal equals the state");
      assert.equal(j.status, "partial");
      const u = json(await ctx.call("drive_undo", { action: "apply", id }));
      assert.equal(u.undone, 4);
      assert.deepEqual(trashedUids(ctx), []);
    });
  });

  it("everything fails (exit 0, ok:false): no batch is left behind that could restore something it never trashed", async () => {
    await withServer(o2(BASE, {}, { FAKE_FAIL_TRASH_UIDS: "f2,d3" }), async (ctx) => {
      const r = await ctx.call("drive_cleanup", { ...CLEAN, confirmed: true });
      assert.equal(r.isError, true);
      assert.deepEqual(trashedUids(ctx), []);
      for (const id of journalIds(ctx)) assert.deepEqual(readJournal(ctx, id).items, [], "an empty or absent batch");
      const u = await ctx.call("drive_undo", { action: "apply" });
      assert.deepEqual(restoreCalls(ctx), [], "nothing to restore, nothing restored");
      void u;
    });
  });

  it("a restore that says ok:true but changed nothing is not reported as undone (uid check after the call)", async () => {
    await withServer(o2(BASE, {}, { FAKE_LIE_UIDS: "f2" }), async (ctx) => {
      const c = json(await ctx.call("drive_cleanup", { ...CLEAN, confirmed: true }));
      const r = await ctx.call("drive_undo", { action: "apply", id: c.undoId });
      assert.ok(trashedUids(ctx).includes("f2"), "the liar left f2 in the trash");
      const body = r.isError ? null : json(r);
      assert.ok(r.isError === true || (body.status !== "undone" && body.failed.length >= 1), `must not claim success: ${text(r)}`);
      assert.notEqual(readJournal(ctx, c.undoId).status, "undone");
    });
  });

  it("a move that the CLI claims (ok:true) but never did: the batch must not make undo move that item, and undo never reports success for it", async () => {
    await withServer(o2(BASE, {}, { FAKE_LIE_UIDS: "f1" }), async (ctx) => {
      const mv = json(await ctx.call("drive_bulk_move", { sources: ["/my-files/docs/a.pdf", "/my-files/docs/unique.txt"], destinationFolder: "/my-files/empty", confirmed: true }));
      assert.equal(readNodes(ctx).f1.parentUid, "d1", "the liar never moved a.pdf");
      assert.equal(readNodes(ctx).f3.parentUid, "d3");
      const movesBefore = moveCalls(ctx).length;
      const r = await ctx.call("drive_undo", { action: "apply", id: mv.undoId });
      assert.equal(readNodes(ctx).f1.parentUid, "d1", "a.pdf is where it always was");
      assert.equal(readNodes(ctx).f3.parentUid, "d1", "unique.txt went back");
      assert.ok(!moveCalls(ctx).slice(movesBefore).some((c) => c.some((a) => /a\.pdf/.test(a))), "undo never addresses an item that is not where the batch says it put it");
      void r;
    });
  });
});

// =====================================================================================================================================
// (c) the keeper property, end to end, over many seeded random trees
// =====================================================================================================================================
describe("(c) keeper property over seeded random trees (stateful fake)", { concurrency: 6 }, () => {
  const stats = [];
  after(() => {
    // the property tests must not pass vacuously: across the seeds, real duplicates and real empty folders were trashed
    assert.equal(stats.length, 24);
    assert.ok(stats.filter((x) => x.files > 0).length >= 10, `seeds that trashed a duplicate: ${JSON.stringify(stats)}`);
    assert.ok(stats.filter((x) => x.folders > 0).length >= 8, `seeds that trashed an empty folder: ${JSON.stringify(stats)}`);
    assert.ok(stats.filter((x) => x.sharedSeen).length >= 8, "seeds that contained shared items");
  });
  for (let seed = 1; seed <= 24; seed++) {
    it(`seed ${seed}: apply leaves a member of every group, trashes no folder with files below, no shared item, nothing outside, undo restores the tree`, async () => {
      const nodes = genTree(seed);
      await withServer(o2(nodes), async (ctx) => {
        const init = readNodes(ctx);
        const shape0 = treeShape(ctx);
        const trash0 = trashedUids(ctx);
        const plan = await ctx.call("drive_cleanup", { path: "/my-files/scope", fixes: ["duplicates", "empty-folders"] });
        assert.notEqual(plan.isError, true, text(plan));
        const applied = await ctx.call("drive_cleanup", { path: "/my-files/scope", fixes: ["duplicates", "empty-folders"], confirmed: true });
        assert.notEqual(applied.isError, true, text(applied));
        const after = readNodes(ctx);
        const newlyTrashed = Object.values(after).filter((n) => n.trashTime !== undefined && init[n.uid]?.trashTime === undefined).map((n) => n.uid);
        // helpers over the INITIAL tree
        const liveInit = Object.values(init).filter((n) => n.trashTime === undefined);
        const ancestors = (uid) => { const out = []; for (let p = init[uid]?.parentUid; p && init[p]; p = init[p].parentUid) out.push(init[p]); return out; };
        const under = (uid, ancestorUid) => ancestors(uid).some((a) => a.uid === ancestorUid);
        const descendants = (uid) => liveInit.filter((n) => under(n.uid, uid));
        const label = `seed ${seed}`;
        stats.push({ seed, files: newlyTrashed.filter((u) => init[u].type === "file").length, folders: newlyTrashed.filter((u) => init[u].type === "folder").length, sharedSeen: Object.values(init).some((n) => n.shared || n.sharedByUrl) });

        // 1. every duplicate group (same claimed sha1) keeps at least one member alive
        const groups = new Map();
        for (const n of liveInit) if (n.type === "file" && n.sha1) groups.set(n.sha1, [...(groups.get(n.sha1) ?? []), n.uid]);
        for (const [sha, uids] of groups) assert.ok(uids.some((u) => after[u].trashTime === undefined), `${label}: group ${sha} lost every member`);
        // 2. a trashed file always has a surviving file with the same claimed sha1 and the same size
        for (const uid of newlyTrashed.filter((u) => init[u].type === "file")) {
          const f = init[uid];
          assert.ok(f.sha1, `${label}: ${uid} trashed without a claimed sha1 and without verify`);
          assert.ok(liveInit.some((g) => g.uid !== uid && g.type === "file" && g.sha1 === f.sha1 && (g.size ?? 0) === (f.size ?? 0) && after[g.uid].trashTime === undefined), `${label}: ${uid} has no equal surviving twin`);
        }
        // 2b. plan 3.2 rule 3: the walk sees only the path, so a trashed file's group is its in-path members (same claimed sha1 and size);
        //     none of them may be shared or sit in a shared folder, and the surviving twin (the keeper) is one of them
        for (const uid of newlyTrashed.filter((u) => init[u].type === "file")) {
          const f = init[uid];
          const members = liveInit.filter((x) => x.type === "file" && x.sha1 === f.sha1 && (x.size ?? 0) === (f.size ?? 0) && under(x.uid, "scope"));
          assert.ok(members.some((g) => g.uid !== uid && after[g.uid].trashTime === undefined), `${label}: ${uid} has no surviving in-path twin`);
          for (const g of members) {
            assert.ok(![g, ...ancestors(g.uid)].some((n) => n.shared || n.sharedByUrl), `${label}: ${uid} was trashed although group member ${g.uid} is shared or in a shared folder`);
          }
        }
        // 3. everything trashed lives under /my-files/scope
        for (const uid of newlyTrashed) assert.ok(under(uid, "scope"), `${label}: ${uid} is outside the path`);
        // 4. nothing shared, nothing inside a shared folder or link
        for (const uid of newlyTrashed) {
          const chain = [init[uid], ...ancestors(uid)];
          assert.ok(!chain.some((n) => n.shared || n.sharedByUrl), `${label}: ${uid} is shared or inside something shared`);
        }
        // 5. a folder with any file below it is never trashed
        for (const uid of newlyTrashed.filter((u) => init[u].type === "folder")) {
          assert.deepEqual(descendants(uid).filter((n) => n.type === "file").map((n) => n.uid), [], `${label}: folder ${uid} held files`);
        }
        // 6. names: nothing whose name is already in the trash, no two same-named items in one batch (plan 3.5)
        const trashNames = new Set(Object.values(init).filter((n) => n.trashTime !== undefined).map((n) => n.name));
        const seen = new Set();
        for (const uid of newlyTrashed) {
          assert.ok(!trashNames.has(init[uid].name), `${label}: ${uid} (${init[uid].name}) collides with a name already in trash`);
          assert.ok(!seen.has(init[uid].name), `${label}: two items named ${init[uid].name} in one batch`);
          seen.add(init[uid].name);
        }
        // 7. outside the path nothing moved
        for (const n of Object.values(init)) if (!under(n.uid, "scope") && n.uid !== "scope") assert.equal(after[n.uid].trashTime, n.trashTime, `${label}: ${n.uid} outside the path changed`);
        assert.equal(after.scope.trashTime, undefined);
        // 8. the batch is the state
        if (newlyTrashed.length) {
          const [id] = journalIds(ctx);
          assert.deepEqual(readJournal(ctx, id).items.map((i) => i.uid).sort(), [...newlyTrashed].sort(), `${label}: journal differs from the trashed set`);
          assert.equal(trashCalls(ctx).length, 1);
          const u = await ctx.call("drive_undo", { action: "apply", id });
          assert.notEqual(u.isError, true, `${label}: ${text(u)}`);
          assert.equal(json(u).status, "undone", `${label}: ${text(u)}`);
          assert.deepEqual(treeShape(ctx), shape0, `${label}: the tree after undo differs`);
          assert.deepEqual(trashedUids(ctx), trash0, label);
        } else {
          assert.deepEqual(trashCalls(ctx), [], label);
        }
      });
    });
  }
});

// =====================================================================================================================================
// (g) undo
// =====================================================================================================================================
describe("(g) drive_undo: refusals and skips", CONC, () => {
  /** A reply function that answers dialogs once n are open (so the calls are released together) or after 1.5 s: the server may refuse a second dialog. */
  const barrier = (n) => { const waiters = []; let asked = 0; return () => new Promise((resolve) => { waiters.push(() => resolve(ACCEPT)); if (++asked >= n) waiters.forEach((w) => w()); setTimeout(() => resolve(ACCEPT), 1500).unref?.(); }); };

  it("two drive_cleanup applies approved at the same moment: no path is trashed twice, every journalled uid is trashed exactly once, keepers survive", async () => {
    const nodes = [folder("a", "root", "keep"), folder("b", "root", "dups")];
    for (let i = 0; i < 12; i++) nodes.push(file(`k${i}`, "a", `o${i}.bin`, { size: 3000 + i, sha1: `P${i}`, mtime: OLD }), file(`c${i}`, "b", `c${i}.bin`, { size: 3000 + i, sha1: `P${i}`, mtime: NEW }));
    await withServer(o2(nodes, { replies: barrier(2) }), async (ctx) => {
      const args = { path: "/my-files", fixes: ["duplicates"], confirmed: true };
      await Promise.all([ctx.call("drive_cleanup", args), ctx.call("drive_cleanup", args)]);
      const addressed = trashCalls(ctx).flatMap(argPaths);
      assert.equal(new Set(addressed).size, addressed.length, `a path was sent to trash twice: ${addressed}`);
      for (let i = 0; i < 12; i++) assert.equal(readNodes(ctx)[`k${i}`].trashTime, undefined, `keeper ${i}`);
      assert.equal(trashedUids(ctx).length, 12);
      const journalled = journalIds(ctx).flatMap((id) => readJournal(ctx, id).items.map((i) => i.uid));
      assert.equal(new Set(journalled).size, journalled.length, "no uid is in two batches");
      assert.deepEqual([...journalled].sort(), trashedUids(ctx), "the journals together are exactly what is in the trash");
    });
  });

  const DOCS = [
    folder("d1", "root", "docs"), folder("d2", "root", "inbox"), folder("d3", "root", "empty"),
    file("x1", "d1", "x.txt", { size: 10 }), file("y1", "d1", "y.txt", { size: 20 }), file("z1", "d2", "z.txt", { size: 30 }),
  ];

  it("a second undo of the same batch is refused and restores nothing; so is 'the newest' once everything is undone", async () => {
    await withServer(o2(BASE), async (ctx) => {
      const c = json(await ctx.call("drive_cleanup", { ...CLEAN, confirmed: true }));
      assert.equal(json(await ctx.call("drive_undo", { action: "apply", id: c.undoId })).status, "undone");
      const restores = restoreCalls(ctx).length;
      const asked = ctx.asked;
      for (const a of [{ action: "apply", id: c.undoId }, { action: "apply" }, { action: "plan", id: c.undoId }]) {
        const again = await ctx.call("drive_undo", a);
        assert.equal(again.isError, true, JSON.stringify(a));
      }
      assert.equal(restoreCalls(ctx).length, restores);
      assert.equal(ctx.asked, asked, "refused before any dialog");
      assert.deepEqual(trashedUids(ctx), []);
      // and trashing again, then undoing the OLD id still does not restore the new trash
      await ctx.call("drive_bulk_trash", { paths: ["/my-files/docs/unique.txt"], confirmed: true });
      assert.equal((await ctx.call("drive_undo", { action: "apply", id: c.undoId })).isError, true);
      assert.deepEqual(trashedUids(ctx), ["f3"]);
    });
  });

  it("move batch: an item the user moved elsewhere afterwards is skipped with a reason, the rest goes back, nothing is overwritten", async () => {
    await withServer(o2(BASE), async (ctx) => {
      const mv = json(await ctx.call("drive_bulk_move", { sources: ["/my-files/docs/a.pdf", "/my-files/docs/unique.txt"], destinationFolder: "/my-files/empty", confirmed: true }));
      assert.equal(readNodes(ctx).f1.parentUid, "d3");
      patchState(ctx, (n) => { n.f1.parentUid = "d2"; }); // the user filed a.pdf under inbox
      const plan = json(await ctx.call("drive_undo", { id: mv.undoId }));
      const skipped = plan.items.filter((i) => !i.restorable);
      assert.equal(skipped.length, 1, JSON.stringify(plan));
      assert.ok(skipped[0].reason && skipped[0].reason.length > 3);
      const movesBefore = moveCalls(ctx).length;
      const r = json(await ctx.call("drive_undo", { action: "apply", id: mv.undoId }));
      assert.equal(r.status, "partial");
      assert.equal(readNodes(ctx).f1.parentUid, "d2", "the user's own move stays");
      assert.equal(readNodes(ctx).f3.parentUid, "d1", "the other item went back");
      const undoMoves = moveCalls(ctx).slice(movesBefore);
      assert.ok(undoMoves.length >= 1);
      assert.ok(!undoMoves.some((c) => c.some((a) => /a\.pdf/.test(a))), "the moved-away item was never addressed");
    });
  });

  it("rename batch: renamed again by the user -> skipped, nothing renamed", async () => {
    await withServer(o2(BASE), async (ctx) => {
      const rn = json(await ctx.call("drive_rename", { path: "/my-files/docs/unique.txt", newName: "first.txt" }));
      patchState(ctx, (n) => { n.f3.name = "mine.txt"; });
      const renamesBefore = renameCalls(ctx).length;
      const r = await ctx.call("drive_undo", { action: "apply", id: rn.undoId });
      assert.equal(renameCalls(ctx).length, renamesBefore, "no rename call");
      assert.equal(readNodes(ctx).f3.name, "mine.txt");
      assert.ok(r.isError === true || json(r).undone === 0);
    });
  });

  it("move batch: the original name is taken, or the original folder is gone -> skipped, the squatter is untouched", async () => {
    await withServer(o2(BASE), async (ctx) => {
      const mv = json(await ctx.call("drive_bulk_move", { sources: ["/my-files/docs/a.pdf", "/my-files/docs/unique.txt"], destinationFolder: "/my-files/empty", confirmed: true }));
      patchState(ctx, (n) => { n.squat = file("squat", "d1", "a.pdf", { size: 1 }); n.d1.name = "docs"; });
      const r = json(await ctx.call("drive_undo", { action: "apply", id: mv.undoId }));
      assert.equal(readNodes(ctx).squat.parentUid, "d1");
      assert.equal(readNodes(ctx).squat.size, 1);
      assert.equal(readNodes(ctx).f1.parentUid, "d3", "a.pdf stays where it is");
      assert.equal(readNodes(ctx).f3.parentUid, "d1");
      assert.equal(r.status, "partial");
    });
    await withServer(o2(BASE), async (ctx) => {
      const mv = json(await ctx.call("drive_bulk_move", { sources: ["/my-files/docs/a.pdf"], destinationFolder: "/my-files/empty", confirmed: true }));
      patchState(ctx, (n) => { n.d1.trashTime = "2026-11-19T12:00:00Z"; });
      const before = JSON.stringify(readNodes(ctx));
      const r = await ctx.call("drive_undo", { action: "apply", id: mv.undoId });
      assert.ok(r.isError === true || json(r).undone === 0, text(r));
      assert.equal(readNodes(ctx).f1.parentUid, "d3");
      assert.equal(JSON.stringify(readNodes(ctx)), before, "state byte-for-byte unchanged");
    });
  });

  it("trash batch: the original parent was deleted, or a same-named file now lives there -> the item stays in trash, nothing overwritten", async () => {
    await withServer(o2(DOCS), async (ctx) => {
      const b = json(await ctx.call("drive_bulk_trash", { paths: ["/my-files/docs/x.txt", "/my-files/inbox/z.txt"], confirmed: true }));
      patchState(ctx, (n) => { n.d1.trashTime = "2026-11-19T12:00:00Z"; }); // docs gone
      const plan = json(await ctx.call("drive_undo", { id: b.undoId }));
      assert.equal(plan.items.find((i) => /x\.txt/.test(i.path)).restorable, false, JSON.stringify(plan));
      const r = json(await ctx.call("drive_undo", { action: "apply", id: b.undoId }));
      assert.equal(readNodes(ctx).x1.trashTime !== undefined, true, "x.txt stays in trash");
      assert.equal(readNodes(ctx).z1.trashTime, undefined, "z.txt (parent intact) is back");
      assert.equal(r.status, "partial");
    });
    await withServer(o2(DOCS), async (ctx) => {
      const b = json(await ctx.call("drive_bulk_trash", { paths: ["/my-files/docs/x.txt"], confirmed: true }));
      patchState(ctx, (n) => { n.squat = file("squat", "d1", "x.txt", { size: 99 }); });
      const r = await ctx.call("drive_undo", { action: "apply", id: b.undoId });
      assert.ok(r.isError === true || json(r).undone === 0, text(r));
      assert.notEqual(readNodes(ctx).x1.trashTime, undefined);
      assert.deepEqual([readNodes(ctx).squat.parentUid, readNodes(ctx).squat.size, readNodes(ctx).squat.trashTime], ["d1", 99, undefined], "the new file is untouched");
    });
  });

  for (const zFirst of [true, false]) {
    it(`a same-named item trashed by someone else (${zFirst ? "listed first" : "listed last"} in the trash): only the unique items are restored, never 'some item named x.txt'`, async () => {
      await withServer(o2(DOCS), async (ctx) => {
        const b = json(await ctx.call("drive_bulk_trash", { paths: ["/my-files/docs/x.txt", "/my-files/docs/y.txt"], confirmed: true }));
        patchState(ctx, (n) => {
          const stranger = file("stranger", "d2", "x.txt", { size: 77, trashTime: "2026-11-19T12:30:00Z" });
          const copy = { ...n };
          for (const k of Object.keys(n)) delete n[k];
          if (zFirst) n.stranger = stranger;
          Object.assign(n, copy);
          if (!zFirst) n.stranger = stranger;
        });
        const plan = json(await ctx.call("drive_undo", { id: b.undoId }));
        assert.equal(plan.restorable, 1, JSON.stringify(plan));
        const r = json(await ctx.call("drive_undo", { action: "apply", id: b.undoId }));
        assert.equal(r.status, "partial");
        assert.equal(readNodes(ctx).y1.trashTime, undefined, "y.txt is back");
        assert.notEqual(readNodes(ctx).x1.trashTime, undefined, "x.txt stays in trash (ambiguous name)");
        assert.notEqual(readNodes(ctx).stranger.trashTime, undefined, "the stranger's item is untouched");
        for (const c of restoreCalls(ctx)) assert.ok(!argPaths(c).includes("/trash/x.txt"), "the ambiguous name was never sent to restore");
        assert.deepEqual(trashedUids(ctx), ["stranger", "x1"]);
      });
    });
  }

  it("two same-named items trashed in one batch cannot be told apart by name: neither is restored", async () => {
    const nodes = [folder("d1", "root", "docs"), folder("d2", "root", "inbox"), file("a", "d1", "same.txt"), file("b", "d2", "same.txt"), file("c", "d1", "other.txt")];
    await withServer(o2(nodes), async (ctx) => {
      const t = json(await ctx.call("drive_bulk_trash", { paths: ["/my-files/docs/same.txt", "/my-files/inbox/same.txt", "/my-files/docs/other.txt"], confirmed: true }));
      const r = await ctx.call("drive_undo", { action: "apply", id: t.undoId });
      for (const c of restoreCalls(ctx)) assert.ok(!argPaths(c).includes("/trash/same.txt"));
      assert.deepEqual(trashedUids(ctx), ["a", "b"]);
      assert.equal(readNodes(ctx).c.trashTime, undefined, "the unique one is back");
      void r;
    });
  });
});

describe("(g) drive_undo: a tampered journal never restores outside the roots and never throws", CONC, () => {
  const NODES = [
    folder("d1", "root", "docs"), folder("d2", "root", "inbox"), folder("d3", "root", "elsewhere"),
    file("f1", "d1", "a.pdf", { size: 10 }), file("f3", "d1", "unique.txt", { size: 20 }),
    file("o1", "d2", "outside.txt", { size: 5, trashTime: "2026-11-19T10:00:00Z" }),
    file("o2", "d3", "other.txt", { size: 5, trashTime: "2026-11-19T10:00:00Z" }),
  ];
  const tamper = (ctx, id, fn) => {
    const p = join(undoDir(ctx), `${id}.json`);
    const j = JSON.parse(readFileSync(p, "utf8"));
    const out = fn(j);
    writeFileSync(p, typeof out === "string" ? out : JSON.stringify(out ?? j));
  };
  /** A batch that trashed docs/a.pdf, plus its journal id. */
  async function makeBatch(ctx) {
    const b = json(await ctx.call("drive_bulk_trash", { paths: ["/my-files/docs/a.pdf"], confirmed: true }));
    assert.match(b.undoId, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    return b.undoId;
  }
  const noStack = (r, label) => assert.doesNotMatch(text(r), STACK, `${label}: ${text(r).slice(0, 300)}`);
  const snapshot = (ctx) => JSON.stringify(readNodes(ctx));

  it("uid replaced by the uid of a LIVE file: that file is never moved, trashed or renamed", async () => {
    await withServer(o2(NODES), async (ctx) => {
      const id = await makeBatch(ctx);
      tamper(ctx, id, (j) => { j.items[0].uid = "f3"; });
      const before = snapshot(ctx);
      for (const a of [{ action: "plan", id }, { action: "apply", id }]) { const r = await ctx.call("drive_undo", a); noStack(r, JSON.stringify(a)); }
      assert.equal(snapshot(ctx), before, "Drive unchanged");
      assert.deepEqual(writes(ctx).filter((c) => c[1] !== "trash"), [], "no restore/move/rename at all");
      await alive(ctx);
    });
  });

  it("uid replaced by the uid of an item that sits in the trash from OUTSIDE the roots: it stays in the trash", async () => {
    await withServer(o2(NODES, {}, { PROTON_DRIVE_REMOTE_ROOTS: "/my-files/docs" }), async (ctx) => {
      const id = await makeBatch(ctx);
      tamper(ctx, id, (j) => { j.items[0].uid = "o1"; /* lived in /my-files/inbox, the journal still says docs/a.pdf */ });
      const before = snapshot(ctx);
      for (const a of [{ action: "plan", id }, { action: "apply", id }]) { const r = await ctx.call("drive_undo", a); noStack(r, JSON.stringify(a)); }
      assert.notEqual(readNodes(ctx).o1.trashTime, undefined, "o1 (an inbox file) must not be restored by a journal that claims it came from docs");
      assert.equal(snapshot(ctx), before);
    });
  });

  it("paths outside PROTON_DRIVE_REMOTE_ROOTS, in /shared-with-me, or with .. segments: refused or skipped, nothing restored, moved or renamed, outside paths never shown", async () => {
    for (const from of ["/my-files/inbox/outside.txt", "/shared-with-me/team/outside.txt", "/my-files/docs/../inbox/outside.txt", "/my-files/docs/../../trash/outside.txt", "/my-files/docsX/outside.txt", "/trash/outside.txt", "/", "relative/outside.txt", "/my-files/docs/\u0000x"]) {
      await withServer(o2(NODES, {}, { PROTON_DRIVE_REMOTE_ROOTS: "/my-files/docs" }), async (ctx) => {
        const id = await makeBatch(ctx);
        tamper(ctx, id, (j) => { j.items[0].uid = "o1"; j.items[0].from = from; j.items[0].name = "outside.txt"; j.items[0].parentUid = "d2"; });
        const before = snapshot(ctx);
        const lexicallyInside = from.startsWith("/my-files/docs/");
        for (const a of [{ action: "plan", id }, { action: "apply", id }]) {
          const r = await ctx.call("drive_undo", a);
          noStack(r, `${from} ${a.action}`);
          if (!lexicallyInside) assert.doesNotMatch(text(r), /outside\.txt/, `${from}: a path outside the roots must not be shown`);
          if (a.action === "plan" && !r.isError) assert.equal(json(r).restorable, 0, `${from}: nothing is restorable`);
        }
        if (!lexicallyInside) assert.doesNotMatch(ctx.messages.join("\n"), /outside\.txt/, "never shown in a dialog either");
        assert.equal(snapshot(ctx), before, `from=${JSON.stringify(from)}: Drive unchanged`);
        assert.deepEqual(writes(ctx).filter((c) => c[1] !== "trash"), []);
      });
    }
  });

  it("a move batch tampered to move back into /shared-with-me, outside the roots, or to a .. path: no move call, nothing moved", async () => {
    for (const [label, mutate] of [
      ["from in shared-with-me", (j) => { j.items[0].from = "/shared-with-me/evil/a.pdf"; }],
      ["from outside roots", (j) => { j.items[0].from = "/my-files/inbox/a.pdf"; }],
      ["from with ..", (j) => { j.items[0].from = "/my-files/docs/../inbox/a.pdf"; }],
      ["to outside roots", (j) => { j.items[0].to = "/my-files/inbox/a.pdf"; }],
      ["parentUid foreign", (j) => { j.items[0].parentUid = "d2"; }],
    ]) {
      await withServer(o2(NODES, {}, { PROTON_DRIVE_REMOTE_ROOTS: ["/my-files/docs", "/my-files/elsewhere"].join(delimiter) }), async (ctx) => {
        const mv = json(await ctx.call("drive_bulk_move", { sources: ["/my-files/docs/a.pdf"], destinationFolder: "/my-files/elsewhere", confirmed: true }));
        tamper(ctx, mv.undoId, mutate);
        const movesBefore = moveCalls(ctx).length;
        for (const a of [{ action: "plan", id: mv.undoId }, { action: "apply", id: mv.undoId }]) noStack(await ctx.call("drive_undo", a), label);
        for (const c of moveCalls(ctx).slice(movesBefore)) for (const p of argPaths(c)) assert.match(p, /^\/my-files\/(docs|elsewhere)(\/|$)/, `${label}: move touched ${p}`);
        assert.ok(!moveCalls(ctx).slice(movesBefore).some((c) => c.some((p) => /shared-with-me|inbox/.test(p))), label);
        assert.ok(["d3", "d1"].includes(readNodes(ctx).f1.parentUid), `${label}: a.pdf is where it was left or back in docs, nowhere else`);
      });
    }
  });

  it("another account, an unknown version, a missing version: refused, restores nothing", async () => {
    for (const [label, mutate] of [
      ["other account", (j) => { j.account = "someone-else"; }], ["no account", (j) => { delete j.account; }],
      ["v 2", (j) => { j.v = 2; }], ["v 0", (j) => { j.v = 0; }], ["v as string", (j) => { j.v = "1"; }], ["no v", (j) => { delete j.v; }], ["v null", (j) => { j.v = null; }],
    ]) {
      await withServer(o2(NODES), async (ctx) => {
        const id = await makeBatch(ctx);
        tamper(ctx, id, mutate);
        const before = snapshot(ctx);
        for (const a of [{ action: "plan", id }, { action: "apply", id }, { action: "apply" }, { action: "list" }]) {
          const r = await ctx.call("drive_undo", a);
          noStack(r, `${label} ${JSON.stringify(a)}`);
          if (a.action === "apply") assert.equal(r.isError, true, `${label} apply must be refused: ${text(r)}`);
        }
        assert.equal(snapshot(ctx), before, label);
        assert.deepEqual(restoreCalls(ctx), [], label);
      });
    }
  });

  it("garbage in the journal file (not JSON, empty, wrong types, unknown kind, prototype keys): no stack trace, server alive, nothing restored", async () => {
    const garbage = [
      ["not json", "this is { not json"], ["empty file", ""], ["null", "null"], ["array", "[]"], ["string", '"x"'],
      ["items not an array", (j) => { j.items = "x"; }], ["items null entries", (j) => { j.items = [null, 5, "s", [], {}]; }],
      ["uid is an object", (j) => { j.items[0].uid = { $ne: 1 }; }], ["from is a number", (j) => { j.items[0].from = 5; }],
      ["unknown kind", (j) => { j.kind = "delete"; }], ["unknown status", (j) => { j.status = "weird"; }], ["tool wrong", (j) => { j.tool = "drive_empty_trash"; }],
      ["negative size, NaN-ish", (j) => { j.items[0].size = -1; j.createdAt = "yesterday"; }], ["huge name", (j) => { j.items[0].name = "n".repeat(100000); }],
      ["proto keys", '{"v":1,"__proto__":{"x":1},"id":"AAAA-BBBB","account":"root","tool":"drive_bulk_trash","kind":"trash","status":"applied","createdAt":1,"items":[{"uid":"f1","__proto__":{"restorable":true},"from":"/my-files/docs/a.pdf","name":"a.pdf"}]}'],
      ["kind move without to", (j) => { j.kind = "move"; delete j.items[0].to; }], ["rename kind with trash item", (j) => { j.kind = "rename"; }],
      ["duplicate uids", (j) => { j.items.push({ ...j.items[0] }, { ...j.items[0] }); }],
      ["10000 items", (j) => { j.items = Array.from({ length: 10000 }, (_, i) => ({ uid: `u${i}`, from: `/my-files/docs/f${i}`, name: `f${i}`, restorable: true })); }],
    ];
    for (const [label, g] of garbage) {
      await withServer(o2(NODES), async (ctx) => {
        const id = await makeBatch(ctx);
        tamper(ctx, id, typeof g === "function" ? g : () => g);
        const before = snapshot(ctx);
        for (const a of [{ action: "list" }, { action: "plan", id }, { action: "apply", id }, { action: "apply" }]) {
          const r = await ctx.call("drive_undo", a);
          noStack(r, `${label} ${JSON.stringify(a)}`);
          assert.ok(typeof text(r) === "string");
        }
        // whatever the file says, only the one item it was written for (f1) may change, and a file that is not a valid journal changes nothing
        const was = JSON.parse(before);
        for (const n of Object.values(readNodes(ctx))) if (n.uid !== "f1") assert.deepEqual(n, was[n.uid], `${label}: ${n.uid} changed`);
        if (["not json", "empty file", "null", "array", "string", "items not an array", "items null entries", "uid is an object", "from is a number", "unknown kind", "10000 items"].includes(label)) assert.equal(snapshot(ctx), before, label);
        for (const c of [...restoreCalls(ctx), ...moveCalls(ctx), ...renameCalls(ctx)]) assert.ok(c.length < 40, `${label}: call with ${c.length} args`);
        await alive(ctx);
      });
    }
  });

  it("ids that try to leave the journal folder are refused before any file access: ../, backslashes, NUL, newline, very long, a planted journal next to the folder", async () => {
    await withServer({
      ...o2(NODES),
      setup: (sb) => {
        const env = driveSetup(NODES)(sb);
        mkdirSync(join(sb.dir, "undo"), { recursive: true });
        // a perfectly valid journal OUTSIDE the undo folder, aimed at a trashed item
        writeFileSync(join(sb.dir, "evil.json"), JSON.stringify({ v: 1, id: "ABCD-EFGH", account: "root", createdAt: Date.now(), tool: "drive_bulk_trash", kind: "trash", status: "applied", items: [{ uid: "o1", parentUid: "d2", from: "/my-files/inbox/outside.txt", name: "outside.txt", restorable: true }] }));
        return env;
      },
    }, async (ctx) => {
      const before = snapshot(ctx);
      for (const id of ["../evil", "../../evil", "..\\evil", "../evil.json", "ABCD-EFGH/../../evil", "/etc/passwd", "ABCD-EFGH\n", "ABCD-EFGH\u0000", "A".repeat(10000), "abcd-efgh", "ABCD EFGH", "", "..", "ABCD-EFGH.json", join(ctx.dir, "evil")]) {
        for (const action of ["plan", "apply"]) {
          const r = await ctx.call("drive_undo", { action, id });
          assert.equal(r.isError, true, `${action} ${JSON.stringify(id.slice(0, 40))}: ${text(r).slice(0, 200)}`);
          noStack(r, id.slice(0, 20));
        }
      }
      assert.equal(snapshot(ctx), before);
      assert.deepEqual(restoreCalls(ctx), []);
      assert.equal(ctx.asked, 0);
    });
  });

  it("a batch older than the retention (30 days) is gone: not listed, not undoable", async () => {
    await withServer(o2(NODES), async (ctx) => {
      const id = await makeBatch(ctx);
      tamper(ctx, id, (j) => { j.createdAt = Date.now() - 40 * DAY; });
      const list = await ctx.call("drive_undo", { action: "list" });
      if (!list.isError) assert.ok(!json(list).batches.some((b) => b.id === id), "a 40-day-old batch is not offered");
      const r = await ctx.call("drive_undo", { action: "apply", id });
      assert.equal(r.isError, true, text(r));
      assert.deepEqual(restoreCalls(ctx), []);
      assert.notEqual(readNodes(ctx).f1.trashTime, undefined);
    });
  });

  it("the cap: after 55 changes at most 50 batches are kept, the newest is undoable, the oldest is gone", async () => {
    const nodes = [folder("d1", "root", "docs"), file("f1", "d1", "n0.txt")];
    await withServer(o2(nodes), async (ctx) => {
      const ids = [];
      for (let i = 1; i <= 55; i++) {
        const r = json(await ctx.call("drive_rename", { path: `/my-files/docs/n${i - 1}.txt`, newName: `n${i}.txt` }));
        ids.push(r.undoId);
      }
      const kept = journalIds(ctx);
      assert.ok(kept.length <= 50, `${kept.length} batches kept`);
      assert.ok(!kept.includes(ids[0]), "the oldest batch was dropped");
      assert.ok(kept.includes(ids[54]), "the newest batch is kept");
      const list = json(await ctx.call("drive_undo", { action: "list" }));
      assert.ok(list.batches.length <= 20, "a listing is the newest 20");
      assert.equal(list.batches[0].id, ids[54]);
      const u = json(await ctx.call("drive_undo", { action: "apply" }));
      assert.equal(u.status, "undone");
      assert.equal(readNodes(ctx).f1.name, "n54.txt");
    });
  });

  it("a batch left 'pending' by a crash is reconciled by uid: what reached the trash is restorable, what never did is not touched", async () => {
    await withServer(o2(NODES), async (ctx) => {
      const id = await makeBatch(ctx); // f1 trashed
      tamper(ctx, id, (j) => {
        j.status = "pending";
        j.items.push({ uid: "f3", parentUid: "d1", from: "/my-files/docs/unique.txt", name: "unique.txt", restorable: true }); // announced, never trashed
      });
      const plan = json(await ctx.call("drive_undo", { id }));
      assert.equal(plan.items.find((i) => /a\.pdf/.test(i.path)).restorable, true, JSON.stringify(plan));
      assert.equal(plan.items.find((i) => /unique\.txt/.test(i.path)).restorable, false, "f3 is alive: nothing to restore");
      await ctx.call("drive_undo", { action: "apply", id });
      assert.equal(readNodes(ctx).f1.trashTime, undefined, "f1 is back");
      assert.equal(readNodes(ctx).f3.trashTime, undefined);
      assert.equal(readNodes(ctx).f3.parentUid, "d1");
      for (const c of restoreCalls(ctx)) assert.ok(!argPaths(c).some((p) => /unique/.test(p)), "the never-trashed item was not addressed");
    });
  });

  it("two undo applies approved at the same moment: every item is restored once, nothing is addressed twice, the batch ends 'undone'", async () => {
    let gate = null;
    await withServer(o2(NODES, { replies: () => (gate ? gate() : ACCEPT) }), async (ctx) => {
      const id = await makeBatch(ctx);
      gate = (() => { const waiters = []; let asked = 0; return () => new Promise((resolve) => { waiters.push(() => resolve(ACCEPT)); if (++asked >= 2) waiters.forEach((w) => w()); setTimeout(() => resolve(ACCEPT), 1500).unref?.(); }); })();
      const [r1, r2] = await Promise.all([ctx.call("drive_undo", { action: "apply", id }), ctx.call("drive_undo", { action: "apply", id })]);
      assert.equal(readNodes(ctx).f1.trashTime, undefined);
      assert.ok(r1.isError !== true || r2.isError !== true, "one of them succeeds");
      const addressed = restoreCalls(ctx).flatMap(argPaths);
      assert.equal(new Set(addressed).size, addressed.length, `restore addressed the same path twice: ${addressed}`);
      assert.equal(readJournal(ctx, id).status, "undone");
      assert.equal(Object.values(readNodes(ctx)).filter((n) => n.name === "a.pdf" && n.trashTime === undefined).length, 1);
    });
  });

  it("journal files are private (0600 in a 0700 folder) on POSIX", async () => {
    await withServer(o2(NODES), async (ctx) => {
      const id = await makeBatch(ctx);
      if (process.platform === "win32") return;
      assert.equal(statSync(undoDir(ctx)).mode & 0o777, 0o700);
      assert.equal(statSync(join(undoDir(ctx), `${id}.json`)).mode & 0o777, 0o600);
      for (const f of readdirSync(undoDir(ctx))) assert.equal(statSync(join(undoDir(ctx), f)).mode & 0o077, 0, `${f} readable by others`);
    });
  });
});

// =====================================================================================================================================
// 5.2 case 13 + (g): the journal folder is out of the model's reach
// =====================================================================================================================================
describe("case 13 and (g): the undo folder cannot be written through the server and cannot sit in the sync folder", CONC, () => {
  it("drive_download and photos_download refuse every path in and around the journal folder; no download reaches the CLI", async () => {
    await withServer(o2(BASE), async (ctx) => {
      await ctx.call("drive_bulk_trash", { paths: ["/my-files/docs/unique.txt"], confirmed: true });
      const u = undoDir(ctx);
      assert.ok(existsSync(u));
      const link = join(ctx.dir, "work", "link");
      symlinkSync(u, link);
      const [id] = journalIds(ctx);
      const paths = [u, join(u, "sub"), join(u, `${id}.json`), join(u, "..", "undo"), `${u}/./x`, `${u}//x`, link, join(link, "sub"), join(ctx.dir, "work", "..", "undo"), join(u, "tmp")];
      for (const p of paths) {
        const strategies = [{}, { fileConflictStrategy: "remove", folderConflictStrategy: "remove", confirmed: true }, { fileConflictStrategy: "rename" }];
        for (const s of strategies) {
          const d = await ctx.call("drive_download", { remotePath: "/my-files/docs/a.pdf", localPath: p, ...s });
          assert.equal(d.isError, true, `drive_download into ${p} ${JSON.stringify(s)}: ${text(d)}`);
        }
        const ph = await ctx.call("photos_download", { photoPaths: ["/photos/p.jpg"], localFolder: p });
        assert.equal(ph.isError, true, `photos_download into ${p}`);
      }
      assert.deepEqual(ctx.changes().filter((a) => /download/.test(a.join(" "))), [], "no download reached the CLI");
      assert.deepEqual(readdirSync(u).filter((n) => !/^[A-Z2-9]{4}-[A-Z2-9]{4}\.json$/.test(n) && n !== "tmp"), [], "nothing foreign appeared in the folder");
      await alive(ctx);
    });
  });

  it("a journal folder inside PROTON_DRIVE_SYNC_PATH: startup warning, no journal is ever written there, the change itself still runs", async () => {
    await withServer({
      ...o2(BASE),
      setup: (sb) => ({ ...driveSetup(BASE)(sb), PROTON_DRIVE_SYNC_PATH: join(sb.dir, "sync"), PROTON_DRIVE_UNDO_DIR: join(sb.dir, "sync", "journal") }),
    }, async (ctx) => {
      const r = await ctx.call("drive_trash", { path: "/my-files/docs/unique.txt" });
      assert.notEqual(r.isError, true, text(r));
      assert.deepEqual(trashedUids(ctx), ["f3"]);
      assert.match(ctx.stderr, /undo/i);
      assert.match(ctx.stderr, /PROTON_DRIVE_SYNC_PATH/);
      assert.equal(existsSync(join(ctx.dir, "sync", "journal")), false);
      assert.equal(json(r).undoId, undefined, "no undo code is promised that cannot be honoured");
      const u = await ctx.call("drive_undo", { action: "list" });
      assert.equal(u.isError, true);
    });
  });

  /** Sync root = $HOME and the journal folder at its default place inside it (the 1.11.0 approvals scenario). */
  const homeSetup = (state, homeRef) => (sb) => {
    homeRef.home = join(sb.dir, "home");
    mkdirSync(homeRef.home, { recursive: true });
    return { ...driveSetup(state)(sb), HOME: homeRef.home, XDG_CACHE_HOME: "", PROTON_DRIVE_SYNC_PATH: homeRef.home, PROTON_DRIVE_UNDO_DIR: "", PROTON_DRIVE_APPROVAL_DIR: join(sb.dir, "approvals") };
  };
  const rel = () => (process.platform === "darwin" ? "Library/Caches/proton-drive-mcp/undo" : ".cache/proton-drive-mcp/undo");
  const forged = () => JSON.stringify({ v: 1, id: "ABCD-EFGH", account: "root", createdAt: Date.now(), tool: "drive_bulk_trash", kind: "trash", status: "applied", items: [{ uid: "f1", parentUid: "d1", from: "/my-files/docs/a.pdf", name: "a.pdf", restorable: true }] });

  it("sync root = $HOME with the default journal folder inside it: a journal planted through drive_write_file is never used (undo is off, nothing restored)", async () => {
    const h = {};
    const nodes = [...BASE.filter((n) => n.uid !== "f3"), file("f3", "d1", "unique.txt", { size: 3000, trashTime: "2026-11-19T10:00:00Z" }), file("f1", "d1", "a.pdf", { size: 5000, sha1: "S1", mtime: OLD, trashTime: "2026-11-19T10:00:00Z" })];
    await withServer({ ...o2(nodes), setup: homeSetup(nodes, h) }, async (ctx) => {
      await ctx.call("drive_write_file", { path: `/my-files/${rel()}/ABCD-EFGH.json`, content: forged() }); // whatever happens to the write itself...
      for (const a of [{ action: "list" }, { action: "plan", id: "ABCD-EFGH" }, { action: "apply", id: "ABCD-EFGH" }, { action: "apply" }]) {
        const r = await ctx.call("drive_undo", a);
        assert.equal(r.isError, true, JSON.stringify(a)); // ...the forged journal is not read
      }
      assert.deepEqual(restoreCalls(ctx), []);
      assert.deepEqual(trashedUids(ctx), ["f1", "f3"], "the forged journal restored nothing");
      assert.equal(ctx.asked, 0);
      assert.match(ctx.stderr, /undo/i, "the startup warning names the undo journal");
    });
  });

  it("the same setup: drive_write_file is refused for the journal folder (plan 3.6: added to the local guard like the approvals folder)", async () => {
    const h = {};
    await withServer({ ...o2(BASE), setup: homeSetup(BASE, h) }, async (ctx) => {
      const w = await ctx.call("drive_write_file", { path: `/my-files/${rel()}/ABCD-EFGH.json`, content: forged() });
      assert.equal(w.isError, true, `a journal must not be writable through drive_write_file: ${text(w)}`);
      assert.equal(existsSync(join(h.home, rel(), "ABCD-EFGH.json")), false);
    });
  });
});

// =====================================================================================================================================
// (h) readonly and (i) PROTON_DRIVE_UNDO=0
// =====================================================================================================================================
describe("(h) readonly mode and (i) PROTON_DRIVE_UNDO=0", CONC, () => {
  it("readonly: drive_checkup works and changes nothing; cleanup and undo are absent from tools/list and refused when called anyway", async () => {
    await withServer({
      ...o2(BASE, {}, { PROTON_DRIVE_MODE: "readonly" }),
      setup: (sb) => { const env = driveSetup(BASE)(sb); seedJournal(sb, { items: [{ uid: "f1", parentUid: "d1", from: "/my-files/docs/a.pdf", name: "a.pdf", restorable: true }] }); return env; },
    }, async (ctx) => {
      const names = (await ctx.client.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes("drive_checkup"));
      assert.ok(!names.includes("drive_cleanup"));
      assert.ok(!names.includes("drive_undo"));
      const ck = await ctx.call("drive_checkup", {});
      assert.notEqual(ck.isError, true, text(ck));
      assert.ok(JSON.parse(text(ck)).findings);
      for (const finding of ["duplicates", "empty-folders", "trash"]) assert.notEqual((await ctx.call("drive_checkup", { finding })).isError, true, finding);
      for (const [n, a] of [["drive_cleanup", CLEAN], ["drive_cleanup", { ...CLEAN, confirmed: true }], ["drive_undo", { action: "list" }], ["drive_undo", { action: "apply" }], ["drive_undo", { action: "apply", id: "ABCD-EFGH" }]]) {
        const r = await ctx.call(n, a);
        assert.equal(r.isError, true, `${n} ${JSON.stringify(a)}`);
        assert.equal(ctx.lastAudit().code, "readonly");
      }
      assert.deepEqual(ctx.changes(), []);
      assert.equal(ctx.asked, 0);
      assert.deepEqual(trashedUids(ctx), []);
    });
  });

  it("PROTON_DRIVE_UNDO=0: cleanup applies and says undo is off, no undo code, no journal folder; drive_undo refuses every action; bulk trash still works", async () => {
    await withServer(o2(BASE, {}, { PROTON_DRIVE_UNDO: "0" }), async (ctx) => {
      const c = await ctx.call("drive_cleanup", { ...CLEAN, confirmed: true });
      assert.notEqual(c.isError, true, text(c));
      const d = json(c);
      assert.equal(d.applied, true);
      assert.equal(d.undoId, undefined);
      assert.match(text(c), /undo/i);
      assert.match(text(c), /off|disabled|switched off/i, `the result must say that undo is off: ${text(c)}`);
      assert.deepEqual(trashedUids(ctx), ["d3", "f2"]);
      assert.equal(existsSync(undoDir(ctx)), false);
      for (const a of [{ action: "list" }, { action: "plan" }, { action: "apply" }, { action: "apply", id: "ABCD-EFGH" }]) {
        const r = await ctx.call("drive_undo", a);
        assert.equal(r.isError, true, JSON.stringify(a));
        assert.match(text(r), /off|disabled|switched off|unavailable/i);
      }
      assert.deepEqual(restoreCalls(ctx), []);
      const b = await ctx.call("drive_bulk_trash", { paths: ["/my-files/docs/unique.txt"], confirmed: true });
      assert.notEqual(b.isError, true, text(b));
      assert.equal(json(b).applied, true);
      assert.deepEqual(trashedUids(ctx), ["d3", "f2", "f3"]);
      assert.equal(existsSync(undoDir(ctx)), false, "still no journal");
    });
  });

  it("PROTON_DRIVE_UNDO=0: the approval dialog does not promise that the change can be undone", async () => {
    await withServer(o2(BASE, {}, { PROTON_DRIVE_UNDO: "0" }), async (ctx) => {
      await ctx.call("drive_cleanup", { ...CLEAN, confirmed: true });
      assert.doesNotMatch(ctx.messages[0], /can be undone/);
    });
  });

  it("an old journal on disk plus PROTON_DRIVE_UNDO=0: drive_undo still refuses and restores nothing", async () => {
    const nodes = [folder("d1", "root", "docs"), file("f1", "d1", "a.txt", { trashTime: "2026-11-19T10:00:00Z" })];
    await withServer({
      ...o2(nodes, {}, { PROTON_DRIVE_UNDO: "0" }),
      setup: (sb) => { const env = driveSetup(nodes, { PROTON_DRIVE_UNDO: "0" })(sb); seedJournal(sb, { items: [{ uid: "f1", parentUid: "d1", from: "/my-files/docs/a.txt", name: "a.txt", restorable: true }] }); return env; },
    }, async (ctx) => {
      assert.equal((await ctx.call("drive_undo", { action: "apply" })).isError, true);
      assert.deepEqual(restoreCalls(ctx), []);
      assert.deepEqual(trashedUids(ctx), ["f1"]);
    });
  });
});

// =====================================================================================================================================
// (j) checkup honesty
// =====================================================================================================================================
describe("(j) drive_checkup is honest about what it returns", CONC, () => {
  const mk = (n, folderUid, i, extra = {}) => file(`${n}${i}`, folderUid, `zq${String(n === "p" ? 100 + i : n === "q" ? 200 + i : n === "b" ? 300 + i : n === "s" ? 400 + i : 500 + i)}.dat`, extra);
  /** Names are counted from the raw text: every distinct "/my-files/..." path in the result is one name the model provider sees. */
  function world() {
    const nodes = [folder("d1", "root", "docs"), folder("d2", "root", "inbox"), folder("sh", "root", "Shared", { shared: true }), folder("em", "root", "empties")];
    for (let i = 0; i < 8; i++) nodes.push(mk("p", "d1", i, { size: 4000, sha1: `D${i}`, mtime: OLD }), mk("q", "d2", i, { size: 4000, sha1: `D${i}`, mtime: NEW }));
    for (let i = 0; i < 6; i++) nodes.push(folder(`e${i}`, "em", `zq${600 + i}`));
    for (let i = 0; i < 5; i++) nodes.push(mk("b", "d1", i, { size: 70 * MB, sha1: `B${i}`, mtime: "2018-01-01T00:00:00Z" }));
    for (let i = 0; i < 5; i++) nodes.push(file(`s${i}`, "sh", `zq${400 + i}-passport-scan.pdf`, { size: 2000, sha1: `SS${i}`, mtime: NEW }));
    for (let i = 0; i < 4; i++) nodes.push(file(`t${i}`, "root", `zq${700 + i}-trashed.txt`, { size: 1000, trashTime: "2026-01-01T00:00:00Z" }));
    return nodes;
  }
  /** Distinct item paths the raw JSON text contains (the scanned root itself is not an item). */
  const markers = (s, root = "/my-files") => new Set((s.match(/\/my-files\/[^"]*/g) ?? []).filter((p) => p !== root));

  it("B2: at most 3 samples per finding and namesInResult equals the number of distinct names in the JSON (counted from the raw text)", async () => {
    await withServer(o2(world()), async (ctx) => {
      const r = await ctx.call("drive_checkup", {});
      assert.notEqual(r.isError, true, text(r));
      const d = json(r);
      for (const f of d.findings) assert.ok(f.samples.length <= 3, `${f.id}: ${f.samples.length} samples`);
      assert.ok(d.findings.some((f) => f.samples.length === 3), "the world is big enough to hit the cap");
      const found = markers(text(r));
      assert.ok(found.size > 0);
      assert.equal(d.namesInResult, found.size, `the result names ${found.size} different files, it says ${d.namesInResult}: ${[...found]}`);
      assert.equal(d.findings.reduce((n, f) => n + f.samples.length, 0), found.size, "every sample is one name");
      assert.deepEqual(writes(ctx), [], "read-only");
    });
  });

  it("finding pages: never more than 200 items whatever limit is asked for; namesInResult counts the names on the page; paging covers everything once", async () => {
    const nodes = [folder("em", "root", "empties")];
    for (let i = 0; i < 230; i++) nodes.push(folder(`e${i}`, "em", `zq${String(i).padStart(3, "0")}`));
    await withServer(o2(nodes), async (ctx) => {
      const seen = new Set();
      for (const limit of [200, 201, 500, 100000, 1000000000]) {
        const r = await ctx.call("drive_checkup", { finding: "empty-folders", limit });
        if (r.isError) continue; // a refusal is within the contract
        const d = json(r);
        assert.ok(d.items.length <= 200, `limit ${limit} returned ${d.items.length} items`);
        assert.equal(d.namesInResult, markers(text(r)).size, `limit ${limit}`);
      }
      for (const bad of [0, -5, 1.5, "10", null]) {
        const r = await ctx.call("drive_checkup", { finding: "empty-folders", limit: bad });
        if (!r.isError) assert.ok(json(r).items.length <= 200, `limit ${bad}`);
      }
      let offset = 0;
      for (let guard = 0; guard < 10; guard++) {
        const r = await ctx.call("drive_checkup", { finding: "empty-folders", limit: 200, offset });
        assert.notEqual(r.isError, true, text(r));
        const d = json(r);
        assert.ok(d.items.length <= 200);
        for (const i of d.items) { assert.ok(!seen.has(i.path), `${i.path} twice`); seen.add(i.path); }
        if (d.nextOffset === undefined) break;
        offset = d.nextOffset;
      }
      assert.ok(seen.size >= 230, `paging reached ${seen.size} of 230 (the 'em' parent counts too)`);
    });
  });

  it("paths outside /my-files or outside PROTON_DRIVE_REMOTE_ROOTS are refused before any CLI call", async () => {
    await withServer(o2(BASE), async (ctx) => {
      const before = nonVersionCalls(ctx.sb.argvLog).length;
      for (const path of ["/shared-with-me", "/trash", "/", "/my-filesX", "/my-files/../trash", "/my-files/../../etc", "relative", "", "my-files", "/my-files/docs/../../trash", "/trash/x", "/photos"]) {
        const r = await ctx.call("drive_checkup", { path });
        assert.equal(r.isError, true, `${JSON.stringify(path)}: ${text(r).slice(0, 150)}`);
      }
      assert.equal(nonVersionCalls(ctx.sb.argvLog).length, before, "refusals cost no CLI call");
    });
    await withServer(o2(BASE, {}, { PROTON_DRIVE_REMOTE_ROOTS: "/my-files/docs" }), async (ctx) => {
      const before = nonVersionCalls(ctx.sb.argvLog).length;
      for (const path of ["/my-files", "/my-files/inbox", "/my-files/docsX", "/my-files/docs/../inbox", "/my-files/doc", "/trash", "/shared-with-me/docs"]) {
        const r = await ctx.call("drive_checkup", { path });
        assert.equal(r.isError, true, path);
      }
      assert.equal(nonVersionCalls(ctx.sb.argvLog).length, before);
      const ok = await ctx.call("drive_checkup", { path: "/my-files/docs" });
      assert.notEqual(ok.isError, true, text(ok));
      const trashRead = nonVersionCalls(ctx.sb.argvLog).filter((a) => a[2] === "/trash");
      assert.deepEqual(trashRead, [], "the account-wide trash is not read for a rooted checkup");
      const shown = JSON.parse(text(ok));
      assert.doesNotMatch(JSON.stringify(shown), /inbox|a \(1\)/, "nothing outside the root leaks into the result");
    });
  });

  it("sharing:false makes no sharing CLI call; sharing:true audits the shared folder; neither changes Drive", async () => {
    const nodes = [...world(), file("lk", "root", "zq800-linked.pdf", { size: 10, sharedByUrl: true })];
    await withServer(o2(nodes), async (ctx) => {
      const off = await ctx.call("drive_checkup", { sharing: false });
      assert.notEqual(off.isError, true, text(off));
      assert.deepEqual(nonVersionCalls(ctx.sb.argvLog).filter((a) => a[0] === "sharing"), [], "no sharing call at all");
      const offPage = await ctx.call("drive_checkup", { sharing: false, finding: "public-links" });
      void offPage;
      assert.deepEqual(nonVersionCalls(ctx.sb.argvLog).filter((a) => a[0] === "sharing"), []);
      assert.ok(json(off).caveats.some((c) => /sharing/i.test(c)), "the result says the sharing details were skipped");
      const on = await ctx.call("drive_checkup", { sharing: true, refresh: true });
      assert.notEqual(on.isError, true, text(on));
      assert.ok(nonVersionCalls(ctx.sb.argvLog).some((a) => a[0] === "sharing" && a[1] === "status"), "with sharing on it looks");
      assert.deepEqual(writes(ctx), []);
    });
  });

  it("the plan's score is within 0..100, scoreParts add up, severities are from the closed set, fix names real tools only", async () => {
    await withServer(o2(world()), async (ctx) => {
      const d = json(await ctx.call("drive_checkup", {}));
      assert.ok(Number.isInteger(d.score) && d.score >= 0 && d.score <= 100, String(d.score));
      const sum = d.scoreParts.reduce((s, p) => s + p.points, 0);
      assert.equal(Math.max(0, Math.min(100, 100 - sum)), d.score, `100 - ${sum} must give the score: ${JSON.stringify(d.scoreParts)}`);
      assert.ok(d.scoreParts.every((p) => Number.isFinite(p.points) && p.points >= 0), "points are deductions");
      for (const f of d.findings) {
        assert.ok(["info", "warn", "risk"].includes(f.severity), f.id);
        assert.ok(["drive_cleanup", "manual", "none"].includes(f.fix), f.id);
        assert.equal(typeof f.next, "string");
      }
      assert.equal(d.findings.find((f) => f.id === "duplicates").count, 8);
      assert.equal(d.findings.find((f) => f.id === "duplicates").fix, "drive_cleanup");
      const again = json(await ctx.call("drive_checkup", {}));
      assert.equal(again.score, d.score, "deterministic");
    });
  });
});

// =====================================================================================================================================
// (l) every journalled existing tool is undoable
// =====================================================================================================================================
describe("(l) every journalled tool creates a batch that undo restores, state compared by uid", CONC, () => {
  const nodes = [
    folder("d1", "root", "docs"), folder("d2", "root", "inbox"), folder("d3", "root", "empty"),
    file("f1", "d1", "a.pdf", { size: 10 }), file("f2", "d1", "b.pdf", { size: 20 }), file("f3", "d2", "c.pdf", { size: 30 }), file("f4", "d1", "d.pdf", { size: 40 }),
  ];
  const same = (ctx, before) => {
    assert.deepEqual(treeShape(ctx), before.shape);
    assert.deepEqual(trashedUids(ctx), before.trash);
    for (const n of Object.values(before.nodes)) {
      assert.equal(readNodes(ctx)[n.uid].name, n.name, n.uid);
      assert.equal(readNodes(ctx)[n.uid].parentUid, n.parentUid, n.uid);
      assert.equal(readNodes(ctx)[n.uid].trashTime, n.trashTime, n.uid);
    }
  };
  const snap = (ctx) => ({ shape: treeShape(ctx), trash: trashedUids(ctx), nodes: readNodes(ctx) });

  for (const [tool, kind, args] of [
    ["drive_trash", "trash", { path: "/my-files/docs/a.pdf" }],
    ["drive_bulk_trash", "trash", { paths: ["/my-files/docs/a.pdf", "/my-files/inbox/c.pdf"], confirmed: true }],
    ["drive_bulk_move", "move", { sources: ["/my-files/docs/a.pdf", "/my-files/inbox/c.pdf"], destinationFolder: "/my-files/empty", confirmed: true }],
    ["drive_move", "move", { sourcePath: "/my-files/docs/a.pdf", destinationPath: "/my-files/empty/renamed-on-the-way.pdf" }],
    ["drive_rename", "rename", { path: "/my-files/docs/a.pdf", newName: "z.pdf" }],
  ]) {
    it(`${tool}: batch recorded (${kind}), undo restores the previous state, a second undo is refused`, async () => {
      await withServer(o2(nodes), async (ctx) => {
        const before = snap(ctx);
        const r = await ctx.call(tool, args);
        assert.notEqual(r.isError, true, text(r));
        const res = json(r);
        const id = res.undoId;
        assert.match(id ?? "", /^[A-Z2-9]{4}-[A-Z2-9]{4}$/, `${tool} must return an undo code: ${text(r)}`);
        assert.deepEqual(journalIds(ctx), [id]);
        const j = readJournal(ctx, id);
        assert.equal(j.tool, tool);
        assert.equal(j.kind, kind);
        assert.equal(j.account, "root");
        assert.ok(j.items.length >= 1 && j.items.every((i) => typeof i.uid === "string" && typeof i.from === "string"));
        assert.notDeepEqual(snap(ctx).shape, before.shape);
        const u = json(await ctx.call("drive_undo", { action: "apply", id }));
        assert.equal(u.status, "undone", JSON.stringify(u));
        same(ctx, before);
        assert.equal((await ctx.call("drive_undo", { action: "apply", id })).isError, true);
      });
    });
  }

  it("a chain of changes undone newest-first returns to the start; undone oldest-first skips what is no longer where it was left and never overwrites", async () => {
    await withServer(o2(nodes), async (ctx) => {
      const before = snap(ctx);
      const a = json(await ctx.call("drive_rename", { path: "/my-files/docs/a.pdf", newName: "z.pdf" }));
      const b = json(await ctx.call("drive_move", { sourcePath: "/my-files/docs/z.pdf", destinationPath: "/my-files/empty/z.pdf" }));
      const c = json(await ctx.call("drive_bulk_trash", { paths: ["/my-files/docs/b.pdf"], confirmed: true }));
      assert.equal(json(await ctx.call("drive_undo", { action: "apply", id: c.undoId })).status, "undone");
      assert.equal(json(await ctx.call("drive_undo", { action: "apply", id: b.undoId })).status, "undone");
      assert.equal(json(await ctx.call("drive_undo", { action: "apply", id: a.undoId })).status, "undone");
      same(ctx, before);
    });
    await withServer(o2(nodes), async (ctx) => {
      const a = json(await ctx.call("drive_rename", { path: "/my-files/docs/a.pdf", newName: "z.pdf" }));
      await ctx.call("drive_move", { sourcePath: "/my-files/docs/z.pdf", destinationPath: "/my-files/empty/z.pdf" });
      const renamesBefore = renameCalls(ctx).length;
      const r = await ctx.call("drive_undo", { action: "apply", id: a.undoId });
      assert.equal(renameCalls(ctx).length, renamesBefore, "the item is no longer where the rename left it: no rename call");
      assert.ok(r.isError === true || json(r).status !== "undone");
      assert.equal(readNodes(ctx).f1.name, "z.pdf");
      assert.equal(readNodes(ctx).f1.parentUid, "d3");
    });
  });

  it("the journalled tools keep their own gate: a declined drive_bulk_move records nothing", async () => {
    await withServer(o2(nodes, { replies: [DECLINE] }), async (ctx) => {
      const r = await ctx.call("drive_bulk_move", { sources: ["/my-files/docs/a.pdf"], destinationFolder: "/my-files/empty", confirmed: true });
      assert.equal(r.isError, true);
      assert.deepEqual(journalIds(ctx), []);
      assert.deepEqual(moveCalls(ctx), []);
    });
  });
});
