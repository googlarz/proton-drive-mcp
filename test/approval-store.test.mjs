import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm, stat, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { resolveApprovalDir, createApprovalStore } from "../dist/utils/approvalStore.js";

const STORE_URL = new URL("../dist/utils/approvalStore.js", import.meta.url).href;
const MIN = 60_000;
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/;
const posix = process.platform !== "win32";

describe("resolveApprovalDir", () => {
  it("honours PROTON_DRIVE_APPROVAL_DIR", () => {
    assert.equal(resolveApprovalDir({ PROTON_DRIVE_APPROVAL_DIR: "/x/y" }, "darwin", "/h"), "/x/y");
  });
  it("macOS default is under ~/Library/Caches", () => {
    assert.equal(resolveApprovalDir({}, "darwin", "/h"), "/h/Library/Caches/proton-drive-mcp/approvals");
  });
  it("elsewhere uses XDG_CACHE_HOME, then ~/.cache", () => {
    assert.equal(resolveApprovalDir({ XDG_CACHE_HOME: "/c" }, "linux", "/h"), "/c/proton-drive-mcp/approvals");
    assert.equal(resolveApprovalDir({}, "linux", "/h"), "/h/.cache/proton-drive-mcp/approvals");
  });
  it("ignores a blank override", () => {
    assert.equal(resolveApprovalDir({ PROTON_DRIVE_APPROVAL_DIR: "  " }, "linux", "/h"), "/h/.cache/proton-drive-mcp/approvals");
  });
});

describe("approval store", () => {
  let base, dir, t, store;
  const mk = (extra = {}) => createApprovalStore({ dir, now: () => t, ...extra });
  const op = (n = "A") => ({ tool: "drive_delete", opHash: `hash-${n}`, summary: `delete ${n}` });

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "approvalstore-"));
    dir = join(base, "approvals");
    t = 1_000_000;
    store = mk();
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  it("request writes a pending record with the documented fields and a well-formed code", async () => {
    const r = store.request(op());
    assert.match(r.code, CODE_RE);
    assert.equal(r.reused, false);
    assert.equal(r.expiresAt, t + 10 * MIN);
    const rec = JSON.parse(await readFile(join(dir, "pending", `${r.code}.json`), "utf8"));
    assert.deepEqual(rec, { code: r.code, tool: "drive_delete", opHash: "hash-A", summary: "delete A", createdAt: t, expiresAt: t + 10 * MIN });
    assert.deepEqual(store.list().map((x) => [x.code, x.status]), [[r.code, "pending"]]);
    assert.equal(store.get(r.code).summary, "delete A");
  });

  it("consume without approval returns null", () => {
    store.request(op());
    assert.equal(store.consume(op()), null);
  });

  it("single use: approve once, consume once, replay refused", async () => {
    const { code } = store.request(op());
    const rec = store.approve(code);
    assert.equal(rec.status, "approved");
    assert.equal(rec.approvedAt, t);
    assert.equal(rec.expiresAt, t + 5 * MIN);
    assert.deepEqual(store.consume(op()), { code });
    assert.equal(store.consume(op()), null);
    assert.equal(store.consume(op()), null);
    assert.deepEqual(await readdir(join(dir, "approved")), []);
    assert.deepEqual(await readdir(join(dir, "consumed")), [`${code}.json`]);
    assert.deepEqual(store.list(), []);
    assert.equal(store.get(code), null);
  });

  it("an approval for other arguments (hash or tool) does not authorise anything else", () => {
    const { code } = store.request(op("A"));
    store.approve(code);
    assert.equal(store.consume(op("B")), null);
    assert.equal(store.consume({ tool: "drive_empty_trash", opHash: "hash-A" }), null);
    assert.deepEqual(store.consume(op("A")), { code });
  });

  it("other args get their own pending record; approving one leaves the other pending", () => {
    const a = store.request(op("A"));
    const b = store.request(op("B"));
    assert.notEqual(a.code, b.code);
    assert.equal(b.reused, false);
    store.approve(a.code);
    assert.equal(store.consume(op("B")), null);
    assert.deepEqual(store.consume(op("A")), { code: a.code });
    assert.equal(store.get(b.code).status, "pending");
  });

  it("reuses an unexpired pending record for the same tool and opHash", () => {
    const a = store.request(op());
    t += 3 * MIN;
    const b = store.request(op());
    assert.equal(b.reused, true);
    assert.equal(b.code, a.code);
    assert.equal(b.expiresAt, a.expiresAt);
    assert.equal(store.list().length, 1);
  });

  it("reuses an unexpired approved record rather than creating a pending one", () => {
    const a = store.request(op());
    store.approve(a.code);
    const b = store.request(op());
    assert.equal(b.reused, true);
    assert.equal(b.code, a.code);
    assert.equal(b.expiresAt, t + 5 * MIN);
    assert.deepEqual(store.list().map((x) => x.status), ["approved"]);
  });

  it("after consume, the same operation needs a new request and gets a new code", () => {
    const a = store.request(op());
    store.approve(a.code);
    store.consume(op());
    const b = store.request(op());
    assert.equal(b.reused, false);
    assert.notEqual(b.code, a.code);
  });

  it("pending expires after 10 minutes: cannot be approved, gets a fresh record", () => {
    const a = store.request(op());
    t += 10 * MIN - 1;
    assert.equal(store.get(a.code).code, a.code);
    t += 1;
    assert.equal(store.get(a.code), null);
    assert.throws(() => store.approve(a.code), /no pending approval/);
    const b = store.request(op());
    assert.equal(b.reused, false);
    assert.notEqual(b.code, a.code);
  });

  it("approved expires after 5 minutes (counted from approval, not from the request)", () => {
    const a = store.request(op());
    t += 9 * MIN;
    store.approve(a.code);
    t += 5 * MIN - 1;
    assert.deepEqual(store.consume(op()), { code: a.code });

    const b = store.request(op());
    store.approve(b.code);
    t += 5 * MIN;
    assert.equal(store.consume(op()), null);
    assert.equal(store.get(b.code), null);
    assert.equal(store.request(op()).reused, false);
  });

  it("purges expired pending, approved and (after 24 h) consumed files", async () => {
    const a = store.request(op("A"));
    const b = store.request(op("B"));
    store.approve(b.code);
    const c = store.request(op("C"));
    store.approve(c.code);
    store.consume(op("C"));
    t += 11 * MIN;
    assert.deepEqual(store.list(), []);
    assert.deepEqual(await readdir(join(dir, "pending")), []);
    assert.deepEqual(await readdir(join(dir, "approved")), []);
    assert.deepEqual(await readdir(join(dir, "consumed")), [`${c.code}.json`]);
    t += 24 * 3_600_000;
    store.list();
    assert.deepEqual(await readdir(join(dir, "consumed")), []);
    assert.ok(a.code && b.code);
  });

  it("caps pending records at 20; reuse and expiry still work at the cap", () => {
    const codes = [];
    for (let i = 0; i < 20; i++) codes.push(store.request(op(`n${i}`)).code);
    assert.throws(() => store.request(op("one-too-many")), /too many pending approvals/);
    assert.equal(store.request(op("n3")).reused, true);
    store.deny(codes[0]);
    assert.equal(store.request(op("one-too-many")).reused, false);
    t += 11 * MIN;
    assert.equal(store.request(op("fresh")).reused, false);
    assert.equal(store.list().length, 1);
  });

  it("maxPending, pendingTtlMs and approvedTtlMs are configurable", () => {
    const s = mk({ maxPending: 1, pendingTtlMs: 1000, approvedTtlMs: 2000 });
    const a = s.request(op("A"));
    assert.equal(a.expiresAt, t + 1000);
    assert.throws(() => s.request(op("B")), /too many pending/);
    assert.equal(s.approve(a.code).expiresAt, t + 2000);
  });

  it("approve is refused for unknown, already approved and consumed codes", () => {
    assert.throws(() => store.approve("AAAA-BBBB"), /no pending approval/);
    const { code } = store.request(op());
    store.approve(code);
    assert.throws(() => store.approve(code), /no pending approval/);
    store.consume(op());
    assert.throws(() => store.approve(code), /no pending approval/);
  });

  it("approve accepts lowercase and surrounding whitespace", () => {
    const { code } = store.request(op());
    assert.equal(store.approve(` ${code.toLowerCase()} `).code, code);
  });

  it("deny removes a pending or approved record; denied cannot be approved or consumed", () => {
    const a = store.request(op("A"));
    assert.equal(store.deny(a.code), true);
    assert.equal(store.deny(a.code), false);
    assert.throws(() => store.approve(a.code), /no pending approval/);
    const b = store.request(op("B"));
    store.approve(b.code);
    assert.equal(store.deny(b.code), true);
    assert.equal(store.consume(op("B")), null);
  });

  it("rejects missing or oversized request fields", () => {
    assert.throws(() => store.request({ tool: "", opHash: "h", summary: "s" }), /needs tool/);
    assert.throws(() => store.request({ tool: "t", opHash: "", summary: "s" }), /needs tool/);
    assert.throws(() => store.request({ tool: "t", opHash: "h", summary: "x".repeat(100_001) }), /too long/);
  });

  it("generated codes are unique and use the unambiguous alphabet", () => {
    const s = mk({ maxPending: 500 });
    const seen = new Set();
    for (let i = 0; i < 120; i++) {
      const { code } = s.request(op(`u${i}`));
      assert.match(code, CODE_RE);
      assert.ok(!seen.has(code));
      seen.add(code);
    }
  });

  describe("path traversal and code validation", () => {
    const bad = [
      "../x", "../../etc/passwd", "ABCD-EFGH/../x", "ABCD/EFGH", "ABCD-EFGH/", "ABCD-EFGH.json", "K7Q2-M9XD\0",
      "I0O1-ILOO", "ABCDEFGH", "ABC-DEFGH", "ABCD-EFGHI", "", "..", ".", "ABCD\\EFGH", " ",
    ];
    for (const code of bad) {
      it(`rejects ${JSON.stringify(code)}`, async () => {
        store.request(op());
        for (const fn of ["get", "approve", "deny"]) {
          assert.throws(() => store[fn](code), /invalid approval code/, fn);
        }
        assert.deepEqual(await readdir(base), ["approvals"]);
      });
    }
    it("rejects non-string codes", () => {
      for (const v of [undefined, null, 5, {}, ["AAAA-BBBB"]]) assert.throws(() => store.get(v), /invalid approval code/);
    });
    it("does not read a record that sits outside the store", async () => {
      const { code } = store.request(op());
      await writeFile(join(base, `${code}.json`), JSON.stringify({ code }));
      assert.throws(() => store.approve(`../${code}`), /invalid approval code/);
    });
  });

  describe("filesystem hardening", { skip: !posix }, () => {
    it("creates the folders as 0700 and the records as 0600", async () => {
      const { code } = store.request(op());
      store.approve(code);
      const { code: c2 } = store.request(op("B"));
      for (const d of ["", "pending", "approved", "consumed", "tmp"]) {
        assert.equal((await stat(join(dir, d))).mode & 0o777, 0o700, d || "root");
      }
      assert.equal((await stat(join(dir, "approved", `${code}.json`))).mode & 0o777, 0o600);
      assert.equal((await stat(join(dir, "pending", `${c2}.json`))).mode & 0o777, 0o600);
      store.consume(op());
      assert.equal((await stat(join(dir, "consumed", `${code}.json`))).mode & 0o777, 0o600);
      assert.deepEqual(await readdir(join(dir, "tmp")), []);
    });

    it("tightens a looser existing folder to 0700", async () => {
      await mkdir(dir, { mode: 0o755 });
      store.request(op());
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
    });

    it("refuses a store folder that is a symlink", async () => {
      const real = join(base, "real");
      await mkdir(real);
      await symlink(real, dir);
      for (const fn of [() => store.request(op()), () => store.list(), () => store.consume(op())]) {
        assert.throws(fn, /symlink/);
      }
      assert.deepEqual(await readdir(real), []);
    });

    it("refuses a state sub-folder that is a symlink, even if it appears later", async () => {
      store.request(op());
      const real = join(base, "elsewhere");
      await mkdir(real);
      await rm(join(dir, "approved"), { recursive: true });
      await symlink(real, join(dir, "approved"));
      assert.throws(() => store.consume(op()), /symlink/);
      assert.throws(() => store.list(), /symlink/);
    });

    it("refuses a store path that is a regular file", async () => {
      await writeFile(dir, "x");
      assert.throws(() => store.request(op()), /not a directory/);
    });

    it("a symlinked pending record cannot be approved", async () => {
      const { code } = store.request(op());
      const real = join(base, "real.json");
      await rename(join(dir, "pending", `${code}.json`), real);
      await symlink(real, join(dir, "pending", `${code}.json`));
      assert.deepEqual(store.list(), []);
      assert.equal(store.get(code), null);
      assert.throws(() => store.approve(code), /no pending approval/);
      assert.deepEqual(await readdir(join(dir, "approved")), []);
    });

    it("a symlinked approved record is never consumed", async () => {
      const { code } = store.request(op());
      store.approve(code);
      const real = join(base, "real.json");
      await rename(join(dir, "approved", `${code}.json`), real);
      await symlink(real, join(dir, "approved", `${code}.json`));
      assert.equal(store.consume(op()), null);
      assert.deepEqual(store.list(), []);
      assert.deepEqual(await readdir(join(dir, "consumed")), []);
      assert.ok((await stat(real)).isFile());
    });

    it("a record whose content does not match its file name is ignored", async () => {
      const { code } = store.request(op());
      store.approve(code);
      await rename(join(dir, "approved", `${code}.json`), join(dir, "approved", "AAAA-BBBB.json"));
      assert.equal(store.consume(op()), null);
      assert.deepEqual(store.list(), []);
    });

    it("garbage files in the state folders are ignored, not crashed on", async () => {
      store.request(op());
      await writeFile(join(dir, "pending", "AAAA-BBBB.json"), "not json");
      await writeFile(join(dir, "pending", "notes.txt"), "hi");
      assert.equal(store.list().length, 1);
      assert.equal(store.consume(op()), null);
    });
  });

  describe("concurrency", () => {
    it("8 parallel consumers in one process: exactly one winner", async () => {
      const { code } = store.request(op());
      store.approve(code);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => new Promise((res) => setImmediate(() => res(mk().consume(op()))))),
      );
      assert.deepEqual(results.filter(Boolean), [{ code }]);
      assert.equal(results.filter((r) => r === null).length, 7);
    });

    it("two child processes racing on the same approved records: exactly one winner each", async () => {
      const N = 40;
      const hashes = Array.from({ length: N }, (_, i) => `race-${i}`);
      const realNow = () => Date.now();
      const s = createApprovalStore({ dir, now: realNow });
      for (const h of hashes) s.approve(s.request({ tool: "drive_delete", opHash: h, summary: "s" }).code);

      const script = `
        const { createApprovalStore } = await import(${JSON.stringify(STORE_URL)});
        const [dir, startAt, n] = process.argv.slice(1);
        const store = createApprovalStore({ dir });
        while (Date.now() < Number(startAt)) {}
        const won = [];
        for (let i = 0; i < Number(n); i++) if (store.consume({ tool: "drive_delete", opHash: "race-" + i })) won.push(i);
        console.log(JSON.stringify(won));
      `;
      const startAt = String(Date.now() + 1500);
      const run = () =>
        new Promise((resolve, reject) => {
          const p = spawn(process.execPath, ["--input-type=module", "-e", script, dir, startAt, String(N)]);
          let out = "", err = "";
          p.stdout.on("data", (d) => (out += d));
          p.stderr.on("data", (d) => (err += d));
          p.on("close", (c) => (c === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child exit ${c}: ${err}`))));
        });
      const [a, b] = await Promise.all([run(), run()]);

      const wins = new Map();
      for (const i of [...a, ...b]) wins.set(i, (wins.get(i) ?? 0) + 1);
      assert.equal(wins.size, N, "every record consumed");
      for (const [i, n] of wins) assert.equal(n, 1, `record race-${i} won ${n} times`);
      assert.equal(a.length + b.length, N);
      assert.equal((await readdir(join(dir, "consumed"))).length, N);
      assert.deepEqual(await readdir(join(dir, "approved")), []);
    });

    it("two approvers racing on one pending record: one approval, the other fails", async () => {
      const { code } = store.request(op());
      const outcomes = [mk(), mk()].map((s) => {
        try { return s.approve(code).status; } catch (e) { return String(e.message); }
      });
      assert.equal(outcomes.filter((o) => o === "approved").length, 1);
      assert.equal(store.consume(op()).code, code);
      assert.equal(store.consume(op()), null);
    });
  });
});
