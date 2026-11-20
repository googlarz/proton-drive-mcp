// drive_undo and the undo journal wired into the server (1.12.0, PLAN-1.12.0 sections 3.4, 3.5, 3.6): the built server on the stateful fake Drive.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPT, DECLINE, withServer, writeTree, text } from "./helpers/approval-harness.mjs";
import { readArgvLog } from "./helpers/mcp-client.mjs";
import { driveSetup, file, folder, readNodes, patchState, trashedUids, treeShape, journalIds, readJournal, undoDir, seedJournal } from "./helpers/drive-state.mjs";

const OLD = "2020-01-01T00:00:00Z";
const NEW = "2024-01-01T00:00:00Z";
const BASE = [
  folder("d1", "root", "docs"), folder("d2", "root", "inbox"), folder("d3", "root", "empty"), folder("d4", "d3", "inner"),
  file("f1", "d1", "a.pdf", { size: 5000, sha1: "S1", mtime: OLD }),
  file("f2", "d2", "a (1).pdf", { size: 5000, sha1: "S1", mtime: NEW }),
  file("f3", "d1", "unique.txt", { size: 3000, sha1: "U1", mtime: OLD }),
];
const opts = (extra = {}, nodes = BASE, envExtra = {}) => ({ fakeMode: "drive", setup: driveSetup(nodes, envExtra), replies: () => ACCEPT, ...extra });
const json = (r) => JSON.parse(text(r));
const CLEANUP = { path: "/my-files", fixes: ["duplicates", "empty-folders"], confirmed: true };
const trashListings = (ctx) => readArgvLog(ctx.sb.argvLog).filter((a) => a[0] === "filesystem" && a[1] === "list" && a[2] === "/trash").length;
const mutations = (ctx, sub) => ctx.changes().filter((a) => a[0] === "filesystem" && a[1] === sub);

describe("drive_undo: after drive_cleanup", () => {
  it("B5: approve a cleanup, undo it, and the fake Drive is the tree it was, checked by uid and path", async () => {
    await withServer(opts(), async (ctx) => {
      const before = treeShape(ctx);
      const cleaned = json(await ctx.call("drive_cleanup", CLEANUP));
      assert.deepEqual(trashedUids(ctx), ["d3", "f2"]);
      assert.notDeepEqual(treeShape(ctx), before);

      const plan = json(await ctx.call("drive_undo", { id: cleaned.undoId }));
      assert.equal(plan.action, "plan");
      assert.equal(plan.id, cleaned.undoId);
      assert.equal(plan.tool, "drive_cleanup");
      assert.equal(plan.restorable, 2);
      assert.deepEqual(plan.items.map((i) => [i.path, i.restorable]), [["/my-files/empty", true], ["/my-files/inbox/a (1).pdf", true]]);
      assert.equal(ctx.asked, 1, "a plan asks nobody");
      assert.equal(mutations(ctx, "restore").length, 0);

      const done = await ctx.call("drive_undo", { action: "apply" }); // default id: the newest batch not yet undone
      assert.notEqual(done.isError, true, text(done));
      const d = json(done);
      assert.equal(d.applied, true);
      assert.equal(d.undone, 2);
      assert.equal(d.status, "undone");
      assert.deepEqual(d.failed, []);
      assert.equal(ctx.asked, 2, "undo asks the human, even though restoring is harmless");
      assert.match(ctx.messages[1], /^drive_undo: undo an earlier change \(restore from the trash, move or rename back\) \(can be undone\)/);
      assert.match(ctx.messages[1], new RegExp(`id: ${cleaned.undoId}`));
      assert.match(ctx.messages[1], /restore \(2\):/);
      assert.match(ctx.messages[1], /\/my-files\/inbox\/a \(1\)\.pdf/);
      assert.deepEqual(treeShape(ctx), before);
      assert.deepEqual(trashedUids(ctx), []);
      assert.equal(readJournal(ctx, cleaned.undoId).status, "undone");
      assert.equal(mutations(ctx, "restore").length, 1, "one batched restore call");
    });
  });

  it("a second undo of the same batch is refused, and 'the newest' finds nothing left", async () => {
    await withServer(opts(), async (ctx) => {
      const { undoId } = json(await ctx.call("drive_cleanup", CLEANUP));
      assert.notEqual((await ctx.call("drive_undo", { action: "apply", id: undoId })).isError, true);
      const asked = ctx.asked;
      const again = await ctx.call("drive_undo", { action: "apply", id: undoId });
      assert.equal(again.isError, true);
      assert.equal(ctx.lastAudit().code, "already_undone");
      const none = await ctx.call("drive_undo", { action: "plan" });
      assert.equal(none.isError, true);
      assert.equal(ctx.lastAudit().code, "no_batch");
      assert.equal(ctx.asked, asked, "refused before any dialog");
      assert.equal(mutations(ctx, "restore").length, 1);
    });
  });

  it("A2/B4: undo needs the human: a decline restores nothing and keeps the batch undoable; no dialog capability means the terminal route", async () => {
    await withServer(opts({ replies: [ACCEPT, DECLINE] }), async (ctx) => {
      const { undoId } = json(await ctx.call("drive_cleanup", CLEANUP));
      const r = await ctx.call("drive_undo", { action: "apply", id: undoId });
      assert.equal(r.isError, true);
      assert.equal(ctx.lastAudit().code, "approval_declined");
      assert.equal(mutations(ctx, "restore").length, 0);
      assert.deepEqual(trashedUids(ctx), ["d3", "f2"]);
      assert.equal(readJournal(ctx, undoId).status, "applied");
    });
    await withServer(opts({ caps: {} }, [folder("d1", "root", "docs"), file("f1", "d1", "a.txt", { trashTime: "2026-11-19T10:00:00Z" })]), async (ctx) => {
      seedJournal(ctx, { items: [{ uid: "f1", from: "/my-files/docs/a.txt", name: "a.txt", restorable: true }] });
      const r = await ctx.call("drive_undo", { action: "apply" });
      assert.equal(r.isError, true);
      assert.match(text(r), /proton-drive-cli approve [A-Z2-9]{4}-[A-Z2-9]{4}/);
      assert.equal(ctx.lastAudit().code, "approval_required");
      assert.equal(mutations(ctx, "restore").length, 0);
    });
  });

  it("a Drive that changed after the plan is not restored blindly: an item whose name was taken is skipped with the reason", async () => {
    await withServer(opts(), async (ctx) => {
      const { undoId } = json(await ctx.call("drive_cleanup", CLEANUP));
      // someone creates a file with the trashed duplicate's name in its old folder
      patchState(ctx, (n) => { n.squatter = file("squatter", "d2", "a (1).pdf"); });
      const plan = json(await ctx.call("drive_undo", { id: undoId }));
      assert.equal(plan.restorable, 1);
      assert.match(plan.items.find((i) => i.path === "/my-files/inbox/a (1).pdf").reason, /already exists/);
      const d = json(await ctx.call("drive_undo", { action: "apply", id: undoId }));
      assert.equal(d.undone, 1);
      assert.equal(d.status, "partial");
      assert.ok(trashedUids(ctx).includes("f2"), "the squatted item stays in trash");
      assert.equal(readNodes(ctx).squatter.parentUid, "d2", "nothing was overwritten");
    });
  });

  it("list shows batches without a single file name", async () => {
    await withServer(opts(), async (ctx) => {
      const { undoId } = json(await ctx.call("drive_cleanup", CLEANUP));
      const r = await ctx.call("drive_undo", { action: "list" });
      const d = json(r);
      assert.equal(d.batches.length, 1);
      assert.deepEqual(Object.keys(d.batches[0]).sort(), ["id", "items", "kind", "status", "tool", "when"]);
      assert.equal(d.batches[0].id, undoId);
      assert.equal(d.batches[0].items, 2);
      assert.doesNotMatch(text(r), /a \(1\)|pdf|empty|inbox/);
    });
  });
});

describe("the other tools write the journal too", () => {
  it("drive_bulk_trash: journalled, undoable, and the result carries the code", async () => {
    await withServer(opts(), async (ctx) => {
      const r = json(await ctx.call("drive_bulk_trash", { paths: ["/my-files/docs/a.pdf", "/my-files/docs/unique.txt"], confirmed: true }));
      assert.equal(r.applied, true);
      assert.equal(r.trashed, 2);
      assert.match(r.undoId, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      assert.equal(r.notUndoable, undefined);
      const j = readJournal(ctx, r.undoId);
      assert.equal(j.tool, "drive_bulk_trash");
      assert.equal(j.status, "applied");
      assert.deepEqual(j.items.map((i) => i.uid), ["f1", "f3"], "recorded in path order");
      const u = json(await ctx.call("drive_undo", { action: "apply", id: r.undoId }));
      assert.equal(u.undone, 2);
      assert.deepEqual(trashedUids(ctx), []);
    });
  });

  it("drive_trash: journalled and undoable", async () => {
    await withServer(opts(), async (ctx) => {
      const r = json(await ctx.call("drive_trash", { path: "/my-files/docs/unique.txt" }));
      assert.match(r.message, /Moved to trash/);
      assert.match(r.undoId, /^[A-Z2-9]{4}-/);
      assert.equal(readJournal(ctx, r.undoId).kind, "trash");
      assert.equal(json(await ctx.call("drive_undo", { action: "apply" })).undone, 1);
      assert.deepEqual(trashedUids(ctx), []);
    });
  });

  it("bulk trash: an item whose name is already in the trash is recorded as not restorable, and the result says how many", async () => {
    const nodes = [...BASE, file("x1", "root", "unique.txt", { trashTime: "2026-01-01T00:00:00Z" })];
    await withServer(opts({}, nodes), async (ctx) => {
      const r = json(await ctx.call("drive_bulk_trash", { paths: ["/my-files/docs/unique.txt"], confirmed: true }));
      assert.equal(r.notUndoable, 1);
      assert.match(r.undo, /cannot be undone reliably/);
      const j = readJournal(ctx, r.undoId);
      assert.equal(j.items[0].restorable, false);
      assert.match(j.items[0].reason, /same-named item is already in the trash/);
      assert.equal(json(await ctx.call("drive_undo", {})).restorable, 0);
      const apply = await ctx.call("drive_undo", { action: "apply" });
      assert.equal(apply.isError, true);
      assert.equal(ctx.lastAudit().code, "nothing_restorable");
      assert.equal(mutations(ctx, "restore").length, 0, "nothing arbitrary is restored");
    });
  });

  it("drive_trash does not list /trash: the item is recorded restorable and the undo plan checks the live trash instead", async () => {
    const nodes = [...BASE, file("x1", "root", "unique.txt", { trashTime: "2026-01-01T00:00:00Z" })];
    await withServer(opts({}, nodes), async (ctx) => {
      const r = json(await ctx.call("drive_trash", { path: "/my-files/docs/unique.txt" }));
      assert.equal(r.notUndoable, undefined);
      assert.equal(readJournal(ctx, r.undoId).items[0].restorable, true);
      assert.equal(trashListings(ctx), 0, "no /trash listing for a single item");
      const plan = json(await ctx.call("drive_undo", {}));
      assert.equal(plan.restorable, 0, "the live trash holds another item of that name");
      assert.match(plan.items[0].reason, /same name is in trash/);
      assert.equal((await ctx.call("drive_undo", { action: "apply" })).isError, true);
      assert.equal(mutations(ctx, "restore").length, 0);
    });
  });

  it("two same-named items trashed in one batch are both marked not restorable", async () => {
    const nodes = [folder("d1", "root", "docs"), folder("d2", "root", "inbox"), file("f1", "d1", "x.txt"), file("g1", "d2", "x.txt")];
    await withServer(opts({}, nodes), async (ctx) => {
      const r = json(await ctx.call("drive_bulk_trash", { paths: ["/my-files/docs/x.txt", "/my-files/inbox/x.txt"], confirmed: true }));
      assert.equal(r.applied, true);
      assert.equal(r.notUndoable, 2);
      assert.deepEqual(readJournal(ctx, r.undoId).items.map((i) => i.restorable), [false, false]);
    });
  });

  it("drive_bulk_move: journalled and moved back by uid", async () => {
    await withServer(opts(), async (ctx) => {
      const before = treeShape(ctx);
      const r = json(await ctx.call("drive_bulk_move", { sources: ["/my-files/docs/a.pdf", "/my-files/docs/unique.txt"], destinationFolder: "/my-files/empty", confirmed: true }));
      assert.equal(r.applied, true);
      const j = readJournal(ctx, r.undoId);
      assert.equal(j.kind, "move");
      assert.deepEqual(j.items.map((i) => [i.from, i.to]), [["/my-files/docs/a.pdf", "/my-files/empty/a.pdf"], ["/my-files/docs/unique.txt", "/my-files/empty/unique.txt"]]);
      assert.notDeepEqual(treeShape(ctx), before);
      const plan = json(await ctx.call("drive_undo", { id: r.undoId }));
      assert.equal(plan.restorable, 2);
      const u = json(await ctx.call("drive_undo", { action: "apply", id: r.undoId }));
      assert.equal(u.status, "undone");
      assert.match(ctx.messages.at(-1), /moveBack \(2\):/);
      assert.match(ctx.messages.at(-1), /\/my-files\/empty\/a\.pdf -> \/my-files\/docs\/a\.pdf/);
      assert.deepEqual(treeShape(ctx), before);
    });
  });

  it("drive_move (to another folder and name) and drive_rename: journalled and undone", async () => {
    await withServer(opts(), async (ctx) => {
      const before = treeShape(ctx);
      const moved = json(await ctx.call("drive_move", { sourcePath: "/my-files/docs/a.pdf", destinationPath: "/my-files/inbox/b.pdf" }));
      assert.match(moved.undoId, /^[A-Z2-9]{4}-/);
      const renamed = json(await ctx.call("drive_rename", { path: "/my-files/docs/unique.txt", newName: "renamed.txt" }));
      assert.match(renamed.undoId, /^[A-Z2-9]{4}-/);
      assert.equal(readJournal(ctx, moved.undoId).kind, "move");
      assert.equal(readJournal(ctx, renamed.undoId).kind, "rename");
      assert.equal(readNodes(ctx).f3.name, "renamed.txt");
      assert.equal(json(await ctx.call("drive_undo", { action: "apply", id: renamed.undoId })).status, "undone");
      assert.equal(json(await ctx.call("drive_undo", { action: "apply", id: moved.undoId })).status, "undone");
      assert.deepEqual(treeShape(ctx), before);
    });
  });
});

describe("review fixes: original folder identity, /trash listings, dialog effect", () => {
  it("the folder at the original path must be the folder the item came from: A renamed to B and a new A created, undo moves nothing", async () => {
    const nodes = [folder("dA", "root", "A"), file("fx", "dA", "x.txt")];
    await withServer(opts({}, nodes), async (ctx) => {
      const trashed = json(await ctx.call("drive_trash", { path: "/my-files/A/x.txt" }));
      assert.equal(readJournal(ctx, trashed.undoId).items[0].parentUid, "dA");
      json(await ctx.call("drive_rename", { path: "/my-files/A", newName: "B" }));
      patchState(ctx, (n) => { n.dNew = folder("dNew", "root", "A"); });
      const before = JSON.stringify(readNodes(ctx));
      const plan = json(await ctx.call("drive_undo", { id: trashed.undoId }));
      assert.equal(plan.restorable, 0);
      assert.equal(plan.items[0].reason, "original folder is not the same folder anymore");
      const apply = await ctx.call("drive_undo", { action: "apply", id: trashed.undoId });
      assert.equal(apply.isError, true);
      assert.equal(ctx.lastAudit().code, "nothing_restorable");
      assert.equal(mutations(ctx, "restore").length, 0);
      assert.equal(JSON.stringify(readNodes(ctx)), before, "nothing moved");
    });
  });

  it("the same holds for a moved item: the original folder was replaced by another one", async () => {
    const nodes = [folder("dA", "root", "A"), folder("dZ", "root", "Z"), file("fx", "dA", "x.txt")];
    await withServer(opts({}, nodes), async (ctx) => {
      const moved = json(await ctx.call("drive_move", { sourcePath: "/my-files/A/x.txt", destinationPath: "/my-files/Z/x.txt" }));
      patchState(ctx, (n) => { n.dA.name = "A-old"; n.dNew = folder("dNew", "root", "A"); });
      const plan = json(await ctx.call("drive_undo", { id: moved.undoId }));
      assert.equal(plan.restorable, 0);
      assert.equal(plan.items[0].reason, "original folder is not the same folder anymore");
      assert.equal(readNodes(ctx).fx.parentUid, "dZ");
    });
  });

  it("every hook records the item's parent uid: trash, bulk trash, move, bulk move, rename and cleanup", async () => {
    await withServer(opts(), async (ctx) => {
      const ids = [];
      ids.push(json(await ctx.call("drive_trash", { path: "/my-files/docs/unique.txt" })).undoId);
      ids.push(json(await ctx.call("drive_bulk_trash", { paths: ["/my-files/docs/a.pdf"], confirmed: true })).undoId);
      ids.push(json(await ctx.call("drive_rename", { path: "/my-files/inbox/a (1).pdf", newName: "b.pdf" })).undoId);
      ids.push(json(await ctx.call("drive_move", { sourcePath: "/my-files/inbox/b.pdf", destinationPath: "/my-files/docs/b.pdf" })).undoId);
      ids.push(json(await ctx.call("drive_bulk_move", { sources: ["/my-files/docs/b.pdf"], destinationFolder: "/my-files/empty", confirmed: true })).undoId);
      ids.push(json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["empty-folders"], confirmed: true })).undoId);
      assert.equal(new Set(ids).size, 6);
      const parents = { "drive_trash": "d1", "drive_bulk_trash": "d1", "drive_rename": "d2", "drive_move": "d2", "drive_bulk_move": "d1" };
      ids.forEach((id) => {
        const j = readJournal(ctx, id);
        for (const it of j.items) assert.equal(typeof it.parentUid, "string", `${j.tool}: ${it.from}`);
        if (parents[j.tool]) assert.equal(j.items[0].parentUid, parents[j.tool], j.tool);
      });
    });
  });

  it("one /trash listing for drive_bulk_trash, none for drive_trash, drive_move and drive_rename", async () => {
    await withServer(opts(), async (ctx) => {
      await ctx.call("drive_trash", { path: "/my-files/docs/unique.txt" });
      await ctx.call("drive_rename", { path: "/my-files/inbox/a (1).pdf", newName: "b.pdf" });
      await ctx.call("drive_move", { sourcePath: "/my-files/inbox/b.pdf", destinationPath: "/my-files/docs/b.pdf" });
      assert.equal(trashListings(ctx), 0);
      await ctx.call("drive_bulk_trash", { paths: ["/my-files/docs/b.pdf"], confirmed: true });
      assert.equal(trashListings(ctx), 1);
    });
  });

  it("an item already in the memory cache of a walk is not looked up with a folder listing", async () => {
    await withServer(opts(), async (ctx) => {
      await ctx.call("drive_checkup", { sharing: false });
      const lists = () => readArgvLog(ctx.sb.argvLog).filter((a) => a[1] === "list" && a[2] === "/my-files/docs").length;
      const before = lists();
      const r = json(await ctx.call("drive_trash", { path: "/my-files/docs/unique.txt" }));
      assert.equal(lists(), before, "no extra listing of the parent");
      assert.equal(readJournal(ctx, r.undoId).items[0].parentUid, "d1");
      assert.equal(readJournal(ctx, r.undoId).items[0].uid, "f3");
    });
  });

  it("moving back into /shared-with-me is shown to the human as outward, plain restores as reversible", async () => {
    const swm = [folder("swm", null, "shared-with-me"), folder("t", "swm", "t"), file("g1", "t", "a.txt", { trashTime: "2026-11-19T10:00:00Z" }), folder("d1", "root", "docs"), file("f1", "d1", "b.txt", { trashTime: "2026-11-19T10:00:00Z" })];
    await withServer({
      ...opts({}, swm),
      setup: (sb) => {
        const env = driveSetup(swm)(sb);
        seedJournal(sb, { items: [{ uid: "g1", parentUid: "t", from: "/shared-with-me/t/a.txt", name: "a.txt", restorable: true }] });
        seedJournal(sb, { items: [{ uid: "f1", parentUid: "d1", from: "/my-files/docs/b.txt", name: "b.txt", restorable: true }] });
        return env;
      },
    }, async (ctx) => {
      const list = json(await ctx.call("drive_undo", { action: "list" })).batches;
      assert.equal(list.length, 2);
      for (const b of list) {
        const plan = json(await ctx.call("drive_undo", { id: b.id }));
        assert.equal(plan.restorable, 1, JSON.stringify(plan));
        await ctx.call("drive_undo", { action: "apply", id: b.id });
      }
      const outward = ctx.messages.filter((m) => /affects other people/.test(m));
      const plain = ctx.messages.filter((m) => /\(can be undone\)/.test(m));
      assert.equal(outward.length, 1);
      assert.match(outward[0], /\/shared-with-me\/t\/a\.txt/);
      assert.equal(plain.length, 1);
      assert.match(plain[0], /\/my-files\/docs\/b\.txt/);
    });
  });
});

describe("the journal never breaks the operation", () => {
  it("PROTON_DRIVE_UNDO=0: nothing is recorded, nothing is created, the tools still work and drive_undo says why it cannot", async () => {
    await withServer(opts({}, BASE, { PROTON_DRIVE_UNDO: "0" }), async (ctx) => {
      const trash = json(await ctx.call("drive_trash", { path: "/my-files/docs/unique.txt" }));
      assert.equal(trash.undoId, undefined);
      assert.equal(trash.undo, undefined, "the older tools stay silent when the owner switched journalling off");
      const bulk = json(await ctx.call("drive_bulk_trash", { paths: ["/my-files/docs/a.pdf"], confirmed: true }));
      assert.equal(bulk.applied, true);
      assert.equal(bulk.undoId, undefined);
      const cleanup = json(await ctx.call("drive_cleanup", { path: "/my-files/inbox", fixes: ["duplicates"], confirmed: true }));
      assert.equal(cleanup.applied, false, "the twin is gone, nothing left to do");
      const fresh = json(await ctx.call("drive_cleanup", { path: "/my-files", fixes: ["empty-folders"], confirmed: true }));
      assert.equal(fresh.applied, true);
      assert.equal(fresh.undoId, undefined);
      assert.match(fresh.undo, /switched off/);
      assert.equal(existsSync(undoDir(ctx)), false, "no folder was created");
      const u = await ctx.call("drive_undo", { action: "list" });
      assert.equal(u.isError, true);
      assert.match(text(u), /switched off/);
      assert.equal(ctx.lastAudit().code, "undo_unavailable");
    });
  });

  it("a journal that cannot be written does not turn a successful change into an error", async () => {
    // The journal folder sits below a regular file, so it can never be created.
    await withServer({
      ...opts(),
      setup: (sb) => { writeFileSync(join(sb.dir, "blocker"), "x"); return { ...driveSetup(BASE)(sb), PROTON_DRIVE_UNDO_DIR: join(sb.dir, "blocker", "undo") }; },
    }, async (ctx) => {
      const trash = await ctx.call("drive_trash", { path: "/my-files/docs/unique.txt" });
      assert.notEqual(trash.isError, true, text(trash));
      assert.match(json(trash).undo, /undo not recorded/);
      assert.equal(json(trash).undoId, undefined);
      assert.deepEqual(trashedUids(ctx), ["f3"]);
      const cleanup = await ctx.call("drive_cleanup", CLEANUP);
      assert.notEqual(cleanup.isError, true, text(cleanup));
      assert.equal(json(cleanup).applied, true);
      assert.match(json(cleanup).undo, /undo not recorded/);
      assert.deepEqual(trashedUids(ctx), ["d3", "f2", "f3"]);
      assert.match(ctx.stderr, /undo journal/);
    });
  });

  it("an account that cannot be identified: the change runs and the result says 'undo unavailable'", async () => {
    // First-level items with different parent uids give no account key (a fixed listing: tree mode).
    const item = (uid, parentUid, name, type) => ({ uid, parentUid, name: { ok: true, value: name }, type });
    const tree = { "/my-files": [item("d1", "root-a", "docs", "folder"), item("d9", "root-b", "stray", "folder")], "/my-files/docs": [item("f1", "d1", "a.txt", "file")] };
    await withServer({ fakeMode: "tree", setup: (sb) => ({ FAKE_TREE: writeTree(sb.dir, tree) }) }, async (ctx) => {
      const r = await ctx.call("drive_trash", { path: "/my-files/docs/a.txt" });
      assert.notEqual(r.isError, true, text(r));
      assert.match(json(r).undo, /undo unavailable/);
      assert.equal(ctx.changes().length, 1, "the change itself ran");
      assert.deepEqual(journalIds(ctx), []);
      const u = await ctx.call("drive_undo", { action: "list" });
      assert.equal(u.isError, true);
      assert.match(text(u), /account could not be identified/);
    });
  });
});

describe("the undo folder and the sync folder", () => {
  it("a journal folder inside PROTON_DRIVE_SYNC_PATH is warned about at startup and never used; the change still runs", async () => {
    await withServer({
      ...opts(),
      setup: (sb) => ({ ...driveSetup(BASE)(sb), PROTON_DRIVE_SYNC_PATH: join(sb.dir, "sync"), PROTON_DRIVE_UNDO_DIR: join(sb.dir, "sync", "undo") }),
    }, async (ctx) => {
      const r = await ctx.call("drive_trash", { path: "/my-files/docs/unique.txt" });
      assert.notEqual(r.isError, true, text(r));
      assert.match(json(r).undo, /undo unavailable: .*outside PROTON_DRIVE_SYNC_PATH/);
      assert.match(ctx.stderr, /undo journal unusable/);
      assert.equal(existsSync(join(ctx.dir, "sync", "undo")), false);
      assert.deepEqual(trashedUids(ctx), ["f3"]);
    });
  });
});

describe("drive_undo: roots, modes, records", () => {
  it("PROTON_DRIVE_REMOTE_ROOTS is checked item by item and a path outside is never shown", async () => {
    const nodes = [
      folder("d1", "root", "docs"), folder("d2", "root", "inbox"),
      file("f1", "d1", "a.pdf", { trashTime: "2026-11-19T10:00:00Z" }), file("f2", "d2", "secret-plan.pdf", { trashTime: "2026-11-19T10:00:00Z" }),
    ];
    await withServer({
      ...opts({ env: { PROTON_DRIVE_REMOTE_ROOTS: "/my-files/docs" } }, nodes),
      setup: (sb) => {
        const env = driveSetup(nodes)(sb);
        seedJournal(sb, { items: [
          { uid: "f1", from: "/my-files/docs/a.pdf", name: "a.pdf", restorable: true },
          { uid: "f2", from: "/my-files/inbox/secret-plan.pdf", name: "secret-plan.pdf", restorable: true },
        ] });
        return env;
      },
    }, async (ctx) => {
      const plan = await ctx.call("drive_undo", {});
      assert.notEqual(plan.isError, true, text(plan));
      assert.doesNotMatch(text(plan), /secret-plan|inbox/);
      const p = json(plan);
      assert.equal(p.restorable, 1);
      assert.ok(p.items.some((i) => i.path === "(outside PROTON_DRIVE_REMOTE_ROOTS)" && !i.restorable));
      const done = await ctx.call("drive_undo", { action: "apply" });
      assert.doesNotMatch(text(done), /secret-plan|inbox/);
      assert.doesNotMatch(ctx.messages.join("\n"), /secret-plan|inbox/, "the dialog shows only what will be restored");
      assert.match(ctx.messages[0], /restore \(1\):\n {2}- \/my-files\/docs\/a\.pdf/);
      assert.deepEqual(trashedUids(ctx), ["f2"], "the item outside the roots stays in the trash");
      assert.equal(json(done).status, "partial");
    });
  });

  it("readonly mode hides it and refuses a stale call", async () => {
    await withServer(opts({ env: { PROTON_DRIVE_MODE: "readonly" } }), async (ctx) => {
      const r = await ctx.call("drive_undo", { action: "list" });
      assert.equal(r.isError, true);
      assert.equal(ctx.lastAudit().code, "readonly");
    });
  });

  it("model mode follows the bulk tools: apply goes ahead without a dialog when the client cannot show one", async () => {
    await withServer(opts({ approval: "model", caps: {} }), async (ctx) => {
      const { undoId } = json(await ctx.call("drive_cleanup", CLEANUP));
      const u = await ctx.call("drive_undo", { action: "apply", id: undoId });
      assert.notEqual(u.isError, true, text(u));
      assert.equal(json(u).status, "undone");
    });
  });

  it("rejects a malformed code and unknown arguments", async () => {
    await withServer(opts(), async (ctx) => {
      const bad = await ctx.call("drive_undo", { id: "../../etc/passwd" });
      assert.equal(bad.isError, true);
      assert.equal(ctx.lastAudit().code, "invalid_id");
      const extra = await ctx.call("drive_undo", { action: "apply", confirmed: true });
      assert.equal(extra.isError, true);
      assert.match(text(extra), /Unknown argument 'confirmed'/);
      assert.equal(mutations(ctx, "restore").length, 0);
    });
  });
});
