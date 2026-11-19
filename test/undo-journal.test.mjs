import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { resolveUndoDir, undoEnabled, createUndoJournal } from "../dist/utils/undoJournal.js";

const JOURNAL_URL = new URL("../dist/utils/undoJournal.js", import.meta.url).href;
const DAY = 86_400_000;
const ID_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/;
const posix = process.platform !== "win32";

const item = (n, extra = {}) => ({
  uid: `uid-${n}`, parentUid: "parent-1", from: `/my-files/docs/f${n}.txt`, name: `f${n}.txt`, size: 10 + n, restorable: true, ...extra,
});
const batchArgs = (n = 2, over = {}) => ({
  tool: "drive_bulk_trash", kind: "trash", items: Array.from({ length: n }, (_, i) => item(i)), ...over,
});

describe("resolveUndoDir / undoEnabled", () => {
  it("honours PROTON_DRIVE_UNDO_DIR", () => {
    assert.equal(resolveUndoDir({ PROTON_DRIVE_UNDO_DIR: "/x/y" }, "darwin", "/h"), "/x/y");
  });
  it("macOS default is undo/ next to approvals/ under ~/Library/Caches", () => {
    assert.equal(resolveUndoDir({}, "darwin", "/h"), "/h/Library/Caches/proton-drive-mcp/undo");
  });
  it("elsewhere uses XDG_CACHE_HOME, then ~/.cache", () => {
    assert.equal(resolveUndoDir({ XDG_CACHE_HOME: "/c" }, "linux", "/h"), "/c/proton-drive-mcp/undo");
    assert.equal(resolveUndoDir({}, "linux", "/h"), "/h/.cache/proton-drive-mcp/undo");
  });
  it("ignores a blank override", () => {
    assert.equal(resolveUndoDir({ PROTON_DRIVE_UNDO_DIR: "  " }, "linux", "/h"), "/h/.cache/proton-drive-mcp/undo");
  });
  it("PROTON_DRIVE_UNDO=0 disables; unset or 1 enables", () => {
    assert.equal(undoEnabled({ PROTON_DRIVE_UNDO: "0" }), false);
    assert.equal(undoEnabled({ PROTON_DRIVE_UNDO: " 0 " }), false);
    assert.equal(undoEnabled({}), true);
    assert.equal(undoEnabled({ PROTON_DRIVE_UNDO: "1" }), true);
  });
});

describe("undo journal", () => {
  let base, dir, t, j;
  const mk = (extra = {}) => createUndoJournal({ dir, account: "acct-A", now: () => t, ...extra });

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "undojournal-"));
    dir = join(base, "undo");
    t = 1_700_000_000_000;
    j = mk();
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  it("begin writes a pending batch with the documented shape and a well-formed id", async () => {
    const r = j.begin(batchArgs(2));
    assert.match(r.id, ID_RE);
    const rec = JSON.parse(await readFile(join(dir, `${r.id}.json`), "utf8"));
    assert.deepEqual(rec, {
      v: 1, id: r.id, account: "acct-A", createdAt: t, tool: "drive_bulk_trash", kind: "trash", status: "pending",
      items: batchArgs(2).items,
    });
    assert.deepEqual(j.get(r.id), rec);
  });

  it("get accepts lower case and surrounding spaces", () => {
    const { id } = j.begin(batchArgs(1));
    assert.equal(j.get(` ${id.toLowerCase()} `).id, id);
  });

  it("begin rejects bad input before touching the disk", async () => {
    assert.throws(() => j.begin({ ...batchArgs(1), kind: "delete" }), /kind/);
    assert.throws(() => j.begin({ ...batchArgs(1), items: [] }), /at least one/);
    assert.throws(() => j.begin({ ...batchArgs(1), items: [{ uid: "", from: "/a", name: "a", restorable: true }] }), /malformed/);
    assert.throws(() => j.begin({ ...batchArgs(1), items: [{ uid: "u", from: "/a", name: "a" }] }), /malformed/);
    assert.throws(() => j.begin({ ...batchArgs(1), tool: "" }), /tool/);
    await assert.rejects(stat(dir), { code: "ENOENT" });
  });

  it("begin keeps only the known item fields", () => {
    const { id } = j.begin({ ...batchArgs(0), items: [{ ...item(1), junk: "x", to: "/trash/f1.txt", reason: "r" }] });
    assert.deepEqual(Object.keys(j.get(id).items[0]).sort(), ["from", "name", "parentUid", "reason", "restorable", "size", "to", "uid"]);
  });

  it("requires an account key", () => {
    assert.throws(() => createUndoJournal({ dir, account: "" }), /account/);
  });

  describe("permissions", { skip: !posix }, () => {
    it("folders are 0700 and records 0600, even under a loose umask or a pre-existing wide folder", async () => {
      await mkdir(dir, { mode: 0o755 });
      const { id } = j.begin(batchArgs(1));
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
      assert.equal((await stat(join(dir, "tmp"))).mode & 0o777, 0o700);
      assert.equal((await stat(join(dir, `${id}.json`))).mode & 0o777, 0o600);
      j.complete(id, { status: "applied" });
      assert.equal((await stat(join(dir, `${id}.json`))).mode & 0o777, 0o600);
      j.markUndone(id);
      assert.equal((await stat(join(dir, `${id}.json`))).mode & 0o777, 0o600);
    });

    it("leaves no temp files behind", async () => {
      const { id } = j.begin(batchArgs(1));
      j.complete(id, { status: "applied" });
      j.markUndone(id);
      assert.deepEqual(await readdir(join(dir, "tmp")), []);
    });
  });

  describe("state transitions", () => {
    it("pending -> applied -> undone; a second markUndone is refused", () => {
      const { id } = j.begin(batchArgs(2));
      assert.equal(j.get(id).status, "pending");
      assert.equal(j.complete(id, { status: "applied" }), true);
      assert.equal(j.get(id).status, "applied");
      assert.equal(j.get(id).items.length, 2);
      assert.equal(j.markUndone(id), true);
      assert.equal(j.get(id).status, "undone");
      assert.equal(j.markUndone(id), false, "second undo refused");
      assert.equal(j.markUndone(id, "partial"), false, "cannot reopen an undone batch");
      assert.equal(j.get(id).status, "undone");
    });

    it("complete is only valid once, from pending", () => {
      const { id } = j.begin(batchArgs(2));
      assert.equal(j.complete(id, { status: "applied" }), true);
      assert.equal(j.complete(id, { status: "applied" }), false);
    });

    it("complete with succeededUids keeps only those and forces partial when some failed", () => {
      const { id } = j.begin(batchArgs(3));
      assert.equal(j.complete(id, { succeededUids: ["uid-0", "uid-2", "uid-unknown"], status: "applied" }), true);
      const b = j.get(id);
      assert.equal(b.status, "partial");
      assert.deepEqual(b.items.map((i) => i.uid), ["uid-0", "uid-2"]);
    });

    it("complete with every uid succeeded keeps status applied", () => {
      const { id } = j.begin(batchArgs(2));
      j.complete(id, { succeededUids: ["uid-0", "uid-1"], status: "applied" });
      assert.equal(j.get(id).status, "applied");
    });

    it("complete with no succeeded item removes the batch (nothing to undo)", async () => {
      const { id } = j.begin(batchArgs(2));
      assert.equal(j.complete(id, { succeededUids: [], status: "partial" }), true);
      assert.equal(j.get(id), null);
      assert.deepEqual(j.list(), []);
      assert.equal((await readdir(dir)).filter((n) => n.endsWith(".json")).length, 0);
    });

    it("markUndone(partial) can be followed by a final markUndone", () => {
      const { id } = j.begin(batchArgs(2));
      j.complete(id, { status: "applied" });
      assert.equal(j.markUndone(id, "partial"), true);
      assert.equal(j.get(id).status, "partial");
      assert.equal(j.markUndone(id), true);
      assert.equal(j.get(id).status, "undone");
    });

    it("a crashed batch stays pending and can still be marked undone (reconcile path)", () => {
      const { id } = j.begin(batchArgs(1));
      assert.equal(j.markUndone(id), true);
    });

    it("unknown ids return null / false", () => {
      assert.equal(j.get("ABCD-2345"), null);
      assert.equal(j.markUndone("ABCD-2345"), false);
      assert.equal(j.complete("ABCD-2345", { status: "applied" }), false);
    });

    it("rejects an invalid status argument", () => {
      const { id } = j.begin(batchArgs(1));
      assert.throws(() => j.complete(id, { status: "undone" }), /applied or partial/);
      assert.throws(() => j.markUndone(id, "applied"), /undone or partial/);
    });
  });

  describe("list", () => {
    it("is newest first and has no file names", () => {
      const ids = [];
      for (let i = 0; i < 3; i++) {
        t += 1000;
        ids.push(j.begin(batchArgs(i + 1, { tool: `tool${i}` })).id);
      }
      const l = j.list();
      assert.deepEqual(l.map((x) => x.id), [...ids].reverse());
      assert.deepEqual(l[0], { id: ids[2], createdAt: t, tool: "tool2", kind: "trash", status: "pending", itemCount: 3 });
      const text = JSON.stringify(l);
      assert.ok(!text.includes("f0.txt") && !text.includes("/my-files"));
    });

    it("is empty and creates nothing when the folder does not exist", async () => {
      assert.deepEqual(j.list(), []);
      assert.equal(j.get("ABCD-2345"), null);
      assert.equal(j.purge(), 0);
      await assert.rejects(stat(dir), { code: "ENOENT" });
    });
  });

  describe("retention", () => {
    it("drops batches older than 30 days (injected clock) on begin and refuses to read them", () => {
      const old = j.begin(batchArgs(1)).id;
      t += 29 * DAY;
      assert.ok(j.get(old), "still there on day 29");
      t += 2 * DAY; // day 31
      assert.equal(j.get(old), null, "expired batch is not readable");
      assert.deepEqual(j.list(), []);
      const fresh = j.begin(batchArgs(1)).id; // purges
      assert.deepEqual(j.list().map((x) => x.id), [fresh]);
    });

    it("purge() reports how many files it removed", async () => {
      j.begin(batchArgs(1));
      j.begin(batchArgs(1));
      t += 31 * DAY;
      assert.equal(j.purge(), 2);
      assert.equal((await readdir(dir)).filter((n) => n.endsWith(".json")).length, 0);
    });

    it("caps at 50 batches, keeping the newest", async () => {
      const ids = [];
      for (let i = 0; i < 55; i++) {
        t += 1000;
        ids.push(j.begin(batchArgs(1)).id);
      }
      const l = j.list();
      assert.equal(l.length, 50);
      assert.deepEqual(l.map((x) => x.id), ids.slice(5).reverse());
      for (const gone of ids.slice(0, 5)) assert.equal(j.get(gone), null);
      assert.equal((await readdir(dir)).filter((n) => n.endsWith(".json")).length, 50);
    });

    it("honours custom limits", () => {
      const k = mk({ maxBatches: 2, maxAgeMs: 10 * DAY });
      const a = k.begin(batchArgs(1)).id;
      t += 1000;
      const b = k.begin(batchArgs(1)).id;
      t += 1000;
      const c = k.begin(batchArgs(1)).id;
      assert.deepEqual(k.list().map((x) => x.id), [c, b]);
      assert.equal(k.get(a), null);
      t += 11 * DAY;
      assert.deepEqual(k.list(), []);
    });

    it("the cap counts per account: another account's batches do not evict mine", () => {
      const other = createUndoJournal({ dir, account: "acct-B", now: () => t, maxBatches: 2 });
      const o1 = other.begin(batchArgs(1)).id;
      t += 1000;
      const mine = createUndoJournal({ dir, account: "acct-A", now: () => t, maxBatches: 2 });
      mine.begin(batchArgs(1));
      t += 1000;
      mine.begin(batchArgs(1));
      t += 1000;
      mine.begin(batchArgs(1));
      assert.ok(other.get(o1));
      assert.equal(mine.list().length, 2);
    });
  });

  describe("corrupt, truncated and foreign files", () => {
    const writeRaw = async (name, text) => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(dir, name), text);
    };

    it("never throws and ignores them, while valid batches stay usable", async () => {
      const good = j.begin(batchArgs(1)).id;
      const valid = JSON.parse(await readFile(join(dir, `${good}.json`), "utf8"));
      await writeRaw("AAAA-2222.json", "{not json");
      await writeRaw("BBBB-3333.json", JSON.stringify(valid).slice(0, 40)); // truncated
      await writeRaw("CCCC-4444.json", ""); // empty
      await writeRaw("DDDD-5555.json", JSON.stringify({ ...valid, id: "DDDD-5555", v: 2 })); // foreign schema
      await writeRaw("EEEE-6666.json", JSON.stringify({ ...valid, id: "EEEE-6666", items: "nope" }));
      await writeRaw("FFFF-7777.json", JSON.stringify({ ...valid, id: "FFFF-7777", kind: "delete" }));
      await writeRaw("GGGG-8888.json", "[]");
      await writeRaw("notes.txt", "x");
      for (const id of ["AAAA-2222", "BBBB-3333", "CCCC-4444", "DDDD-5555", "EEEE-6666", "FFFF-7777", "GGGG-8888"]) {
        assert.equal(j.get(id), null, id);
        assert.equal(j.markUndone(id), false, id);
        assert.equal(j.complete(id, { status: "applied" }), false, id);
      }
      assert.deepEqual(j.list().map((x) => x.id), [good]);
      assert.doesNotThrow(() => j.purge());
      assert.equal(j.begin(batchArgs(1)).id.length, 9);
    });

    it("ignores a record whose content id differs from its file name", async () => {
      const { id } = j.begin(batchArgs(1));
      const valid = JSON.parse(await readFile(join(dir, `${id}.json`), "utf8"));
      await writeRaw("HHHH-2345.json", JSON.stringify(valid)); // content id is `id`
      assert.equal(j.get("HHHH-2345"), null);
      assert.deepEqual(j.list().map((x) => x.id), [id]);
    });

    it("purge removes an unreadable file only once it is older than the retention", async () => {
      await writeRaw("AAAA-2222.json", "{not json");
      assert.equal(j.purge(), 0);
      t = Date.now() + 31 * DAY; // the file mtime is real time, so move the injected clock past it
      assert.equal(j.purge(), 1);
      await assert.rejects(stat(join(dir, "AAAA-2222.json")), { code: "ENOENT" });
    });

    it("a record bigger than the size cap is ignored", async () => {
      await writeRaw("AAAA-2222.json", " ".repeat(5_000_001));
      assert.equal(j.get("AAAA-2222"), null);
    });
  });

  describe("account isolation", () => {
    it("get and list hide batches of another account; markUndone and complete cannot touch them", () => {
      const other = createUndoJournal({ dir, account: "acct-B", now: () => t });
      const theirs = other.begin(batchArgs(1)).id;
      const mine = j.begin(batchArgs(1)).id;
      assert.equal(j.get(theirs), null);
      assert.deepEqual(j.list().map((x) => x.id), [mine]);
      assert.equal(j.markUndone(theirs), false);
      assert.equal(j.complete(theirs, { status: "applied" }), false);
      assert.equal(other.get(theirs).status, "pending", "untouched");
      assert.equal(other.get(mine), null);
      assert.deepEqual(other.list().map((x) => x.id), [theirs]);
    });

    it("a file edited to another account is hidden", async () => {
      const { id } = j.begin(batchArgs(1));
      const p = join(dir, `${id}.json`);
      const rec = JSON.parse(await readFile(p, "utf8"));
      await writeFile(p, JSON.stringify({ ...rec, account: "acct-B" }));
      assert.equal(j.get(id), null);
    });
  });

  describe("ids and path traversal", () => {
    it("rejects malformed ids with a clear error before touching the disk", async () => {
      await mkdir(join(base, "evil"));
      await writeFile(join(base, "evil", "x.json"), "{}");
      for (const bad of ["../evil/x", "../x", "/etc/passwd", "ABCD-234", "ABCD_2345", "ABCD-2345.json", "ABCD-2345/../..", "", "0000-1111", "ILIL-OIOI", " "]) {
        assert.throws(() => j.get(bad), /invalid undo code/, JSON.stringify(bad));
        assert.throws(() => j.markUndone(bad), /invalid undo code/, JSON.stringify(bad));
        assert.throws(() => j.complete(bad, { status: "applied" }), /invalid undo code/, JSON.stringify(bad));
      }
      assert.throws(() => j.get(undefined), /invalid undo code/);
      assert.throws(() => j.get({}), /invalid undo code/);
    });
  });

  describe("symlinks", { skip: !posix }, () => {
    it("refuses a journal folder that is a symlink", async () => {
      const real = join(base, "real");
      await mkdir(real, { mode: 0o700 });
      await symlink(real, dir);
      assert.throws(() => j.begin(batchArgs(1)), /symlink/);
      assert.throws(() => j.list(), /symlink/);
      assert.throws(() => j.get("ABCD-2345"), /symlink/);
      assert.throws(() => j.purge(), /symlink/);
      assert.deepEqual(await readdir(real), []);
    });

    it("refuses a tmp sub-folder that is a symlink, even if it appears later", async () => {
      j.begin(batchArgs(1));
      const real = join(base, "real");
      await mkdir(real, { mode: 0o700 });
      await rm(join(dir, "tmp"), { recursive: true });
      await symlink(real, join(dir, "tmp"));
      assert.throws(() => j.begin(batchArgs(1)), /symlink/);
      assert.deepEqual(await readdir(real), []);
    });

    it("ignores a symlinked record and does not follow it", async () => {
      const { id } = j.begin(batchArgs(1));
      const p = join(dir, `${id}.json`);
      const copy = join(base, "copy.json");
      await writeFile(copy, await readFile(p));
      await rm(p);
      await symlink(copy, p);
      assert.equal(j.get(id), null);
      assert.deepEqual(j.list(), []);
      assert.equal(j.markUndone(id), false);
    });

    it("a dangling symlink at a record path is ignored", async () => {
      await mkdir(dir, { mode: 0o700 });
      await symlink(join(base, "nowhere"), join(dir, "ABCD-2345.json"));
      assert.equal(j.get("ABCD-2345"), null);
      assert.doesNotThrow(() => j.list());
    });
  });

  describe("disabled journal", () => {
    it("begin returns null, everything else is empty, and nothing touches the disk", async () => {
      const off = createUndoJournal({ dir, account: "acct-A", enabled: undoEnabled({ PROTON_DRIVE_UNDO: "0" }) });
      assert.equal(off.enabled, false);
      assert.equal(off.begin(batchArgs(1)), null);
      assert.equal(off.complete("ABCD-2345", { status: "applied" }), false);
      assert.deepEqual(off.list(), []);
      assert.equal(off.get("ABCD-2345"), null);
      assert.equal(off.markUndone("ABCD-2345"), false);
      assert.equal(off.purge(), 0);
      await assert.rejects(stat(dir), { code: "ENOENT" });
      assert.equal(j.enabled, true);
    });
  });

  describe("concurrency", () => {
    it("two child processes racing begin() produce intact, distinct files", async () => {
      const N = 25;
      const script = `
        const { createUndoJournal } = await import(${JSON.stringify(JOURNAL_URL)});
        const [dir, startAt, n, tag] = process.argv.slice(1);
        const j = createUndoJournal({ dir, account: "acct-A", maxBatches: 1000 });
        while (Date.now() < Number(startAt)) {}
        const ids = [];
        for (let i = 0; i < Number(n); i++) {
          const items = Array.from({ length: 20 }, (_, k) => ({ uid: tag + "-" + i + "-" + k, from: "/my-files/" + tag + "/" + k, name: "n" + k, restorable: true }));
          const r = j.begin({ tool: "drive_bulk_trash", kind: "trash", items });
          j.complete(r.id, { status: "applied" });
          ids.push(r.id);
        }
        console.log(JSON.stringify(ids));
      `;
      const startAt = String(Date.now() + 1500);
      const run = (tag) =>
        new Promise((resolve, reject) => {
          const p = spawn(process.execPath, ["--input-type=module", "-e", script, dir, startAt, String(N), tag]);
          let out = "", err = "";
          p.stdout.on("data", (d) => (out += d));
          p.stderr.on("data", (d) => (err += d));
          p.on("close", (c) => (c === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child exit ${c}: ${err}`))));
        });
      const [a, b] = await Promise.all([run("a"), run("b")]);
      const all = [...a, ...b];
      assert.equal(new Set(all).size, 2 * N, "no id handed out twice");

      const reader = createUndoJournal({ dir, account: "acct-A", maxBatches: 1000 });
      for (const [list, tag] of [[a, "a"], [b, "b"]]) {
        list.forEach((id, i) => {
          const batch = reader.get(id);
          assert.ok(batch, `${id} intact`);
          assert.equal(batch.status, "applied");
          assert.equal(batch.items.length, 20);
          assert.equal(batch.items[0].uid, `${tag}-${i}-0`, "each file holds its own writer's content");
        });
      }
      assert.equal((await readdir(dir)).filter((n) => n.endsWith(".json")).length, 2 * N);
      assert.deepEqual(await readdir(join(dir, "tmp")), []);
    });
  });
});
