import type { DriveService } from "./drive.js";
import { walkTree, currentAccountKey, type WalkNode, type WalkResult } from "./walk.js";
import { indexEnabled, readPrivateJson, writePrivateFile, deletePrivateFile } from "./walkIndex.js";
import { walkMeta, type WalkFn } from "./analytics.js";

const DAY_MS = 86_400_000;
const UNIT_MS: Record<string, number> = { h: 3_600_000, d: DAY_MS, w: 7 * DAY_MS };
const FILE_NAME = "changes-snapshot.json";
export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024;
const MAX_ROOTS = 8;
const DEFAULT_LIMIT = 50;

/** "7d", "12h", "2w" (relative to now) or an ISO date/time. */
export function parseSince(raw: string, now: number): number {
  const rel = /^(\d{1,4})\s*([hdw])$/i.exec(raw.trim());
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2]!.toLowerCase()]!;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) throw new Error(`since must be an ISO date (2026-10-01) or a relative age like 7d, 12h or 2w, got: ${raw.slice(0, 40)}`);
  return t;
}

const ms = (s: string | undefined) => { const t = Date.parse(s ?? ""); return Number.isFinite(t) ? t : undefined; };

/** Newest of the original modification time and the upload time, so a re-upload with an old mtime still counts. */
function changedAt(n: WalkNode): number | undefined {
  const t = [ms(n.mtime), ms(n.uploadedAt)].filter((x): x is number => x !== undefined);
  return t.length ? Math.max(...t) : undefined;
}

export function recentFiles(nodes: WalkNode[], sinceMs: number, limit: number) {
  const hits = nodes
    .filter((n) => n.type === "file")
    .map((n) => ({ n, at: changedAt(n) }))
    .filter((x): x is { n: WalkNode; at: number } => x.at !== undefined && x.at >= sinceMs)
    .sort((a, b) => b.at - a.at || (a.n.path < b.n.path ? -1 : 1));
  return {
    total: hits.length,
    items: hits.slice(0, limit).map(({ n, at }) => ({ path: n.path, size: n.size, changedAt: new Date(at).toISOString(), mtime: n.mtime, uploadedAt: n.uploadedAt })),
  };
}

/** Removes the saved snapshots (`index clear` does this together with the walk index). */
export const deleteChangeSnapshots = (): boolean => deletePrivateFile(FILE_NAME);

// ---- snapshots (PROTON_DRIVE_INDEX=1) ---------------------------------------------------------

export interface SnapEntry { size?: number; mtime?: string; sha1?: string }
interface RootSnapshot { savedAt: number; files: Record<string, SnapEntry> }
interface SnapshotFile { version: number; accountKey: string; roots: Record<string, RootSnapshot> }

function readSnapshotFile(): SnapshotFile | undefined {
  const j = readPrivateJson(FILE_NAME, SNAPSHOT_MAX_BYTES) as Partial<SnapshotFile> | null | undefined;
  if (!j || j.version !== SNAPSHOT_VERSION || typeof j.accountKey !== "string" || !j.roots || typeof j.roots !== "object") return undefined;
  return j as SnapshotFile;
}

export function toSnapshot(nodes: WalkNode[]): Record<string, SnapEntry> {
  const files: Record<string, SnapEntry> = {};
  for (const n of nodes) {
    if (n.type !== "file") continue;
    files[n.path] = { size: n.size, mtime: n.mtime ?? n.uploadedAt, sha1: n.sha1 ? n.sha1.toLowerCase() : undefined };
  }
  return files;
}

export interface SnapshotDiff {
  added: { path: string; size?: number }[];
  removed: { path: string; size?: number }[];
  modified: { path: string; before: SnapEntry; after: SnapEntry }[];
  moved: { from: string; to: string; size?: number }[];
}

const byPath = <T extends { path: string }>(a: T, b: T) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Moves are removed+added pairs with the same size and the same non-empty claimed sha1 (paired one to one, in path order). */
export function diffSnapshots(prev: Record<string, SnapEntry>, cur: Record<string, SnapEntry>): SnapshotDiff {
  let added: SnapshotDiff["added"] = [], removed: SnapshotDiff["removed"] = [];
  const modified: SnapshotDiff["modified"] = [];
  for (const [path, after] of Object.entries(cur)) {
    const before = prev[path];
    if (!before) { added.push({ path, size: after.size }); continue; }
    if (before.size !== after.size || before.mtime !== after.mtime || (before.sha1 && after.sha1 && before.sha1 !== after.sha1)) modified.push({ path, before, after });
  }
  for (const [path, before] of Object.entries(prev)) if (!(path in cur)) removed.push({ path, size: before.size });
  added.sort(byPath); removed.sort(byPath); modified.sort(byPath);

  const moved: SnapshotDiff["moved"] = [];
  const key = (e: SnapEntry | undefined) => (e?.sha1 ? `${e.sha1}|${e.size}` : undefined);
  const free = new Map<string, string[]>();
  for (const r of added) { const k = key(cur[r.path]); if (k) free.set(k, [...(free.get(k) ?? []), r.path]); }
  const movedFrom = new Set<string>(), movedTo = new Set<string>();
  for (const r of removed) {
    const k = key(prev[r.path]);
    const to = k ? free.get(k)?.shift() : undefined;
    if (!to) continue;
    moved.push({ from: r.path, to, size: r.size });
    movedFrom.add(r.path); movedTo.add(to);
  }
  added = added.filter((a) => !movedTo.has(a.path));
  removed = removed.filter((r) => !movedFrom.has(r.path));
  return { added, removed, modified, moved };
}

export const SNAPSHOT_NEEDS_INDEX = "snapshot modes need PROTON_DRIVE_INDEX=1: they keep a plaintext list of file names, sizes and hashes in the same private local folder as the walk index. Set PROTON_DRIVE_INDEX=1 and restart the server, or use `since` without `snapshot`.";

export async function driveRecentChanges(
  drive: DriveService,
  o: { path: string; since?: string; limit?: number; snapshot?: "diff" | "save"; refresh?: boolean },
  deps: { walk?: WalkFn; now?: number; accountKey?: (drive: DriveService) => Promise<string | undefined> } = {}
) {
  if (o.path === "/") throw new Error("path must be a folder such as /my-files, not '/'");
  if (o.snapshot && o.since !== undefined) throw new Error("since cannot be combined with snapshot: a snapshot diff compares against the previous snapshot.");
  if (o.snapshot && !indexEnabled()) throw new Error(SNAPSHOT_NEEDS_INDEX);
  const now = deps.now ?? Date.now();
  const limit = o.limit ?? DEFAULT_LIMIT;
  const sinceMs = o.snapshot ? undefined : parseSince(o.since ?? "7d", now); // reject a bad `since` before the walk
  // A change feed must reflect the live drive (no saved index) and wait for the whole walk.
  const walk: WalkResult = await (deps.walk ?? walkTree)(drive, o.path, { refresh: o.refresh, noDisk: true, budgetMs: 0 });
  const trustworthy = walk.complete && !walk.partial;

  if (sinceMs !== undefined) {
    return { root: walk.root, since: new Date(sinceMs).toISOString(), ...recentFiles(walk.nodes, sinceMs, limit), ...walkMeta(walk), note: "Files only. changedAt is the newer of the original modification time and the upload time; a file whose content changed but kept an old modification time and was not re-uploaded is not seen." };
  }

  const account = await (deps.accountKey ?? currentAccountKey)(drive);
  if (!account) throw new Error("Could not identify the signed-in account, so a snapshot cannot be compared or saved safely.");
  const file = readSnapshotFile();
  const sameAccount = file?.accountKey === account;
  const prev = sameAccount ? file!.roots[walk.root] : undefined;
  const cur = toSnapshot(walk.nodes);
  const notes: string[] = [];
  if (file && !sameAccount) notes.push("The stored snapshot belongs to another account and was ignored.");
  if (!trustworthy) notes.push("The walk was incomplete, so removed and moved files cannot be told apart from files that were not reached; they are left out, and this snapshot was not saved.");

  const diff = prev ? diffSnapshots(prev.files, cur) : undefined;
  const cap = <T>(xs: T[] | undefined) => (xs ? { total: xs.length, items: xs.slice(0, limit) } : undefined);

  let saved = false;
  if (o.snapshot === "save") {
    if (!trustworthy) {
      /* never overwrite a good snapshot with a partial one: it would fake mass deletions */
    } else {
      const roots: Record<string, RootSnapshot> = { ...(sameAccount ? file!.roots : {}), [walk.root]: { savedAt: now, files: cur } };
      const kept = Object.entries(roots).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, MAX_ROOTS);
      const r = writePrivateFile(FILE_NAME, JSON.stringify({ version: SNAPSHOT_VERSION, accountKey: account, roots: Object.fromEntries(kept) } satisfies SnapshotFile), SNAPSHOT_MAX_BYTES);
      saved = r === "ok";
      if (!saved) notes.push(r === "too-large" ? `Snapshot not saved: it would exceed ${SNAPSHOT_MAX_BYTES / 1024 / 1024} MB. Use a smaller path.` : "Snapshot not saved: the private index folder could not be written (see the server log).");
    }
  }
  if (!prev) notes.push(o.snapshot === "save" && saved ? "No earlier snapshot for this path: baseline saved, nothing to compare yet." : "No earlier snapshot for this path: nothing to compare. Call with snapshot:'save' to create the baseline.");

  return {
    root: walk.root,
    snapshot: o.snapshot,
    previousSnapshotAt: prev ? new Date(prev.savedAt).toISOString() : undefined,
    files: Object.keys(cur).length,
    saved,
    added: cap(diff?.added),
    modified: cap(diff?.modified),
    ...(trustworthy ? { removed: cap(diff?.removed), moved: cap(diff?.moved) } : {}),
    ...walkMeta(walk),
    note: notes.join(" ") || undefined,
  };
}
