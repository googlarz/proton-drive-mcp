import type { DriveService } from "./drive.js";
import { DriveNotAuthenticatedError } from "../utils/errors.js";
import { callContext } from "../utils/subprocess.js";
import { logger } from "../utils/logger.js";
import { Semaphore } from "../utils/semaphore.js";
import { indexEnabled, indexMaxAgeMs, folderMaxAgeMs, readIndex, writeIndex, deleteIndex, INDEX_VERSION, MAX_ENTRIES, type IndexEntry, type IndexFile } from "./walkIndex.js";

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
  /**
   * Oldest folder listing (ms) the result may be built from. With PROTON_DRIVE_INDEX=1 and a saved tree for the root, listings
   * younger than this are reused and only older or unknown folders are listed again, oldest first (an incremental walk).
   * Default: the memory cache TTL for `noDisk` callers, otherwise PROTON_DRIVE_INDEX_FOLDER_MAX_AGE_H.
   */
  maxListingAgeMs?: number;
  /** Walk incrementally even without a saved tree, never answer from memory or the index, and always save progress (drive_refresh_index). */
  resumable?: boolean;
  /** Incremental walks: count what the re-listed folders gained, lost or changed (WalkResult.changes). */
  trackChanges?: boolean;
  signal?: AbortSignal;
}

/** What re-listed folders gained, lost or changed compared with their previous listing. */
export interface WalkChanges { added: number; removed: number; modified: number; samples: { kind: "added" | "removed" | "modified"; path: string }[] }

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
  /** Incremental walks only: folder listings read in this call, reused from the saved index, and still older than the allowed age or never read. */
  foldersRefreshed?: number;
  foldersReused?: number;
  foldersRemaining?: number;
  /** Incremental walks only: age of the oldest folder listing the result is built from (also `ageMs`). */
  oldestListingAgeMs?: number;
  /** Incremental walks with trackChanges only. */
  changes?: WalkChanges;
}

/** Output fields for results served from the persistent index while a refresh runs (empty otherwise). */
export const staleFields = (w: Pick<WalkResult, "stale" | "refreshing">) =>
  w.stale ? { stale: true, ...(w.refreshing ? { refreshing: true } : {}) } : {};

/** Output fields for a result cut short by the time budget (empty otherwise). */
export const partialFields = (w: Pick<WalkResult, "partial" | "budgetMs" | "foldersRefreshed" | "foldersReused" | "foldersRemaining" | "oldestListingAgeMs">): { partial?: true; continuing?: true; foldersRefreshed?: number; foldersReused?: number; foldersRemaining?: number; oldestListingAgeMs?: number; note?: string } =>
  w.partial
    ? {
      partial: true, continuing: true,
      ...(w.foldersRemaining === undefined ? {} : { foldersRefreshed: w.foldersRefreshed, foldersReused: w.foldersReused, foldersRemaining: w.foldersRemaining, oldestListingAgeMs: w.oldestListingAgeMs }),
      note: w.foldersRemaining === undefined
        ? `Partial: the drive walk was still running after ${(w.budgetMs ?? 0) / 1000} s; repeat the call in a minute for the full result.`
        : `Partial: the saved index is being refreshed in slices; ${w.foldersRemaining} folder listing(s) are still older than the allowed age or unread, so some entries may be out of date. Repeat the call to continue (drive_refresh_index does the same with a larger budget).`,
    }
    : {};

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
    // A subpath the ancestor never saw as a folder must be walked fresh so it fails like a cold call (the root of a walk is not one of its nodes).
    if (root !== e.root && !e.nodes.some((n) => n.path === root && n.type === "folder")) continue;
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
  /** Set for an incremental walk: it merges fresh listings into the saved tree `entry` (none = start from the root) instead of walking from scratch. */
  inc?: { entry?: IndexEntry; maxAgeMs: number; deadlineAt?: number; track: boolean };
}
/** Walk state a time-budget snapshot can read while the walk runs. */
interface LiveWalk { nodes: WalkNode[]; skipped: { path: string; reason: string }[]; queue: { path: string; depth: number }[]; active: Set<string>; callsMade: number; listed: Map<string, number> }
const newLive = (root: string): LiveWalk => ({ nodes: [], skipped: [], queue: [{ path: root, depth: 0 }], active: new Set(), callsMade: 0, listed: new Map() });
interface RawWalk {
  nodes: WalkNode[]; skipped: { path: string; reason: string }[]; callsMade: number; complete: boolean;
  /** Folder path -> ms its listing was read, for every folder the nodes contain a listing of. */
  listed: Map<string, number>;
  inc?: IncStats;
}

type ListEntries = Awaited<ReturnType<DriveService["listEntries"]>>;

/** `fs list` with the process-wide concurrency cap and one retry, counting calls in `live`. */
function makeLister(svc: DriveService, signal: AbortSignal | undefined, live: { callsMade: number }, maxCalls: number) {
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
  return async (path: string): Promise<ListEntries> => {
    try {
      return await listOnce(path);
    } catch (err) {
      if (err instanceof DriveNotAuthenticatedError || signal?.aborted || live.callsMade >= maxCalls) throw err;
      await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
      if (signal?.aborted) throw err;
      return listOnce(path);
    }
  };
}

function toNode({ item, file }: ListEntries[number]): WalkNode {
  const rev = (item.activeRevision ?? {}) as Record<string, unknown>;
  const digests = (rev.claimedDigests ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    path: file.path, uid: item.uid as string, parentUid: str(item.parentUid), type: file.type,
    mediaType: file.mimeType, size: file.size, storageSize: file.storageSize,
    mtime: str(rev.claimedModificationTime), uploadedAt: file.modifiedAt, sha1: str(digests.sha1),
    isShared: typeof item.isShared === "boolean" ? item.isShared : undefined,
    isSharedByUrl: typeof item.isSharedByUrl === "boolean" ? item.isSharedByUrl : undefined,
  };
}

/** The actual breadth-first walk (no caching). */
async function runWalk(svc: DriveService, p: WalkParams, signal: AbortSignal | undefined, live: LiveWalk = newLive(p.root)): Promise<RawWalk> {
  const { root, maxDepth, maxCalls, concurrency, exclude } = p;
  const { nodes, skipped, queue } = live;
  let active = 0;
  const listWithRetry = makeLister(svc, signal, live, maxCalls);

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

    const handle = (job: { path: string; depth: number }, entries: ListEntries) => {
      live.listed.set(job.path, Date.now());
      for (const entry of entries) {
        const { item, file } = entry;
        if (typeof item.uid !== "string") continue; // "/" lists path-only roots, not nodes
        const node = toNode(entry);
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
  return { nodes, skipped, callsMade: live.callsMade, complete: skipped.length === 0 && !isDepthCut(nodes, depthOf(root), maxDepth, exclude), listed: live.listed };
}

function remember(p: WalkParams, w: RawWalk, createdAt = Date.now()): void {
  cache.delete(p.key);
  cache.set(p.key, { root: p.root, key: p.key, excludeKey: p.excludeKey, maxDepth: p.maxDepth, createdAt, nodes: w.nodes, skipped: w.skipped, complete: w.complete });
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
}

// ---- incremental walk: merge fresh listings into a saved tree ---------------------
// The Drive listing carries no usable change signal for a folder (a folder's modification time does not move when its
// contents change, directly or deeper), so the only sound rule is age: a listing younger than the allowed age is reused,
// anything older (or never read) is listed again, oldest first. Changes below a reused folder stay unseen until it ages out.

interface IncStats {
  /** Listings read by this call, reused from the saved tree, and (at the end) still older than allowed or never read. */
  refreshed: number; reused: number; remaining: number;
  /** Folders whose listing failed in this call. */
  failed: number;
  /** Why the walk stopped with listings left to do. */
  stop?: "time" | "calls";
  oldestListedAt?: number;
  changes?: WalkChanges;
}

/** A saved tree: every folder's children as last listed, and when. */
interface Tree {
  root: string;
  kids: Map<string, WalkNode[]>;
  /** Folder path -> uid, for every folder node below the root. */
  folders: Map<string, string>;
  listed: Map<string, number>;
  changes?: WalkChanges;
}

function treeFromEntry(root: string, exclude: Set<string>, entry: IndexEntry | undefined, track: boolean): Tree {
  const t: Tree = { root, kids: new Map(), folders: new Map(), listed: new Map(), ...(track ? { changes: { added: 0, removed: 0, modified: 0, samples: [] } } : {}) };
  if (!entry) return t;
  for (const n of entry.nodes) {
    const parent = parentPath(n.path);
    const list = t.kids.get(parent);
    if (list) list.push(n); else t.kids.set(parent, [n]);
    if (n.type === "folder") t.folders.set(n.path, n.uid);
  }
  if (entry.listed) {
    for (const [path, at] of Object.entries(entry.listed)) if (path === root || t.folders.has(path)) t.listed.set(path, at);
  } else {
    // A version 1 file saved complete walks only, so every folder it lists was read at completedAt.
    t.listed.set(root, entry.completedAt);
    for (const path of t.folders.keys()) if (!exclude.has(baseName(path))) t.listed.set(path, entry.completedAt);
  }
  return t;
}

/** The tree's nodes in walk order. Anything not reachable from the root is left out. */
function flatten(t: Tree): WalkNode[] {
  const out: WalkNode[] = [], seen = new Set<string>(), stack = [t.root];
  while (stack.length) {
    const path = stack.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    for (const n of t.kids.get(path) ?? []) { out.push(n); if (n.type === "folder") stack.push(n.path); }
  }
  return out.sort(byPath);
}

const SAMPLES_PER_KIND = 16;
function noteChange(t: Tree, kind: "added" | "removed" | "modified", path: string, sample = true): void {
  const c = t.changes;
  if (!c) return;
  c[kind]++;
  if (sample && c.samples.filter((s) => s.kind === kind).length < SAMPLES_PER_KIND) c.samples.push({ kind, path });
}
const changedNode = (a: WalkNode, b: WalkNode) =>
  a.size !== b.size || a.mtime !== b.mtime || a.uploadedAt !== b.uploadedAt || a.sha1 !== b.sha1 || a.isShared !== b.isShared || a.isSharedByUrl !== b.isSharedByUrl;

/** Forgets a removed folder's cached descendants and listing times, so nothing below a deleted, moved or renamed folder survives. */
function dropSubtree(t: Tree, n: WalkNode): void {
  if (n.type !== "folder") return;
  const stack = [n.path];
  while (stack.length) {
    const path = stack.pop()!;
    for (const c of t.kids.get(path) ?? []) { noteChange(t, "removed", c.path, false); if (c.type === "folder") stack.push(c.path); }
    t.kids.delete(path);
    t.listed.delete(path);
    t.folders.delete(path);
  }
}

/** Replaces one folder's children with its fresh listing. Returns the folders that are new (their contents are unknown). */
function applyListing(t: Tree, folder: string, fresh: WalkNode[], at: number): WalkNode[] {
  const old = t.kids.get(folder) ?? [];
  const freshBy = new Map(fresh.map((n) => [n.uid, n]));
  const oldBy = new Map(old.map((n) => [n.uid, n]));
  const same = (a: WalkNode, b: WalkNode | undefined) => !!b && a.path === b.path && a.type === b.type;
  // Removals first: a renamed or replaced folder can leave a new one at the old path.
  for (const o of old) {
    if (same(o, freshBy.get(o.uid))) continue;
    noteChange(t, "removed", o.path);
    dropSubtree(t, o);
  }
  const added: WalkNode[] = [];
  for (const n of fresh) {
    const o = oldBy.get(n.uid);
    if (o && same(n, o)) { if (t.changes && changedNode(o, n)) noteChange(t, "modified", n.path); continue; }
    noteChange(t, "added", n.path);
    if (n.type === "folder") { t.folders.set(n.path, n.uid); added.push(n); }
  }
  t.kids.set(folder, fresh);
  t.listed.set(folder, at);
  return added;
}

/**
 * Lists the folders of the saved tree (p.inc.entry; empty = from the root) whose listing is older than p.inc.maxAgeMs or was never
 * read, oldest first, merging each fresh listing in. Stops at the deadline or the call limit; what is left stays as it was (nothing is
 * deleted from a folder that was not listed) and is reported as skipped, so a stopped walk is never complete.
 */
async function runIncremental(svc: DriveService, p: WalkParams, signal: AbortSignal | undefined, live: LiveWalk): Promise<RawWalk> {
  const inc = p.inc!;
  const { root, maxCalls, concurrency, exclude } = p;
  const t = treeFromEntry(root, exclude, inc.entry, inc.track);
  const cutoff = Date.now() - inc.maxAgeMs;
  const listable = (path: string) => path === root || !exclude.has(baseName(path));
  const stale = (path: string) => { const at = t.listed.get(path); return at === undefined || at < cutoff; };
  const all = [root, ...t.folders.keys()].filter(listable);
  const todo = all.filter(stale)
    .map((path) => ({ path, uid: path === root ? "" : t.folders.get(path)!, at: t.listed.get(path) ?? 0, depth: depthOf(path) }))
    .sort((a, b) => a.at - b.at || a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const reused = all.length - todo.length;

  const discovered: { path: string; uid: string }[] = []; // folders first seen in this walk go before everything else
  let next = 0, head = 0, active = 0, refreshed = 0;
  let stop: "time" | "calls" | undefined;
  const failed = new Map<string, string>();
  const more = () => head < discovered.length || next < todo.length;
  const listWithRetry = makeLister(svc, signal, live, maxCalls);

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

    const pump = () => {
      if (settled) return;
      while (active < concurrency && more()) {
        if (live.callsMade >= maxCalls) { stop = "calls"; break; }
        if (inc.deadlineAt !== undefined && Date.now() >= inc.deadlineAt) { stop = "time"; break; }
        const job = head < discovered.length ? discovered[head++]! : todo[next++]!;
        if (job.path !== root && t.folders.get(job.path) !== job.uid) continue; // dropped or replaced by an earlier listing of this walk
        active++;
        live.active.add(job.path);
        listWithRetry(job.path)
          .then((entries) => {
            const children = entries.filter(({ item }) => typeof item.uid === "string").map(toNode);
            for (const f of applyListing(t, job.path, children, Date.now())) if (listable(f.path)) discovered.push({ path: f.path, uid: f.uid });
            refreshed++;
          })
          .catch((err) => {
            if (job.path === root || err instanceof DriveNotAuthenticatedError) return finish(err);
            failed.set(job.path, String(err instanceof Error ? err.message : err).slice(0, 200));
          })
          .finally(() => { active--; live.active.delete(job.path); pump(); });
      }
      if (active === 0 && (stop || !more())) finish();
    };
    pump();
  });

  const skipped: { path: string; reason: string }[] = [];
  let oldest: number | undefined;
  for (const path of [root, ...t.folders.keys()]) {
    if (!listable(path)) continue;
    const at = t.listed.get(path);
    if (at !== undefined && (oldest === undefined || at < oldest)) oldest = at;
    if (stale(path)) skipped.push({ path, reason: failed.get(path) ?? (stop === "calls" ? `not listed: maxCalls (${maxCalls}) reached` : "not refreshed yet: time budget") });
  }
  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const complete = skipped.length === 0;
  return {
    nodes: flatten(t), skipped, callsMade: live.callsMade, complete, listed: t.listed,
    inc: { refreshed, reused, remaining: skipped.length, failed: failed.size, ...(complete ? {} : { stop }), oldestListedAt: oldest, changes: t.changes },
  };
}

function incResult(root: string, w: RawWalk): WalkResult {
  const s = w.inc!;
  const ageMs = s.oldestListedAt === undefined ? 0 : Math.max(0, Date.now() - s.oldestListedAt);
  return {
    root, nodes: w.nodes.slice(), complete: w.complete, callsMade: w.callsMade, skipped: w.skipped.slice(),
    fromCache: s.refreshed === 0, ageMs,
    ...(s.reused > 0 || !w.complete ? { stale: true } : {}),
    ...(s.stop ? { partial: true, continuing: true } : {}),
    foldersRefreshed: s.refreshed, foldersReused: s.reused, foldersRemaining: s.remaining, oldestListingAgeMs: ageMs,
    ...(s.changes ? { changes: s.changes } : {}),
  };
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

/** Identifies the signed-in account's Drive (see fingerprint). Undefined when it cannot be determined. */
export async function currentAccountKey(svc: DriveService): Promise<string | undefined> {
  knownAccountKey ??= fingerprint((await svc.listEntries(ACCOUNT_ROOT)).map((e) => e.item));
  return knownAccountKey;
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

/** Age of a saved tree = its oldest folder listing (entries without per-folder times were saved complete at completedAt). */
const oldestMemo = new WeakMap<IndexEntry, number>();
function oldestListedAt(e: IndexEntry): number {
  let at = oldestMemo.get(e);
  if (at === undefined) {
    at = Infinity;
    for (const v of e.listed ? Object.values(e.listed) : []) if (v < at) at = v;
    if (at === Infinity) at = e.completedAt;
    oldestMemo.set(e, at);
  }
  return at;
}

/** True when every folder that a walk of this scope lists has a listing time; a tree from an unfinished refresh is only partial. */
const completeMemo = new WeakMap<IndexEntry, boolean>();
function treeComplete(e: IndexEntry): boolean {
  let c = completeMemo.get(e);
  if (c === undefined) {
    const { listed } = e;
    const ex = new Set(e.opts.exclude), rootDepth = depthOf(e.root), md = e.opts.maxDepth;
    c = !listed || (listed[e.root] !== undefined && e.nodes.every((n) =>
      n.type !== "folder" || ex.has(baseName(n.path)) || (md !== undefined && depthOf(n.path) - rootDepth >= md) || listed[n.path] !== undefined));
    completeMemo.set(e, c);
  }
  return c;
}

const toCacheEntry = (e: IndexEntry): CacheEntry => ({
  root: e.root, key: e.key, excludeKey: e.opts.exclude.join("\0"), maxDepth: e.opts.maxDepth,
  createdAt: oldestListedAt(e), nodes: e.nodes, skipped: [], complete: true,
});

function diskCandidates(): CacheEntry[] {
  const st = loadDisk();
  const now = Date.now(), maxAge = indexMaxAgeMs();
  return st ? st.entries.filter((e) => { const age = now - oldestListedAt(e); return Number.isFinite(age) && age >= 0 && age <= maxAge && treeComplete(e); }).map(toCacheEntry) : [];
}

const sameScope = (e: IndexEntry, p: WalkParams) => e.root === p.root && e.opts.maxDepth === p.maxDepth && e.opts.exclude.join("\0") === p.excludeKey;

/** Incremental walks need the opt-in index, a full-depth walk and a root inside the account (the only place the index saves). */
const incPossible = (p: WalkParams) => indexEnabled() && indexMaxAgeMs() > 0 && p.maxDepth === undefined && isUnder(p.root, ACCOUNT_ROOT);

/** The saved tree for exactly this scope (any age, complete or partial), once the index is proven to belong to the signed-in account. */
async function incSeed(svc: DriveService, p: WalkParams, signal: AbortSignal | undefined, check: AccountCheck): Promise<IndexEntry | undefined> {
  const find = () => loadDisk()?.entries.find((e) => sameScope(e, p));
  if (check.failed || !find()) return undefined;
  if (!(await verifyDisk(svc, signal))) { check.failed = true; return undefined; }
  return find();
}

let lastPersistOk = false;
/** Waits for queued index writes; true when the most recent one reached the disk. */
export async function settleIndexWrites(): Promise<boolean> {
  await persistChain;
  return lastPersistOk;
}

/** Saves a complete walk, or (incremental walks) whatever progress it made: unfinished folders simply have no listing time. */
function persist(svc: DriveService, p: WalkParams, w: RawWalk, startSeq: number): void {
  if (!indexEnabled() || (!w.complete && !w.inc) || !isUnder(p.root, ACCOUNT_ROOT)) return;
  persistChain = persistChain.then(async () => {
    lastPersistOk = false;
    try {
      if (shuttingDown || invalidationSeq !== startSeq) return; // a write happened mid-walk: do not save a possibly outdated tree
      let acct = knownAccountKey ?? (p.root === ACCOUNT_ROOT ? fingerprint(w.nodes.filter((n) => depthOf(n.path) === 2)) : undefined);
      if (!acct) acct = fingerprint((await svc.listEntries(ACCOUNT_ROOT)).map((e) => e.item));
      if (!acct || shuttingDown || invalidationSeq !== startSeq) return;
      knownAccountKey = acct;
      const cur = loadDisk();
      const base = cur && cur.accountKey === acct ? cur.entries : [];
      const entry: IndexEntry = { key: p.key, root: p.root, opts: { maxDepth: p.maxDepth, maxCalls: p.maxCalls, exclude: p.excludeList }, completedAt: Date.now(), nodes: w.nodes, listed: Object.fromEntries(w.listed) };
      const entries = [entry, ...base.filter((e) => !sameScope(e, p))].sort((a, b) => b.completedAt - a.completedAt).slice(0, MAX_ENTRIES);
      const file: IndexFile = { version: INDEX_VERSION, accountKey: acct, savedAt: Date.now(), entries };
      if (writeIndex(file) === "ok") {
        disk = { accountKey: acct, entries };
        lastPersistOk = true;
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
  // A saved tree for this scope is refreshed in place (listings younger than the memory TTL are kept), so a refresh that is cut short still saves its progress.
  const entry = incPossible(p) && ttlMs() > 0 ? loadDisk()?.entries.find((e) => sameScope(e, p)) : undefined;
  const bg: WalkParams = entry ? { ...p, inc: { entry, maxAgeMs: ttlMs(), track: false } } : p;
  // Own signal, not the triggering request's: that request has already returned.
  rec.promise = callContext.run({ signal: controller.signal }, () => (bg.inc ? runIncremental(svc, bg, controller.signal, newLive(p.root)) : runWalk(svc, p, controller.signal)))
    .then((w) => {
      if (rec.superseded) return;
      if (w.inc) {
        if (w.inc.failed > 0 || (!w.complete && w.inc.refreshed === 0)) refreshFailedAt.set(p.key, Date.now()); else refreshFailedAt.delete(p.key);
        if (w.complete) remember(p, w, w.inc.oldestListedAt);
        persist(svc, p, w, startSeq);
        return;
      }
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

/** Whether this call already failed to prove the saved index belongs to the signed-in account (it is not retried within the call). */
interface AccountCheck { failed: boolean }

async function diskLookup(svc: DriveService, p: WalkParams, signal: AbortSignal | undefined, check: AccountCheck, maxAgeMs?: number): Promise<WalkResult | undefined> {
  if (!indexEnabled() || indexMaxAgeMs() <= 0) return undefined;
  const find = () => pick(diskCandidates(), p.root, p.maxDepth, p.key, p.excludeKey, p.exclude);
  if (!find()) return undefined;
  if (!(await verifyDisk(svc, signal))) { check.failed = true; return undefined; }
  const hit = find(); // the file may have been invalidated or discarded while we checked the account
  if (!hit) return undefined;
  const res = fromCache(hit.e, p.root, p.maxDepth, p.exclude, hit.exact);
  if (maxAgeMs !== undefined && res.ageMs > maxAgeMs) return undefined; // the caller needs fresher listings than the index has
  // A depth-limited answer cut from a deeper saved walk is not refreshed on its own (a depth-cut walk is never saved); that walk is.
  if (res.ageMs < ttlMs() || (p.maxDepth !== undefined && !hit.exact)) return { ...res, stale: true };
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
  // Oldest listing the caller accepts. Callers that cannot use saved data (noDisk) get what the memory cache would give.
  const explicitAge = opts.maxListingAgeMs !== undefined && Number.isFinite(opts.maxListingAgeMs) && opts.maxListingAgeMs >= 0 ? opts.maxListingAgeMs : undefined;
  const listingAgeMs = explicitAge ?? (opts.noDisk ? ttlMs() : Math.min(folderMaxAgeMs(), indexMaxAgeMs()));
  const check: AccountCheck = { failed: false };
  if (!opts.refresh && !opts.resumable) {
    const hit = lookup(root, maxDepth, key, excludeKey, exclude);
    if (hit && (explicitAge === undefined || hit.ageMs <= explicitAge)) return hit;
    if (!opts.noDisk) {
      const fromDisk = await diskLookup(svc, params, signal, check, explicitAge);
      if (fromDisk) return fromDisk;
    }
  }

  const budgetMs = opts.budgetMs !== undefined && Number.isFinite(opts.budgetMs) && opts.budgetMs >= 0 ? opts.budgetMs : defaultBudgetMs();
  if (!opts.refresh && listingAgeMs > 0 && incPossible(params)) {
    const entry = await incSeed(svc, params, signal, check);
    if (entry || opts.resumable) params.inc = { entry, maxAgeMs: listingAgeMs, track: opts.trackChanges === true, deadlineAt: budgetMs > 0 ? Date.now() + budgetMs : undefined };
  }
  const rec = joinOrStartWalk(svc, params);
  // An incremental walk stops itself at its deadline (and saves its progress), so nobody takes a snapshot of it.
  const out = await waitForWalk(rec, signal, params.inc ? 0 : budgetMs);
  if (out.partial) return out.partial;
  const w = out.full;
  if (w.inc) return incResult(root, w);
  return { root, nodes: w.nodes.slice(), complete: w.complete, callsMade: w.callsMade, skipped: w.skipped.slice(), fromCache: false, ageMs: 0 };
}

/** One shared walk per key: it runs on its own signal, caches itself when done, and callers only wait for it. */
function joinOrStartWalk(svc: DriveService, p: WalkParams): WalkRec & { fg: NonNullable<WalkRec["fg"]> } {
  const fgKey = FG + p.key + (p.inc ? `\0inc\0${p.inc.maxAgeMs}` : "");
  const existing = refreshes.get(fgKey);
  if (existing?.fg && !existing.superseded && !existing.controller.signal.aborted) return existing as WalkRec & { fg: NonNullable<WalkRec["fg"]> };
  if (!exitHooked) { exitHooked = true; process.once("exit", abortBackgroundRefreshes); }
  const controller = new AbortController();
  const live = newLive(p.root);
  const startSeq = invalidationSeq;
  const rec: WalkRec = { controller, root: p.root, superseded: false, promise: Promise.resolve() };
  const done = callContext.run({ signal: controller.signal }, () => (p.inc ? runIncremental(svc, p, controller.signal, live) : runWalk(svc, p, controller.signal, live))).then(
    (w) => {
      if (refreshes.get(fgKey) === rec) refreshes.delete(fgKey);
      if (!rec.superseded) {
        if (!w.inc || w.complete) remember(p, w, w.inc?.oldestListedAt);
        persist(svc, p, w, startSeq);
      }
      return w;
    },
    (err) => {
      if (refreshes.get(fgKey) === rec) refreshes.delete(fgKey);
      throw err;
    }
  );
  rec.fg = { live, startedAt: Date.now(), waiters: 0, partialReturned: false, done };
  rec.promise = done.then(() => undefined, () => undefined);
  refreshes.set(fgKey, rec);
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
