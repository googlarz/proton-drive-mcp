import type { DriveService } from "./drive.js";
import { baseName, depthOf, parentPath, DEFAULT_EXCLUDE, walkTree, type WalkNode, type WalkResult } from "./walk.js";
import { validateRemotePath } from "../utils/validation.js";
import { globMatch } from "../utils/glob.js";

// Argument handling shared by the drive_tree / drive_search tools and the CLI.
// Everything is validated here because the CLI does not go through the MCP schema check.

const MAX_PATTERN = 200;
// Bounds the work done per search on a very large walk.
const SCAN_CAP = 100_000;
const SKIPPED_SHOWN = 10;

type Args = Record<string, unknown>;

function str(a: Args, k: string, max = MAX_PATTERN): string | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`${k} must be a string`);
  if (!v) throw new Error(`${k} must not be empty`);
  if (v.length > max) throw new Error(`${k} must be ${max} characters or fewer`);
  if (/[\x00-\x1f\x7f]/.test(v)) throw new Error(`${k} contains control characters`);
  return v;
}

function int(a: Args, k: string, def: number | undefined, min: number, max: number): number | undefined {
  const v = a[k];
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`${k} must be an integer`);
  if (v < min || v > max) throw new Error(`${k} must be between ${min} and ${max}`);
  return v;
}

function bool(a: Args, k: string): boolean {
  const v = a[k];
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") throw new Error(`${k} must be a boolean`);
  return v;
}

function time(a: Args, k: string): number | undefined {
  const v = str(a, k, 40);
  if (v === undefined) return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`${k} must be an ISO date like 2026-01-31 or 2026-01-31T12:00:00Z`);
  return t;
}

function root(a: Args): string {
  const p = validateRemotePath(a.path ?? "/my-files");
  if (p === "/") throw new Error("path must be a folder such as /my-files, not '/'");
  return p;
}

function walkInfo(w: WalkResult, scanned: number, scanCapped: boolean) {
  return {
    complete: w.complete, fromCache: w.fromCache, ageMs: w.ageMs, callsMade: w.callsMade, scanned,
    ...(scanCapped ? { scanCapped: true } : {}),
    ...(w.skipped.length ? { skippedCount: w.skipped.length, skipped: w.skipped.slice(0, SKIPPED_SHOWN) } : {}),
  };
}

// ---- drive_search -----------------------------------------------------------

export async function driveSearch(svc: DriveService, a: Args) {
  const path = root(a);
  const query = str(a, "query")?.toLowerCase();
  const globRaw = str(a, "glob");
  const type = str(a, "type", 10);
  if (type !== undefined && type !== "file" && type !== "folder") throw new Error("type must be 'file' or 'folder'");
  const mediaType = str(a, "mediaType", 100)?.toLowerCase();
  const minSize = int(a, "minSize", undefined, 0, Number.MAX_SAFE_INTEGER);
  const maxSize = int(a, "maxSize", undefined, 0, Number.MAX_SAFE_INTEGER);
  const after = time(a, "modifiedAfter");
  const before = time(a, "modifiedBefore");
  let extensions: string[] | undefined;
  if (a.extensions !== undefined && a.extensions !== null) {
    if (!Array.isArray(a.extensions) || a.extensions.length > 50 || a.extensions.some((e) => typeof e !== "string" || !e.replace(/^\./, "") || e.length > 20 || e.includes("/"))) {
      throw new Error("extensions must be up to 50 short strings such as ['pdf', 'docx']");
    }
    extensions = (a.extensions as string[]).map((e) => `.${e.replace(/^\./, "").toLowerCase()}`);
  }
  const sort = str(a, "sort", 10) ?? "name";
  if (sort !== "name" && sort !== "size" && sort !== "mtime") throw new Error("sort must be name, size or mtime");
  const limit = int(a, "limit", 50, 1, 500)!;
  const offset = int(a, "offset", 0, 0, Number.MAX_SAFE_INTEGER)!;
  const refresh = bool(a, "refresh");

  const w = await walkTree(svc, path, { refresh });
  const scanCapped = w.nodes.length > SCAN_CAP;
  const scanned = scanCapped ? SCAN_CAP : w.nodes.length;
  const when = (n: WalkNode) => Date.parse(n.mtime ?? n.uploadedAt ?? "");

  const hits: WalkNode[] = [];
  for (let i = 0; i < scanned; i++) {
    const n = w.nodes[i];
    if (type && n.type !== type) continue;
    if (mediaType && !(n.mediaType ?? "").toLowerCase().startsWith(mediaType)) continue;
    if (minSize !== undefined && !(n.size !== undefined && n.size >= minSize)) continue;
    if (maxSize !== undefined && !(n.size !== undefined && n.size <= maxSize)) continue;
    if (after !== undefined || before !== undefined) {
      const t = when(n);
      if (Number.isNaN(t) || (after !== undefined && t < after) || (before !== undefined && t > before)) continue;
    }
    const name = baseName(n.path);
    if (extensions && !extensions.some((e) => name.toLowerCase().endsWith(e))) continue;
    if (query && !name.toLowerCase().includes(query)) continue;
    if (globRaw !== undefined && !globMatch(globRaw, globRaw.includes("/") ? n.path.slice(path.length + 1) : name, true)) continue;
    hits.push(n);
  }

  // The walk order is already (path, uid); ties fall through to it, so pages are stable.
  const tie = (x: WalkNode, y: WalkNode) => (x.path < y.path ? -1 : x.path > y.path ? 1 : x.uid < y.uid ? -1 : x.uid > y.uid ? 1 : 0);
  const num = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? -Infinity : v); // missing sorts last (descending)
  hits.sort((x, y) => {
    const c = sort === "size" ? num(y.size) - num(x.size) || 0
      : sort === "mtime" ? num(when(y)) - num(when(x)) || 0
      : baseName(x.path).localeCompare(baseName(y.path));
    return (Number.isNaN(c) ? 0 : c) || tie(x, y);
  });

  const items = hits.slice(offset, offset + limit).map((n) => ({
    path: n.path, type: n.type, size: n.size, mtime: n.mtime ?? n.uploadedAt, sha1: n.sha1, mediaType: n.mediaType,
  }));
  return { path, total: hits.length, offset, limit, hasMore: offset + items.length < hits.length, items, walk: walkInfo(w, scanned, scanCapped) };
}

// ---- drive_tree -------------------------------------------------------------

interface TreeEntry {
  name: string;
  type?: "folder";
  size?: number;
  files?: number;
  folders?: number;
  unexpanded?: true;
  more?: number;
  children?: TreeEntry[];
}

export async function driveTree(svc: DriveService, a: Args) {
  const path = root(a);
  const depth = int(a, "depth", 2, 1, 10)!;
  const limit = int(a, "limit", 200, 1, 1000)!;
  const foldersOnly = bool(a, "foldersOnly");
  const refresh = bool(a, "refresh");

  const w = await walkTree(svc, path, { maxDepth: depth, refresh });

  const kids = new Map<string, WalkNode[]>();
  const agg = new Map<string, { files: number; folders: number; size: number }>();
  const aggOf = (p: string) => agg.get(p) ?? agg.set(p, { files: 0, folders: 0, size: 0 }).get(p)!;
  for (const n of w.nodes) {
    const parent = parentPath(n.path);
    (kids.get(parent) ?? kids.set(parent, []).get(parent)!).push(n);
    for (let p = parent; ; p = parentPath(p)) {
      const g = aggOf(p);
      if (n.type === "file") { g.files++; g.size += n.size ?? 0; } else g.folders++;
      if (p === path) break;
    }
  }
  const skippedPaths = new Set(w.skipped.map((s) => s.path));
  // Folders whose contents were never listed: past the depth limit, excluded, or failed/cut.
  const rootDepth = depthOf(path);
  const unlisted = (n: WalkNode) =>
    skippedPaths.has(n.path) || DEFAULT_EXCLUDE.includes(baseName(n.path)) || depthOf(n.path) - rootDepth >= depth;

  const size = (n: WalkNode) => (n.type === "folder" ? agg.get(n.path)?.size : n.size) ?? -1;
  const order = (x: WalkNode, y: WalkNode) =>
    (x.type === y.type ? 0 : x.type === "folder" ? -1 : 1) || size(y) - size(x) || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0);

  const top: TreeEntry = { name: path };
  let budget = limit;
  let unexpandedCount = 0;
  const queue: { out: TreeEntry; node: string }[] = [{ out: top, node: path }];
  for (let q = queue.shift(); q; q = queue.shift()) {
    const children = (kids.get(q.node) ?? []).filter((n) => !(foldersOnly && n.type === "file")).sort(order);
    for (const n of children) {
      if (budget <= 0) { q.out.more = (q.out.more ?? 0) + 1; continue; }
      budget--;
      const e: TreeEntry = { name: baseName(n.path) };
      if (n.type === "folder") {
        e.type = "folder";
        if (unlisted(n)) { e.unexpanded = true; unexpandedCount++; } else {
          const g = agg.get(n.path) ?? { files: 0, folders: 0, size: 0 };
          e.files = g.files; e.folders = g.folders; e.size = g.size;
          queue.push({ out: e, node: n.path });
        }
      } else e.size = n.size;
      (q.out.children ??= []).push(e);
    }
  }
  const total = agg.get(path) ?? { files: 0, folders: 0, size: 0 };
  // Only failures and call-budget cuts make a tree incomplete; the depth limit is the caller's choice
  // (see `unexpanded`), so walk.complete is not used here.
  return {
    path, files: total.files, folders: total.folders, size: total.size,
    complete: w.skipped.length === 0,
    ...(unexpandedCount ? { unexpanded: unexpandedCount } : {}),
    ...(w.skipped.length ? { skippedCount: w.skipped.length, skipped: w.skipped.slice(0, SKIPPED_SHOWN) } : {}),
    fromCache: w.fromCache, ageMs: w.ageMs, callsMade: w.callsMade,
    tree: top.children ?? [], ...(top.more ? { more: top.more } : {}),
  };
}
