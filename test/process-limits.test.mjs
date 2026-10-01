// Process-wide walk concurrency cap, temp-dir cleanup on SIGTERM, and small output/parse fixes.
import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriveService } from "../dist/services/drive.js";
import { walkTree, resetWalkCacheForTests, partialFields } from "../dist/services/walk.js";
import { Semaphore } from "../dist/utils/semaphore.js";
import { docxXmlToText } from "../dist/services/contentExtract.js";
import { makeSandbox, startServer, waitFor, readPids, sleep } from "./helpers/mcp-client.mjs";

const folder = (name) => ({ uid: `d-${name}`, parentUid: "p", type: "folder", name: { ok: true, value: name } });
const file = (name) => ({ uid: `f-${name}`, parentUid: "p", type: "file", name: { ok: true, value: name }, mediaType: "text/plain", activeRevision: { claimedSize: 5 } });

/** root `/my-files/<prefix>` -> n folders, each holding a file. Tracks simultaneous listings across every service built from `stats`. */
function makeSvc(stats, n, delay, { failFrom } = {}) {
  const names = Array.from({ length: n }, (_, i) => `f${i + 1}`);
  const runner = async (args) => {
    const path = args[2];
    stats.active++;
    stats.peak = Math.max(stats.peak, stats.active);
    try {
      await sleep(delay);
      if (failFrom && stats.failing) throw new Error("boom");
      if (path.split("/").length <= 3) return names.map(folder);
      return [file("x.txt")];
    } finally {
      stats.active--;
    }
  };
  return new DriveService(runner);
}

beforeEach(() => { process.env.PROTON_DRIVE_WALK_CONCURRENCY = "3"; resetWalkCacheForTests(); });
afterEach(() => { delete process.env.PROTON_DRIVE_WALK_CONCURRENCY; resetWalkCacheForTests(); });

describe("process-wide walk limiter", () => {
  it("three overlapping walks of concurrency 8 never exceed the global cap", async () => {
    const stats = { active: 0, peak: 0 };
    const svc = makeSvc(stats, 12, 25);
    const opts = { concurrency: 8, budgetMs: 0, refresh: true, noDisk: true };
    // Distinct roots so the walks do not share one in-flight walk.
    await Promise.all(["/my-files/a", "/my-files/b", "/my-files/c"].map((r) => walkTree(svc, r, opts)));
    assert.ok(stats.peak <= 3, `peak ${stats.peak}`);
    assert.ok(stats.peak >= 2, "walks should still run in parallel");
  });

  it("a slot is not leaked when listings throw: a later walk completes", async () => {
    const stats = { active: 0, peak: 0, failing: true };
    const svc = makeSvc(stats, 6, 5, { failFrom: true });
    await walkTree(svc, "/my-files/a", { concurrency: 8, budgetMs: 0, noDisk: true }).catch(() => {});
    stats.failing = false;
    const r = await walkTree(svc, "/my-files/b", { concurrency: 8, budgetMs: 0, noDisk: true, refresh: true });
    assert.ok(r.nodes.length >= 6);
  });
});

describe("Semaphore", () => {
  it("serves waiters FIFO", async () => {
    const s = new Semaphore(1);
    const order = [];
    const first = await s.acquire();
    const a = s.acquire().then((rel) => { order.push("a"); rel(); });
    const b = s.acquire().then((rel) => { order.push("b"); rel(); });
    first();
    await Promise.all([a, b]);
    assert.deepEqual(order, ["a", "b"]);
  });

  it("an aborted waiter leaves the queue without taking a slot", async () => {
    const s = new Semaphore(1);
    const held = await s.acquire();
    const ctl = new AbortController();
    const waiting = s.acquire(ctl.signal);
    const later = s.acquire();
    ctl.abort(new Error("gone"));
    await assert.rejects(waiting, /gone/);
    held();
    const rel = await Promise.race([later, sleep(500).then(() => null)]);
    assert.ok(rel, "the next waiter must get the slot");
    rel();
    (await s.acquire())(); // capacity fully restored
    await assert.rejects(s.acquire(AbortSignal.abort(new Error("pre"))), /pre/);
  });

  it("release is idempotent", async () => {
    const s = new Semaphore(1);
    const rel = await s.acquire();
    rel(); rel();
    const a = await s.acquire();
    const second = await Promise.race([s.acquire(), sleep(50).then(() => "blocked")]);
    assert.equal(second, "blocked");
    a();
  });
});

describe("partial output fields", () => {
  it("partialFields reports continuing: true next to partial", () => {
    assert.equal(partialFields({ partial: true, budgetMs: 1000 }).continuing, true);
    assert.deepEqual(partialFields({}), {});
  });
});

describe("docx self-closing paragraphs", () => {
  it("<w:p/> and <w:p w:rsidR=\"1\"/> emit an empty line", () => {
    assert.equal(docxXmlToText("<w:p><w:t>a</w:t></w:p><w:p/><w:p w:rsidR=\"1\" /><w:p><w:t>b</w:t></w:p></w:body>"), "a\n\n\nb");
  });
  it("many unclosed <w:p openers stay linear", () => {
    const t0 = Date.now();
    docxXmlToText("<w:p " .repeat(200000));
    assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
  });
});

describe("SIGTERM during a download", () => {
  const sbs = [];
  after(() => sbs.forEach((f) => f()));
  it("removes the pdmcp-read-* temp dir and exits promptly", { timeout: 30_000 }, async () => {
    const sb = makeSandbox();
    const tmp = mkdtempSync(join(tmpdir(), "pdmcp-tmproot-"));
    sbs.push(sb.cleanup, () => rmSync(tmp, { recursive: true, force: true }));
    const c = await startServer("download-hang", sb, { TMPDIR: tmp });
    c.callRaw("drive_read_content", { path: "/my-files/a.txt" }, { timeout: 20_000 }).catch(() => {});
    const started = await waitFor(() => readPids(sb.pidFile).some((r) => r.argv0 === "filesystem" && r.role === "child"), 8000);
    assert.ok(started, "download never started");
    assert.ok(readdirSync(tmp).some((n) => n.startsWith("pdmcp-read-")), "temp dir should exist during the download");
    const t0 = Date.now();
    c.kill("SIGTERM");
    await c.exitPromise;
    assert.ok(Date.now() - t0 < 5000, `exit took ${Date.now() - t0} ms`);
    assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith("pdmcp-")), []);
  });
});
