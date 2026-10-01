import type { DriveService } from "./drive.js";
import { DriveNotAuthenticatedError } from "../utils/errors.js";
import { callContext } from "../utils/subprocess.js";
import { logger } from "../utils/logger.js";
import { Semaphore } from "../utils/semaphore.js";
import { indexEnabled, indexMaxAgeMs, readIndex, writeIndex, deleteIndex, INDEX_VERSION, MAX_ENTRIES, type IndexEntry, type IndexFile } from "./walkIndex.js";

/** One node of a walked Drive tree. Sizes are the real (claimed) sizes, not encrypted storage sizes. */
export interface WalkNode {
  path: string;
  uid: string;
  parentUid?: string;
  type: "file" | "folder";
  mediaType?: string;
  size?: number;
  storageSize?: number;
  /** Original local modification time (activeRevision.claimedModificationTime), ISO string. */
  mtime?: string;
  /** Upload/modification time on Drive, ISO string. */
  uploadedAt?: string;
  /** Uploader-claimed sha1 (unverified, present on only some files). */
  sha1?: string;
  isShared?: boolean;
  isSharedByUrl?: boolean;
}

export interface WalkOptions {
  maxDepth?: number;
  /** Hard cap on `fs list` calls (default 300). */
  maxCalls?: number;
  /** Parallel `fs list` calls (default 12, max 12; PROTON_DRIVE_WALK_CONCURRENCY overrides the default). */
  concurrency?: number;
  /** Folder names skipped entirely (default: .git, node_modules). */
  exclude?: string[];
  /** Ignore the cache and re-walk. */
  refresh?: boolean;
  /** Never answer from the persistent index (memory cache is still used); for tools where saved data is unsafe (plans, deletion suggestions, audits). */
  noDisk?: boolean;
  /**
   * Soft time budget in ms (default 25 s, PROTON_DRIVE_WALK_BUDGET_MS; 0 = wait for the whole walk). When it expires
   * the nodes collected so far are returned with `partial: true` while the same walk finishes in the background.
   */
  budgetMs?: number;
  signal?: AbortSignal;
}

export interface WalkResult {
  root: string;
  nodes: WalkNode[];
  /** false when maxCalls/maxDepth/failures cut the walk short. */
  complete: boolean;
  callsMade: number;
  skipped: { path: string; reason: string }[];
  fromCache: boolean;
  ageMs: number;
  /** Served from the saved index (PROTON_DRIVE_INDEX=1), not from a walk made in this process; may be hours old (see ageMs). */
  stale?: boolean;
  /** A background re-walk is replacing the stale data. */
  refreshing?: boolean;
  /** The time budget expired: only part of the drive was listed so far (see skipped); never cached or saved as complete. */
  partial?: boolean;
  /** The same walk is still running in the background and will fill the cache for the next call. */
  continuing?: boolean;
  /** The budget that expired (set with `partial`). */
  budgetMs?: number;
}

/** Output fields for results served from the persistent index while a refresh runs (empty otherwise). */
export const staleFields = (w: Pick<WalkResult, "stale" | "refreshing">) =>
  w.stale ? { stale: true, ...(w.refreshing ? { refreshing: true } : {}) } : {};

/** Output fields for a result cut short by the time budget (empty otherwise). */
export const partialFields = (w: Pick<WalkResult, "partial" | "budgetMs">) =>
  w.partial ? { partial: true, continuing: true, note: `Partial: the drive walk was still running after ${(w.budgetMs ?? 0) / 1000} s; repeat the call in a minute for the full result.` } : {};

export const DEFAULT_EXCLUDE = [".git", "node_modules"];
const DEFAULT_MAX_CALLS = 300;
const MAX_CONCURRENCY = 12; // the CLI's SQLite cache starts failing above this
// Process-wide cap on simultaneous walk `fs list` calls: per-walk concurrency alone lets overlapping walks exceed it.
let limiter: Semaphore | undefined;
const walkLimiter = () => (limiter ??= new Semaphore(defaultConcurrency()));
const DEFAULT_BUDGET_MS = 25_000; // Claude Desktop gives an MCP request ~60 s
const defaultConcurrency = () => {
  const v = Math.floor(Number(process.env.PROTON_DRIVE_WALK_CONCURRENCY));
  return v >= 1 ? Math.min(v, MAX_CONCURRENCY) : MAX_CONCURRENCY;
};
const defaultBudgetMs = () => {
  const v = Number(process.env.PROTON_DRIVE_WALK_BUDGET_MS ?? DEFAULT_BUDGET_MS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_BUDGET_MS;
};
const RETRY_PAUSE_MS = 300;
const CACHE_ENTRIES = 16;

/** Nodes are shared with the cache: treat them as read-only. */
interface CacheEntry {
  root: string;
  key: string;
  excludeKey: string;
  maxDepth?: number;
  createdAt: number;
  nodes: WalkNode[];
  skipped: { path: string; reason: string }[];
  complete: boolean;
}
const cache = new Map<string, CacheEntry>();

const ttlMs = () => {
  const v = Number(process.env.PROTON_DRIVE_WALK_TTL_MS ?? 300_000);
  return Number.isFinite(v) && v >= 0 ? v : 300_000;
};

// Path helpers that respect the "\/" escape used for a literal '/' in a name.
function segments(path: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 1; i < path.length; i++) {
    if (path[i] === "/" && path[i - 1] !== "\\") { out.push(cur); cur = ""; } else cur += path[i];
  }
  out.push(cur);
  return out;
}
export const depthOf = (path: string) => segments(path).length;
export const baseName = (path: string) => segments(path).pop()!.replace(/\\\//g, "/");

/** Parent folder path of `path` ("/" for a top-level root). */
export function parentPath(path: string): string {
  for (let i = path.length - 1; i > 0; i--) if (path[i] === "/" && path[i - 1] !== "\\") return path.slice(0, i);
  return "/";
}

const isUnder = (path: string, ancestor: string) => ancestor === "/" || path === ancestor || path.startsWith(ancestor + "/");
const normalizeRoot = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);
const byPath = (a: WalkNode, b: WalkNode) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);

/** A folder at the depth limit that we would have listed had the limit been higher. */
function isDepthCut(nodes: WalkNode[], rootDepth: number, maxDepth: number | undefined, exclude: Set<string>): boolean {
  if (maxDepth === undefined) return false;
  return nodes.some((n) => n.type === "folder" && depthOf(n.path) - rootDepth === maxDepth && !exclude.has(baseName(n.path)));
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("walk aborted");
}

function fromCache(entry: CacheEntry, root: string, maxDepth: number | undefined, exclude: Set<string>, exact: boolean): WalkResult {
  const rootDepth = depthOf(root);
  const nodes = exact
    ? entry.nodes.slice()
    : entry.nodes.filter((n) => n.path.startsWith(root + "/") && (maxDepth === undefined || depthOf(n.path) - rootDepth <= maxDepth));
  const skipped = entry.skipped.filter((s) => isUnder(s.path, root));
  return {
    root, nodes, skipped,
    complete: exact ? entry.complete : skipped.length === 0 && !isDepthCut(nodes, rootDepth, maxDepth, exclude),
    callsMade: 0, fromCache: true, ageMs: Date.now() - entry.createdAt,
  };
}

function pick(entries: Iterable<CacheEntry>, root: string, maxDepth: number | undefined, key: string, excludeKey: string, exclude: Set<string>): { e: CacheEntry; exact: boolean } | undefined {
  let best: CacheEntry | undefined;
  for (const e of entries) {
    if (e.key === key) return { e, exact: true }; // same request, even if it was partial
    // An ancestor's walk can answer a subfolder request if it saw everything and went deep enough.
    if (e.excludeKey !== excludeKey || e.skipped.length > 0 || !isUnder(root, e.root)) continue;
    // A subpath the ancestor never saw as a folder must be walked fresh so it fails like a cold call.
    if (!e.nodes.some((n) => n.path === root && n.type === "folder")) continue;
    // The ancestor never listed an excluded folder, so it cannot answer for it or anything below it.
    if (segments(root).slice(e.root === "/" ? 0 : depthOf(e.root)).some((seg) => exclude.has(seg))) continue;
    const reach = e.maxDepth === undefined ? Infinity : e.maxDepth - (depthOf(root) - depthOf(e.root));
    if (reach < (maxDepth ?? Infinity)) continue;
    if (!best || e.root.length > best.root.length) best = e;
  }
  return best && { e: best, exact: false };
}

function lookup(root: string, maxDepth: number | undefined, key: string, excludeKey: string, exclude: Set<string>): WalkResult | undefined {
  const now = Date.now(), ttl = ttlMs();
  for (const [k, e] of cache) if (now - e.createdAt >= ttl) cache.delete(k);
  const hit = pick(cache.values(), root, maxDepth, key, excludeKey, exclude);
  return hit && fromCache(hit.e, root, maxDepth, exclude, hit.exact);
}

interface WalkParams {
  root: string;
  maxDepth?: number;
  maxCalls: number;
  concurrency: number;
  excludeList: string[];
  exclude: Set<string>;
  key: string;
  excludeKey: string;
}
/** Walk state a time-budget snapshot can read while the walk runs. */
interface LiveWalk { nodes: WalkNode[]; skipped: { path: string; reason: string }[]; queue: { path: string; depth: number }[]; active: Set<string>; callsMade: number }
const newLive = (root: string): LiveWalk => ({ nodes: [], skipped: [], queue: [{ path: root, depth: 0 }], active: new Set(), callsMade: 0 });
interface RawWalk { nodes: WalkNode[]; skipped: { path: string; reason: string }[]; callsMade: number; complete: boolean }

/** The actual breadth-first walk (no caching). */
async function runWalk(svc: DriveService, p: WalkParams, signal: AbortSignal | undefined, live: LiveWalk = newLive(p.root)): Promise<RawWalk> {
  const { root, maxDepth, maxCalls, concurrency, exclude } = p;
  const { nodes, skipped, queue } = live;
  let active = 0;

  const listOnce = async (path: string) => {
    live.callsMade++;
    const release = await walkLimiter().acquire(signal);
    try {
      return await svc.listEntries(path);
    } finally {
      release();
    }
  };
  // One retry covers a transient failure the subprocess layer already gave up on.
  const listWithRetry = async (path: string) => {
    try {
      return await listOnce(path);
    } catch (err) {
      if (err instanceof DriveNotAuthenticatedError || signal?.aborted || live.callsMade >= maxCalls) throw err;
      await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
      if (signal?.aborted) throw err;
      return listOnce(path);
    }
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (err !== undefined) reject(err); else resolve();
    };
    const onAbort = () => finish(abortError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });

    const handle = (job: { path: string; depth: number }, entries: Awaited<ReturnType<typeof listOnce>>) => {
      for (const { item, file } of entries) {
        if (typeof item.uid !== "string") continue; // "/" lists path-only roots, not nodes
        const rev = (item.activeRevision ?? {}) as Record<string, unknown>;
        const digests = (rev.claimedDigests ?? {}) as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === "string" ? v : undefined);
        const node: WalkNode = {
          path: file.path, uid: item.uid, parentUid: str(item.parentUid), type: file.type,
          mediaType: file.mimeType, size: file.size, storageSize: file.storageSize,
          mtime: str(rev.claimedModificationTime), uploadedAt: file.modifiedAt, sha1: str(digests.sha1),
          isShared: typeof item.isShared === "boolean" ? item.isShared : undefined,
          isSharedByUrl: typeof item.isSharedByUrl === "boolean" ? item.isSharedByUrl : undefined,
        };
        nodes.push(node);
        if (file.type === "folder" && !exclude.has(file.name) && (maxDepth === undefined || job.depth + 1 < maxDepth)) {
          queue.push({ path: file.path, depth: job.depth + 1 });
        }
      }
    };

    const pump = () => {
      if (settled) return;
      while (active < concurrency && queue.length) {
        if (live.callsMade >= maxCalls) {
          for (const q of queue.splice(0)) skipped.push({ path: q.path, reason: `not listed: maxCalls (${maxCalls}) reached` });
          break;
        }
        const job = queue.shift()!;
        active++;
        live.active.add(job.path);
        listWithRetry(job.path)
          .then((entries) => handle(job, entries))
          .catch((err) => {
            if (job.depth === 0 || err instanceof DriveNotAuthenticatedError) return finish(err);
            skipped.push({ path: job.path, reason: String(err instanceof Error ? err.message : err).slice(0, 200) });
          })
          .finally(() => { active--; live.active.delete(job.path); pump(); });
      }
      if (active === 0 && queue.length === 0) finish();
    };
    pump();
  });

  nodes.sort(byPath);
  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { nodes, skipped, callsMade: live.callsMade, complete: skipped.length === 0 && !isDepthCut(nodes, depthOf(root), maxDepth, exclude) };
}

function remember(p: WalkParams, w: RawWalk): void {
  cache.delete(p.key);
  cache.set(p.key, { root: p.root, key: p.key, excludeKey: p.excludeKey, maxDepth: p.maxDepth, createdAt: Date.now(), nodes: w.nodes, skipped: w.skipped, complete: w.complete });
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
}

// ---- persistent index (opt-in, PROTON_DRIVE_INDEX=1) ------------------------
// Disk data is only served after one `list /my-files` proves it belongs to the
// current account, and is served stale-while-revalidate.

const ACCOUNT_ROOT = "/my-files";
/** undefined = not loaded yet, null = nothing usable on disk. */
let disk: { accountKey: string; entries: IndexEntry[] } | null | undefined;
type Verdict = "match" | "mismatch" | "unknown";
let diskVerified: { at: number; ctl: AbortController; promise: Promise<Verdict> } | undefined;
const VERIFY_TTL_MS = 10 * 60_000;
let shuttingDown = false;
const refreshFailedAt = new Map<string, number>();
const cooldownMs = () => {
  const v = Number(process.env.PROTON_DRIVE_INDEX_REFRESH_COOLDOWN_MS ?? 300_000);
  return Number.isFinite(v) && v >= 0 ? v : 300_000;
};
let knownAccountKey: string | undefined;
let persistChain: Promise<void> = Promise.resolve();
let invalidationSeq = 0;
/** Background refreshes of stale index data, and (key prefixed FG) foreground walks that callers share and that may outlive a budgeted call. */
interface WalkRec {
  controller: AbortController; root: string; superseded: boolean; promise: Promise<void>;
  /** Foreground walks only. */
  fg?: { live: LiveWalk; startedAt: number; waiters: number; partialReturned: boolean; done: Promise<RawWalk> };
}
const refreshes = new Map<string, WalkRec>();
const FG = "fg\0";
let exitHooked = false;

/** The parentUid shared by the first-level children of /my-files identifies the account's Drive root. */
function fingerprint(items: { parentUid?: unknown }[]): string | undefined {
  const ids = new Set(items.map((i) => i.parentUid));
  const [only] = ids;
  return ids.size === 1 && typeof only === "string" ? only : undefined;
}

function loadDisk() {
  if (disk === undefined) {
    const f = readIndex({ requireWritable: true });
    disk = f ? { accountKey: f.accountKey, entries: f.entries } : null;
  }
  return disk;
}

function discardDisk(): void {
  disk = null;
  try { deleteIndex(); } catch { /* best effort */ }
}

/** Rejects with the caller's own abort reason without touching the shared promise. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * One `list /my-files` proves the saved data belongs to the live account. Only a
 * successful comparison that differs deletes the file; any failure (network, rate
 * limit, empty or unreadable listing) just serves nothing from disk this time and is
 * not remembered. The check is shared by concurrent callers on its own signal, so one
 * caller's abort cannot fail the others, and it is repeated after 10 minutes.
 */
async function verifyDisk(svc: DriveService, signal: AbortSignal | undefined): Promise<boolean> {
  if (diskVerified && Date.now() - diskVerified.at > VERIFY_TTL_MS) diskVerified = undefined;
  if (!diskVerified) {
    const ctl = new AbortController();
    const promise = callContext.run({ signal: ctl.signal }, async (): Promise<Verdict> => {
      try {
        const current = fingerprint((await svc.listEntries(ACCOUNT_ROOT)).map((e) => e.item));
        if (!current) return "unknown";
        knownAccountKey = current;
        if (disk && disk.accountKey === current) return "match";
        discardDisk();
        return "mismatch";
      } catch {
        return "unknown";
      }
    });
    const rec = { at: Date.now(), ctl, promise };
    diskVerified = rec;
    void promise.then((v) => { if (v === "unknown" && diskVerified === rec) diskVerified = undefined; });
  }
  return (await raceAbort(diskVerified.promise, signal)) === "match";
}

const toCacheEntry = (e: IndexEntry): CacheEntry => ({
  root: e.root, key: e.key, excludeKey: e.opts.exclude.join("\0"), maxDepth: e.opts.maxDepth,
  createdAt: e.completedAt, nodes: e.nodes, skipped: [], complete: true,
});

function diskCandidates(): CacheEntry[] {
  const st = loadDisk();
  const now = Date.now(), maxAge = indexMaxAgeMs();
  return st ? st.entries.filter((e) => { const age = now - e.completedAt; return Number.isFinite(age) && age >= 0 && age <= maxAge; }).map(toCacheEntry) : [];
}

function persist(svc: DriveService, p: WalkParams, w: RawWalk, startSeq: number): void {
  if (!indexEnabled() || !w.complete || !isUnder(p.root, ACCOUNT_ROOT)) return;
  persistChain = persistChain.then(async () => {
    try {
      if (shuttingDown || invalidationSeq !== startSeq) return; // a write happened mid-walk: do not save a possibly outdated tree
      let acct = knownAccountKey ?? (p.root === ACCOUNT_ROOT ? fingerprint(w.nodes.filter((n) => depthOf(n.path) === 2)) : undefined);
      if (!acct) acct = fingerprint((await svc.listEntries(ACCOUNT_ROOT)).map((e) => e.item));
      if (!acct || shuttingDown || invalidationSeq !== startSeq) return;
      knownAccountKey = acct;
      const cur = loadDisk();
      const base = cur && cur.accountKey === acct ? cur.entries : [];
      const entry: IndexEntry = { key: p.key, root: p.root, opts: { maxDepth: p.maxDepth, maxCalls: p.maxCalls, exclude: p.excludeList }, completedAt: Date.now(), nodes: w.nodes };
      const entries = [entry, ...base.filter((e) => e.key !== p.key)].sort((a, b) => b.completedAt - a.completedAt).slice(0, MAX_ENTRIES);
      const file: IndexFile = { version: INDEX_VERSION, accountKey: acct, savedAt: Date.now(), entries };
      if (writeIndex(file) === "ok") {
        disk = { accountKey: acct, entries };
        diskVerified = { at: Date.now(), ctl: new AbortController(), promise: Promise.resolve("match") }; // saved under the live drive's own account key
      }
    } catch (err) {
      logger.warn("Persistent walk index not updated:", err instanceof Error ? err.message : String(err));
    }
  });
}

/** Stops background index refreshes (process shutdown). */
export function abortBackgroundRefreshes(): void {
  shuttingDown = true;
  diskVerified?.ctl.abort(new Error("walk aborted"));
  for (const r of refreshes.values()) r.controller.abort(new Error("walk aborted"));
}

/** True when a refresh is running (or was just started); false while a failed one cools down. */
function startRefresh(svc: DriveService, p: WalkParams): boolean {
  if (refreshes.has(p.key)) return true;
  const failed = refreshFailedAt.get(p.key);
  if (failed !== undefined && Date.now() - failed < cooldownMs()) return false;
  if (!exitHooked) { exitHooked = true; process.once("exit", abortBackgroundRefreshes); }
  const controller = new AbortController();
  const rec = { controller, root: p.root, superseded: false, promise: Promise.resolve() };
  const startSeq = invalidationSeq;
  refreshes.set(p.key, rec);
  // Own signal, not the triggering request's: that request has already returned.
  rec.promise = callContext.run({ signal: controller.signal }, () => runWalk(svc, p, controller.signal))
    .then((w) => {
      if (rec.superseded) return;
      if (!w.complete) { refreshFailedAt.set(p.key, Date.now()); return; } // keep the stale entry rather than store a partial tree
      refreshFailedAt.delete(p.key);
      remember(p, w);
      persist(svc, p, w, startSeq);
    })
    .catch((err) => {
      if (controller.signal.aborted) return;
      refreshFailedAt.set(p.key, Date.now());
      logger.warn("Background walk refresh failed:", err instanceof Error ? err.message : String(err));
    })
    .finally(() => { if (refreshes.get(p.key) === rec) refreshes.delete(p.key); });
  return true;
}

async function diskLookup(svc: DriveService, p: WalkParams, signal: AbortSignal | undefined): Promise<WalkResult | undefined> {
  if (!indexEnabled() || indexMaxAgeMs() <= 0) return undefined;
  const find = () => pick(diskCandidates(), p.root, p.maxDepth, p.key, p.excludeKey, p.exclude);
  if (!find()) return undefined;
  if (!(await verifyDisk(svc, signal))) return undefined;
  const hit = find(); // the file may have been invalidated or discarded while we checked the account
  if (!hit) return undefined;
  const res = fromCache(hit.e, p.root, p.maxDepth, p.exclude, hit.exact);
  if (res.ageMs < ttlMs()) return { ...res, stale: true };
  return { ...res, stale: true, ...(startRefresh(svc, p) ? { refreshing: true } : {}) };
}

/**
 * Breadth-first walk of a Drive folder with bounded parallelism. A folder that
 * still fails after one retry goes to `skipped` (its subtree is never dropped
 * silently); maxCalls/maxDepth cuts set `complete: false`. Results are cached
 * for PROTON_DRIVE_WALK_TTL_MS (default 5 min); a walk of a subfolder can be
 * served from a cached walk of an ancestor. With PROTON_DRIVE_INDEX=1 complete
 * walks are also saved to disk and served stale-while-revalidate in a new process.
 */
export async function walkTree(svc: DriveService, rootPath: string, opts: WalkOptions = {}): Promise<WalkResult> {
  const root = normalizeRoot(rootPath);
  const maxDepth = opts.maxDepth === undefined ? undefined : Math.max(1, Math.floor(opts.maxDepth));
  const maxCalls = Math.max(1, Math.floor(opts.maxCalls ?? DEFAULT_MAX_CALLS));
  const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(opts.concurrency ?? defaultConcurrency())));
  const excludeList = [...new Set(opts.exclude ?? DEFAULT_EXCLUDE)].sort();
  const exclude = new Set(excludeList);
  const signal = opts.signal ?? callContext.getStore()?.signal;
  if (signal?.aborted) throw abortError(signal);

  const excludeKey = excludeList.join("\0");
  const key = [root, maxDepth ?? "", maxCalls, excludeKey].join("\0");
  const params: WalkParams = { root, maxDepth, maxCalls, concurrency, excludeList, exclude, key, excludeKey };
  if (!opts.refresh) {
    const hit = lookup(root, maxDepth, key, excludeKey, exclude);
    if (hit) return hit;
    if (!opts.noDisk) {
      const fromDisk = await diskLookup(svc, params, signal);
      if (fromDisk) return fromDisk;
    }
  }

  const budgetMs = opts.budgetMs !== undefined && Number.isFinite(opts.budgetMs) && opts.budgetMs >= 0 ? opts.budgetMs : defaultBudgetMs();
  const rec = joinOrStartWalk(svc, params);
  const out = await waitForWalk(rec, signal, budgetMs);
  if (out.partial) return out.partial;
  const w = out.full;
  return { root, nodes: w.nodes.slice(), complete: w.complete, callsMade: w.callsMade, skipped: w.skipped.slice(), fromCache: false, ageMs: 0 };
}

/** One shared walk per key: it runs on its own signal, caches itself when done, and callers only wait for it. */
function joinOrStartWalk(svc: DriveService, p: WalkParams): WalkRec & { fg: NonNullable<WalkRec["fg"]> } {
  const existing = refreshes.get(FG + p.key);
  if (existing?.fg && !existing.superseded && !existing.controller.signal.aborted) return existing as WalkRec & { fg: NonNullable<WalkRec["fg"]> };
  if (!exitHooked) { exitHooked = true; process.once("exit", abortBackgroundRefreshes); }
  const controller = new AbortController();
  const live = newLive(p.root);
  const startSeq = invalidationSeq;
  const rec: WalkRec = { controller, root: p.root, superseded: false, promise: Promise.resolve() };
  const done = callContext.run({ signal: controller.signal }, () => runWalk(svc, p, controller.signal, live)).then(
    (w) => {
      if (refreshes.get(FG + p.key) === rec) refreshes.delete(FG + p.key);
      if (!rec.superseded) { remember(p, w); persist(svc, p, w, startSeq); }
      return w;
    },
    (err) => {
      if (refreshes.get(FG + p.key) === rec) refreshes.delete(FG + p.key);
      throw err;
    }
  );
  rec.fg = { live, startedAt: Date.now(), waiters: 0, partialReturned: false, done };
  rec.promise = done.then(() => undefined, () => undefined);
  refreshes.set(FG + p.key, rec);
  return rec as WalkRec & { fg: NonNullable<WalkRec["fg"]> };
}

type Waited = { full: RawWalk; partial?: undefined } | { partial: WalkResult; full?: undefined };

/**
 * Waits for the shared walk. At the budget it returns what the walk has so far and leaves the walk running. A caller's
 * abort rejects only that caller; it stops the walk only when nobody else waits and no partial result was handed out.
 */
function waitForWalk(rec: WalkRec & { fg: NonNullable<WalkRec["fg"]> }, signal: AbortSignal | undefined, budgetMs: number): Promise<Waited> {
  const { fg } = rec;
  fg.waiters++;
  return new Promise<Waited>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const leave = () => { settled = true; fg.waiters--; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    const onAbort = () => {
      if (settled) return;
      leave();
      if (fg.waiters === 0 && !fg.partialReturned) rec.controller.abort(abortError(signal));
      reject(abortError(signal));
    };
    if (signal?.aborted) return onAbort(); // aborted while the index lookup ran
    signal?.addEventListener("abort", onAbort, { once: true });
    fg.done.then(
      (full) => { if (!settled) { leave(); resolve({ full }); } },
      (err) => { if (!settled) { leave(); reject(err); } }
    );
    if (budgetMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        leave();
        fg.partialReturned = true;
        resolve({ partial: snapshot(rec, budgetMs) });
      }, Math.max(0, budgetMs - (Date.now() - fg.startedAt)));
    }
  });
}

/** What the walk has listed so far; every folder not yet listed is reported as skipped. */
function snapshot(rec: WalkRec & { fg: NonNullable<WalkRec["fg"]> }, budgetMs: number): WalkResult {
  const { live } = rec.fg;
  const unlisted = [...live.queue.map((q) => q.path), ...live.active].map((path) => ({ path, reason: "not listed yet: time budget" }));
  const skipped = [...live.skipped, ...unlisted].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    root: rec.root, nodes: live.nodes.slice().sort(byPath), skipped, complete: false, callsMade: live.callsMade,
    fromCache: false, ageMs: 0, partial: true, continuing: true, budgetMs,
  };
}

/** Drop cached walks that contain `path` (call after the server itself writes there). */
export function invalidatePath(path: string): void {
  const p = normalizeRoot(path);
  const related = (root: string) => isUnder(root, p) || isUnder(p, root);
  invalidationSeq++;
  for (const [k, e] of cache) if (related(e.root)) cache.delete(k);
  for (const r of refreshes.values()) {
    if (!related(r.root)) continue;
    r.superseded = true;
    // A foreground walk someone still waits for finishes for them (as before) but is not cached.
    if (!r.fg || r.fg.waiters === 0) r.controller.abort(new Error("walk superseded"));
  }
  // Memory first: nothing related may be served from the loaded state, whatever happens to the file.
  if (disk) {
    const keepMem = disk.entries.filter((e) => !related(e.root));
    disk = keepMem.length ? { accountKey: disk.accountKey, entries: keepMem } : null;
  }
  if (!indexEnabled()) return;
  try {
    const f = readIndex(); // re-read: another process may have saved since we loaded
    if (!f) return;
    const keep = f.entries.filter((e) => !related(e.root));
    if (keep.length === f.entries.length) return;
    // If the rewrite does not succeed, remove the file so no deleted/moved item can outlive this call.
    if (keep.length === 0 || writeIndex({ ...f, savedAt: Date.now(), entries: keep }) !== "ok") deleteIndex();
  } catch {
    try { deleteIndex(); } catch { /* never fail a write because of the index */ }
  }
}

/** Test hook: drop all in-process state (memory cache, loaded index, background refreshes). */
export function resetWalkCacheForTests(): void {
  limiter = undefined;
  abortBackgroundRefreshes();
  refreshes.clear();
  cache.clear();
  disk = undefined;
  diskVerified = undefined;
  knownAccountKey = undefined;
  refreshFailedAt.clear();
  shuttingDown = false;
}

/** Test hook: resolves when background refreshes and index writes have finished. */
export async function flushWalkIndexForTests(): Promise<void> {
  do {
    await Promise.allSettled([...refreshes.values()].map((r) => r.promise));
    await persistChain;
  } while (refreshes.size > 0);
}
