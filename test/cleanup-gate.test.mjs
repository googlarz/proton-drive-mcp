// drive_cleanup wired into the server (1.12.0, PLAN-1.12.0 section 3.2): the built server on the stateful fake Drive (FAKE_MODE=drive).
// The server builds the list, the human approves that exact list, and nothing reaches the CLI before that.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ACCEPT, DECLINE, CANCEL, NO_APPROVE, withServer, text } from "./helpers/approval-harness.mjs";
import { driveSetup, file, folder, readNodes, patchState, trashedUids, journalIds, readJournal, seedJournal } from "./helpers/drive-state.mjs";

const OLD = "2020-01-01T00:00:00Z";
const NEW = "2024-01-01T00:00:00Z";
/** docs/a.pdf (older, kept) and inbox/a (1).pdf are a duplicate pair; empty/inner is an empty folder tree; unique.txt has no twin. */
const BASE = [
  folder("d1", "root", "docs"), folder("d2", "root", "inbox"), folder("d3", "root", "empty"), folder("d4", "d3", "inner"),
  file("f1", "d1", "a.pdf", { size: 5000, sha1: "S1", mtime: OLD }),
  file("f2", "d2", "a (1).pdf", { size: 5000, sha1: "S1", mtime: NEW }),
  file("f3", "d1", "unique.txt", { size: 3000, sha1: "U1", mtime: OLD }),
];
const opts = (extra = {}, nodes = BASE, envExtra = {}) => ({ fakeMode: "drive", setup: driveSetup(nodes, envExtra), ...extra });
const ARGS = { path: "/my-files", fixes: ["duplicates", "empty-folders"] };
const json = (r) => JSON.parse(text(r));
const trashCalls = (ctx) => ctx.changes().filter((a) => a[0] === "filesystem" && a[1] === "trash");

describe("drive_cleanup: plan", () => {
  it("lists counts, bytes and samples with the kept copy named; changes nothing and records nothing", async () => {
    await withServer(opts(), async (ctx) => {
      const r = await ctx.call("drive_cleanup", ARGS);
      assert.notEqual(r.isError, true, text(r));
      const d = json(r);
      assert.equal(d.applied, false);
      assert.deepEqual(d.counts, { duplicates: 1, emptyFolders: 1 });
      assert.equal(d.bytes, 5000);
      assert.equal(d.remaining, 0);
      assert.deepEqual(d.skipped, []);
      assert.deepEqual(d.samples.sort(), ["trash /my-files/empty (empty folder)", "trash /my-files/inbox/a (1).pdf (keeps /my-files/docs/a.pdf)"]);
      assert.match(d.next, /confirmed=true/);
      assert.deepEqual(ctx.changes(), [], "a plan never changes Drive");
      assert.equal(ctx.asked, 0);
      assert.deepEqual(journalIds(ctx), []);
    });
  });

  it("the model names no file: extra arguments, bad fixes and paths outside /my-files are rejected before any CLI call", async () => {
    await withServer(opts(), async (ctx) => {
      for (const extra of [{ paths: ["/my-files/docs/a.pdf"] }, { keep: "/my-files/inbox/a (1).pdf" }, { force: true }]) {
        const r = await ctx.call("drive_cleanup", { ...ARGS, ...extra });
        assert.equal(r.isError, true);
        assert.match(text(r), /Unknown argument/);
      }
      for (const args of [{ path: "/my-files", fixes: ["everything"] }, { path: "/my-files", fixes: [] }, { path: "/my-files" }, { path: "/shared-with-me/x", fixes: ["duplicates"] }, { path: "/trash", fixes: ["duplicates"] }]) {
        assert.equal((await ctx.call("drive_cleanup", args)).isError, true, JSON.stringify(args));
      }
      assert.deepEqual(ctx.changes(), []);
    });
  });

  it("an empty plan says so and asks nobody", async () => {
    await withServer(opts({ replies: () => ACCEPT }), async (ctx) => {
      const r = await ctx.call("drive_cleanup", { path: "/my-files/docs", fixes: ["duplicates", "empty-folders"], confirmed: true });
      assert.notEqual(r.isError, true, text(r));
      assert.equal(json(r).applied, false);
      assert.match(json(r).next, /Nothing to clean up/);
      assert.equal(ctx.asked, 0);
      assert.deepEqual(ctx.changes(), []);
    });
  });

  it("B3: a name that is already in the trash is left out and reported", async () => {
    const nodes = [...BASE, file("x9", "root", "a (1).pdf", { trashTime: "2026-01-01T00:00:00Z" })];
    await withServer(opts({}, nodes), async (ctx) => {
      const d = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"] }));
      assert.equal(d.counts.duplicates, 0);
      assert.ok(d.skipped.some((s) => /name already in trash/.test(s.reason) && s.count === 1), JSON.stringify(d.skipped));
      assert.deepEqual(d.samples, []);
    });
  });

  it("B3: shared items, and everything below a shared ancestor, need verify and are left out", async () => {
    const shared = [...BASE.filter((n) => n.uid !== "d2"), folder("d2", "root", "inbox", { shared: true }), file("f2", "d2", "a (1).pdf", { size: 5000, sha1: "S1", mtime: NEW })];
    await withServer(opts({}, shared), async (ctx) => {
      const d = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"] }));
      assert.equal(d.counts.duplicates, 0);
      assert.ok(d.skipped.some((s) => /needs verify/.test(s.reason)), JSON.stringify(d.skipped));
    });
    const below = [
      folder("s1", "root", "team", { shared: true }), folder("s2", "s1", "sub"),
      file("g1", "s2", "x.bin", { size: 4000, sha1: "G", mtime: OLD }), file("g2", "s2", "x copy.bin", { size: 4000, sha1: "G", mtime: NEW }),
    ];
    await withServer(opts({}, below), async (ctx) => {
      const d = json(await ctx.call("drive_cleanup", { path: "/my-files/team/sub", fixes: ["duplicates"] }));
      assert.equal(d.counts.duplicates, 0, "the path itself is not shared, but a folder above it is");
      assert.ok(d.skipped.some((s) => /shared/.test(s.reason)));
    });
  });

  it("verify:true counts only sha256-confirmed groups: when the download fails nothing is proposed", async () => {
    await withServer(opts(), async (ctx) => {
      const d = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"], verify: true }));
      assert.equal(d.verified, true);
      assert.equal(d.counts.duplicates, 0);
      assert.ok(d.skipped.some((s) => /not verified/.test(s.reason)), JSON.stringify(d.skipped));
      assert.deepEqual(ctx.changes().filter((a) => a[1] === "trash"), []);
    });
  });

  it("a walk that could not list a folder is refused, not planned", async () => {
    await withServer(opts({}, BASE, { FAKE_FAIL_LIST_UIDS: "d2", PROTON_DRIVE_RETRY_BASE_MS: "1" }), async (ctx) => {
      const r = await ctx.call("drive_cleanup", ARGS);
      assert.equal(r.isError, true);
      assert.match(text(r), /could not be listed/);
      assert.equal(ctx.lastAudit().code, "cleanup_refused");
      assert.deepEqual(ctx.changes(), []);
    });
  });

  it("caps one call at 50 items (what the dialog lists in full), reports what remains and the next call continues", async () => {
    const many = Array.from({ length: 55 }, (_, i) => folder(`e${i}`, "root", `empty-${String(i).padStart(3, "0")}`));
    await withServer(opts({ replies: () => ACCEPT }, many), async (ctx) => {
      const plan = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["empty-folders"] }));
      assert.equal(plan.counts.emptyFolders, 50);
      assert.equal(plan.remaining, 5);
      assert.ok(plan.samples.length <= 10);
      assert.match(plan.next, /5 more item\(s\)/);
      const done = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["empty-folders"], confirmed: true }));
      assert.equal(done.trashed, 50);
      assert.equal(done.remaining, 5);
      // the human saw every one of the 50 items, not a cut-off list with folder counts
      assert.doesNotMatch(ctx.messages[0], /only the first/);
      for (let i = 0; i < 50; i++) assert.ok(ctx.messages[0].includes(`  - /my-files/empty-${String(i).padStart(3, "0")}\n    (empty folder)`), `item ${i} in the dialog`);
      assert.ok(!ctx.messages[0].includes("/my-files/empty-050"), "the item beyond the cap is not in this call");
      const next = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["empty-folders"] }));
      assert.equal(next.counts.emptyFolders, 5);
      assert.equal(next.remaining, 0);
    });
  });

  it("an entry listed without a uid makes the scan incomplete: cleanup refuses, nothing is trashed", async () => {
    const odd = [...BASE, file("ghost", "d1", "ghost.txt", { noUid: true })];
    await withServer(opts({ replies: () => ACCEPT }, odd), async (ctx) => {
      const r = await ctx.call("drive_cleanup", { ...ARGS, confirmed: true });
      assert.equal(r.isError, true);
      assert.match(text(r), /could not be listed/);
      assert.match(text(r), /without a uid/);
      assert.equal(ctx.lastAudit().code, "cleanup_refused");
      assert.deepEqual(ctx.changes(), []);
      assert.equal(ctx.asked, 0);
    });
  });
});

describe("drive_checkup and drive_cleanup agree on what is fixable", () => {
  it("V1: a 700-byte duplicate pair is not fixable (cleanup ignores files under 1024 bytes), a 2000-byte pair is, and the numbers match", async () => {
    const small = [folder("d1", "root", "docs"), folder("d2", "root", "inbox"),
      file("s1", "d1", "tiny.txt", { size: 700, sha1: "T", mtime: OLD }), file("s2", "d2", "tiny (1).txt", { size: 700, sha1: "T", mtime: NEW })];
    const big = [...small, file("b1", "d1", "big.bin", { size: 2000, sha1: "B", mtime: OLD }), file("b2", "d2", "big (1).bin", { size: 2000, sha1: "B", mtime: NEW })];
    for (const [nodes, expected] of [[small, 0], [big, 1]]) {
      await withServer(opts({}, nodes), async (ctx) => {
        const checkup = json(await ctx.call("drive_checkup", { sharing: false }));
        const dup = checkup.findings.find((f) => f.id === "duplicates");
        assert.equal(dup.fixableCount, expected, "fixableCount");
        const plan = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"] }));
        assert.equal(plan.counts.duplicates, expected, "what cleanup plans");
        assert.equal(dup.fixableCount, plan.counts.duplicates);
      });
    }
  });

  it("the dialog does not say 'can be undone' when the undo record is switched off", async () => {
    await withServer(opts({ replies: () => ACCEPT }, BASE, { PROTON_DRIVE_UNDO: "0" }), async (ctx) => {
      const r = await ctx.call("drive_cleanup", { ...ARGS, confirmed: true });
      assert.notEqual(r.isError, true, text(r));
      assert.doesNotMatch(ctx.messages[0], /can be undone/);
      assert.match(ctx.messages[0], /^drive_cleanup: move redundant copies and empty folders to the trash \(items go to the trash, nothing is deleted; undo is switched off or unavailable\)/);
    });
  });
});

describe("drive_cleanup: apply needs the human", () => {
  it("accept: trashes exactly the listed items in one batched call, keeps the keeper, records the batch", async () => {
    await withServer(opts({ replies: () => ACCEPT }), async (ctx) => {
      const r = await ctx.call("drive_cleanup", { ...ARGS, confirmed: true });
      assert.notEqual(r.isError, true, text(r));
      const d = json(r);
      assert.equal(d.applied, true);
      assert.equal(d.trashed, 2);
      assert.equal(d.bytes, 5000);
      assert.match(d.undoId, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      assert.equal(d.notUndoable, 0);
      assert.equal(d.remaining, 0);
      assert.match(d.note, /trash is emptied/);
      // the dialog the human saw: server text, the exact list, the kept copy on the line
      assert.equal(ctx.asked, 1);
      assert.match(ctx.messages[0], /^drive_cleanup: move redundant copies and empty folders to the trash \(can be undone\)/);
      assert.match(ctx.messages[0], /path: \/my-files\n/);
      assert.match(ctx.messages[0], /  - \/my-files\/inbox\/a \(1\)\.pdf\n {4}keeps: \/my-files\/docs\/a\.pdf(\n|$)/);
      assert.match(ctx.messages[0], /  - \/my-files\/empty\n {4}\(empty folder\)/);
      assert.match(ctx.messages[0], /\(can be undone\)/);
      // what ran is what was shown: one batched trash with those two paths
      const calls = trashCalls(ctx);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].slice(2).filter((a) => a !== "--json").sort(), ["/my-files/empty", "/my-files/inbox/a (1).pdf"]);
      assert.deepEqual(trashedUids(ctx), ["d3", "f2"]);
      assert.equal(readNodes(ctx).f1.trashTime, undefined, "the keeper is untouched");
      assert.equal(ctx.lastAudit().approval.channel, "elicitation");
      // journal
      assert.deepEqual(journalIds(ctx), [d.undoId]);
      const j = readJournal(ctx, d.undoId);
      assert.equal(j.tool, "drive_cleanup");
      assert.equal(j.kind, "trash");
      assert.equal(j.status, "applied");
      assert.deepEqual(j.items.map((i) => [i.uid, i.from, i.restorable]), [["d3", "/my-files/empty", true], ["f2", "/my-files/inbox/a (1).pdf", true]]);
      assert.equal(j.items[1].parentUid, "d2");
    });
  });

  it("B4: decline, cancel and accept-without-approve stop everything: zero changes, no journal entry", async () => {
    for (const [label, reply, code] of [["decline", DECLINE, "approval_declined"], ["cancel", CANCEL, "approval_required"], ["approve=false", NO_APPROVE, "approval_declined"]]) {
      await withServer(opts({ replies: [reply] }), async (ctx) => {
        const r = await ctx.call("drive_cleanup", { ...ARGS, confirmed: true });
        assert.equal(r.isError, true, label);
        assert.equal(ctx.asked, 1, label);
        assert.equal(ctx.lastAudit().code, code, label);
        assert.deepEqual(ctx.changes(), [], label);
        assert.deepEqual(trashedUids(ctx), [], label);
        assert.deepEqual(journalIds(ctx), [], label);
      });
    }
  });

  it("a client that cannot show a dialog gets the terminal route; nothing changes, nothing is recorded", async () => {
    await withServer(opts({ caps: {} }), async (ctx) => {
      for (const confirmed of [true, undefined]) {
        const r = await ctx.call("drive_cleanup", { ...ARGS, ...(confirmed ? { confirmed } : {}) });
        if (!confirmed) { assert.notEqual(r.isError, true); continue; } // the plan needs no approval
        assert.equal(r.isError, true);
        assert.match(text(r), /proton-drive-cli approve [A-Z2-9]{4}-[A-Z2-9]{4}/);
        assert.equal(ctx.lastAudit().code, "approval_required");
      }
      assert.deepEqual(ctx.changes(), []);
      assert.deepEqual(journalIds(ctx), []);
    });
  });

  it("strict mode asks as well", async () => {
    await withServer(opts({ approval: "strict", replies: [DECLINE, ACCEPT] }), async (ctx) => {
      assert.equal((await ctx.call("drive_cleanup", { ...ARGS, confirmed: true })).isError, true);
      assert.deepEqual(ctx.changes(), []);
      assert.notEqual((await ctx.call("drive_cleanup", { ...ARGS, confirmed: true })).isError, true);
      assert.equal(trashCalls(ctx).length, 1);
      assert.equal(ctx.asked, 2);
    });
  });

  it("A2: if Drive changes while the dialog is open (a file lands in an 'empty' folder), nothing is applied", async () => {
    let c;
    await withServer(opts({ replies: () => { patchState(c, (n) => { n.late = file("late", "d3", "late.txt"); }); return ACCEPT; } }), async (ctx) => {
      c = ctx;
      const r = await ctx.call("drive_cleanup", { ...ARGS, confirmed: true });
      assert.equal(r.isError, true);
      assert.equal(ctx.lastAudit().code, "approval_changed");
      assert.match(text(r), /nothing trashed/);
      assert.deepEqual(ctx.changes(), []);
      assert.deepEqual(journalIds(ctx), []);
      assert.deepEqual(trashedUids(ctx), []);
    });
  });

  it("A2: a duplicate modified while the dialog is open (no longer the same size) is not applied either", async () => {
    let c;
    await withServer(opts({ replies: () => { patchState(c, (n) => { n.f2.size = 9999; }); return ACCEPT; } }), async (ctx) => {
      c = ctx;
      const r = await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"], confirmed: true });
      assert.equal(r.isError, true);
      assert.equal(ctx.lastAudit().code, "approval_changed");
      assert.deepEqual(ctx.changes(), []);
    });
  });

  it("B3: whatever the groups look like, exactly one member of every group is left alive", async () => {
    const t = [
      folder("a1", "root", "one"), folder("a2", "root", "two"), folder("a3", "root", "three"),
      // triple with distinct dates
      file("t1", "a1", "same.dat", { size: 2000, sha1: "T", mtime: "2021-05-05T00:00:00Z" }), file("t2", "a2", "same-2.dat", { size: 2000, sha1: "T", mtime: "2022-05-05T00:00:00Z" }), file("t3", "a3", "same-3.dat", { size: 2000, sha1: "T", mtime: "2023-05-05T00:00:00Z" }),
      // pair with equal dates and equal path length (tie)
      file("u1", "a1", "p.dat", { size: 2000, sha1: "U", mtime: OLD }), file("u2", "a2", "q.dat", { size: 2000, sha1: "U", mtime: OLD }),
      // pair without any date
      file("v1", "a1", "m.dat", { size: 2000, sha1: "V" }), file("v2", "a3", "n.dat", { size: 2000, sha1: "V" }),
    ];
    await withServer(opts({ replies: () => ACCEPT }, t), async (ctx) => {
      const plan = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"] }));
      assert.equal(plan.counts.duplicates, 4);
      assert.ok(plan.samples.every((s) => / \(keeps \/my-files\//.test(s)));
      const done = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["duplicates"], confirmed: true }));
      assert.equal(done.trashed, 4);
      const alive = (ids) => ids.filter((id) => readNodes(ctx)[id].trashTime === undefined).length;
      assert.equal(alive(["t1", "t2", "t3"]), 1);
      assert.equal(readNodes(ctx).t1.trashTime, undefined, "the oldest copy is the keeper");
      assert.equal(alive(["u1", "u2"]), 1);
      assert.equal(alive(["v1", "v2"]), 1);
    });
  });

  it("a trash call that fails for one item: the journal keeps only what reached the trash and the result says so", async () => {
    await withServer(opts({ replies: () => ACCEPT }, BASE, { FAKE_FAIL_TRASH_UIDS: "f2" }), async (ctx) => {
      const r = await ctx.call("drive_cleanup", { ...ARGS, confirmed: true });
      assert.equal(r.isError, true);
      assert.match(text(r), /1 of 2 item\(s\) reached the trash \(undo code [A-Z2-9]{4}-[A-Z2-9]{4}\)/);
      assert.deepEqual(trashedUids(ctx), ["d3"]);
      const [id] = journalIds(ctx);
      const j = readJournal(ctx, id);
      assert.equal(j.status, "partial");
      assert.deepEqual(j.items.map((i) => i.uid), ["d3"]);
    });
  });
});

describe("drive_cleanup: overlapping applies", () => {
  const DUP = { path: "/my-files", fixes: ["duplicates"], confirmed: true };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const BUSY = /another bulk apply \(cleanup, undo, bulk trash or bulk move\) is running\. Nothing was changed/;
  /** Starts the first apply and returns once its dialog is up (the call itself stays pending, held open by the slow reply). */
  async function firstHeldOpen(ctx, args = DUP) {
    const first = ctx.call("drive_cleanup", args);
    while (ctx.asked < 1) await sleep(10);
    return { first }; // not the bare promise: an async function would wait for it
  }

  it("a second apply while one is running is refused at once: no dialog, no journal entry, no CLI call; the first one completes and the lock is free afterwards", async () => {
    await withServer(opts({ replies: async () => { await sleep(700); return ACCEPT; } }), async (ctx) => {
      const { first } = await firstHeldOpen(ctx);
      const second = await ctx.call("drive_cleanup", DUP);
      assert.equal(second.isError, true);
      assert.match(text(second), BUSY);
      assert.equal(ctx.lastAudit().code, "approval_unavailable");
      assert.equal(ctx.asked, 1, "no second dialog");
      assert.deepEqual(trashCalls(ctx), [], "the refused call sent nothing, and the first has not trashed yet");
      assert.deepEqual(journalIds(ctx), []);
      const done = json(await first);
      assert.equal(done.applied, true);
      assert.equal(trashCalls(ctx).length, 1);
      assert.deepEqual(trashedUids(ctx), ["f2"]);
      assert.equal(journalIds(ctx).length, 1, "one batch, from the first call only");
      // the lock is free again: a new apply is planned (nothing left to do) and does not hit the busy refusal
      const again = await ctx.call("drive_cleanup", DUP);
      assert.notEqual(again.isError, true, text(again));
      assert.equal(json(again).applied, false);
    });
  });

  it("three parallel cleanup applies: one dialog, one batch, every path sent once (whatever the interleaving)", async () => {
    await withServer(opts({ replies: async () => { await sleep(300); return ACCEPT; } }), async (ctx) => {
      const rs = await Promise.all([1, 2, 3].map(() => ctx.call("drive_cleanup", DUP)));
      const applied = rs.filter((r) => r.isError !== true && json(r).applied === true);
      const busy = rs.filter((r) => r.isError === true && BUSY.test(text(r)));
      const nothing = rs.filter((r) => r.isError !== true && json(r).applied === false); // a late call that planned after the first finished
      assert.equal(applied.length, 1);
      assert.equal(applied.length + busy.length + nothing.length, 3, rs.map((r) => text(r).slice(0, 80)).join(" | "));
      assert.equal(ctx.asked, 1);
      assert.equal(trashCalls(ctx).length, 1);
      assert.deepEqual(trashCalls(ctx)[0].filter((a) => !["filesystem", "trash", "--json"].includes(a)), ["/my-files/inbox/a (1).pdf"]);
      assert.equal(journalIds(ctx).length, 1);
      assert.equal(json(await ctx.call("drive_bulk_trash", { paths: ["/my-files/docs/unique.txt"], confirmed: true })).applied, true, "the lock is free");
    });
  });

  it("cleanup running: a bulk trash and an undo apply are refused too, and the state does not change", async () => {
    const nodes = [...BASE, file("g1", "d1", "gone.txt", { trashTime: "2026-11-19T10:00:00Z" })];
    await withServer({
      ...opts({ replies: async () => { await sleep(700); return ACCEPT; } }, nodes),
      setup: (sb) => { const env = driveSetup(nodes)(sb); seedJournal(sb, { items: [{ uid: "g1", parentUid: "d1", from: "/my-files/docs/gone.txt", name: "gone.txt", restorable: true }] }); return env; },
    }, async (ctx) => {
      const { first } = await firstHeldOpen(ctx);
      const before = JSON.stringify(readNodes(ctx));
      const bulk = await ctx.call("drive_bulk_trash", { paths: ["/my-files/docs/unique.txt"], confirmed: true });
      const undo = await ctx.call("drive_undo", { action: "apply" });
      const move = await ctx.call("drive_bulk_move", { sources: ["/my-files/docs/unique.txt"], destinationFolder: "/my-files/empty", confirmed: true });
      for (const r of [bulk, undo, move]) { assert.equal(r.isError, true); assert.match(text(r), BUSY); }
      assert.equal(ctx.asked, 1);
      assert.equal(JSON.stringify(readNodes(ctx)), before, "nothing changed while the first dialog was open");
      assert.deepEqual(trashCalls(ctx), []);
      assert.equal(json(await first).applied, true);
      // free again: the undo goes through (asks its own dialog)
      assert.equal(json(await ctx.call("drive_undo", { action: "apply" })).status, "undone");
    });
  });

  it("the lock is released after a declined dialog", async () => {
    await withServer(opts({ replies: [DECLINE, ACCEPT] }), async (ctx) => {
      const declined = await ctx.call("drive_cleanup", DUP);
      assert.equal(declined.isError, true);
      assert.equal(ctx.lastAudit().code, "approval_declined");
      const again = await ctx.call("drive_cleanup", DUP);
      assert.notEqual(again.isError, true, text(again));
      assert.equal(json(again).applied, true);
      assert.equal(trashCalls(ctx).length, 1);
    });
  });

  it("the lock is released after an error inside the planner (a path that does not exist)", async () => {
    await withServer(opts({ replies: () => ACCEPT }), async (ctx) => {
      const broken = await ctx.call("drive_cleanup", { path: "/my-files/does-not-exist", fixes: ["duplicates"], confirmed: true });
      assert.equal(broken.isError, true);
      assert.doesNotMatch(text(broken), BUSY);
      const ok = await ctx.call("drive_cleanup", DUP);
      assert.notEqual(ok.isError, true, text(ok));
      assert.equal(json(ok).applied, true);
    });
  });
});

describe("drive_cleanup: modes and guards", () => {
  it("readonly mode hides the tool and refuses a stale call", async () => {
    await withServer(opts({ env: { PROTON_DRIVE_MODE: "readonly" } }), async (ctx) => {
      const names = (await ctx.client.listTools()).tools.map((t) => t.name);
      for (const n of ["drive_cleanup", "drive_undo"]) assert.ok(!names.includes(n), n);
      assert.ok(names.includes("drive_checkup"));
      const r = await ctx.call("drive_cleanup", ARGS);
      assert.equal(r.isError, true);
      assert.equal(ctx.lastAudit().code, "readonly");
      assert.deepEqual(ctx.changes(), []);
    });
  });

  it("PROTON_DRIVE_REMOTE_ROOTS: a path outside the roots is refused, one inside works", async () => {
    await withServer(opts({ env: { PROTON_DRIVE_REMOTE_ROOTS: "/my-files/docs" } }), async (ctx) => {
      const out = await ctx.call("drive_cleanup", { path: "/my-files/inbox", fixes: ["duplicates"] });
      assert.equal(out.isError, true);
      assert.equal(ctx.lastAudit().code, "roots");
      const inside = await ctx.call("drive_cleanup", { path: "/my-files/docs", fixes: ["duplicates"] });
      assert.notEqual(inside.isError, true, text(inside));
    });
  });

  it("model mode follows the bulk tools: confirmed=true applies, an elicitation-capable client can still say no", async () => {
    await withServer(opts({ approval: "model", caps: {} }), async (ctx) => {
      assert.notEqual((await ctx.call("drive_cleanup", ARGS)).isError, true);
      assert.deepEqual(ctx.changes(), []);
      const r = await ctx.call("drive_cleanup", { ...ARGS, confirmed: true });
      assert.notEqual(r.isError, true, text(r));
      assert.equal(json(r).applied, true);
      assert.equal(trashCalls(ctx).length, 1);
    });
    await withServer(opts({ approval: "model", replies: [DECLINE] }), async (ctx) => {
      const r = await ctx.call("drive_cleanup", { ...ARGS, confirmed: true });
      assert.equal(r.isError, true);
      assert.match(text(r), /user declined drive_cleanup.*Do not retry/);
      assert.deepEqual(ctx.changes(), []);
    });
  });

  it("the tool text for human/strict does not tell the model to pass confirmed=true to authorise", async () => {
    await withServer(opts(), async (ctx) => {
      const t = (await ctx.client.listTools()).tools.find((x) => x.name === "drive_cleanup");
      assert.match(t.description, /server first asks the user to approve the exact list/);
      assert.deepEqual(t.inputSchema.required, ["path", "fixes"]);
      assert.equal(t.inputSchema.additionalProperties, false);
      assert.deepEqual(t.inputSchema.properties.fixes.items.enum, ["duplicates", "empty-folders"]);
    });
  });
});
