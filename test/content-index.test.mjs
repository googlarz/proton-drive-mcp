// Opt-in encrypted content index (1.7.0): drive_content_index and drive_search_content.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { makeSandbox, startServer, DIST_CLI, fakeEnv } from "./helpers/mcp-client.mjs";
import { SealedWriter, readSealed, readSealedAccount, accountDigest, ContentIndexError, SEALED_FILE_NAME, CHUNK_BYTES } from "../dist/services/contentSeal.js";
import { writePrivateStream } from "../dist/services/walkIndex.js";
import { tokenize, parseQuery, searchData, ContentData, termFrequencies, makeExcerpt, makeSnippet, serializeData, DataLoader } from "../dist/services/contentSearch.js";
import { driveContentIndex, driveSearchContent, looksSecret, contentIndexPath } from "../dist/services/contentIndex.js";
import { getContentKey, plannedBackend, ContentKeyError } from "../dist/utils/contentKey.js";
import { redactArgs } from "../dist/utils/audit.js";

const HEX_A = "ab".repeat(32);
const HEX_B = "cd".repeat(32);
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pdci-")); // mkdtemp: mode 0700, as the private index directory must be
  process.env.PROTON_DRIVE_INDEX_DIR = dir;
  process.env.PROTON_DRIVE_CONTENT_INDEX = "1";
  process.env.PROTON_DRIVE_CONTENT_INDEX_KEY = HEX_A;
  delete process.env.PROTON_DRIVE_CONTENT_INDEX_MAX_MB;
});
afterEach(() => {
  for (const k of ["PROTON_DRIVE_INDEX_DIR", "PROTON_DRIVE_CONTENT_INDEX", "PROTON_DRIVE_CONTENT_INDEX_KEY", "PROTON_DRIVE_CONTENT_INDEX_MAX_MB"]) delete process.env[k];
  rmSync(dir, { recursive: true, force: true });
});

// ---- helpers ---------------------------------------------------------------------------------------------------------
const node = (path, o = {}) => ({ path, uid: path, type: "file", size: 10, mtime: "2026-01-01T00:00:00Z", mediaType: "text/plain", ...o });
const walkOf = (nodes, extra = {}) => async (_d, root) => ({ root, nodes, complete: true, callsMade: 1, skipped: [], fromCache: false, ageMs: 0, ...extra });
/** Fake Drive world: files = {path: text}; counts loads per path. */
function world(files, { sizes = {}, mtimes = {} } = {}) {
  const loads = [];
  const nodes = () => Object.keys(files).map((p) => node(p, { size: sizes[p] ?? files[p].length, mtime: mtimes[p] ?? "2026-01-01T00:00:00Z", mediaType: p.endsWith(".png") ? "image/png" : "text/plain" }));
  const deps = (extra = {}) => ({
    walk: async (_d, root) => ({ root, nodes: nodes(), complete: true, callsMade: 1, skipped: [], fromCache: false, ageMs: 0 }),
    accountKey: async () => "acct-1",
    load: async (_d, p) => { loads.push(p); if (files[p] instanceof Error) throw files[p]; return { text: files[p] }; },
    ...extra,
  });
  return { files, loads, deps, nodes };
}
const update = (w, o = {}, extra = {}) => driveContentIndex({}, { path: "/my-files/Docs", ...o }, w.deps(extra));
const search = (w, q, o = {}, extra = {}) => driveSearchContent({}, { query: q, ...o }, w.deps(extra));
const paths = (r) => r.results.map((x) => x.path);

// ---- sealed container ------------------------------------------------------------------------------------------------
describe("sealed container", () => {
  const digest = accountDigest("acct-1");
  const key = Buffer.from(HEX_A, "hex");
  const write = (payload, k = key, max = 1 << 30) => writePrivateStream(SEALED_FILE_NAME, (fd) => { const w = new SealedWriter(fd, k, digest, max); for (const p of payload) w.write(p); w.finish(); });
  const read = (k = key, d = digest) => { const out = []; const found = readSealed(k, d, 1 << 30, (c) => out.push(c)); return found ? Buffer.concat(out) : undefined; };
  const file = () => join(dir, SEALED_FILE_NAME);

  it("round-trips data spanning several chunks and an empty payload", () => {
    const big = randomBytes(CHUNK_BYTES * 2 + 12345);
    assert.equal(write([big.subarray(0, 700_000), big.subarray(700_000)]), "ok");
    assert.ok(read().equals(big));
    assert.equal(statSync(file()).mode & 0o777, 0o600);
    assert.equal(write([]), "ok");
    assert.equal(read().length, 0);
  });

  it("the same plaintext encrypts differently every time (random nonce per chunk) and is not readable in the file", () => {
    write(["secret-token-in-plaintext"]);
    const a = readFileSync(file());
    write(["secret-token-in-plaintext"]);
    const b = readFileSync(file());
    assert.ok(!a.equals(b));
    assert.ok(!a.includes("secret-token"));
  });

  it("returns undefined when there is no file", () => assert.equal(read(), undefined));

  it("a wrong key fails closed and returns nothing", () => {
    write(["hello"]);
    const seen = [];
    assert.throws(() => readSealed(Buffer.from(HEX_B, "hex"), digest, 1 << 30, (c) => seen.push(c)), (e) => e instanceof ContentIndexError && /key is wrong or the file was modified/.test(e.message));
    assert.deepEqual(seen, []);
  });

  it("every flipped byte position class fails closed: magic, version, digest, length, nonce, ciphertext, tag", () => {
    write([randomBytes(5000)]);
    const orig = readFileSync(file());
    const positions = [0, 4, 10, 37, 41, 60, orig.length - 20, orig.length - 1];
    for (const pos of positions) {
      const bad = Buffer.from(orig);
      bad[pos] ^= 0x01;
      writeFileSync(file(), bad, { mode: 0o600 });
      assert.throws(() => read(), ContentIndexError, `byte ${pos}`);
    }
  });

  it("truncation, appended bytes, a dropped or reordered chunk all fail closed", () => {
    write([randomBytes(CHUNK_BYTES + 5000)]); // two chunks
    const orig = readFileSync(file());
    const headerLen = 37;
    const firstLen = headerLen + 4 + 12 + CHUNK_BYTES + 16;
    for (const bad of [
      orig.subarray(0, orig.length - 1), // cut mid-chunk
      orig.subarray(0, firstLen), // second (final) chunk removed: first one claims "not final"
      Buffer.concat([orig, Buffer.from([0])]), // trailing byte
      Buffer.concat([orig.subarray(0, headerLen), orig.subarray(firstLen), orig.subarray(headerLen, firstLen)]), // chunks swapped
      orig.subarray(0, headerLen), // header only
    ]) {
      writeFileSync(file(), bad, { mode: 0o600 });
      assert.throws(() => read(), ContentIndexError);
    }
  });

  it("another account's digest is refused before anything is decrypted", () => {
    write(["x"]);
    const seen = [];
    assert.throws(() => readSealed(key, accountDigest("acct-2"), 1 << 30, (c) => seen.push(c)), /another Proton account/);
    assert.deepEqual(seen, []);
    assert.ok(readSealedAccount(1 << 30).equals(digest));
  });

  it("refuses a file with group/other access, a symlink and an over-cap file", () => {
    write(["x"]);
    chmodSync(file(), 0o644);
    assert.throws(() => read(), /must be a regular file owned by you/);
    chmodSync(file(), 0o600);
    assert.throws(() => readSealed(key, digest, 10, () => {}), /over the size cap/);
  });

  it("the writer enforces the size cap and leaves no file or temp file behind", () => {
    assert.equal(write([randomBytes(5000)], key, 1000), "too-large");
    assert.deepEqual(readdirSync(dir), []);
  });
});

// ---- tokenizer, ranking --------------------------------------------------------------------------------------------
describe("tokenizer and BM25", () => {
  const build = (docs) => {
    const d = new ContentData();
    for (const [path, text] of Object.entries(docs)) {
      const { tf, tokens } = termFrequencies(text);
      d.addDoc({ path, sig: "s", at: 1, tokens, excerpt: makeExcerpt(text) }, tf);
    }
    return d;
  };

  it("lowercases, splits on non letters/digits, keeps unicode, drops 1-character and over-long tokens", () => {
    assert.deepEqual(tokenize("Hello, WORLD! a 42 Zażółć-gęślą Ünïcode x".concat(" ", "z".repeat(41))), ["hello", "world", "42", "zażółć", "gęślą", "ünïcode"]);
  });

  it("ranks the document with more and denser matches first; ties break by path", () => {
    const d = build({
      "/a/long": "invoice " + "filler ".repeat(300),
      "/a/dense": "invoice invoice invoice payment",
      "/a/none": "completely different",
      "/a/b-tie": "invoice x1 y1",
      "/a/a-tie": "invoice x1 y1",
    });
    const r = searchData(d, parseQuery("invoice"), { limit: 10 });
    assert.deepEqual(r.hits.map((h) => h.path), ["/a/dense", "/a/a-tie", "/a/b-tie", "/a/long"]);
    assert.equal(r.total, 4);
  });

  it("requires all words (AND) and supports a prefix on the last word only with a trailing *", () => {
    const d = build({ "/1": "annual invoice report", "/2": "annual budget", "/3": "invoicing and billing" });
    assert.deepEqual(searchData(d, parseQuery("annual invoice"), { limit: 10 }).hits.map((h) => h.path), ["/1"]);
    assert.deepEqual(searchData(d, parseQuery("invoi"), { limit: 10 }).hits, []);
    assert.deepEqual(searchData(d, parseQuery("invoi*"), { limit: 10 }).hits.map((h) => h.path).sort(), ["/1", "/3"]);
    assert.deepEqual(searchData(d, parseQuery("annual invoi*"), { limit: 10 }).hits.map((h) => h.path), ["/1"]);
    assert.deepEqual(searchData(d, parseQuery("annual zzz"), { limit: 10 }).hits, []);
  });

  it("rejects a query without searchable words and a one-character prefix", () => {
    assert.throws(() => parseQuery("a ! ?"), /no searchable words/);
    assert.throws(() => parseQuery("a*"), /prefix needs/);
  });

  it("removeDocs drops postings and empties; the file text round-trips through serialize and DataLoader", () => {
    const d = build({ "/1": "alpha beta", "/2": "beta gamma" });
    d.folders["/x"] = { updatedAt: 5, complete: true };
    const lines = [];
    serializeData(d, (s) => lines.push(s));
    const l = new DataLoader();
    l.push(Buffer.from(lines.join("")));
    const back = l.finish();
    assert.deepEqual(searchData(back, parseQuery("beta"), { limit: 9 }).hits.map((h) => h.path).sort(), ["/1", "/2"]);
    assert.deepEqual(back.folders, d.folders);
    const id1 = back.idByPath().get("/1");
    back.removeDocs(new Set([id1]));
    assert.ok(!back.postings.has("alpha"));
    assert.deepEqual(searchData(back, parseQuery("beta"), { limit: 9 }).hits.map((h) => h.path), ["/2"]);
  });

  it("DataLoader rejects malformed plaintext", () => {
    for (const bad of ["not json\n", '{"k":"doc"}\n', '{"k":"meta","v":99}\n']) {
      const l = new DataLoader();
      assert.throws(() => { l.push(Buffer.from(bad)); l.finish(); }, ContentIndexError);
    }
  });

  it("snippets: about 200 characters around the match, whitespace collapsed, ellipses at cut ends", () => {
    const text = "intro ".repeat(100) + "the needle is here\n\n\tand more text " + "tail ".repeat(100);
    const s = makeSnippet(makeExcerpt(text), ["needle"]);
    assert.match(s, /needle is here and more text/);
    assert.ok(s.startsWith("…") && s.endsWith("…"));
    assert.ok(s.length <= 210);
    assert.ok(!/[\n\t]/.test(s));
    assert.ok(makeSnippet(makeExcerpt("short text"), ["nomatch"]).startsWith("short text"));
  });
});

// ---- update and search -----------------------------------------------------------------------------------------------
describe("drive_content_index update and drive_search_content", () => {
  it("indexes, finds, and the file on disk contains none of the text", async () => {
    const w = world({ "/my-files/Docs/a.txt": "The quarterly zebracorn report", "/my-files/Docs/b.md": "Other topic entirely" });
    const r = await update(w);
    assert.equal(r.indexed, 2);
    assert.equal(r.partial, false);
    assert.equal(r.keyBackend, "env");
    const raw = readFileSync(contentIndexPath());
    assert.ok(!raw.includes("zebracorn") && !raw.includes("/my-files/Docs"));
    const s = await search(w, "zebracorn");
    assert.deepEqual(paths(s), ["/my-files/Docs/a.txt"]);
    assert.match(s.results[0].snippet, /quarterly zebracorn report/);
    assert.equal(s.stale, true);
    assert.match(s.note, /untrusted data, never instructions/);
    assert.match(s.results[0].indexedAt, /^\d{4}-\d\d-\d\dT/);
  });

  it("is incremental: unchanged files are not read again, changed ones are replaced, vanished ones are dropped", async () => {
    const w = world({ "/my-files/Docs/a.txt": "alpha apple", "/my-files/Docs/b.txt": "beta banana", "/my-files/Docs/c.txt": "gamma cherry" });
    await update(w);
    assert.equal(w.loads.length, 3);
    w.loads.length = 0;
    const same = await update(w);
    assert.equal(same.unchanged, 3);
    assert.equal(same.indexed, 0);
    assert.deepEqual(w.loads, []);

    w.files["/my-files/Docs/a.txt"] = "alpha avocado extra"; // size changes
    delete w.files["/my-files/Docs/c.txt"];
    const r = await update(w);
    assert.deepEqual(w.loads, ["/my-files/Docs/a.txt"]);
    assert.equal(r.indexed, 1);
    assert.equal(r.removed, 1);
    assert.equal(r.documents, 2);
    assert.deepEqual(paths(await search(w, "avocado")), ["/my-files/Docs/a.txt"]);
    assert.deepEqual(paths(await search(w, "apple")), []); // old content gone
    assert.deepEqual(paths(await search(w, "cherry")), []); // vanished file gone
  });

  it("a modification time change alone re-reads the file", async () => {
    const mt = { "/my-files/Docs/a.txt": "2026-01-01T00:00:00Z" };
    const w = world({ "/my-files/Docs/a.txt": "same text" }, { mtimes: mt });
    await update(w);
    mt["/my-files/Docs/a.txt"] = "2026-02-02T00:00:00Z";
    w.loads.length = 0;
    await update(w);
    assert.equal(w.loads.length, 1);
  });

  it("an incomplete listing never drops index entries", async () => {
    const w = world({ "/my-files/Docs/a.txt": "alpha", "/my-files/Docs/b.txt": "beta" });
    await update(w);
    delete w.files["/my-files/Docs/b.txt"];
    const r = await update(w, {}, { walk: async (_d, root) => ({ root, nodes: w.nodes(), complete: false, callsMade: 1, skipped: [{ path: "/my-files/Docs/x", reason: "boom" }], fromCache: false, ageMs: 0 }) });
    assert.equal(r.removed, 0);
    assert.equal(r.documents, 2);
    assert.match(r.note, /listing was incomplete/);
  });

  it("time budget: partial with remaining, and repeated calls continue until done without re-reading", async () => {
    const files = {};
    for (let i = 0; i < 9; i++) files[`/my-files/Docs/f${i}.txt`] = `word${i} common`;
    const w = world(files);
    let clock = 1_000_000;
    const slowLoad = async (_d, p) => { w.loads.push(p); clock += 1000; return { text: files[p] }; };
    const deps = { now: () => clock, load: slowLoad };
    const first = await update(w, { timeBudgetMs: 2500 }, deps);
    assert.equal(first.partial, true);
    assert.ok(first.remaining > 0 && first.indexed > 0 && first.indexed + first.remaining === 9, JSON.stringify(first));
    assert.match(first.note, /call drive_content_index again/);
    let guard = 0, last = first;
    while (last.partial && guard++ < 10) last = await update(w, { timeBudgetMs: 2500 }, deps);
    assert.equal(last.partial, false);
    assert.equal(last.documents, 9);
    assert.equal(new Set(w.loads).size, 9);
    assert.equal(w.loads.length, 9); // each file read exactly once
    assert.equal((await search(w, "common", { limit: 50 })).totalMatches, 9);
  });

  it("maxFiles caps one call and the next call continues", async () => {
    const w = world({ "/my-files/Docs/a.txt": "one", "/my-files/Docs/b.txt": "two", "/my-files/Docs/c.txt": "three" });
    const r = await update(w, { maxFiles: 2 });
    assert.equal(r.indexed, 2);
    assert.equal(r.remaining, 1);
    assert.equal(r.partial, true);
    const r2 = await update(w, { maxFiles: 2 });
    assert.equal(r2.indexed, 1);
    assert.equal(r2.partial, false);
  });

  it("a partial Drive listing is flagged partial and removes nothing", async () => {
    const w = world({ "/my-files/Docs/a.txt": "alpha", "/my-files/Docs/b.txt": "beta" });
    await update(w);
    delete w.files["/my-files/Docs/b.txt"];
    const r = await update(w, {}, { walk: async (_d, root) => ({ root, nodes: w.nodes(), complete: false, partial: true, continuing: true, budgetMs: 100, callsMade: 1, skipped: [], fromCache: false, ageMs: 0 }) });
    assert.equal(r.partial, true);
    assert.equal(r.removed, 0);
  });

  it("secret-looking names are never read nor indexed", async () => {
    for (const n of [".env", ".env.local", "server.pem", "my.key", "cert.p12", "cert.pfx", "id_rsa", "id_rsa.pub", "id_ed25519", "login.keychain-db", "My Passwords.txt", "client_secret.json", "credentials.txt", "PASSWORD.md"]) {
      assert.equal(looksSecret("/r", `/r/sub/${n}`), true, n);
    }
    assert.equal(looksSecret("/r", "/r/secretary/notes.txt"), true); // directory segments count too
    assert.equal(looksSecret("/my-files/Docs", "/my-files/Docs/report.txt"), false);
    assert.equal(looksSecret("/secret-root", "/secret-root/report.txt"), false); // only below the indexed folder
    const w = world({ "/my-files/Docs/ok.txt": "visible words", "/my-files/Docs/.env": "TOKEN=hunter2", "/my-files/Docs/passwords.txt": "hunter2 again", "/my-files/Docs/sub/id_rsa": "-----BEGIN hunter2" });
    const r = await update(w);
    assert.equal(r.skippedSecretNames, 3);
    assert.deepEqual(w.loads, ["/my-files/Docs/ok.txt"]);
    assert.deepEqual(paths(await search(w, "hunter2")), []);
  });

  it("unsupported types, empty text and oversize files are recorded as skipped, not errors, and not retried", async () => {
    const w = world(
      { "/my-files/Docs/pic.png": "x", "/my-files/Docs/blank.txt": " ... ", "/my-files/Docs/huge.txt": "never read", "/my-files/Docs/ok.txt": "fine text" },
      { sizes: { "/my-files/Docs/huge.txt": 30 * 1048576 } },
    );
    const r = await update(w);
    assert.equal(r.failedCount, 0);
    assert.equal(r.indexed, 1);
    assert.equal(r.skippedFiles, 3);
    assert.deepEqual(w.loads.sort(), ["/my-files/Docs/blank.txt", "/my-files/Docs/ok.txt"]);
    w.loads.length = 0;
    const again = await update(w);
    assert.equal(again.unchanged, 4);
    assert.deepEqual(w.loads, []);
  });

  it("an extraction failure is per file and non-fatal; a stable failure is recorded, a transient one is retried", async () => {
    const files = { "/my-files/Docs/ok.txt": "fine text", "/my-files/Docs/locked.txt": new Error("SQLiteError: database is locked"), "/my-files/Docs/bin.txt": new Error("not text: the file contains NUL bytes (binary)") };
    const w = world(files);
    const r = await update(w);
    assert.equal(r.indexed, 1);
    assert.equal(r.failedCount, 1);
    assert.equal(r.failed[0].path, "/my-files/Docs/locked.txt");
    assert.equal(r.skippedFiles, 1);
    assert.equal(r.partial, false);
    w.loads.length = 0;
    files["/my-files/Docs/locked.txt"] = "now readable";
    const r2 = await update(w);
    assert.deepEqual(w.loads, ["/my-files/Docs/locked.txt"]);
    assert.equal(r2.failedCount, 0);
  });

  it("requires an explicit folder, refuses '/', and is off without the env gate", async () => {
    const w = world({});
    await assert.rejects(driveContentIndex({}, {}, w.deps()), /path is required/);
    await assert.rejects(driveContentIndex({}, { path: "/" }, w.deps()), /not '\/'/);
    delete process.env.PROTON_DRIVE_CONTENT_INDEX;
    await assert.rejects(update(w), /PROTON_DRIVE_CONTENT_INDEX=1/);
    await assert.rejects(search(w, "x"), /PROTON_DRIVE_CONTENT_INDEX=1/);
  });

  it("search validates query length and limit, and says so when there is no index", async () => {
    const w = world({});
    await assert.rejects(search(w, "x".repeat(201)), /longer than 200/);
    await assert.rejects(search(w, "word", { limit: 51 }), /limit must be/);
    await assert.rejects(search(w, "   "), /non-empty/);
    await assert.rejects(search(w, "word"), /no content index yet/);
  });

  it("search honours the path prefix, the limit and drops results outside PROTON_DRIVE_REMOTE_ROOTS", async () => {
    const w = world({ "/my-files/Docs/a/x.txt": "shared term one", "/my-files/Docs/b/y.txt": "shared term two", "/my-files/Docs/ab.txt": "shared term three" });
    await update(w);
    assert.equal((await search(w, "shared term")).results.length, 3);
    assert.equal((await search(w, "shared term", { limit: 2 })).results.length, 2);
    assert.deepEqual(paths(await search(w, "shared term", { path: "/my-files/Docs/a" })), ["/my-files/Docs/a/x.txt"]); // whole segments: not ab.txt
    const allow = (p) => p.startsWith("/my-files/Docs/b/");
    const r = await search(w, "shared term", {}, { allow });
    assert.deepEqual(paths(r), ["/my-files/Docs/b/y.txt"]);
    assert.equal(r.totalMatches, 1);
  });

  it("an index of another account is refused for search and update; clear removes the file only", async () => {
    const w = world({ "/my-files/Docs/a.txt": "alpha" });
    await update(w);
    await assert.rejects(search(w, "alpha", {}, { accountKey: async () => "acct-2" }), /another Proton account/);
    await assert.rejects(update(w, {}, { accountKey: async () => "acct-2" }), /another Proton account/);
    const walkIdx = join(dir, "walk-index.json");
    writeFileSync(walkIdx, "{}", { mode: 0o600 });
    const c = await driveContentIndex({}, { action: "clear" }, w.deps());
    assert.equal(c.deleted, true);
    assert.ok(existsSync(walkIdx));
    assert.ok(!existsSync(contentIndexPath()));
    assert.equal((await driveContentIndex({}, { action: "clear" }, w.deps())).deleted, false);
    await update(w, {}, { accountKey: async () => "acct-2" }); // a fresh index for the new account works
  });

  it("a wrong key or a flipped byte fails closed for search, update and status", async () => {
    const w = world({ "/my-files/Docs/a.txt": "alpha" });
    await update(w);
    const wrong = { keys: { env: { PROTON_DRIVE_CONTENT_INDEX_KEY: HEX_B } } };
    await assert.rejects(search(w, "alpha", {}, wrong), /key is wrong or the file was modified/);
    await assert.rejects(update(w, {}, wrong), /key is wrong or the file was modified/);
    const st = await driveContentIndex({}, { action: "status" }, w.deps(wrong));
    assert.equal(st.readable, false);
    assert.match(st.error, /key is wrong/);
    assert.equal(st.documents, undefined);
    const f = contentIndexPath();
    const b = readFileSync(f);
    b[b.length - 40] ^= 0xff;
    writeFileSync(f, b);
    await assert.rejects(search(w, "alpha"), ContentIndexError);
  });

  it("size cap: stops indexing below the cap, and refuses to save an index over the cap", async () => {
    const w = world({ "/my-files/Docs/a.txt": "alpha" });
    process.env.PROTON_DRIVE_CONTENT_INDEX_MAX_MB = "0.3"; // below the 400 KB per-document margin
    const r = await update(w);
    assert.equal(r.capReached, true);
    assert.equal(r.partial, true);
    assert.equal(r.indexed, 0);
    assert.match(r.note, /size cap/);
    process.env.PROTON_DRIVE_CONTENT_INDEX_MAX_MB = "0.00005"; // ~52 bytes: not even the empty index fits
    rmSync(contentIndexPath(), { force: true });
    await assert.rejects(update(w), /would exceed .* MB/);
    assert.ok(!existsSync(contentIndexPath()));
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
  });

  it("status reports counts, folders, bytes, the key backend, never the key", async () => {
    const w = world({ "/my-files/Docs/a.txt": "alpha", "/my-files/Docs/p.png": "x" });
    const none = await driveContentIndex({}, { action: "status" }, w.deps());
    assert.equal(none.exists, false);
    assert.equal(none.plannedKeyBackend, "env");
    await update(w);
    const st = await driveContentIndex({}, { action: "status" }, w.deps());
    assert.equal(st.readable, true);
    assert.equal(st.documents, 2);
    assert.equal(st.withText, 1);
    assert.equal(st.skipped, 1);
    assert.equal(st.keyBackend, "env");
    assert.equal(st.accountMatches, true);
    assert.deepEqual(st.folders.map((f) => [f.path, f.complete]), [["/my-files/Docs", true]]);
    assert.ok(st.bytes > 0 && st.oldestIndexedAt <= st.newestIndexedAt);
    assert.ok(!JSON.stringify(st).includes(HEX_A));
    const filtered = await driveContentIndex({}, { action: "status" }, w.deps({ allow: (p) => p.startsWith("/my-files/Other") }));
    assert.equal(filtered.documents, 0);
    assert.deepEqual(filtered.folders, []);
  });

  it("status works while the feature is off (it only reports) and clear works too", async () => {
    delete process.env.PROTON_DRIVE_CONTENT_INDEX;
    const w = world({});
    const st = await driveContentIndex({}, { action: "status" }, w.deps());
    assert.equal(st.enabled, false);
    assert.equal(st.exists, false);
    assert.equal((await driveContentIndex({}, { action: "clear" }, w.deps())).deleted, false);
  });
});

// ---- key backends -----------------------------------------------------------------------------------------------------
describe("content index key", () => {
  const ACCT = "0123456789abcdef0123456789abcdef";

  /** A stand-in for /usr/bin/security (macOS) or secret-tool (Linux) that keeps items in a JSON file and logs every call. */
  function shim(kind, { failStore = false, findFail = null } = {}) {
    const bin = join(dir, `${kind}-shim.mjs`);
    const log = join(dir, `${kind}.log`);
    const store = join(dir, `${kind}.json`);
    writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const kind = ${JSON.stringify(kind)};
const items = existsSync(${JSON.stringify(store)}) ? JSON.parse(readFileSync(${JSON.stringify(store)}, "utf8")) : {};
let stdin = "";
if (!process.stdin.isTTY) for await (const c of process.stdin) stdin += c;
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, stdin }) + "\\n");
const flag = (a, f) => a[a.indexOf(f) + 1];
const save = () => writeFileSync(${JSON.stringify(store)}, JSON.stringify(items));
const findFail = ${JSON.stringify(findFail)};
const failFind = () => { if (!findFail) return; if (findFail.kill) process.kill(process.pid, "SIGKILL"); process.stderr.write(findFail.stderr ?? ""); process.exit(findFail.exit); };
if (kind === "security") {
  if (argv[0] === "find-generic-password") {
    failFind();
    const v = items[flag(argv, "-s") + "/" + flag(argv, "-a")];
    if (v === undefined) { process.stderr.write("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n"); process.exit(44); }
    process.stdout.write(v + "\\n");
  } else if (argv[0] === "-i") {
    for (const line of stdin.split("\\n").filter(Boolean)) {
      const t = line.split(" ");
      if (t[0] === "add-generic-password" && ${failStore ? "false" : "true"}) { const k = flag(t, "-s") + "/" + flag(t, "-a"); if (items[k] === undefined) items[k] = flag(t, "-w"); }
    }
    save();
  } else if (argv[0] === "delete-generic-password") {
    const k = flag(argv, "-s") + "/" + flag(argv, "-a");
    if (items[k] === undefined) process.exit(44);
    delete items[k]; save();
  } else process.exit(2);
} else {
  if (argv[0] === "lookup") { failFind(); const v = items[argv[2] + "/" + argv[4]]; if (v === undefined) process.exit(1); process.stdout.write(v); }
  else if (argv[0] === "store") { ${failStore ? "process.stderr.write('no dbus\\\\n'); process.exit(1);" : ""} items[argv[3] + "/" + argv[5]] = stdin; save(); }
  else if (argv[0] === "clear") { delete items[argv[2] + "/" + argv[4]]; save(); }
  else process.exit(2);
}
`, { mode: 0o755 });
    return { bin, calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []), items: () => (existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : {}) };
  }

  it("macOS: generates a key, stores it through `security -i` stdin, and the secret is never in any argv", async () => {
    const s = shim("security");
    const o = { create: true, platform: "darwin", env: {}, securityBin: s.bin };
    const k = await getContentKey(ACCT, o);
    assert.equal(k.backend, "macos-keychain");
    assert.equal(k.key.length, 32);
    const stored = Object.values(s.items())[0];
    assert.equal(stored, k.key.toString("hex"));
    for (const c of s.calls()) assert.ok(!c.argv.join(" ").includes(stored), `secret in argv: ${c.argv}`);
    const add = s.calls().find((c) => c.argv[0] === "-i");
    assert.deepEqual(add.argv, ["-i"]);
    assert.match(add.stdin, new RegExp(`^add-generic-password -s proton-drive-mcp-content-index -a ${ACCT} -l proton-drive-mcp-content-index -w ${stored}\\n$`));
    // second call reads the same key, with no further add
    const again = await getContentKey(ACCT, o);
    assert.ok(again.key.equals(k.key));
    assert.equal(s.calls().filter((c) => c.argv[0] === "-i").length, 1);
    // create:false on an unknown account returns undefined and stores nothing
    assert.equal(await getContentKey("f".repeat(32), { ...o, create: false }), undefined);
    assert.equal(Object.keys(s.items()).length, 1);
  });

  it("macOS: PROTON_DRIVE_KEYCHAIN_SERVICE renames the entry, and an unsafe name is refused (stdin injection)", async () => {
    const s = shim("security");
    await getContentKey(ACCT, { create: true, platform: "darwin", env: { PROTON_DRIVE_KEYCHAIN_SERVICE: "pdmcp-test.svc" }, securityBin: s.bin });
    assert.deepEqual(Object.keys(s.items()), [`pdmcp-test.svc/${ACCT}`]);
    for (const bad of ["a b", "x\ndelete-generic-password", 'q"uote', "a;b", "x".repeat(101)]) {
      await assert.rejects(getContentKey(ACCT, { create: true, platform: "darwin", env: { PROTON_DRIVE_KEYCHAIN_SERVICE: bad }, securityBin: s.bin }), ContentKeyError, bad);
    }
    await assert.rejects(getContentKey("a b\nx", { create: true, platform: "darwin", env: {}, securityBin: s.bin }), /bad keychain account/);
  });

  it("macOS: when the item was not stored the read-back catches it and points to the env key", async () => {
    const s = shim("security", { failStore: true });
    await assert.rejects(getContentKey(ACCT, { create: true, platform: "darwin", env: {}, securityBin: s.bin }), /could not be stored.*PROTON_DRIVE_CONTENT_INDEX_KEY/);
  });

  it("Linux: secret-tool store reads the secret from stdin, lookup returns it, argv has no secret", async () => {
    const s = shim("secret-tool");
    const o = { create: true, platform: "linux", env: {}, secretToolBin: s.bin };
    const k = await getContentKey(ACCT, o);
    assert.equal(k.backend, "secret-tool");
    const stored = Object.values(s.items())[0];
    assert.equal(stored, k.key.toString("hex"));
    for (const c of s.calls()) assert.ok(!c.argv.join(" ").includes(stored));
    assert.equal(s.calls().find((c) => c.argv[0] === "store").stdin, stored);
    assert.ok((await getContentKey(ACCT, o)).key.equals(k.key));
    await assert.rejects(getContentKey(ACCT, { ...o, secretToolBin: join(dir, "does-not-exist") }), /No safe place to keep the content index key.*not found/);
  });

  it("Linux: a failing secret-tool gives an actionable error", async () => {
    const s = shim("secret-tool", { failStore: true });
    await assert.rejects(getContentKey(ACCT, { create: true, platform: "linux", env: {}, secretToolBin: s.bin }), /PROTON_DRIVE_CONTENT_INDEX_KEY/);
  });

  it("the env key is the only fallback: used exclusively, validated, and Windows refuses without it", async () => {
    const s = shim("security");
    const k = await getContentKey(ACCT, { create: true, platform: "darwin", env: { PROTON_DRIVE_CONTENT_INDEX_KEY: HEX_A }, securityBin: s.bin });
    assert.equal(k.backend, "env");
    assert.equal(k.key.toString("hex"), HEX_A);
    assert.deepEqual(s.calls(), []); // the keychain is never touched
    for (const bad of ["short", "zz".repeat(32), "ab".repeat(31), "ab".repeat(33)]) {
      await assert.rejects(getContentKey(ACCT, { create: false, platform: "darwin", env: { PROTON_DRIVE_CONTENT_INDEX_KEY: bad }, securityBin: s.bin }), /64 hex characters/, bad);
    }
    await assert.rejects(getContentKey(ACCT, { create: true, platform: "win32", env: {} }), (e) => e instanceof ContentKeyError && /win32.*PROTON_DRIVE_CONTENT_INDEX_KEY/s.test(e.message));
    assert.equal((await getContentKey(ACCT, { create: true, platform: "win32", env: { PROTON_DRIVE_CONTENT_INDEX_KEY: HEX_B } })).backend, "env");
    assert.equal(plannedBackend({ platform: "win32", env: {} }), "none");
    assert.equal(plannedBackend({ platform: "darwin", env: {} }), "macos-keychain");
    assert.equal(plannedBackend({ platform: "linux", env: {} }), "secret-tool");
    assert.equal(plannedBackend({ platform: "linux", env: { PROTON_DRIVE_CONTENT_INDEX_KEY: HEX_A } }), "env");
  });

  it("Linux: exit 1 is 'not found' only with empty stderr and no kill: a D-Bus failure or a kill is an error and never generates a new key", async () => {
    const dbus = shim("secret-tool", { findFail: { exit: 1, stderr: "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n" } });
    for (const create of [false, true]) {
      await assert.rejects(getContentKey(ACCT, { create, platform: "linux", env: {}, secretToolBin: dbus.bin }), (e) => e instanceof ContentKeyError && /D-Bus/.test(e.message), `create ${create}`);
    }
    assert.ok(!dbus.calls().some((c) => c.argv[0] === "store"));
    const killed = shim("secret-tool", { findFail: { kill: true } });
    for (const create of [false, true]) {
      await assert.rejects(getContentKey(ACCT, { create, platform: "linux", env: {}, secretToolBin: killed.bin }), (e) => e instanceof ContentKeyError && /killed or timed out/.test(e.message), `create ${create}`);
    }
    assert.ok(!killed.calls().some((c) => c.argv[0] === "store"));
    const missing = shim("secret-tool", { findFail: { exit: 1, stderr: "" } }); // the documented "no such item"
    assert.equal(await getContentKey(ACCT, { create: false, platform: "linux", env: {}, secretToolBin: missing.bin }), undefined);
  });

  it("macOS: only exit 44 means 'item not found'; any other failure or a kill is an error", async () => {
    const gone = shim("security", { findFail: { exit: 44, stderr: "The specified item could not be found in the keychain.\n" } });
    assert.equal(await getContentKey(ACCT, { create: false, platform: "darwin", env: {}, securityBin: gone.bin }), undefined);
    for (const findFail of [{ exit: 1, stderr: "" }, { exit: 36, stderr: "User interaction is not allowed.\n" }, { exit: 1, stderr: "The specified item could not be found in the keychain.\n" }, { kill: true }]) {
      const s = shim("security", { findFail });
      for (const create of [false, true]) {
        await assert.rejects(getContentKey(ACCT, { create, platform: "darwin", env: {}, securityBin: s.bin }), ContentKeyError, JSON.stringify(findFail));
      }
      assert.ok(!s.calls().some((c) => c.argv[0] === "-i"), "no new key stored");
    }
  });

  it("update refuses to generate a new key when an index file exists but its key is missing", async () => {
    delete process.env.PROTON_DRIVE_CONTENT_INDEX_KEY;
    const s = shim("security");
    const keys = { platform: "darwin", env: {}, securityBin: s.bin };
    const w = world({ "/my-files/Docs/a.txt": "keychain backed words" });
    await update(w, {}, { keys });
    writeFileSync(join(dir, "security.json"), "{}"); // key lost
    const before = readFileSync(contentIndexPath());
    await assert.rejects(update(w, {}, { keys }), (e) => e instanceof ContentKeyError && /key for the content index was not found/.test(e.message));
    assert.deepEqual(s.items(), {}); // nothing generated
    assert.ok(readFileSync(contentIndexPath()).equals(before)); // the old file is untouched
  });

  it("clear deletes the keychain item too (macOS): argv only, a missing item is not an error", async () => {
    delete process.env.PROTON_DRIVE_CONTENT_INDEX_KEY;
    const s = shim("security");
    const keys = { platform: "darwin", env: {}, securityBin: s.bin };
    const w = world({ "/my-files/Docs/a.txt": "words" });
    await update(w, {}, { keys });
    assert.equal(Object.keys(s.items()).length, 1);
    const [item] = Object.keys(s.items());
    const r = await driveContentIndex({}, { action: "clear" }, w.deps({ keys }));
    assert.equal(r.deleted, true);
    assert.equal(r.keyRemoved, true);
    assert.match(r.note, /old copies|backup/i);
    assert.deepEqual(s.items(), {});
    const del = s.calls().find((c) => c.argv[0] === "delete-generic-password");
    assert.deepEqual(del.argv, ["delete-generic-password", "-s", "proton-drive-mcp-content-index", "-a", item.split("/")[1]]);
    // item already gone while the file exists: fine, keyRemoved false
    await update(w, {}, { keys });
    writeFileSync(join(dir, "security.json"), "{}");
    const r2 = await driveContentIndex({}, { action: "clear" }, w.deps({ keys }));
    assert.equal(r2.deleted, true);
    assert.equal(r2.keyRemoved, false);
  });

  it("clear deletes the Secret Service item (Linux) with the same attributes", async () => {
    delete process.env.PROTON_DRIVE_CONTENT_INDEX_KEY;
    const s = shim("secret-tool");
    const keys = { platform: "linux", env: {}, secretToolBin: s.bin };
    const w = world({ "/my-files/Docs/a.txt": "words" });
    await update(w, {}, { keys });
    const [item] = Object.keys(s.items());
    const r = await driveContentIndex({}, { action: "clear" }, w.deps({ keys }));
    assert.equal(r.keyRemoved, true);
    assert.deepEqual(s.items(), {});
    assert.deepEqual(s.calls().find((c) => c.argv[0] === "clear").argv, ["clear", "service", "proton-drive-mcp-content-index", "account", item.split("/")[1]]);
  });

  it("clear with the key from PROTON_DRIVE_CONTENT_INDEX_KEY says it cannot rotate it", async () => {
    const s = shim("security");
    const w = world({ "/my-files/Docs/a.txt": "words" });
    await update(w);
    const r = await driveContentIndex({}, { action: "clear" }, w.deps({ keys: { platform: "darwin", env: { PROTON_DRIVE_CONTENT_INDEX_KEY: HEX_A }, securityBin: s.bin } }));
    assert.equal(r.deleted, true);
    assert.equal(r.keyRemoved, false);
    assert.match(r.note, /PROTON_DRIVE_CONTENT_INDEX_KEY.*cannot|cannot.*PROTON_DRIVE_CONTENT_INDEX_KEY/s);
    assert.deepEqual(s.calls(), []);
  });

  it("end to end through the service with the keychain shim: index, restart-like reload, search", async () => {
    delete process.env.PROTON_DRIVE_CONTENT_INDEX_KEY;
    const s = shim("security");
    const keys = { platform: "darwin", env: {}, securityBin: s.bin };
    const w = world({ "/my-files/Docs/a.txt": "keychain backed words" });
    const r = await update(w, {}, { keys });
    assert.equal(r.keyBackend, "macos-keychain");
    assert.deepEqual(paths(await search(w, "keychain", {}, { keys })), ["/my-files/Docs/a.txt"]);
    for (const c of s.calls()) assert.ok(!c.argv.join(" ").includes(Object.values(s.items())[0]));
    // the key is gone from the keychain: the existing index is unreadable, with an actionable message
    writeFileSync(join(dir, "security.json"), "{}");
    await assert.rejects(search(w, "keychain", {}, { keys }), /key for the content index was not found/);
  });
});

// ---- server integration: guards, audit -------------------------------------------------------------------------------
describe("server: guards and audit", () => {
  const readLog = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  async function withServer(env, fn) {
    const sb = makeSandbox();
    const c = await startServer("json", sb, { PROTON_DRIVE_INDEX_DIR: dir, ...env });
    try { return await fn(c, sb); } finally { await c.close(); sb.cleanup(); }
  }

  it("both tools are listed, available in readonly mode, and refuse politely while the feature is off", async () => {
    await withServer({ PROTON_DRIVE_MODE: "readonly" }, async (c) => {
      const names = (await c.listTools()).map((t) => t.name);
      assert.ok(names.includes("drive_content_index") && names.includes("drive_search_content"));
      const st = await c.call("drive_content_index", { action: "status" });
      assert.equal(st.isError, false);
      assert.equal(JSON.parse(st.text).enabled, false);
      const s = await c.call("drive_search_content", { query: "anything" });
      assert.equal(s.isError, true);
      assert.match(s.text, /PROTON_DRIVE_CONTENT_INDEX=1/);
      assert.doesNotMatch(s.text, /readonly mode/); // refused by the feature gate, not by readonly mode
      const u = await c.call("drive_content_index", { path: "/my-files/Docs" });
      assert.match(u.text, /PROTON_DRIVE_CONTENT_INDEX=1/);
    });
  });

  it("update without a path and unknown arguments are rejected by the schema/service", async () => {
    await withServer({ PROTON_DRIVE_CONTENT_INDEX: "1", PROTON_DRIVE_CONTENT_INDEX_KEY: HEX_A }, async (c) => {
      assert.match((await c.call("drive_content_index", {})).text, /path is required/);
      assert.match((await c.call("drive_content_index", { path: "/my-files/x", bogus: 1 })).text, /Unknown argument/);
      assert.match((await c.call("drive_search_content", {})).text, /Missing required argument 'query'/);
      assert.match((await c.call("drive_search_content", { query: "x".repeat(201) })).text, /longer than 200/);
    });
  });

  it("PROTON_DRIVE_REMOTE_ROOTS: a path outside the roots is refused for both tools; status and the in-root path pass", async () => {
    await withServer({ PROTON_DRIVE_CONTENT_INDEX: "1", PROTON_DRIVE_CONTENT_INDEX_KEY: HEX_A, PROTON_DRIVE_REMOTE_ROOTS: "/my-files/A" }, async (c) => {
      for (const [tool, args] of [["drive_content_index", { path: "/my-files/B" }], ["drive_search_content", { query: "x", path: "/my-files/B" }], ["drive_content_index", { path: "/my-files/AB" }]]) {
        const r = await c.call(tool, args);
        assert.equal(r.isError, true);
        assert.match(r.text, /outside PROTON_DRIVE_REMOTE_ROOTS/, tool);
      }
      assert.equal((await c.call("drive_content_index", { action: "status" })).isError, false);
      assert.doesNotMatch((await c.call("drive_search_content", { query: "x", path: "/my-files/A/sub" })).text, /outside PROTON_DRIVE_REMOTE_ROOTS/);
    });
  });

  it("the audit log keeps the folder and counts but never the query text", async () => {
    const sb = makeSandbox();
    const log = join(sb.dir, "audit.jsonl");
    const c = await startServer("json", sb, { PROTON_DRIVE_INDEX_DIR: dir, PROTON_DRIVE_CONTENT_INDEX: "1", PROTON_DRIVE_CONTENT_INDEX_KEY: HEX_A, PROTON_DRIVE_AUDIT_LOG: log });
    try {
      await c.call("drive_search_content", { query: "my confidential merger term", path: "/my-files/Docs", limit: 5 });
      await c.call("drive_content_index", { path: "/my-files/Docs", maxFiles: 7, action: "update" });
    } finally { await c.close(); }
    try {
      const raw = readFileSync(log, "utf8");
      assert.ok(!raw.includes("confidential") && !raw.includes("merger"));
      const [s, u] = readLog(log);
      assert.equal(s.tool, "drive_search_content");
      assert.deepEqual(s.args, { query: "[redacted]", queryLength: 27, path: "/my-files/Docs", limit: 5 });
      assert.equal(u.tool, "drive_content_index");
      assert.deepEqual(u.args, { path: "/my-files/Docs", maxFiles: 7, action: "update" });
    } finally { sb.cleanup(); }
  });

  it("redactArgs replaces only the search query, even when it is long, and leaves other tools alone", () => {
    const declared = { query: {}, path: {}, limit: {} };
    assert.deepEqual(redactArgs("drive_search_content", { query: "x".repeat(150_000), limit: 3 }, declared), { query: "[redacted]", queryLength: 150_000, limit: 3 });
    assert.deepEqual(redactArgs("drive_search", { query: "name" }, declared), { query: "name" });
  });

  it("proton-drive-cli index clear also deletes the encrypted content index", async () => {
    const sb = makeSandbox();
    try {
      mkdirSync(dir, { recursive: true });
      const f = join(dir, SEALED_FILE_NAME);
      writeFileSync(f, "x", { mode: 0o600 });
      const out = await new Promise((resolve, reject) => execFile(process.execPath, [DIST_CLI, "index", "clear"], { env: fakeEnv("json", sb, { PROTON_DRIVE_INDEX_DIR: dir }) }, (e, so) => (e ? reject(e) : resolve(so))));
      assert.equal(JSON.parse(out).contentIndexDeleted, true);
      assert.ok(!existsSync(f));
    } finally { sb.cleanup(); }
  });
});

// ---- review fixes ----------------------------------------------------------------------------------------------------
describe("content index review fixes", () => {
  it("credential-looking names are skipped; ordinary names are not", () => {
    for (const n of ["production.env", "prod.env.txt", ".env", ".env.local", ".npmrc", ".netrc", ".pgpass", ".htpasswd", ".git-credentials", ".pypirc", ".dockercfg", "id_ecdsa", "id_dsa", "id_rsa", "id_ed25519.pub", "service-account.json", "api_keys.txt", "API-KEY.md", "apikey.txt", "token.txt", "tokenizer-paper.pdf", "kubeconfig.yaml", "Passwort.txt", "hasło.txt", "HASŁO.txt", "haslo.docx", "passwd", "private_key.txt", "PrivateKey.txt", "vault.kdbx", "app.keystore", "app.jks", "a.p12", "a.pfx", "cert.pem", "my.key", "pub.asc", "backup.gpg", "client_secret.json", "credentials.txt", "login.keychain-db"]) {
      assert.equal(looksSecret("/r", `/r/sub/${n}`), true, n);
    }
    for (const n of ["report.txt", "environment-notes.md", "envelope.pdf", "keynote.md", "monkey.txt", "ascii.txt", "invoice.docx", "notes.vars.md"]) {
      assert.equal(looksSecret("/r", `/r/${n}`), false, n);
    }
  });

  it("the size estimate covers what a document really adds to the file", () => {
    const d = new ContentData();
    const tf = new Map();
    for (let i = 0; i < 5000; i++) tf.set(`term${String(i).padStart(6, "x")}`, 1 + (i % 7));
    d.addDoc({ path: "/my-files/Docs/a.txt", sig: "1|2|3", at: 1, tokens: 5000, excerpt: makeExcerpt("lorem ipsum ".repeat(500)) }, tf);
    let actual = 0;
    serializeData(d, (s) => { actual += Buffer.byteLength(s); });
    assert.ok(d.bytes >= actual, `estimate ${d.bytes} < actual ${actual}`);
    assert.ok(d.bytes < actual * 2, `estimate ${d.bytes} is more than twice the actual ${actual}`);
  });

  it("the default size cap is 200 MB and PROTON_DRIVE_CONTENT_INDEX_MAX_MB overrides it", async () => {
    const { contentIndexMaxBytes } = await import("../dist/services/contentIndex.js");
    assert.equal(contentIndexMaxBytes(), 200 * 1024 * 1024);
    process.env.PROTON_DRIVE_CONTENT_INDEX_MAX_MB = "7";
    assert.equal(contentIndexMaxBytes(), 7 * 1024 * 1024);
  });

  it("a save over the cap drops the newest documents, saves the rest and reports it instead of failing the whole update", async () => {
    // Control characters in a path are JSON-escaped to 6 bytes each: the estimate undercounts, the real file does not fit.
    const files = {};
    for (let i = 0; i < 40; i++) files[`/my-files/Docs/${"\u0001".repeat(3000)}${i}.txt`] = `alpha beta word${i}`;
    const w = world(files);
    process.env.PROTON_DRIVE_CONTENT_INDEX_MAX_MB = "0.6";
    const r = await update(w);
    assert.equal(r.partial, true);
    assert.ok(r.droppedForSize > 0 && r.droppedForSize < 40, `dropped ${r.droppedForSize}`);
    assert.equal(r.documents, 40 - r.droppedForSize);
    assert.equal(r.indexed, 40 - r.droppedForSize);
    assert.match(r.note, /size cap|left out/);
    assert.ok(statSync(contentIndexPath()).size <= 0.6 * 1024 * 1024);
    const hits = paths(await search(w, "alpha beta", { limit: 50 }));
    assert.equal(hits.length, 40 - r.droppedForSize);
    assert.ok(hits.some((p) => p.endsWith("\u00010.txt")));
    assert.ok(!hits.some((p) => p.endsWith("\u000139.txt")));
    assert.equal((await driveContentIndex({}, { action: "status" }, w.deps())).folders[0].complete, false);
    // with room, the next call indexes what was dropped and re-reads nothing else
    process.env.PROTON_DRIVE_CONTENT_INDEX_MAX_MB = "5";
    w.loads.length = 0;
    const r2 = await update(w);
    assert.equal(r2.indexed, r.droppedForSize);
    assert.equal(r2.unchanged, 40 - r.droppedForSize);
    assert.equal(r2.droppedForSize, undefined);
  });

  it("clear waits for an in-flight update, so the update cannot recreate the file afterwards", async () => {
    const w = world({ "/my-files/Docs/a.txt": "alpha" });
    let release;
    const gate = new Promise((res) => { release = res; });
    let entered;
    const started = new Promise((res) => { entered = res; });
    const slow = { load: async () => { entered(); await gate; return { text: "alpha" }; } };
    const up = update(w, {}, slow);
    await started;
    const cl = driveContentIndex({}, { action: "clear" }, w.deps());
    await new Promise((res) => setTimeout(res, 30));
    release();
    await up;
    const r = await cl;
    assert.equal(r.deleted, true); // it saw the file the update wrote
    assert.ok(!existsSync(contentIndexPath()));
  });

  it("status checks the account before decrypting anything and says so", async () => {
    const w = world({ "/my-files/Docs/a.txt": "alpha" });
    await update(w);
    for (const extra of [{}, { keys: { env: { PROTON_DRIVE_CONTENT_INDEX_KEY: HEX_B } } }]) { // even with a wrong key it is the account that is reported
      const st = await driveContentIndex({}, { action: "status" }, w.deps({ accountKey: async () => "acct-2", ...extra }));
      assert.equal(st.readable, false);
      assert.equal(st.accountMatches, false);
      assert.match(st.error, /index belongs to another account/);
      assert.equal(st.folders, undefined);
      assert.equal(st.documents, undefined);
    }
    const ok = await driveContentIndex({}, { action: "status" }, w.deps());
    assert.equal(ok.accountMatches, true);
    assert.equal(ok.folders.length, 1);
  });

  it("a file the listing gives no size, time or hash for is treated as changed and re-read every update", async () => {
    const w = world({ "/my-files/Docs/a.txt": "alpha" });
    const bare = { walk: walkOf([node("/my-files/Docs/a.txt", { size: undefined, mtime: undefined })]) };
    await update(w, {}, bare);
    const r = await update(w, {}, bare);
    assert.equal(r.unchanged, 0);
    assert.equal(r.indexed, 1);
    assert.deepEqual(w.loads, ["/my-files/Docs/a.txt", "/my-files/Docs/a.txt"]);
    assert.equal((await update(w)).documents, 1); // with a signature it settles, still one document
  });

  it("surfaces the listing age, and forces a fresh walk when a cached listing is older than 60 s", async () => {
    const w = world({ "/my-files/Docs/a.txt": "alpha" });
    const calls = [];
    const walk = (age) => async (_d, root, opts) => {
      calls.push(opts);
      return { root, nodes: w.nodes(), complete: true, callsMade: 0, skipped: [], fromCache: !opts.refresh, ageMs: opts.refresh ? 0 : age };
    };
    const fresh = await update(w, {}, { walk: walk(30_000) });
    assert.equal(calls.length, 1);
    assert.equal(fresh.fromCache, true);
    assert.equal(fresh.listingAgeMs, 30_000);
    assert.equal(fresh.listingRefreshed, undefined);
    calls.length = 0;
    const old = await update(w, {}, { walk: walk(120_000) });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].refresh, undefined);
    assert.equal(calls[1].refresh, true);
    assert.equal(old.fromCache, false);
    assert.equal(old.listingAgeMs, 0);
    assert.equal(old.listingRefreshed, true);
  });

  it("with PROTON_DRIVE_REMOTE_ROOTS, a search without a path and the status folder list only show what is inside the roots", async () => {
    const w = world({ "/my-files/A/x.txt": "shared term", "/my-files/B/y.txt": "shared term", "/my-files/AB/z.txt": "shared term" });
    for (const root of ["/my-files/A", "/my-files/B", "/my-files/AB"]) await driveContentIndex({}, { path: root }, w.deps());
    const allow = (p) => p === "/my-files/A" || p.startsWith("/my-files/A/");
    const r = await driveSearchContent({}, { query: "shared term" }, w.deps({ allow }));
    assert.deepEqual(paths(r), ["/my-files/A/x.txt"]);
    assert.equal(r.totalMatches, 1);
    const st = await driveContentIndex({}, { action: "status" }, w.deps({ allow }));
    assert.deepEqual(st.folders.map((f) => f.path), ["/my-files/A"]);
    assert.equal(st.documents, 1);
    assert.equal((await driveContentIndex({}, { action: "status" }, w.deps())).folders.length, 3);
  });
});
