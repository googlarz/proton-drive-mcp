import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveFile, ShareStatus } from "../types/index.js";
import type { DriveService } from "./drive.js";
import { walkTree, staleFields, partialFields, type WalkNode, type WalkOptions, type WalkResult } from "./walk.js";
import { validateLocalPath } from "../utils/validation.js";
import { callContext } from "../utils/subprocess.js";

export type WalkFn = (svc: DriveService, root: string, opts?: WalkOptions) => Promise<WalkResult>;

const DAY_MS = 86_400_000;
const nodeTime = (n: WalkNode): string | undefined => n.mtime ?? n.uploadedAt;
const byteSize = (n: WalkNode): number => n.size ?? 0;

/** Parent of a remote path, honouring the "\/" escape used for slashes inside names. */
function parentOf(p: string): string {
  for (let i = p.length - 1; i > 0; i--) if (p[i] === "/" && p[i - 1] !== "\\") return p.slice(0, i);
  return "";
}

function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "(none)";
}

function topBy<T extends { bytes: number }>(rows: T[], n: number, tie: (r: T) => string): T[] {
  return [...rows].sort((a, b) => b.bytes - a.bytes || (tie(a) < tie(b) ? -1 : tie(a) > tie(b) ? 1 : 0)).slice(0, n);
}

function breakdown(nodes: WalkNode[], key: (n: WalkNode) => string, top: number) {
  const m = new Map<string, { count: number; bytes: number }>();
  for (const n of nodes) {
    const e = m.get(key(n)) ?? { count: 0, bytes: 0 };
    e.count++;
    e.bytes += byteSize(n);
    m.set(key(n), e);
  }
  return topBy([...m].map(([k, v]) => ({ key: k, ...v })), top, (r) => r.key);
}

function walkMeta(w: WalkResult) {
  return { complete: w.complete, skippedCount: w.skipped.length, skipped: w.skipped.slice(0, 10), fromCache: w.fromCache, ...staleFields(w), ...partialFields(w) };
}

// ---- drive_usage ----------------------------------------------------------

export function summarizeTrash(items: DriveFile[]) {
  const dates = items.map((i) => i.trashedAt).filter((d): d is string => !!d).sort();
  return { count: items.length, bytes: items.reduce((s, i) => s + (i.size ?? 0), 0), oldestTrashedAt: dates[0] };
}

export function summarizeUsage(walk: WalkResult, opts: { top: number; olderThanDays?: number; now: number }) {
  const files = walk.nodes.filter((n) => n.type === "file");
  const folders = walk.nodes.filter((n) => n.type === "folder");
  const toRow = (n: WalkNode) => ({ path: n.path, bytes: byteSize(n), mtime: nodeTime(n) });

  const rolled = new Map<string, { bytes: number; files: number }>();
  for (const f of files) {
    for (let p = parentOf(f.path); p.length > walk.root.length && p.startsWith(walk.root); p = parentOf(p)) {
      const e = rolled.get(p) ?? { bytes: 0, files: 0 };
      e.bytes += byteSize(f);
      e.files++;
      rolled.set(p, e);
    }
  }

  const out: Record<string, unknown> = {
    root: walk.root,
    totals: { files: files.length, folders: folders.length, bytes: files.reduce((s, f) => s + byteSize(f), 0) },
    largestFiles: topBy(files.map(toRow), opts.top, (r) => r.path),
    largestFolders: topBy([...rolled].map(([path, v]) => ({ path, ...v })), opts.top, (r) => r.path),
    byExtension: breakdown(files, (n) => extOf(n.path), opts.top).map(({ key, ...r }) => ({ ext: key, ...r })),
    byMediaType: breakdown(files, (n) => n.mediaType ?? "(unknown)", opts.top).map(({ key, ...r }) => ({ mediaType: key, ...r })),
    ...walkMeta(walk),
  };
  if (opts.olderThanDays !== undefined) {
    const cutoff = opts.now - opts.olderThanDays * DAY_MS;
    const old = files.filter((n) => {
      const t = Date.parse(nodeTime(n) ?? "");
      return Number.isFinite(t) && t < cutoff;
    });
    out.olderThan = {
      days: opts.olderThanDays,
      count: old.length,
      bytes: old.reduce((s, f) => s + byteSize(f), 0),
      undated: files.length - files.filter((n) => Number.isFinite(Date.parse(nodeTime(n) ?? ""))).length,
      largest: topBy(old.map(toRow), opts.top, (r) => r.path),
    };
  }
  return out;
}

export async function driveUsage(
  drive: DriveService,
  o: { path: string; top?: number; olderThanDays?: number; refresh?: boolean },
  deps: { walk?: WalkFn; now?: number } = {}
) {
  if (o.path === "/") throw new Error("path must be a folder such as /my-files, not '/'");
  const walk = await (deps.walk ?? walkTree)(drive, o.path, { refresh: o.refresh });
  let trash: unknown;
  try {
    trash = summarizeTrash(await drive.listTrash());
  } catch (e) {
    trash = { error: e instanceof Error ? e.message : String(e) };
  }
  return {
    ...summarizeUsage(walk, { top: o.top ?? 10, olderThanDays: o.olderThanDays, now: deps.now ?? Date.now() }),
    trash,
    note: [partialFields(walk).note, "Sizes are the sum of file sizes, not the account storage quota."].filter(Boolean).join(" "),
  };
}

// ---- drive_find_duplicates ------------------------------------------------

export type DuplicateKind = "verified" | "claimed-sha1" | "same-size";
export interface DuplicateGroup {
  kind: DuplicateKind;
  members: WalkNode[];
}

function keeperOf(members: WalkNode[]): WalkNode {
  const t = (n: WalkNode) => Date.parse(nodeTime(n) ?? "");
  return [...members].sort((a, b) => {
    const ta = Number.isFinite(t(a)) ? t(a) : Infinity, tb = Number.isFinite(t(b)) ? t(b) : Infinity;
    return ta - tb || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  })[0];
}

function wasted(g: DuplicateGroup): number {
  return g.members.reduce((s, m) => s + byteSize(m), 0) - byteSize(keeperOf(g.members));
}

/** Unverified candidate groups: same claimed sha1, or (for files without sha1) same size + mediaType. */
export function findDuplicateCandidates(nodes: WalkNode[], minSize: number): DuplicateGroup[] {
  const bySha = new Map<string, WalkNode[]>();
  const bySize = new Map<string, WalkNode[]>();
  for (const n of nodes) {
    if (n.type !== "file" || n.size === undefined || n.size < minSize) continue;
    const [map, key] = n.sha1 ? [bySha, n.sha1.toLowerCase()] : [bySize, `${n.size}|${n.mediaType ?? ""}`];
    map.set(key, [...(map.get(key) ?? []), n]);
  }
  const groups: DuplicateGroup[] = [];
  for (const m of bySha.values()) if (m.length > 1) groups.push({ kind: "claimed-sha1", members: m });
  for (const m of bySize.values()) if (m.length > 1) groups.push({ kind: "same-size", members: m });
  return groups.sort((a, b) => wasted(b) - wasted(a) || (a.members[0].path < b.members[0].path ? -1 : 1));
}

async function pool<T>(items: T[], concurrency: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    })
  );
}

const DEFAULT_VERIFY_TOTAL_BYTES = 500_000_000;
export const MAX_VERIFY_TOTAL_BYTES = 2_000_000_000;
const MAX_VERIFY_MEMBERS = 200;

export type Hasher = (node: WalkNode) => Promise<string>;

/**
 * Hash every member of each group (members over maxVerifyBytes are never hashed) and regroup by sha256.
 * Groups with an unhashable member stay unverified and report why in `verifyNote`.
 */
export async function verifyGroups(
  groups: DuplicateGroup[],
  hash: Hasher,
  o: { maxVerifyBytes: number; maxTotalBytes?: number; maxMembers?: number; concurrency?: number; signal?: AbortSignal }
): Promise<(DuplicateGroup & { verifyNote?: string })[]> {
  const out: (DuplicateGroup & { verifyNote?: string })[] = [];
  const maxTotal = o.maxTotalBytes ?? DEFAULT_VERIFY_TOTAL_BYTES;
  const maxMembers = o.maxMembers ?? MAX_VERIFY_MEMBERS;
  let totalBytes = 0, totalMembers = 0;
  const stop = () => { if (o.signal?.aborted) throw o.signal.reason instanceof Error ? o.signal.reason : new Error("verification aborted"); };
  for (const g of groups) {
    stop();
    if (g.members.some((m) => byteSize(m) > o.maxVerifyBytes)) {
      out.push({ ...g, verifyNote: `skipped: member over maxVerifyBytes (${o.maxVerifyBytes})` });
      continue;
    }
    const groupBytes = g.members.reduce((s, m) => s + byteSize(m), 0);
    if (totalBytes + groupBytes > maxTotal || totalMembers + g.members.length > maxMembers) {
      const limit = totalBytes + groupBytes > maxTotal ? `maxVerifyTotalBytes ${maxTotal}` : `${maxMembers} files`;
      out.push({ ...g, verifyNote: `skipped: verify budget reached (${limit})` });
      continue;
    }
    totalBytes += groupBytes;
    totalMembers += g.members.length;
    const digests = new Map<WalkNode, string>();
    const failed: string[] = [];
    await pool(g.members, o.concurrency ?? 2, async (m) => {
      if (o.signal?.aborted) return;
      try {
        digests.set(m, await hash(m));
      } catch (e) {
        failed.push(`${m.path}: ${oneLine(e instanceof Error ? e.message : String(e))}`);
      }
    });
    stop(); // the hasher's own finally already removed any temp dir
    if (failed.length) {
      out.push({ ...g, verifyNote: `not verified, download/hash failed: ${failed.join("; ")}` });
      continue;
    }
    const byDigest = new Map<string, WalkNode[]>();
    for (const m of g.members) byDigest.set(digests.get(m)!, [...(byDigest.get(digests.get(m)!) ?? []), m]);
    for (const m of byDigest.values()) if (m.length > 1) out.push({ kind: "verified", members: m });
  }
  return out.filter((g) => g.members.length > 1).sort((a, b) => wasted(b) - wasted(a) || (a.members[0].path < b.members[0].path ? -1 : 1));
}

const LOCKED_RE = /database is locked|SQLITE_BUSY/i;
const oneLine = (m: string): string => (m.split("\n")[0] ?? m).slice(0, 160);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Downloads one file into its own private temp dir, sha256s it, and always removes the dir.
 * The CLI's SQLite cache can report "database is locked" at startup when several downloads run
 * at once; nothing has been transferred then, so a fresh attempt is safe (max 4 tries).
 */
export function makeDriveHasher(drive: DriveService): Hasher {
  const once: Hasher = async (node) => {
    const dir = await mkdtemp(join(tmpdir(), "pdmcp-dup-"));
    try {
      validateLocalPath(dir); // same local-path rules as drive_download
      const r = await drive.download(node.path, dir, "rename", "skip");
      if (r.failed > 0 || r.downloaded < 1) throw new Error("download failed");
      const [name, ...more] = await readdir(dir);
      if (!name || more.length || !(await stat(join(dir, name))).isFile()) throw new Error("unexpected download result");
      const h = createHash("sha256");
      for await (const chunk of createReadStream(join(dir, name))) h.update(chunk);
      return h.digest("hex");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  return async (node) => {
    const base = Number(process.env["PROTON_DRIVE_RETRY_BASE_MS"] ?? 250);
    for (let attempt = 1; ; attempt++) {
      try {
        return await once(node);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt >= 4 || !LOCKED_RE.test(msg)) throw e;
        await sleep(base * attempt + Math.random() * base);
      }
    }
  };
}

function reportGroup(g: DuplicateGroup & { verifyNote?: string }) {
  const keeper = keeperOf(g.members);
  return {
    kind: g.kind,
    sizeBytes: byteSize(keeper),
    wastedBytes: wasted(g),
    suggestedKeeper: keeper.path,
    members: g.members.map((m) => ({ path: m.path, size: byteSize(m), mtime: nodeTime(m) })),
    ...(g.verifyNote ? { verifyNote: g.verifyNote } : {}),
  };
}

export async function driveFindDuplicates(
  drive: DriveService,
  o: { path: string; minSize?: number; verify?: boolean; maxVerifyBytes?: number; maxVerifyTotalBytes?: number; limit?: number; refresh?: boolean; signal?: AbortSignal },
  deps: { walk?: WalkFn; hash?: Hasher } = {}
) {
  if (o.maxVerifyTotalBytes !== undefined && (!Number.isInteger(o.maxVerifyTotalBytes) || o.maxVerifyTotalBytes < 1 || o.maxVerifyTotalBytes > MAX_VERIFY_TOTAL_BYTES)) {
    throw new Error(`maxVerifyTotalBytes must be an integer between 1 and ${MAX_VERIFY_TOTAL_BYTES}`);
  }
  const walk = await (deps.walk ?? walkTree)(drive, o.path, { refresh: o.refresh, noDisk: true, budgetMs: 0 }); // deletion suggestions must come from a current, complete walk
  const limit = o.limit ?? 20;
  let groups: (DuplicateGroup & { verifyNote?: string })[] = findDuplicateCandidates(walk.nodes, o.minSize ?? 1024);
  let verified = false;
  if (o.verify) {
    // Only the top `limit` candidate groups are downloaded; the rest stay unverified.
    const head = groups.slice(0, limit);
    const tail = groups.slice(limit);
    groups = [...(await verifyGroups(head, deps.hash ?? makeDriveHasher(drive), {
      maxVerifyBytes: o.maxVerifyBytes ?? 50_000_000, maxTotalBytes: o.maxVerifyTotalBytes,
      signal: o.signal ?? callContext.getStore()?.signal,
    })), ...tail];
    groups.sort((a, b) => wasted(b) - wasted(a) || (a.members[0].path < b.members[0].path ? -1 : 1));
    verified = true;
  }
  return {
    root: walk.root,
    verifyRequested: verified,
    totalGroups: groups.length,
    totalWastedBytes: groups.reduce((s, g) => s + wasted(g), 0),
    groups: groups.slice(0, limit).map(reportGroup),
    note: "Suggestions only; nothing is deleted. 'claimed-sha1' uses an uploader-supplied hash; 'same-size' is a candidate only; 'verified' means a local sha256 match.",
    ...walkMeta(walk),
  };
}

// ---- drive_sharing_audit --------------------------------------------------

const PROTON_DOMAINS = new Set(["proton.me", "protonmail.com", "protonmail.ch", "pm.me", "proton.ch"]);
export const SHARE_AUDIT_CAP = 100;

export function auditShareStatus(path: string, s: ShareStatus) {
  const flags: string[] = [];
  const publicLink = s.shareUrl !== undefined || s.shareUrlExpiresAt !== undefined || s.shareUrlRole !== undefined || s.sharePasswordProtected !== undefined
    ? { role: s.shareUrlRole, expiresAt: s.shareUrlExpiresAt, passwordProtected: s.sharePasswordProtected === true }
    : undefined;
  if (publicLink) {
    if (!publicLink.expiresAt) flags.push("public-link-no-expiry");
    if (publicLink.role === "editor" || publicLink.role === "admin") flags.push("public-link-editor");
  }
  const invitees = s.members.filter((m) => m.status === "accepted").map((m) => ({ email: m.email, role: m.role }));
  const pending = s.members.filter((m) => m.status === "pending").map((m) => ({ email: m.email, role: m.role }));
  const external = [...invitees, ...pending].some((m) => !PROTON_DOMAINS.has(m.email.split("@")[1]?.toLowerCase() ?? ""));
  if (external) flags.push("external-invitee");
  return { path, publicLink, invitees, pending, flags };
}

export async function driveSharingAudit(
  drive: DriveService,
  o: { path: string; refresh?: boolean },
  deps: { walk?: WalkFn; status?: (path: string) => Promise<ShareStatus> } = {}
) {
  const walk = await (deps.walk ?? walkTree)(drive, o.path, { refresh: o.refresh, noDisk: true, budgetMs: 0 }); // a security audit must not read a saved index or stop at a time budget
  const status = deps.status ?? ((p: string) => drive.shareStatus(p));
  const shared = walk.nodes.filter((n) => (n.isShared || n.isSharedByUrl) && parentOf(n.path) !== "");
  const targets = shared.slice(0, SHARE_AUDIT_CAP);
  const items: ReturnType<typeof auditShareStatus>[] = [];
  const errors: { path: string; error: string }[] = [];
  await pool(targets, 4, async (n) => {
    try {
      items.push(auditShareStatus(n.path, await status(n.path)));
    } catch (e) {
      errors.push({ path: n.path, error: e instanceof Error ? e.message : String(e) });
    }
  });
  items.sort((a, b) => (a.path < b.path ? -1 : 1));
  const flagged = items.filter((i) => i.flags.length > 0);
  return {
    root: walk.root,
    sharedNodes: shared.length,
    audited: targets.length,
    capped: shared.length > targets.length,
    flaggedCount: flagged.length,
    items,
    errors,
    note: "Public link URLs are intentionally omitted. Only sharing set directly on each item is shown (inherited access is not).",
    ...walkMeta(walk),
  };
}
