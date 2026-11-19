// drive_checkup wired into the server (1.12.0, PLAN-1.12.0 section 3.1): the built server on the fake CLI (tree mode: a fixed listing).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DECLINE, withServer, writeTree, text } from "./helpers/approval-harness.mjs";
import { readArgvLog } from "./helpers/mcp-client.mjs";

const OLD = "2019-01-01T00:00:00Z";
const raw = (uid, parentUid, name, type, o = {}) => ({
  uid, parentUid, name: { ok: true, value: name }, type,
  activeRevision: type === "file"
    ? { claimedSize: o.size ?? 10, claimedModificationTime: o.mtime ?? OLD, ...(o.sha1 ? { claimedDigests: { sha1: o.sha1 } } : {}) }
    : undefined,
  isShared: o.shared === true, isSharedByUrl: o.url === true,
});
const MB = 1024 * 1024;

/** docs/a.pdf and inbox/a (1).pdf are a duplicate pair; empty/ is an empty folder; Shared/ is shared and holds a passport scan; one big old file. */
const TREE = {
  "/my-files": [
    raw("d1", "root", "docs", "folder"), raw("d2", "root", "inbox", "folder"), raw("d3", "root", "empty", "folder"),
    raw("d4", "root", "Shared", "folder", { shared: true }), raw("b1", "root", "backup.iso", "file", { size: 60 * MB }),
  ],
  "/my-files/docs": [raw("f1", "d1", "a.pdf", "file", { size: 5000, sha1: "S1", mtime: "2020-01-01T00:00:00Z" })],
  "/my-files/inbox": [raw("f2", "d2", "a (1).pdf", "file", { size: 5000, sha1: "S1", mtime: "2024-01-01T00:00:00Z" })],
  "/my-files/empty": [],
  "/my-files/Shared": [raw("f3", "d4", "passport-scan.pdf", "file", { size: 2000 })],
  "/trash": [raw("t1", "root", "old.txt", "file", { size: 1000 })],
};
const setup = (sb) => ({ FAKE_TREE: writeTree(sb.dir, TREE) });
const opts = (extra = {}) => ({ setup, fakeMode: "tree", ...extra });
const call = async (ctx, args = {}) => {
  const r = await ctx.call("drive_checkup", args);
  return { r, data: r.isError ? undefined : JSON.parse(text(r)) };
};
const findingOf = (data, id) => data.findings.find((f) => f.id === id);

describe("drive_checkup: summary", () => {
  it("returns the plan 3.1 shape and finds the planted problems", async () => {
    await withServer(opts(), async (ctx) => {
      const { r, data } = await call(ctx);
      assert.notEqual(r.isError, true, text(r));
      assert.equal(data.path, "/my-files");
      assert.deepEqual(Object.keys(data.scanned).sort(), ["ageMs", "bytes", "complete", "files", "folders"]);
      assert.equal(data.scanned.complete, true);
      assert.equal(data.scanned.files, 4);
      assert.equal(data.scanned.folders, 4);
      assert.equal(typeof data.score, "number");
      assert.ok(data.score > 0 && data.score < 100);
      assert.ok(Array.isArray(data.scoreParts) && data.scoreParts.length > 0);
      assert.equal(findingOf(data, "duplicates").count, 1);
      assert.equal(findingOf(data, "duplicates").fix, "drive_cleanup");
      assert.equal(findingOf(data, "empty-folders").count, 1);
      assert.equal(findingOf(data, "large-old").count, 1);
      assert.equal(findingOf(data, "outside-access").count, 1);
      assert.equal(findingOf(data, "sensitive-exposed").count, 1);
      assert.deepEqual(data.trash, { count: 1, bytes: 1000 });
      assert.ok(Array.isArray(data.caveats));
    });
  });

  it("B1: makes no call that changes Drive, and works in readonly mode", async () => {
    for (const env of [{}, { PROTON_DRIVE_MODE: "readonly" }]) {
      await withServer(opts({ env }), async (ctx) => {
        const { r } = await call(ctx);
        assert.notEqual(r.isError, true, text(r));
        assert.deepEqual(ctx.changes(), []);
      });
    }
  });

  it("B2: at most 3 names per finding, and namesInResult is the number of names the result holds", async () => {
    const tree = { ...TREE, "/my-files/docs": [], "/my-files/inbox": [] };
    // five duplicate pairs: 10 files, 5 copies
    for (let i = 0; i < 5; i++) {
      tree["/my-files/docs"].push(raw(`p${i}`, "d1", `p${i}.bin`, "file", { size: 4000, sha1: `H${i}`, mtime: "2020-01-01T00:00:00Z" }));
      tree["/my-files/inbox"].push(raw(`q${i}`, "d2", `p${i} copy.bin`, "file", { size: 4000, sha1: `H${i}`, mtime: "2024-01-01T00:00:00Z" }));
    }
    await withServer({ fakeMode: "tree", setup: (sb) => ({ FAKE_TREE: writeTree(sb.dir, tree) }) }, async (ctx) => {
      const { data } = await call(ctx);
      assert.equal(findingOf(data, "duplicates").count, 5);
      assert.equal(findingOf(data, "duplicates").samples.length, 3);
      for (const f of data.findings) assert.ok(f.samples.length <= 3, f.id);
      const names = new Set(data.findings.flatMap((f) => f.samples));
      assert.equal(data.namesInResult, data.findings.reduce((n, f) => n + f.samples.length, 0));
      assert.equal(data.namesInResult, names.size, "every sample is a different path");
    });
  });

  it("sharing:false makes no sharing call and says so; with sharing on, shared items are looked at", async () => {
    await withServer(opts(), async (ctx) => {
      const { data } = await call(ctx, { sharing: false });
      assert.ok(data.caveats.some((c) => /Sharing details were skipped/.test(c)));
      assert.ok(!readArgvLog(ctx.sb.argvLog).some((a) => a[0] === "sharing"), "no sharing call");
    });
    await withServer(opts(), async (ctx) => {
      await call(ctx);
      assert.ok(readArgvLog(ctx.sb.argvLog).some((a) => a[0] === "sharing" && a[1] === "status" && a[2] === "/my-files/Shared"), "the shared folder was audited");
      assert.deepEqual(ctx.changes(), []);
    });
  });

  it("a partial walk says so and asks to call again", async () => {
    await withServer({ ...opts({ env: { PROTON_DRIVE_WALK_BUDGET_MS: "100", FAKE_SLEEP_MS: "500" } }) }, async (ctx) => {
      const { r, data } = await call(ctx);
      assert.notEqual(r.isError, true, text(r));
      assert.equal(data.scanned.partial, true);
      assert.equal(data.scanned.complete, false);
      assert.ok(data.caveats.some((c) => /partial/i.test(c) && /call again/i.test(c)), data.caveats.join(" | "));
      assert.ok(!data.findings.some((f) => f.id === "empty-folders"), "no folder is called empty on a partial scan");
    });
  });
});

describe("drive_checkup: entries that cannot be identified", () => {
  it("an entry listed without a uid is reported as an incomplete scan, not dropped silently", async () => {
    const tree = { ...TREE, "/my-files/docs": [...TREE["/my-files/docs"], { name: { ok: true, value: "ghost.txt" }, type: "file", activeRevision: { claimedSize: 5 } }] };
    await withServer({ fakeMode: "tree", setup: (sb) => ({ FAKE_TREE: writeTree(sb.dir, tree) }) }, async (ctx) => {
      const { r, data } = await call(ctx);
      assert.notEqual(r.isError, true, text(r));
      assert.equal(data.scanned.complete, false);
      assert.ok(data.caveats.some((c) => /incomplete/i.test(c)), data.caveats.join(" | "));
      assert.ok(!data.findings.some((f) => f.id === "empty-folders"), "no folder is called empty when something below it could not be identified");
    });
  });
});

describe("drive_checkup: finding pages", () => {
  it("pages one finding with total, nextOffset and an honest namesInResult", async () => {
    const tree = { ...TREE, "/my-files/docs": [], "/my-files/inbox": [] };
    for (let i = 0; i < 4; i++) {
      tree["/my-files/docs"].push(raw(`p${i}`, "d1", `p${i}.bin`, "file", { size: 4000, sha1: `H${i}`, mtime: "2020-01-01T00:00:00Z" }));
      tree["/my-files/inbox"].push(raw(`q${i}`, "d2", `p${i} copy.bin`, "file", { size: 4000, sha1: `H${i}`, mtime: "2024-01-01T00:00:00Z" }));
    }
    await withServer({ fakeMode: "tree", setup: (sb) => ({ FAKE_TREE: writeTree(sb.dir, tree) }) }, async (ctx) => {
      const first = (await call(ctx, { finding: "duplicates", limit: 3 })).data;
      assert.equal(first.finding, "duplicates");
      assert.equal(first.total, 4);
      assert.equal(first.items.length, 3);
      assert.equal(first.nextOffset, 3);
      assert.equal(first.namesInResult, 6, "3 copies and the 3 copies they duplicate");
      const second = (await call(ctx, { finding: "duplicates", limit: 3, offset: 3 })).data;
      assert.equal(second.items.length, 1);
      assert.equal(second.nextOffset, undefined);
      const paths = [...first.items, ...second.items].map((i) => i.path);
      assert.equal(new Set(paths).size, 4);
    });
  });

  it("lists empty folders, large old files and the sensitive name in the shared folder", async () => {
    await withServer(opts(), async (ctx) => {
      assert.deepEqual((await call(ctx, { finding: "empty-folders" })).data.items.map((i) => i.path), ["/my-files/empty"]);
      assert.deepEqual((await call(ctx, { finding: "large-old" })).data.items.map((i) => i.path), ["/my-files/backup.iso"]);
      const se = (await call(ctx, { finding: "sensitive-exposed" })).data;
      assert.deepEqual(se.items.map((i) => i.path), ["/my-files/Shared/passport-scan.pdf"]);
      assert.equal(se.items[0].sharedVia, "/my-files/Shared");
      assert.ok((await call(ctx, { finding: "outside-access" })).data.items.some((i) => i.path === "/my-files/Shared"));
    });
  });
});

describe("drive_checkup: guards", () => {
  it("is hidden in the core tool tier and refused there without touching the CLI", async () => {
    await withServer(opts({ env: { PROTON_DRIVE_TOOL_TIER: "core" } }), async (ctx) => {
      const names = (await ctx.client.listTools()).tools.map((t) => t.name);
      assert.ok(!names.includes("drive_checkup"));
      const r = await ctx.call("drive_checkup", {});
      assert.equal(r.isError, true);
      assert.equal(ctx.lastAudit().code, "tier");
    });
  });

  it("PROTON_DRIVE_REMOTE_ROOTS: only paths inside a root, trash left out", async () => {
    await withServer(opts({ env: { PROTON_DRIVE_REMOTE_ROOTS: "/my-files/docs" } }), async (ctx) => {
      const outside = await ctx.call("drive_checkup", { path: "/my-files/inbox" });
      assert.equal(outside.isError, true);
      assert.equal(ctx.lastAudit().code, "roots");
      const dflt = await ctx.call("drive_checkup", {});
      assert.equal(dflt.isError, true, "the default /my-files is outside the root");
      const { r, data } = await call(ctx, { path: "/my-files/docs" });
      assert.notEqual(r.isError, true, text(r));
      assert.deepEqual(data.trash, { count: 0, bytes: 0 });
      assert.ok(data.caveats.some((c) => /trash is not included/.test(c)));
      assert.ok(!readArgvLog(ctx.sb.argvLog).some((a) => a[2] === "/trash"), "the account-wide trash is not read");
    });
  });

  it("path must be under /my-files; unknown arguments are rejected", async () => {
    await withServer(opts({ replies: () => DECLINE }), async (ctx) => {
      const r = await ctx.call("drive_checkup", { path: "/shared-with-me/x" });
      assert.equal(r.isError, true);
      assert.match(text(r), /\/my-files/);
      const extra = await ctx.call("drive_checkup", { paths: ["/my-files"] });
      assert.equal(extra.isError, true);
      assert.match(text(extra), /Unknown argument 'paths'/);
      const bad = await ctx.call("drive_checkup", { finding: "everything" });
      assert.equal(bad.isError, true);
    });
  });

  it("is annotated read-only", async () => {
    await withServer(opts(), async (ctx) => {
      const t = (await ctx.client.listTools()).tools.find((x) => x.name === "drive_checkup");
      assert.equal(t.annotations.readOnlyHint, true);
      assert.equal(t.inputSchema.additionalProperties, false);
    });
  });
});
