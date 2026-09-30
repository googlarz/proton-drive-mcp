import type { DriveService } from "./drive.js";
import { DriveNotAuthenticatedError } from "../utils/errors.js";
import { callContext } from "../utils/subprocess.js";

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
  /** Parallel `fs list` calls (default 8, max 12). */
  concurrency?: number;
  /** Folder names skipped entirely (default: .git, node_modules). */
  exclude?: string[];
  /** Ignore the cache and re-walk. */
  refresh?: boolean;
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
}

export const DEFAULT_EXCLUDE = [".git", "node_modules"];
const DEFAULT_MAX_CALLS = 300;
const MAX_CONCURRENCY = 12; // the CLI's SQLite cache starts failing above this
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

function lookup(root: string, maxDepth: number | undefined, key: string, excludeKey: string, exclude: Set<string>): WalkResult | undefined {
  const now = Date.now(), ttl = ttlMs();
  let best: CacheEntry | undefined;
  for (const [k, e] of cache) {
    if (now - e.createdAt >= ttl) { cache.delete(k); continue; }
    if (e.key === key) return fromCache(e, root, maxDepth, exclude, true); // same request, even if it was partial
    // An ancestor's walk can answer a subfolder request if it saw everything and went deep enough.
    if (e.excludeKey !== excludeKey || e.skipped.length > 0 || !isUnder(root, e.root)) continue;
    const reach = e.maxDepth === undefined ? Infinity : e.maxDepth - (depthOf(root) - depthOf(e.root));
    if (reach < (maxDepth ?? Infinity)) continue;
    if (!best || e.root.length > best.root.length) best = e;
  }
  return best && fromCache(best, root, maxDepth, exclude, false);
}

/**
 * Breadth-first walk of a Drive folder with bounded parallelism. A folder that
 * still fails after one retry goes to `skipped` (its subtree is never dropped
 * silently); maxCalls/maxDepth cuts set `complete: false`. Results are cached
 * for PROTON_DRIVE_WALK_TTL_MS (default 5 min); a walk of a subfolder can be
 * served from a cached walk of an ancestor.
 */
export async function walkTree(svc: DriveService, rootPath: string, opts: WalkOptions = {}): Promise<WalkResult> {
  const root = normalizeRoot(rootPath);
  const maxDepth = opts.maxDepth === undefined ? undefined : Math.max(1, Math.floor(opts.maxDepth));
  const maxCalls = Math.max(1, Math.floor(opts.maxCalls ?? DEFAULT_MAX_CALLS));
  const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(opts.concurrency ?? 8)));
  const excludeList = [...new Set(opts.exclude ?? DEFAULT_EXCLUDE)].sort();
  const exclude = new Set(excludeList);
  const signal = opts.signal ?? callContext.getStore()?.signal;
  if (signal?.aborted) throw abortError(signal);

  const excludeKey = excludeList.join("\0");
  const key = [root, maxDepth ?? "", maxCalls, excludeKey].join("\0");
  if (!opts.refresh) {
    const hit = lookup(root, maxDepth, key, excludeKey, exclude);
    if (hit) return hit;
  }

  const nodes: WalkNode[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  let callsMade = 0;
  let active = 0;

  const listOnce = async (path: string) => {
    callsMade++;
    return svc.listEntries(path);
  };
  // One retry covers a transient failure the subprocess layer already gave up on.
  const listWithRetry = async (path: string) => {
    try {
      return await listOnce(path);
    } catch (err) {
      if (err instanceof DriveNotAuthenticatedError || signal?.aborted || callsMade >= maxCalls) throw err;
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
        if (callsMade >= maxCalls) {
          for (const q of queue.splice(0)) skipped.push({ path: q.path, reason: `not listed: maxCalls (${maxCalls}) reached` });
          break;
        }
        const job = queue.shift()!;
        active++;
        listWithRetry(job.path)
          .then((entries) => handle(job, entries))
          .catch((err) => {
            if (job.depth === 0 || err instanceof DriveNotAuthenticatedError) return finish(err);
            skipped.push({ path: job.path, reason: String(err instanceof Error ? err.message : err).slice(0, 200) });
          })
          .finally(() => { active--; pump(); });
      }
      if (active === 0 && queue.length === 0) finish();
    };
    pump();
  });

  nodes.sort(byPath);
  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const complete = skipped.length === 0 && !isDepthCut(nodes, depthOf(root), maxDepth, exclude);
  cache.delete(key);
  cache.set(key, { root, key, excludeKey, maxDepth, createdAt: Date.now(), nodes, skipped, complete });
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
  return { root, nodes: nodes.slice(), complete, callsMade, skipped: skipped.slice(), fromCache: false, ageMs: 0 };
}

/** Drop cached walks that contain `path` (call after the server itself writes there). */
export function invalidatePath(path: string): void {
  const p = normalizeRoot(path);
  for (const [k, e] of cache) if (isUnder(e.root, p) || isUnder(p, e.root)) cache.delete(k);
}
