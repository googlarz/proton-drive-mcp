import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ROOT_PATHS, splitRemotePath, joinRemote, type DriveService } from "./drive.js";
import { walkTree, staleFields, partialFields, type WalkResult } from "./walk.js";
import { globMatch } from "../utils/glob.js";
import { validateLocalPath, validateRemotePath } from "../utils/validation.js";
import { isProtectedEntry } from "../utils/localguard.js";

// ---- drive_sync_plan: read-only local <-> Drive diff ----------------------------

export const DEFAULT_IGNORE = [".git", "node_modules", ".DS_Store"];
export const MAX_LOCAL_ENTRIES = 50_000;
const MTIME_TOLERANCE_MS = 2000; // Drive stores the claimed mtime; filesystems round differently

export interface LocalFile { path: string; size: number; mtimeMs: number }
export interface LocalScan { files: LocalFile[]; scanned: number; symlinksSkipped: number; unreadable: number; protectedSkipped: number; truncated: boolean }

export type Compare = "size-mtime" | "sha1";
export type Direction = "up" | "down" | "both";
export interface SyncPlanItem { path: string; size?: number; driveSize?: number; reason?: string; newer?: "local" | "drive" }
export interface SyncDiff {
  onlyLocal: SyncPlanItem[];
  onlyDrive: SyncPlanItem[];
  changed: SyncPlanItem[];
  identicalCount: number;
}

export function makeIgnore(patterns: string[]): (relPath: string) => boolean {
  // Glob subset (see utils/glob.ts). A pattern without '/' matches any path segment.
  const compiled = patterns.map((p) => ({ glob: p.replace(/\/+$/, ""), bySegment: !p.replace(/\/+$/, "").includes("/") }));
  return (relPath) => {
    const segs = relPath.split("/");
    return compiled.some(({ glob, bySegment }) =>
      bySegment ? segs.some((s) => globMatch(glob, s)) : segs.some((_, i) => globMatch(glob, segs.slice(0, i + 1).join("/"))));
  };
}

/** Bounded, symlink-safe local scan: symlinks are counted, never followed. */
export function scanLocal(root: string, ignore: (rel: string) => boolean, maxEntries = MAX_LOCAL_ENTRIES): LocalScan {
  const out: LocalScan = { files: [], scanned: 0, symlinksSkipped: 0, unreadable: 0, protectedSkipped: 0, truncated: false };
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)); }
    catch { out.unreadable++; continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(root, full).split(sep).join("/");
      if (ignore(rel)) continue;
      if (out.scanned >= maxEntries) { out.truncated = true; return out; }
      out.scanned++;
      if (e.isSymbolicLink()) { out.symlinksSkipped++; continue; }
      if (isProtectedEntry(full, e.name)) { out.protectedSkipped++; continue; }
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile()) continue;
      try {
        const st = statSync(full);
        out.files.push({ path: rel, size: st.size, mtimeMs: st.mtimeMs });
      } catch { out.unreadable++; }
    }
  }
  return out;
}

export function sha1File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha1");
    createReadStream(path).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

/**
 * Pure diff of a local file list against a walked Drive tree (paths relative to the walk root).
 * `hashLocal` is only called for same-size files when compare is 'sha1' and Drive claims a sha1.
 */
export async function diffTrees(
  local: LocalFile[],
  walk: WalkResult,
  opts: { compare?: Compare; ignore?: (rel: string) => boolean; hashLocal?: (rel: string) => Promise<string> } = {},
): Promise<SyncDiff> {
  const ignore = opts.ignore ?? (() => false);
  const prefix = walk.root === "/" ? "/" : walk.root + "/";
  const remote = new Map<string, WalkResult["nodes"][number]>();
  for (const n of walk.nodes) {
    if (n.type !== "file" || !n.path.startsWith(prefix)) continue;
    const rel = n.path.slice(prefix.length);
    if (!ignore(rel)) remote.set(rel, n);
  }
  const d: SyncDiff = { onlyLocal: [], onlyDrive: [], changed: [], identicalCount: 0 };
  const seen = new Set<string>();
  for (const f of [...local].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const r = remote.get(f.path);
    if (!r) { d.onlyLocal.push({ path: f.path, size: f.size }); continue; }
    seen.add(f.path);
    const item: SyncPlanItem = { path: f.path, size: f.size, driveSize: r.size };
    const driveMs = r.mtime ? Date.parse(r.mtime) : NaN;
    const mtimeDiffers = Number.isFinite(driveMs) && Math.abs(driveMs - f.mtimeMs) > MTIME_TOLERANCE_MS;
    if (typeof r.size === "number" && r.size !== f.size) {
      d.changed.push({ ...item, reason: "size differs", ...(mtimeDiffers ? { newer: f.mtimeMs > driveMs ? "local" : "drive" } as const : {}) });
      continue;
    }
    if (opts.compare === "sha1" && r.sha1 && opts.hashLocal) {
      const same = (await opts.hashLocal(f.path)).toLowerCase() === r.sha1.toLowerCase();
      if (same) d.identicalCount++;
      else d.changed.push({ ...item, reason: "sha1 differs" });
      continue;
    }
    if (mtimeDiffers) d.changed.push({ ...item, reason: "maybe changed (same size, mtime differs)", newer: f.mtimeMs > driveMs ? "local" : "drive" });
    else d.identicalCount++;
  }
  for (const [rel, n] of [...remote].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!seen.has(rel)) d.onlyDrive.push({ path: rel, size: n.size });
  }
  return d;
}

export interface SyncPlanArgs {
  localPath: string;
  drivePath: string;
  direction?: Direction;
  ignore?: string[];
  compare?: Compare;
  limit?: number;
}

const sum = (xs: SyncPlanItem[], pick: (i: SyncPlanItem) => number | undefined) => xs.reduce((t, i) => t + (pick(i) ?? 0), 0);

/** Plan only; nothing is uploaded, downloaded or deleted. `walk` is injectable for tests. */
export async function syncPlan(svc: DriveService, a: SyncPlanArgs, walk: typeof walkTree = walkTree) {
  const localRoot = validateLocalPath(a.localPath, { scan: true }); // same denylist / PROTON_DRIVE_LOCAL_ROOT rules as upload
  const driveRoot = validateRemotePath(a.drivePath);
  if (!lstatSync(localRoot).isDirectory()) throw new Error(`localPath is not a directory: ${localRoot}`);
  const direction = a.direction ?? "up";
  const compare = a.compare ?? "size-mtime";
  const limit = Math.max(1, Math.min(a.limit ?? 200, 1000));
  const patterns = a.ignore ?? DEFAULT_IGNORE;
  const ignore = makeIgnore(patterns);

  const w = await walk(svc, driveRoot, { exclude: patterns.filter((p) => !/[*?/]/.test(p)), noDisk: true, budgetMs: 0 }); // a plan must come from a current, complete walk
  const scan = scanLocal(localRoot, ignore);
  const diff = await diffTrees(scan.files, w, { compare, ignore, hashLocal: (rel) => sha1File(join(localRoot, ...rel.split("/"))) });

  const cap = <T,>(xs: T[]) => xs.slice(0, limit);
  const up = direction !== "down", down = direction !== "up";
  return {
    direction, compare,
    counts: { onlyLocal: diff.onlyLocal.length, onlyDrive: diff.onlyDrive.length, changed: diff.changed.length, identical: diff.identicalCount },
    bytes: {
      ...(up ? { upload: sum(diff.onlyLocal, (i) => i.size) + sum(diff.changed, (i) => i.size) } : {}),
      ...(down ? { download: sum(diff.onlyDrive, (i) => i.size) + sum(diff.changed, (i) => i.driveSize) } : {}),
    },
    onlyLocal: cap(diff.onlyLocal), onlyDrive: cap(diff.onlyDrive), changed: cap(diff.changed),
    listsTruncated: [diff.onlyLocal, diff.onlyDrive, diff.changed].some((l) => l.length > limit),
    complete: w.complete && !scan.truncated,
    driveWalkComplete: w.complete,
    ...staleFields(w),
    ...partialFields(w),
    skipped: cap(w.skipped),
    local: { scanned: scan.scanned, symlinksSkipped: scan.symlinksSkipped, unreadable: scan.unreadable, protectedSkipped: scan.protectedSkipped, truncated: scan.truncated, maxEntries: MAX_LOCAL_ENTRIES },
    note: "Plan only. onlyLocal = not on Drive, onlyDrive = not local; 'maybe changed' compares mtime (Drive claimed time) and can be a false positive." +
      (w.complete ? "" : " Drive walk incomplete: onlyLocal may include files that exist on Drive."),
  };
}

// ---- drive_bulk_move / drive_bulk_trash: stateless plan + problem detection ------

/** folder path -> path tails (escaped names) of its children, or null when the folder does not exist. */
export type Listing = Map<string, Set<string> | null>;
export interface BulkProblem { source?: string; problem: string }
export interface BulkPlan { plan: { source: string; destination?: string }[]; problems: BulkProblem[] }

const isUnder = (p: string, ancestor: string) => p === ancestor || p.startsWith(ancestor === "/" ? "/" : ancestor + "/");

/** Folders whose listing the problem checks need. */
export function foldersToList(sources: string[], destination?: string): string[] {
  return [...new Set([...sources.map((s) => splitRemotePath(s).parent), ...(destination ? [destination] : [])])];
}

function sourceProblems(sources: string[], listing: Listing): BulkProblem[] {
  const problems: BulkProblem[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    if (seen.has(s)) { problems.push({ source: s, problem: "listed more than once" }); continue; }
    seen.add(s);
    if (ROOT_PATHS.has(s) || s === "/") { problems.push({ source: s, problem: "is a root and cannot be used" }); continue; }
    const other = sources.find((o) => o !== s && isUnder(s, o));
    if (other) { problems.push({ source: s, problem: `is inside another listed source (${other})` }); continue; }
    const { parent, name } = splitRemotePath(s);
    if (!listing.get(parent)?.has(name)) problems.push({ source: s, problem: "source not found" });
  }
  return problems;
}

export function planBulkTrash(paths: string[], listing: Listing): BulkPlan {
  const problems = sourceProblems(paths, listing);
  return { plan: problems.length ? [] : paths.map((source) => ({ source })), problems };
}

export function planBulkMove(sources: string[], destination: string, listing: Listing): BulkPlan {
  const problems = sourceProblems(sources, listing);
  const destNames = listing.get(destination);
  if (destination === "/") {
    problems.push({ problem: "destination must be a folder, not '/'" });
  } else if (!destNames) {
    problems.push({ problem: `destination folder not found (or not a folder): ${destination}` });
  }
  const already = new Set(problems.map((p) => p.source));
  const names = new Map<string, string>();
  for (const s of sources) {
    if (already.has(s) || ROOT_PATHS.has(s)) continue;
    const { parent, name } = splitRemotePath(s);
    if (isUnder(destination, s)) { problems.push({ source: s, problem: "destination is the source itself or inside it" }); continue; }
    if (parent === destination) { problems.push({ source: s, problem: "already in the destination folder" }); continue; }
    const clash = names.get(name);
    if (clash) { problems.push({ source: s, problem: `same name as ${clash}; both would land in ${destination}` }); continue; }
    names.set(name, s);
    if (destNames?.has(name)) problems.push({ source: s, problem: `name collision: ${name} already exists in ${destination}` });
  }
  return {
    plan: problems.length ? [] : sources.map((source) => ({ source, destination: joinRemote(destination, splitRemotePath(source).name) })),
    problems,
  };
}

// "Invalid link type": the path resolves to a file, so it cannot be listed as a folder.
const isNotFound = (err: unknown) => err instanceof Error && /not found|invalid link type/i.test(err.message);

/** One `filesystem list` per distinct folder, a few at a time; a not-found (or not-a-folder) path maps to null. */
export async function loadListing(svc: DriveService, folders: string[]): Promise<Listing> {
  const listing: Listing = new Map();
  for (let i = 0; i < folders.length; i += 4) {
    await Promise.all(folders.slice(i, i + 4).map(async (f) => {
      try {
        listing.set(f, new Set((await svc.list(f)).map((e) => splitRemotePath(e.path).name)));
      } catch (err) {
        if (!isNotFound(err)) throw err;
        listing.set(f, null);
      }
    }));
  }
  return listing;
}
