// drive_bulk_move / drive_bulk_trash: exact batched argv, two-step gate, problems block execution.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DriveService } from "../dist/services/drive.js";
import { planBulkMove, planBulkTrash, loadListing, foldersToList } from "../dist/services/plan.js";
import { makeSandbox, startServer, nonVersionCalls } from "./helpers/mcp-client.mjs";

const TREE = {
  "/my-files/a": [{ name: "x.txt", type: "file" }, { name: "y.txt", type: "file" }],
  "/my-files/dst": [{ name: "old.txt", type: "file" }],
};
function runner(result = []) {
  const calls = [];
  const fn = async (args) => {
    calls.push([...args]);
    if (args[1] === "list") {
      const items = TREE[args[2]];
      if (!items) throw new Error("Node not found: " + args[2]);
      return items;
    }
    return result;
  };
  return { fn, calls, mutations: () => calls.filter((c) => c[1] !== "list") };
}

describe("DriveService.bulkMove / bulkTrash", () => {
  it("bulkMove sends ONE batched move with the destination last", async () => {
    const r = runner([{ uid: "1", ok: true }, { uid: "2", ok: true }]);
    await new DriveService(r.fn).bulkMove(["/my-files/a/x.txt", "/my-files/a/y.txt"], "/my-files/dst");
    assert.deepEqual(r.calls, [["filesystem", "move", "/my-files/a/x.txt", "/my-files/a/y.txt", "/my-files/dst"]]);
  });

  it("bulkTrash sends ONE batched trash", async () => {
    const r = runner([{ ok: true }, { ok: true }]);
    await new DriveService(r.fn).bulkTrash(["/my-files/a/x.txt", "/my-files/a/y.txt"]);
    assert.deepEqual(r.calls, [["filesystem", "trash", "/my-files/a/x.txt", "/my-files/a/y.txt"]]);
  });

  it("per-item failures go through assertItemsOk and report how many succeeded", async () => {
    const r = runner([{ uid: "1", ok: true }, { uid: "2", ok: false, error: { name: "NodeWithSameNameExistsValidationError", code: 2500 } }]);
    await assert.rejects(new DriveService(r.fn).bulkMove(["/my-files/a/x.txt", "/my-files/a/y.txt"], "/my-files/dst"), (e) => {
      assert.match(e.message, /Move failed: NodeWithSameNameExistsValidationError/);
      assert.match(e.message, /1 of 2 items succeeded/);
      return true;
    });
  });
});

describe("loadListing + plan with the injected runner (plan step never mutates)", () => {
  it("lists each distinct folder once and maps a not-found folder to null", async () => {
    const r = runner();
    const svc = new DriveService(r.fn);
    const srcs = ["/my-files/a/x.txt", "/my-files/a/y.txt"];
    const listing = await loadListing(svc, foldersToList(srcs, "/my-files/dst"));
    assert.deepEqual(r.calls.map((c) => c[2]).sort(), ["/my-files/a", "/my-files/dst"]);
    assert.deepEqual(planBulkMove(srcs, "/my-files/dst", listing).problems, []);
    assert.deepEqual(r.mutations(), []);
    const missing = await loadListing(svc, ["/my-files/none"]);
    assert.equal(missing.get("/my-files/none"), null);
    assert.equal(planBulkTrash(["/my-files/a/x.txt"], listing).problems.length, 0);
  });

  it("propagates non-not-found list errors instead of treating them as missing", async () => {
    const svc = new DriveService(async () => { throw new Error("CLI exploded"); });
    await assert.rejects(loadListing(svc, ["/my-files"]), /CLI exploded/);
  });
});

describe("stdio gates (fake CLI; every call answers the same listing)", () => {
  // Same payload for every folder => x.txt exists in the source folder AND in the destination (collision).
  const PAYLOAD = JSON.stringify([{ name: "x.txt", type: "file" }]);
  async function withServer(fn) {
    const sb = makeSandbox();
    const c = await startServer("json", sb, { FAKE_STDOUT: PAYLOAD });
    try { await fn(c, sb); } finally { await c.close(); sb.cleanup(); }
  }
  const mutationsOf = (sb) => nonVersionCalls(sb.argvLog).filter((a) => a[1] !== "list");

  it("bulk_move without confirmed returns a plan + problems and runs no mutation", async () => {
    await withServer(async (c, sb) => {
      const r = await c.call("drive_bulk_move", { sources: ["/my-files/s/x.txt"], destinationFolder: "/my-files/d" });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.data.applied, false);
      assert.match(r.data.problems[0].problem, /name collision/);
      assert.deepEqual(mutationsOf(sb), []);
    });
  });

  it("bulk_move confirmed=true with a problem fails and runs no mutation", async () => {
    await withServer(async (c, sb) => {
      const r = await c.call("drive_bulk_move", { sources: ["/my-files/s/x.txt"], destinationFolder: "/my-files/d", confirmed: true });
      assert.equal(r.isError, true);
      assert.match(r.text, /nothing moved/);
      assert.deepEqual(mutationsOf(sb), []);
    });
  });

  it("bulk_trash: plan without confirmed is unapplied; confirmed=true with a missing path is blocked", async () => {
    await withServer(async (c, sb) => {
      const plan = await c.call("drive_bulk_trash", { paths: ["/my-files/s/x.txt"] });
      assert.equal(plan.data.applied, false);
      assert.deepEqual(plan.data.plan, [{ source: "/my-files/s/x.txt" }]);
      const blocked = await c.call("drive_bulk_trash", { paths: ["/my-files/s/x.txt", "/my-files/s/nope.txt"], confirmed: true });
      assert.equal(blocked.isError, true);
      assert.match(blocked.text, /source not found/);
      assert.deepEqual(mutationsOf(sb), []);
    });
  });

  it("bulk_trash confirmed=true on a clean plan sends one batched trash", async () => {
    await withServer(async (c, sb) => {
      const r = await c.call("drive_bulk_trash", { paths: ["/my-files/s/x.txt"], confirmed: true });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.data.trashed, 1);
      assert.equal(mutationsOf(sb).length, 1);
      assert.deepEqual(mutationsOf(sb)[0].slice(0, 3), ["filesystem", "trash", "/my-files/s/x.txt"]);
    });
  });

  it("validates input: empty list, >200 paths, non-array, relative path", async () => {
    await withServer(async (c) => {
      for (const args of [{ paths: [] }, { paths: Array.from({ length: 201 }, (_, i) => `/my-files/p${i}`) }, { paths: "/my-files/a" }, { paths: ["rel"] }]) {
        const r = await c.call("drive_bulk_trash", args);
        assert.equal(r.isError, true, JSON.stringify(args).slice(0, 40));
      }
    });
  });

  it("advertises the confirmation flag and annotations", async () => {
    await withServer(async (c) => {
      const t = Object.fromEntries((await c.listTools()).map((x) => [x.name, x]));
      assert.ok(t.drive_bulk_move.inputSchema.properties.confirmed);
      assert.ok(t.drive_bulk_trash.inputSchema.properties.confirmed);
      assert.equal(t.drive_bulk_move.annotations.destructiveHint, false);
      assert.equal(t.drive_bulk_trash.annotations.destructiveHint, false); // reversible, like drive_trash
      assert.equal(t.drive_sync_plan.annotations.readOnlyHint, true);
      assert.equal(t.drive_sync_plan.inputSchema.properties.confirmed, undefined);
    });
  });
});
