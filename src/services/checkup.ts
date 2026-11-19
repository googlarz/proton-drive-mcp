/**
 * Pure logic of `drive_checkup` (plan 1.12.0, section 3.1). No I/O, no CLI calls: the caller walks the tree, lists the
 * trash and (optionally) runs the sharing audit, then passes the results in.
 *
 * Score formula (deterministic, printed in the README). The score starts at 100. Each finding that is present deducts
 *   points = min(CAP, ceil(units * NUM / DEN))      (integer arithmetic only)
 * and the score is 100 minus the sum of the points, never below 0. `scoreParts` lists every deduction.
 *
 *   finding            units                                          points per unit   cap
 *   duplicates         extra copies (group size - 1, summed)          1/2               15
 *   empty-folders      empty folders                                  1/10              5
 *   large-old          files >= minSizeMB and older than olderThanDays 1                 10
 *   public-links       public links without a known expiry            5                 20
 *   outside-access     items shared with other accounts               2                 10
 *   sensitive-exposed  sensitive-looking names in shared places       8                 30
 *   trash              whole GiB in the trash                         1                 5
 *
 * The caps sum to 95, so the lowest possible score is 5. It is a conversation starter, not a measurement.
 */
import type { WalkNode } from "./walk.js";
import { findDuplicateCandidates } from "./analytics.js";
import { looksSecret } from "./contentIndex.js";
import { CLEANUP_MIN_SIZE } from "./cleanup.js";

export type CheckupFinding = "duplicates" | "empty-folders" | "large-old" | "public-links" | "outside-access" | "sensitive-exposed" | "trash";
export const CHECKUP_FINDINGS: readonly CheckupFinding[] = ["duplicates", "empty-folders", "large-old", "public-links", "outside-access", "sensitive-exposed", "trash"];

/** points = min(cap, ceil(units * num / den)) */
export const SCORE_TABLE: Readonly<Record<CheckupFinding, { num: number; den: number; cap: number }>> = {
  "duplicates": { num: 1, den: 2, cap: 15 },
  "empty-folders": { num: 1, den: 10, cap: 5 },
  "large-old": { num: 1, den: 1, cap: 10 },
  "public-links": { num: 5, den: 1, cap: 20 },
  "outside-access": { num: 2, den: 1, cap: 10 },
  "sensitive-exposed": { num: 8, den: 1, cap: 30 },
  "trash": { num: 1, den: 1, cap: 5 },
};

export const MAX_SAMPLES = 3;
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
const DAY_MS = 86_400_000;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** The part of the existing `driveSharingAudit` result this module reads. */
export interface SharingAuditInput {
  items: { path: string; publicLink?: { role?: string; expiresAt?: string; passwordProtected?: boolean }; invitees?: unknown[]; pending?: unknown[]; flags?: string[] }[];
  capped?: boolean;
}

export interface ScanInfo { files: number; folders: number; bytes: number; complete: boolean; partial?: boolean; ageMs: number }

export interface CheckupOptions {
  olderThanDays?: number;
  minSizeMB?: number;
  now: number;
  sharing: boolean;
  scanInfo: ScanInfo;
}

export interface CheckupFindingSummary {
  id: CheckupFinding;
  severity: "info" | "warn" | "risk";
  count: number;
  bytes?: number;
  fix: "drive_cleanup" | "manual" | "none";
  fixableCount?: number;
  samples: string[];
  next: string;
}

export interface CheckupSummary {
  path: string;
  scanned: ScanInfo;
  score: number;
  scoreParts: { finding: CheckupFinding; points: number }[];
  findings: CheckupFindingSummary[];
  trash: { count: number; bytes: number };
  sharingCapped?: true;
  namesInResult: number;
  caveats: string[];
}

export interface CheckupItem { path: string; size?: number; mtime?: string; [k: string]: unknown }
export interface CheckupPage { finding: CheckupFinding; total: number; items: CheckupItem[]; offset: number; limit: number; nextOffset?: number; note?: string }
export interface CheckupPageOptions {
  limit?: number;
  offset?: number;
  olderThanDays?: number;
  minSizeMB?: number;
  now: number;
  rootPath?: string;
  /** Whether the walk was complete. Empty folders are only listed when this is true. */
  complete?: boolean;
  sharingAudit?: SharingAuditInput;
}

// ---- helpers ---------------------------------------------------------------

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byPath = (a: { path: string; uid?: string }, b: { path: string; uid?: string }): number => cmp(a.path, b.path) || cmp(a.uid ?? "", b.uid ?? "");
const nodeTime = (n: WalkNode): string | undefined => n.mtime ?? n.uploadedAt;
const sizeOf = (n: WalkNode): number => n.size ?? 0;

/** Parent of a remote path, honouring the "\/" escape used for slashes inside names. */
function parentOf(p: string): string {
  for (let i = p.length - 1; i > 0; i--) if (p[i] === "/" && p[i - 1] !== "\\") return p.slice(0, i);
  return "";
}

/** Name-based list of sensitive-looking names, in addition to the secret matcher: plain substrings (long words, so German compounds match) ... */
const SENSITIVE_SUBSTRING = new RegExp([
  "passport", "reisepass", "personalausweis", "paszport", "dowod", "dowód",
  "payslip", "gehaltsabrechnung", "lohnabrechnung", "verdienstabrechnung", "wyplat", "wypłat",
  "steuer", "podatk", "contract", "vertrag", "umowa", "kontrakt",
  "insurance", "versicherung", "ubezpieczen", "diagnos", "befund", "lebenslauf", "testament",
  "recovery[-_ ]?codes?", "seed[-_ ]?phrase", "mnemonic", "wallet",
].join("|"), "iu");
/** ... and short words that must stand alone (so "pit" does not match "pitch"). */
const SENSITIVE_WORD = /(?<![\p{L}\p{N}])(?:tax|pit|nip|pesel|iban|ssn)(?![\p{L}\p{N}])/iu;

function looksSensitive(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).normalize("NFC");
  return looksSecret(parentOf(path), path) || SENSITIVE_SUBSTRING.test(name) || SENSITIVE_WORD.test(name);
}

/** Per node: the path of the nearest shared item at or above it (itself included), or undefined. Iterative, memoised. */
function sharedVia(nodes: WalkNode[]): Map<WalkNode, string | undefined> {
  const byUid = new Map<string, WalkNode>();
  const byPathMap = new Map<string, WalkNode>();
  for (const n of nodes) { byUid.set(n.uid, n); byPathMap.set(n.path, n); }
  const parent = (n: WalkNode): WalkNode | undefined =>
    (n.parentUid !== undefined ? byUid.get(n.parentUid) : undefined) ?? byPathMap.get(parentOf(n.path));
  const memo = new Map<WalkNode, string | undefined>();
  for (const start of nodes) {
    const chain: WalkNode[] = [];
    let cur: WalkNode | undefined = start;
    let found: string | undefined;
    let known = false;
    while (cur && chain.length <= nodes.length) {
      if (memo.has(cur)) { found = memo.get(cur); known = true; break; }
      chain.push(cur);
      if (cur.isShared || cur.isSharedByUrl) { found = cur.path; known = true; break; }
      cur = parent(cur);
    }
    if (!known) found = undefined;
    // Every node on the chain below the hit inherits it; the hit node itself maps to itself.
    for (const c of chain) memo.set(c, c.isShared || c.isSharedByUrl ? c.path : found);
  }
  return memo;
}

function prepared(nodes: WalkNode[]): WalkNode[] {
  return [...nodes].sort(byPath);
}

// ---- finding computations (all take nodes already sorted by path) ----------

interface DupItem extends CheckupItem { keeper: string; kind: string; groupSize: number; fixable: boolean }

function keeperOf(members: WalkNode[]): WalkNode {
  const t = (n: WalkNode) => Date.parse(nodeTime(n) ?? "");
  return [...members].sort((a, b) => {
    const ta = Number.isFinite(t(a)) ? t(a) : Infinity, tb = Number.isFinite(t(b)) ? t(b) : Infinity;
    return ta - tb || a.path.length - b.path.length || cmp(a.path, b.path);
  })[0];
}

function duplicateItems(nodes: WalkNode[], rootPath: string | undefined, via: Map<WalkNode, string | undefined>): { items: DupItem[]; bytes: number; fixable: number } {
  const items: DupItem[] = [];
  let bytes = 0, fixable = 0;
  for (const g of findDuplicateCandidates(nodes, 1)) {
    const keeper = keeperOf(g.members);
    const sizes = new Set(g.members.map(sizeOf));
    // Conservative stand-in for plan 3.2 rule 3 (cleanup.ts owns the exact test): claimed sha1, identical size of at least CLEANUP_MIN_SIZE
    // (cleanup ignores smaller files, so `fixableCount` must not count them), all inside the root, nothing shared.
    const eligible = g.kind === "claimed-sha1" && sizes.size === 1 && [...sizes][0] >= CLEANUP_MIN_SIZE
      && g.members.every((m) => (rootPath === undefined || m.path.startsWith(rootPath.replace(/\/+$/, "") + "/")) && via.get(m) === undefined);
    bytes += g.members.reduce((s, m) => s + sizeOf(m), 0) - Math.max(...g.members.map(sizeOf));
    for (const m of g.members) {
      if (m === keeper) continue;
      if (eligible) fixable++;
      items.push({ path: m.path, size: m.size, mtime: nodeTime(m), keeper: keeper.path, kind: g.kind, groupSize: g.members.length, fixable: eligible });
    }
  }
  return { items: items.sort(byPath), bytes, fixable };
}

function emptyFolders(nodes: WalkNode[]): CheckupItem[] {
  const byUid = new Map<string, WalkNode>();
  const byPathMap = new Map<string, WalkNode>();
  for (const n of nodes) { byUid.set(n.uid, n); byPathMap.set(n.path, n); }
  const parent = (n: WalkNode): WalkNode | undefined =>
    (n.parentUid !== undefined ? byUid.get(n.parentUid) : undefined) ?? byPathMap.get(parentOf(n.path));
  const hasFile = new Set<WalkNode>();
  for (const n of nodes) {
    if (n.type !== "file") continue;
    for (let p = parent(n); p && !hasFile.has(p); p = parent(p)) hasFile.add(p);
  }
  return nodes.filter((n) => n.type === "folder" && !hasFile.has(n)).map((n) => ({ path: n.path }));
}

function largeOld(nodes: WalkNode[], o: { olderThanDays: number; minSizeMB: number; now: number }): CheckupItem[] {
  const cutoff = o.now - o.olderThanDays * DAY_MS;
  const minBytes = o.minSizeMB * MIB;
  const out: CheckupItem[] = [];
  for (const n of nodes) {
    if (n.type !== "file" || n.size === undefined || n.size < minBytes) continue;
    const t = Date.parse(nodeTime(n) ?? "");
    if (Number.isFinite(t) && t < cutoff) out.push({ path: n.path, size: n.size, mtime: nodeTime(n) });
  }
  return out;
}

function auditByPath(a: SharingAuditInput | undefined): Map<string, SharingAuditInput["items"][number]> {
  return new Map((a?.items ?? []).map((i) => [i.path, i]));
}

function publicLinks(nodes: WalkNode[], audit: SharingAuditInput | undefined): (CheckupItem & { expiryKnown: boolean; editor: boolean })[] {
  const ap = auditByPath(audit);
  return nodes.filter((n) => n.isSharedByUrl).map((n) => {
    const link = ap.get(n.path)?.publicLink;
    return {
      path: n.path, type: n.type, size: n.size, mtime: nodeTime(n),
      expiresAt: link?.expiresAt, role: link?.role,
      expiryKnown: !!link?.expiresAt,
      editor: link?.role === "editor" || link?.role === "admin",
    };
  });
}

function outsideAccess(nodes: WalkNode[], audit: SharingAuditInput | undefined): (CheckupItem & { external: boolean })[] {
  const ap = auditByPath(audit);
  return nodes.filter((n) => n.isShared).map((n) => ({
    path: n.path, type: n.type, size: n.size, mtime: nodeTime(n),
    external: ap.get(n.path)?.flags?.includes("external-invitee") === true,
  }));
}

function sensitiveExposed(nodes: WalkNode[], via: Map<WalkNode, string | undefined>): CheckupItem[] {
  const out: CheckupItem[] = [];
  for (const n of nodes) {
    const v = via.get(n);
    if (v !== undefined && looksSensitive(n.path)) out.push({ path: n.path, type: n.type, size: n.size, mtime: nodeTime(n), sharedVia: v });
  }
  return out;
}

const samplesOf = (items: { path: string }[]): string[] => items.slice(0, MAX_SAMPLES).map((i) => i.path);
const sumSize = (items: CheckupItem[]): number => items.reduce((s, i) => s + (i.size ?? 0), 0);
const ceilDiv = (a: number, b: number): number => Math.floor((a + b - 1) / b);

export function scorePoints(finding: CheckupFinding, units: number): number {
  if (units <= 0) return 0;
  const r = SCORE_TABLE[finding];
  return Math.min(r.cap, ceilDiv(units * r.num, r.den));
}

// ---- public API -------------------------------------------------------------

export function computeCheckup(input: {
  nodes: WalkNode[];
  rootPath: string;
  trash: { count: number; bytes: number };
  sharingAudit?: SharingAuditInput;
  opts: CheckupOptions;
}): CheckupSummary {
  const { rootPath, trash, sharingAudit, opts } = input;
  const olderThanDays = opts.olderThanDays ?? 365;
  const minSizeMB = opts.minSizeMB ?? 50;
  const nodes = prepared(input.nodes);
  const via = sharedVia(nodes);
  const findings: CheckupFindingSummary[] = [];
  const units: Partial<Record<CheckupFinding, number>> = {};
  const caveats: string[] = [];

  const dup = duplicateItems(nodes, rootPath, via);
  if (dup.items.length > 0) {
    units.duplicates = dup.items.length;
    findings.push({
      id: "duplicates", severity: dup.bytes >= 100 * MIB ? "warn" : "info", count: dup.items.length, bytes: dup.bytes,
      fix: "drive_cleanup", fixableCount: dup.fixable, samples: samplesOf(dup.items),
      next: "Offer drive_cleanup with fixes [\"duplicates\"] (the server builds the list, nothing is trashed without the owner's approval); drive_checkup with finding \"duplicates\" lists the copies.",
    });
  }

  if (opts.scanInfo.complete && !opts.scanInfo.partial) {
    const ef = emptyFolders(nodes);
    if (ef.length > 0) {
      units["empty-folders"] = ef.length;
      findings.push({
        id: "empty-folders", severity: "info", count: ef.length, fix: "drive_cleanup", fixableCount: ef.length, samples: samplesOf(ef),
        next: "Offer drive_cleanup with fixes [\"empty-folders\"]; empty means no file anywhere below the folder.",
      });
    }
  } else {
    caveats.push("The scan is not complete, so empty folders were not evaluated (a folder can only be called empty when everything below it was listed). Run the checkup again for the full result.");
  }

  const lo = largeOld(nodes, { olderThanDays, minSizeMB, now: opts.now });
  if (lo.length > 0) {
    units["large-old"] = lo.length;
    findings.push({
      id: "large-old", severity: "info", count: lo.length, bytes: sumSize(lo), fix: "manual", samples: samplesOf(lo),
      next: `Files of ${minSizeMB} MB or more, last modified over ${olderThanDays} days ago; list them with finding "large-old" and let the owner decide, nothing is removed automatically.`,
    });
  }

  const pl = publicLinks(nodes, sharingAudit);
  if (pl.length > 0) {
    const noExpiry = pl.filter((p) => !p.expiryKnown).length;
    if (noExpiry > 0) units["public-links"] = noExpiry;
    findings.push({
      id: "public-links", severity: pl.some((p) => p.editor) ? "risk" : noExpiry > 0 ? "warn" : "info", count: pl.length, fix: "manual", samples: samplesOf(pl),
      next: `${noExpiry} of ${pl.length} public link(s) have no known expiry${opts.sharing ? "" : " (sharing details were skipped, so expiry is unknown)"}; the owner can remove or change a link with drive_share_remove_url or drive_share_set_url.`,
    });
  }

  const oa = outsideAccess(nodes, sharingAudit);
  if (oa.length > 0) {
    units["outside-access"] = oa.length;
    findings.push({
      id: "outside-access", severity: oa.some((o) => o.external) ? "warn" : "info", count: oa.length, fix: "manual", samples: samplesOf(oa),
      next: "Items shared with other accounts; review who has access with drive_share_status and remove access with drive_share_revoke if it is no longer needed.",
    });
  }

  const se = sensitiveExposed(nodes, via);
  if (se.length > 0) {
    units["sensitive-exposed"] = se.length;
    findings.push({
      id: "sensitive-exposed", severity: "risk", count: se.length, fix: "manual", samples: samplesOf(se),
      next: "Names that look sensitive sit in a shared place; this is a guess from file names only, so ask the owner to check these items before changing any sharing.",
    });
    caveats.push("sensitive-exposed is a name-based guess: only file and folder names are compared with a fixed word list (German, Polish and English); no file content is read, and items can be missed or flagged wrongly.");
  }

  if (trash.count > 0) {
    const gib = Math.floor(trash.bytes / GIB);
    if (gib > 0) units.trash = gib;
    findings.push({
      id: "trash", severity: trash.bytes >= GIB ? "warn" : "info", count: trash.count, bytes: trash.bytes, fix: "manual", samples: [],
      next: "Trash still counts towards storage; only the owner can empty it (drive_empty_trash, always gated). Nothing in the checkup deletes permanently.",
    });
  }

  if (!opts.sharing) caveats.push("Sharing details were skipped (sharing: false): public link expiry and external invitees are unknown.");
  if (sharingAudit?.capped) caveats.push("The sharing audit looks at the first 100 shared items only, so expiry and invitee details can be missing for the rest.");
  if (opts.scanInfo.partial) caveats.push("The scan is partial: the drive walk was still running. Call again in a minute for the full result.");
  else if (!opts.scanInfo.complete) caveats.push("The scan is incomplete (some folders could not be listed), so counts can be too low.");
  if (findings.some((f) => f.id === "duplicates")) caveats.push("Duplicates are candidates: the hash is claimed by the uploader and not checked unless a cleanup is run with verify.");

  findings.sort((a, b) => CHECKUP_FINDINGS.indexOf(a.id) - CHECKUP_FINDINGS.indexOf(b.id));
  const scoreParts = CHECKUP_FINDINGS
    .map((finding) => ({ finding, points: scorePoints(finding, units[finding] ?? 0) }))
    .filter((p) => p.points > 0);
  const score = Math.max(0, 100 - scoreParts.reduce((s, p) => s + p.points, 0));

  return {
    path: rootPath,
    scanned: { ...opts.scanInfo },
    score,
    scoreParts,
    findings,
    trash: { count: trash.count, bytes: trash.bytes },
    ...(sharingAudit?.capped ? { sharingCapped: true as const } : {}),
    namesInResult: findings.reduce((s, f) => s + f.samples.length, 0),
    caveats,
  };
}

export function checkupFindingPage(nodesIn: WalkNode[], finding: CheckupFinding, opts: CheckupPageOptions): CheckupPage {
  const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_PAGE_LIMIT)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const nodes = prepared(nodesIn);
  let all: CheckupItem[] = [];
  let note: string | undefined;
  switch (finding) {
    case "duplicates": all = duplicateItems(nodes, opts.rootPath, sharedVia(nodes)).items; break;
    case "empty-folders":
      if (opts.complete === true) all = emptyFolders(nodes);
      else note = "The scan was not complete, so empty folders are not listed.";
      break;
    case "large-old": all = largeOld(nodes, { olderThanDays: opts.olderThanDays ?? 365, minSizeMB: opts.minSizeMB ?? 50, now: opts.now }); break;
    case "public-links": all = publicLinks(nodes, opts.sharingAudit).map(({ expiryKnown: _e, editor: _d, ...rest }) => rest); break;
    case "outside-access": all = outsideAccess(nodes, opts.sharingAudit); break;
    case "sensitive-exposed": all = sensitiveExposed(nodes, sharedVia(nodes)); break;
    case "trash": note = "Trash items are not part of the walked tree; list them with drive_list_trash."; break;
  }
  const items = all.slice(offset, offset + limit);
  const next = offset + limit;
  return { finding, total: all.length, items, offset, limit, ...(next < all.length ? { nextOffset: next } : {}), ...(note ? { note } : {}) };
}
