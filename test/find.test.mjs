// drive_tree / drive_search over real stdio against the fake CLI's "tree" mode.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, startServer, fakeEnv, nonVersionCalls, DIST_CLI } from "./helpers/mcp-client.mjs";

const folder = (name) => ({ uid: `d-${name}`, parentUid: "p", type: "folder", name: { ok: true, value: name } });
const file = (name, size, { mtime, up = "2026-03-01T00:00:00.000Z", mediaType = "application/octet-stream", sha1 } = {}) => ({
  uid: `f-${name}`, parentUid: "p", type: "file", name: { ok: true, value: name }, mediaType, modificationTime: up,
  activeRevision: { claimedSize: size, ...(mtime ? { claimedModificationTime: mtime } : {}), ...(sha1 ? { claimedDigests: { sha1 } } : {}) },
});
const pdf = { mediaType: "application/pdf" };

const TREE = {
  "/my-files": [folder("Docs"), folder("Pics"), folder(".git"), folder("Broken"), file("notes.txt", 10, { mtime: "2024-01-01T00:00:00.000Z" })],
  "/my-files/Docs": [folder("Old"), file("Report.PDF", 5_000_000, { ...pdf, mtime: "2025-06-01T00:00:00.000Z", sha1: "deadbeef" }), file("small.pdf", 100, pdf), file("a.docx", 3000)],
  "/my-files/Docs/Old": [file("report-2019.pdf", 2_000_000, { ...pdf, mtime: "2019-01-01T00:00:00.000Z" })],
  "/my-files/Pics": [file("cat.jpg", 4000, { mediaType: "image/jpeg", up: "2026-02-01T00:00:00.000Z" }), file("dog.jpg", 6000, { mediaType: "image/jpeg", mtime: "2026-07-01T00:00:00.000Z" })],
  "/my-files/.git": [file("HEAD", 1)],
  "/my-files/Broken": "Some permanent failure",
};

let sb, c;
before(async () => {
  sb = makeSandbox();
  writeFileSync(join(sb.dir, "tree.json"), JSON.stringify(TREE));
  c = await startServer("tree", sb, { FAKE_TREE: join(sb.dir, "tree.json"), PROTON_DRIVE_RETRY_BASE_MS: "1" });
});
after(async () => { await c?.close(); sb?.cleanup(); });

const search = async (args) => {
  const r = await c.call("drive_search", { refresh: true, ...args });
  assert.equal(r.isError, false, r.text);
  return r.data;
};
const paths = (d) => d.items.map((i) => i.path);

describe("drive_search", () => {
  it("both tools are read-only", async () => {
    const tools = await c.listTools();
    for (const n of ["drive_tree", "drive_search"]) assert.equal(tools.find((t) => t.name === n).annotations.readOnlyHint, true);
  });

  it("reports a partial walk: failed folder is named in skipped, complete:false", async () => {
    const d = await search({ glob: "*.pdf" });
    assert.equal(d.walk.complete, false);
    assert.equal(d.walk.skippedCount, 1);
    assert.equal(d.walk.skipped[0].path, "/my-files/Broken");
    assert.match(d.walk.skipped[0].reason, /permanent failure/);
    assert.equal(d.walk.fromCache, false);
  });

  it("glob is case-insensitive on the name and skips .git", async () => {
    const d = await search({ glob: "*.pdf" });
    assert.deepEqual(paths(d), ["/my-files/Docs/Old/report-2019.pdf", "/my-files/Docs/Report.PDF", "/my-files/Docs/small.pdf"]);
    assert.equal(d.total, 3);
    assert.deepEqual(d.items[1], { path: "/my-files/Docs/Report.PDF", type: "file", size: 5_000_000, mtime: "2025-06-01T00:00:00.000Z", sha1: "deadbeef", mediaType: "application/pdf" });
    assert.ok(!(await search({ query: "HEAD" })).items.length);
  });

  it("the headline query: pdfs over 1 MB", async () => {
    const d = await search({ glob: "*.pdf", minSize: 1_000_000, sort: "size" });
    assert.deepEqual(paths(d), ["/my-files/Docs/Report.PDF", "/my-files/Docs/Old/report-2019.pdf"]);
  });

  it("query, regex, extensions, type, mediaType and size bounds", async () => {
    assert.deepEqual(paths(await search({ query: "REPORT" })), ["/my-files/Docs/Old/report-2019.pdf", "/my-files/Docs/Report.PDF"]);
    assert.deepEqual(paths(await search({ regex: "^report-\\d+" })), ["/my-files/Docs/Old/report-2019.pdf"]);
    assert.deepEqual(paths(await search({ extensions: [".docx", "TXT"] })), ["/my-files/Docs/a.docx", "/my-files/notes.txt"]);
    assert.deepEqual(paths(await search({ type: "folder" })), ["/my-files/.git", "/my-files/Broken", "/my-files/Docs", "/my-files/Docs/Old", "/my-files/Pics"]);
    assert.equal((await search({ mediaType: "image/" })).total, 2);
    assert.deepEqual(paths(await search({ minSize: 3000, maxSize: 4000 })), ["/my-files/Docs/a.docx", "/my-files/Pics/cat.jpg"]);
    assert.equal((await search({ glob: "Docs/**" })).total, 0); // a glob with '/' is matched against the full path
    assert.equal((await search({ glob: "/my-files/Docs/*" })).total, 4);
  });

  it("date filters use claimed mtime and fall back to upload time", async () => {
    assert.deepEqual(paths(await search({ modifiedBefore: "2020-01-01" })), ["/my-files/Docs/Old/report-2019.pdf"]);
    // cat.jpg has no claimed mtime: its upload time (2026-02-01) counts; small.pdf/a.docx upload 2026-03-01
    const d = await search({ type: "file", modifiedAfter: "2026-01-01", modifiedBefore: "2026-02-15" });
    assert.deepEqual(paths(d), ["/my-files/Pics/cat.jpg"]);
    assert.equal((await search({ type: "file", sort: "mtime", limit: 2 })).items[0].path, "/my-files/Pics/dog.jpg");
  });

  it("paginates deterministically", async () => {
    const seen = [];
    for (let offset = 0; ; offset += 2) {
      const d = await search({ type: "file", limit: 2, offset, sort: "size" });
      seen.push(...paths(d));
      if (!d.hasMore) break;
    }
    const all = paths(await search({ type: "file", limit: 500, sort: "size" }));
    assert.deepEqual(seen, all);
    assert.equal(new Set(all).size, all.length);
    assert.equal(all[0], "/my-files/Docs/Report.PDF");
  });

  it("serves repeat searches from the cache with no new CLI calls; refresh re-walks", async () => {
    const r1 = await c.call("drive_search", { refresh: true, query: "cat" });
    const before = nonVersionCalls(sb.argvLog).length;
    const r2 = await c.call("drive_search", { query: "dog" });
    assert.equal(r2.data.walk.fromCache, true);
    assert.equal(r2.data.walk.callsMade, 0);
    assert.ok(r2.data.walk.ageMs >= 0);
    assert.equal(nonVersionCalls(sb.argvLog).length, before);
    const r3 = await c.call("drive_search", { refresh: true, query: "dog" });
    assert.equal(r3.data.walk.fromCache, false);
    assert.ok(nonVersionCalls(sb.argvLog).length > before);
    assert.equal(r1.data.walk.fromCache, false);
  });

  it("rejects bad arguments before touching the CLI", async () => {
    const before = nonVersionCalls(sb.argvLog).length;
    const bad = [
      [{ regex: "a".repeat(201) }, /200 characters/],
      [{ regex: "(" }, /regex is invalid/],
      [{ glob: "" }, /must not be empty/],
      [{ modifiedAfter: "yesterday" }, /ISO date/],
      [{ extensions: ["a/b"] }, /extensions/],
      [{ path: "/" }, /not '\/'/],
      [{ path: "relative" }, /absolute/],
      [{ limit: 501 }, /<= 500/],
      [{ minSize: -1 }, />= 0/],
      [{ sort: "random" }, /one of/],
      [{ type: "album" }, /one of/],
      [{ bogus: 1 }, /Unknown argument/],
    ];
    for (const [args, re] of bad) {
      const r = await c.call("drive_search", args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.text, re, JSON.stringify(args));
    }
    assert.equal(nonVersionCalls(sb.argvLog).length, before);
  });

  it("a failing root is an error, not an empty result", async () => {
    const r = await c.call("drive_search", { path: "/my-files/missing", refresh: true });
    assert.equal(r.isError, true);
    assert.match(r.text, /not found/i);
  });
});

describe("drive_tree", () => {
  const tree = async (args) => {
    const r = await c.call("drive_tree", { refresh: true, ...args });
    assert.equal(r.isError, false, r.text);
    return r.data;
  };
  const find = (d, ...names) => names.reduce((n, name) => n.children.find((x) => x.name === name), { children: d.tree });

  it("rolls up counts and sizes, largest first, and flags folders it could not open", async () => {
    const d = await tree({ depth: 3 });
    assert.equal(d.path, "/my-files");
    assert.equal(d.files, 7);
    assert.equal(d.folders, 5);
    assert.equal(d.size, 7_013_110);
    assert.equal(d.complete, false); // Broken failed
    assert.equal(d.skippedCount, 1);
    assert.equal(d.unexpanded, 2); // .git (excluded) and Broken (failed)
    assert.deepEqual(d.tree.map((n) => n.name), ["Docs", "Pics", ".git", "Broken", "notes.txt"]);
    assert.deepEqual(find(d, "Docs"), {
      name: "Docs", type: "folder", files: 4, folders: 1, size: 7_003_100,
      children: [
        { name: "Old", type: "folder", files: 1, folders: 0, size: 2_000_000, children: [{ name: "report-2019.pdf", size: 2_000_000 }] },
        { name: "Report.PDF", size: 5_000_000 }, { name: "a.docx", size: 3000 }, { name: "small.pdf", size: 100 },
      ],
    });
    assert.equal(find(d, "Broken").unexpanded, true);
  });

  it("depth is a display choice: complete stays true and deeper folders are flagged unexpanded", async () => {
    const d = await tree({ depth: 1 });
    assert.equal(d.complete, true);
    assert.equal(d.files, 1);
    assert.equal(d.unexpanded, 4);
    assert.equal(find(d, "Docs").unexpanded, true);
    assert.equal(find(d, "Docs").children, undefined);
    assert.equal(d.callsMade, 1);
  });

  it("foldersOnly hides files from the tree but not from the totals", async () => {
    const d = await tree({ depth: 3, foldersOnly: true });
    assert.equal(d.files, 7);
    assert.deepEqual(d.tree.map((n) => n.name), ["Docs", "Pics", ".git", "Broken"]);
    assert.deepEqual(find(d, "Docs").children.map((n) => n.name), ["Old"]);
  });

  it("limit caps the entries returned and reports how many were left out", async () => {
    const d = await tree({ depth: 3, limit: 2 });
    assert.deepEqual(d.tree.map((n) => n.name), ["Docs", "Pics"]);
    assert.equal(d.more, 3);
    assert.equal(d.tree[0].children, undefined);
  });

  it("walks a subfolder and serves repeats from the cache", async () => {
    const d = await tree({ path: "/my-files/Docs/", depth: 2 });
    assert.equal(d.path, "/my-files/Docs");
    assert.equal(d.files, 4);
    assert.equal(d.complete, true);
    const again = await c.call("drive_tree", { path: "/my-files/Docs", depth: 2 });
    assert.equal(again.data.fromCache, true);
    assert.equal(again.data.callsMade, 0);
  });

  it("rejects bad arguments", async () => {
    for (const [args, re] of [[{ depth: 11 }, /<= 10/], [{ limit: 0 }, />= 1/], [{ path: "/" }, /not '\/'/], [{ foldersOnly: "yes" }, /boolean/]]) {
      const r = await c.call("drive_tree", args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.text, re);
    }
  });
});

describe("companion CLI", () => {
  const cli = (args) => new Promise((resolve) => {
    execFile(process.execPath, [DIST_CLI, ...args], { env: fakeEnv("tree", sb, { FAKE_TREE: join(sb.dir, "tree.json"), PROTON_DRIVE_RETRY_BASE_MS: "1" }), timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout, stderr });
    });
  });

  it("search prints the same result shape", async () => {
    const r = await cli(["search", "/my-files/Docs", "--glob", "*.pdf", "--min-size", "1000000", "--sort", "size", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).items.map((i) => i.path), ["/my-files/Docs/Report.PDF", "/my-files/Docs/Old/report-2019.pdf"]);
  });

  it("tree prints totals; bad flags exit 1", async () => {
    const r = await cli(["tree", "/my-files/Pics", "--depth", "1", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).size, 10000);
    assert.equal((await cli(["search", "--limit", "abc"])).code, 1);
  });
});
