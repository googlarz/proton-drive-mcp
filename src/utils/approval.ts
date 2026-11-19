// The approval gate (1.11.0): a destructive or outward-facing operation runs only after a HUMAN said yes to that exact
// operation. Pure and injectable: the MCP elicitation call, the out-of-band approval store and the clock come from outside,
// so everything here is testable without a server. See PLAN-1.11.0.md section 2.
import { createHash } from "node:crypto";
import { canonical } from "./audit.js";
import { showValueStrict } from "./text.js";

// ---- Operation: what is shown = what is hashed = what runs -------------------------------------------------------

export type Effect = "irreversible" | "reversible" | "outward" | "local-delete";
export type FieldValue = string | number | boolean | string[] | null;
export interface Operation {
  tool: string;
  effect: Effect;
  /**
   * Validated values with defaults applied. Never put `confirmed` here. Secrets (password, message, content) should be passed
   * as sha256 digests under a key ending in "Digest" (hashed, never rendered); a raw secret under its own name is still never rendered.
   */
  fields: Record<string, FieldValue>;
  /** What the human sees in place of the secrets: `password: true|false`, `message: <characters>`, `content: <bytes>`. NOT hashed; derived from the same validated values as `fields`. */
  display?: Record<string, FieldValue>;
}

/** sha256 hex of the canonical (sorted-key) JSON of the operation: stable under key order, different for any changed field. */
export function opHash(op: Operation): string {
  return createHash("sha256").update(canonical({ tool: op.tool, effect: op.effect, fields: op.fields })).digest("hex");
}

// ---- Server-side text: nothing here comes from the model ---------------------------------------------------------

const EFFECT_LABEL: Record<Effect, string> = {
  irreversible: "PERMANENT, cannot be undone",
  reversible: "can be undone",
  outward: "affects other people or is visible outside your Drive",
  "local-delete": "DELETES files on THIS computer, cannot be undone",
};

/** First line of the prompt, keyed by tool name. Every tool the gate can be asked about (gated set and, in strict mode, every mutating tool). */
export const TOOL_TITLES: Readonly<Record<string, string>> = {
  drive_auth_logout: "end the stored Proton Drive session on this machine",
  drive_delete: "permanently delete from the trash",
  drive_empty_trash: "permanently empty the trash",
  drive_share_invite: "invite a person to a file or folder",
  drive_share_revoke: "remove one person's access",
  drive_share_set_url: "create or replace a PUBLIC link",
  drive_share_remove_url: "disable the public link",
  drive_share_remove_all: "remove every member and pending invitation",
  drive_share_leave: "leave a shared folder",
  drive_invitation_accept: "accept a sharing invitation",
  drive_invitation_reject: "decline a sharing invitation",
  photos_delete_album: "delete an album",
  photos_remove_from_album: "remove a photo from an album",
  drive_bulk_move: "move several items",
  drive_bulk_trash: "move several items to the trash",
  drive_cleanup: "move redundant copies and empty folders to the trash",
  drive_undo: "undo an earlier change (restore from the trash, move or rename back)",
  drive_upload: "upload (may replace existing items)",
  drive_download: "download (may delete existing LOCAL files or folders first)",
  photos_download: "download photos (may delete existing LOCAL files first)",
  drive_write_file: "write a file (may overwrite an existing one)",
  drive_copy: "copy an item",
  drive_move: "move an item",
  drive_mkdir: "create a folder",
  drive_rename: "rename an item",
  drive_trash: "move an item to the trash",
  drive_restore: "restore an item from the trash",
  photos_create_album: "create an album",
  photos_update_album: "change an album",
  photos_add_to_album: "add photos to an album",
  photos_upload: "upload photos",
};

// Rendering order of fields; anything else follows alphabetically. Keys come from server code, never from the model.
const FIELD_ORDER = [
  "path", "paths", "sources", "sourcePath", "remotePath", "destinationPath", "destinationFolder", "newName", "localPath",
  "album", "albumName", "name", "uid", "item", "inviter", "invitedFolder", "email", "role", "expiration", "replacesExistingLink", "resetSettings", "password",
  "message", "content", "fileConflictStrategy", "folderConflictStrategy", "conflictStrategy",
  "fixes", "trash", "id", "when", "restore", "moveBack",
];
const KEY_OK = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const LIST_FULL_MAX = 50;
const FOLDER_LINES_MAX = 50;

const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
/**
 * The path a list line is about. Cleanup lines read "<path>  (keeps <other path>)" or "<path>  (empty folder)" and undo lines
 * "<from> -> <to>": the folder counts must group by the first path, so a trailing "(keeps ...)" or "-> ..." never decides the folder.
 */
const leadPath = (line: string) => line.split(/ {2}\((?:keeps |empty folder\))| -> /, 1)[0];

function renderList(key: string, items: string[]): string[] {
  const shown = (xs: string[]) => xs.map((x) => `  - ${showValueStrict(x)}`);
  if (items.length <= LIST_FULL_MAX) return [`${key} (${items.length}):`, ...shown(items)];
  const perFolder = new Map<string, number>();
  for (const it of items) { const f = parentOf(leadPath(it)); perFolder.set(f, (perFolder.get(f) ?? 0) + 1); }
  const folders = [...perFolder].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  return [
    `${key} (${items.length}): only the first ${LIST_FULL_MAX} are listed; counts per folder first`,
    ...folders.slice(0, FOLDER_LINES_MAX).map(([f, n]) => `  folder ${showValueStrict(f)}: ${n}`),
    ...(folders.length > FOLDER_LINES_MAX ? [`  (+${folders.length - FOLDER_LINES_MAX} more folders)`] : []),
    `first ${LIST_FULL_MAX}:`,
    ...shown(items.slice(0, LIST_FULL_MAX)),
  ];
}

// Readable labels for a few boolean fields; every other key is shown as it is.
const LABELS: Record<string, string> = { replacesExistingLink: "replaces an existing link", overwritesExisting: "overwrites an existing file" };

// Values a human must RECOGNISE (who is invited, who invited me, which item). A look-alike letter from another alphabet
// (Cyrillic "a" in an e-mail address) would pass as ASCII, so every non-ASCII character in them is listed by code point.
const RECOGNISED = new Set(["email", "inviter", "item", "invitedFolder"]);
function nonAsciiNote(v: string): string {
  const cps = [...new Set([...v].map((c) => c.codePointAt(0)!).filter((cp) => cp > 0x7f))];
  if (cps.length === 0) return "";
  const shown = cps.slice(0, 12).map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
  return ` (contains non-ASCII: ${shown.join(" ")}${cps.length > 12 ? ` +${cps.length - 12} more` : ""})`;
}

function renderField(key: string, v: FieldValue): string[] {
  if (key === "password") return [`password: ${v === true || (typeof v === "string" && v.length > 0) ? "set" : "not set"}`];
  if (key === "message") {
    if (typeof v === "number") return [`message: ${v > 0 ? `${v} characters` : "none"}`];
    return [`message: ${typeof v === "string" && v.length > 0 ? `${[...v].length} characters` : "none"}`];
  }
  if (key === "content") {
    if (typeof v === "string") return [`content: ${Buffer.byteLength(v, "utf8")} bytes (sha256 ${createHash("sha256").update(v).digest("hex").slice(0, 12)})`];
    return [`content: ${typeof v === "number" ? `${v} bytes` : "none"}`];
  }
  if (v === null) return [`${key}: none`];
  if (typeof v === "boolean") return [`${LABELS[key] ?? key}: ${v ? "yes" : "no"}`];
  if (typeof v === "number") return [`${key}: ${Number.isFinite(v) ? v : "invalid"}`];
  if (Array.isArray(v)) return renderList(key, v);
  return [`${key}: ${showValueStrict(v)}${RECOGNISED.has(key) && typeof v === "string" ? nonAsciiNote(v) : ""}`];
}

/** The text the human sees (and the store records). Every line is server-composed; values are neutralised and cannot add or reorder lines. */
export function renderOperation(op: Operation): string {
  const title = TOOL_TITLES[op.tool];
  if (title === undefined) throw new Error(`approval: no prompt text for tool ${showValueStrict(op.tool)}`);
  if (!(op.effect in EFFECT_LABEL)) throw new Error(`approval: unknown effect ${showValueStrict(op.effect)}`);
  // Digest fields are hashed but not shown; display fields are shown but not hashed. A key present in both is shown from `display`.
  const shown: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(op.fields)) if (v !== undefined && !k.endsWith("Digest")) shown[k] = v;
  for (const [k, v] of Object.entries(op.display ?? {})) if (v !== undefined) shown[k] = v;
  const keys = Object.keys(shown);
  for (const k of keys) if (!KEY_OK.test(k)) throw new Error(`approval: invalid field name ${showValueStrict(k)}`);
  const rank = (k: string) => { const i = FIELD_ORDER.indexOf(k); return i < 0 ? FIELD_ORDER.length : i; };
  keys.sort((x, y) => rank(x) - rank(y) || (x < y ? -1 : x > y ? 1 : 0));
  return [`${op.tool}: ${title} (${EFFECT_LABEL[op.effect]})`, ...keys.flatMap((k) => renderField(k, shown[k]))].join("\n");
}

// ---- Mode -------------------------------------------------------------------------------------------------------

export type ApprovalMode = "human" | "strict" | "model";

/**
 * PROTON_DRIVE_APPROVAL. Accepts the raw value or an env object. Unset/human -> human, strict -> strict, model -> model with
 * a warning, anything else -> strict with a warning (fail closed).
 */
export function resolveApprovalMode(env: string | undefined | Record<string, string | undefined>): { mode: ApprovalMode; warning?: string } {
  const raw = typeof env === "object" && env !== null ? env.PROTON_DRIVE_APPROVAL : env;
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "human") return { mode: "human" };
  if (v === "strict") return { mode: "strict" };
  if (v === "model") return { mode: "model", warning: "PROTON_DRIVE_APPROVAL=model: the assistant's own confirmed=true is accepted as authorisation. No human approves destructive or outward-facing operations." };
  return { mode: "strict", warning: `Unknown PROTON_DRIVE_APPROVAL "${showValueStrict(raw, 40, 10)}": using "strict" (valid: human, strict, model).` };
}

// ---- Which operations need a human --------------------------------------------------------------------------------

/** Default-mode gated set: the 18 gated before 1.11.0 plus drive_invitation_accept, the /shared-with-me destinations and (1.12.0) the apply step of drive_cleanup and drive_undo. Some entries are gated only conditionally, see requiresApproval. */
export const GATED_TOOLS: ReadonlySet<string> = new Set([
  "drive_auth_logout", "drive_delete", "drive_empty_trash", "drive_share_invite", "drive_share_revoke", "drive_share_set_url",
  "drive_share_remove_url", "drive_share_remove_all", "drive_share_leave", "drive_invitation_reject", "photos_delete_album",
  "photos_remove_from_album", "drive_bulk_move", "drive_bulk_trash", "drive_upload", "drive_download", "photos_download", "drive_write_file",
  "drive_invitation_accept", "drive_copy", "drive_move", "drive_mkdir", "drive_rename", "drive_trash", "drive_restore",
  "drive_cleanup", "drive_undo",
]);

const ALWAYS = new Set([
  "drive_auth_logout", "drive_delete", "drive_empty_trash", "drive_share_invite", "drive_share_revoke", "drive_share_set_url",
  "drive_share_remove_url", "drive_share_remove_all", "drive_share_leave", "drive_invitation_reject", "drive_invitation_accept",
  "photos_delete_album", "photos_remove_from_album",
]);
const BULK = new Set(["drive_bulk_move", "drive_bulk_trash", "drive_cleanup"]);
// Outward when any path the operation reads from or ends up at (either side) is under /shared-with-me.
const SHARED_DEST = new Set(["drive_copy", "drive_move", "drive_mkdir", "drive_rename", "drive_bulk_move", "drive_upload", "drive_write_file", "drive_trash", "drive_bulk_trash", "drive_restore"]);
const PATH_ARGS = ["destinationPath", "destinationFolder", "remotePath", "path", "sourcePath", "sources", "paths"];

export interface GateContext {
  /** Paths the operation ends up at (what resultingPaths yields; for upload / mkdir the target). */
  resultingPaths?: string[];
  /** Paths the operation takes things from (move/copy/rename sources, items to trash or restore). Under /shared-with-me they gate the call just like a destination there. */
  sourcePaths?: string[];
  /** drive_write_file: the target already exists, so the write overwrites. */
  overwritesExisting?: boolean;
  /** Bulk tools: this call applies (true) or only computes the plan (false). Defaults to args.confirmed === true, which is the plan/apply switch. */
  apply?: boolean;
  /** Required in strict mode: every tool that changes Drive (index.ts MUTATING_TOOL_NAMES). Not imported here, to avoid a cycle with index.ts. */
  mutatingTools?: ReadonlySet<string>;
}

/** True when the first path segment is shared-with-me after dropping empty and "." segments (so `//shared-with-me/x`, `/./Shared-With-Me/x` count) and ignoring case. */
export function underShared(p: string): boolean {
  const first = p.split("/").find((seg) => seg !== "" && seg !== ".");
  return first !== undefined && first.toLowerCase() === "shared-with-me";
}

/** Whether this call must pass ApprovalGate.require. In model mode always false: the legacy confirmed=true path stays in force. */
export function requiresApproval(tool: string, args: Record<string, unknown>, mode: ApprovalMode, ctx: GateContext = {}): boolean {
  if (mode === "model") return false;
  if (BULK.has(tool)) {
    return ctx.apply ?? args.confirmed === true; // a plan (no apply) changes nothing
  }
  if (tool === "drive_undo") return ctx.apply ?? args.action === "apply"; // list and plan change nothing
  const isRemove = (...ks: string[]) => ks.some((k) => args[k] === "remove");
  if ((tool === "drive_download" && isRemove("fileConflictStrategy", "folderConflictStrategy")) || (tool === "photos_download" && isRemove("conflictStrategy"))) return true;
  if (mode === "strict") {
    if (!ctx.mutatingTools) throw new TypeError("requiresApproval in strict mode needs ctx.mutatingTools");
    if (ctx.mutatingTools.has(tool)) return true;
  }
  if (ALWAYS.has(tool)) return true;
  if (tool === "drive_upload" && ["fileConflictStrategy", "folderConflictStrategy"].some((k) => args[k] === "replace")) return true;
  if (tool === "drive_write_file" && ctx.overwritesExisting === true) return true;
  if (SHARED_DEST.has(tool)) {
    const fromArgs = PATH_ARGS.flatMap((k) => { const v = args[k]; return typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; });
    const paths = [...(ctx.resultingPaths ?? []), ...(ctx.sourcePaths ?? []), ...fromArgs];
    if (paths.some(underShared)) return true;
  }
  return false;
}

// ---- The gate ---------------------------------------------------------------------------------------------------

export type ElicitResult = "accept" | "decline" | "cancel" | "error";
/** Asks the human. Resolve "accept" only when they approved (accept AND approve=true); undefined when the client cannot elicit. */
export type Elicit = (summary: string, signal?: AbortSignal) => Promise<ElicitResult>;

/** What the out-of-band store (src/utils/approvalStore.ts) provides to the gate. */
export interface ApprovalStoreLike {
  request(p: { tool: string; opHash: string; summary: string; fresh?: boolean }): { code: string; expiresAt: number; reused: boolean };
  consume(p: { tool: string; opHash: string }): { code: string } | null;
  /** Removes pending and approved records for this operation (a record must not outlive a decision). */
  discard?(p: { tool: string; opHash: string }): number;
}

export type ApprovalResult =
  | { ok: true; channel: "elicitation" | "cli" | "model"; opHash: string; code?: string }
  | { ok: false; code: "approval_required" | "approval_declined" | "approval_unavailable"; message: string; opHash: string };

export interface RequireOptions {
  /** model mode only: the legacy confirmed=true was passed. Ignored in human and strict. */
  legacyConfirmed?: boolean;
  signal?: AbortSignal;
}

export interface GateInit {
  mode: ApprovalMode;
  elicit?: Elicit;
  /** Read when needed, not at construction (the server creates it lazily). */
  store?: ApprovalStoreLike;
  /** Why the store cannot be used (set by the server when its folder is misconfigured); worded to the model as a server problem. */
  storeProblem?: string;
  /** The store only if its folder already exists (never creates it); used to clean up after a dialog decision. Defaults to `store`. */
  storeIfPresent?: ApprovalStoreLike;
  now?: () => number;
  /** Runtime notices for stderr (store failure, decline budget used up). */
  onWarning?: (message: string) => void;
  /** Backstop if elicit never settles (the SDK call has its own 120 s timeout). Default 130 000 ms. */
  elicitTimeoutMs?: number;
}

export const MAX_DECLINES_PER_MINUTE = 5;
const WINDOW_MS = 60_000;
const NO_RETRY = "Do not retry this operation or a variant of it unless the user asks you to.";

const TERMINAL_HOW = (code: string) => `\`proton-drive-cli approve ${code}\` (without a global install: \`npx -y -p proton-drive-mcp proton-drive-cli approve ${code}\`)`;

export class ApprovalGate {
  private readonly declinedAt: number[] = [];
  /** One elicitation at a time: a second gated call while a dialog is open is refused, never queued. */
  private promptOpen = false;
  /** Operations that were refused with a terminal code because the dialog was cancelled or failed; their next call looks in the store first. */
  private readonly terminalFallback = new Set<string>();
  private readonly now: () => number;
  private readonly timeoutMs: number;
  constructor(private readonly init: GateInit) {
    this.now = init.now ?? Date.now;
    this.timeoutMs = init.elicitTimeoutMs ?? 130_000;
  }

  get mode(): ApprovalMode { return this.init.mode; }

  async require(op: Operation, opts: RequireOptions = {}): Promise<ApprovalResult> {
    const hash = opHash(op);
    const refuse = (code: "approval_required" | "approval_declined" | "approval_unavailable", message: string): ApprovalResult => ({ ok: false, code, message, opHash: hash });
    const { mode, elicit } = this.init;

    if (mode === "model") {
      return opts.legacyConfirmed === true
        ? { ok: true, channel: "model", opHash: hash }
        : refuse("approval_required", `${op.tool} needs the user's confirmation. Describe the operation to the user, get their explicit OK, then call again with confirmed=true.`);
    }

    const summary = renderOperation(op);

    if (elicit) {
      if (this.terminalFallback.has(hash)) {
        // The dialog failed earlier and the user may have approved in a terminal since.
        try {
          const used = this.init.store?.consume({ tool: op.tool, opHash: hash });
          if (used) { this.terminalFallback.delete(hash); return { ok: true, channel: "cli", opHash: hash, code: used.code }; }
        } catch { /* fall through to a new dialog */ }
      }
      if (this.promptOpen) {
        return refuse("approval_unavailable", `${op.tool} was not run: another approval request is already waiting for the user's answer. Only one can be open at a time and this one was not queued. Nothing was changed. Wait for the user to answer, and call again only if they ask you to.`);
      }
      const now = this.now();
      while (this.declinedAt.length && now - this.declinedAt[0] > WINDOW_MS) this.declinedAt.shift();
      if (this.declinedAt.length >= MAX_DECLINES_PER_MINUTE) {
        this.init.onWarning?.(`approval prompts suspended: ${MAX_DECLINES_PER_MINUTE} declined or failed within a minute`);
        return refuse("approval_unavailable", `${op.tool} was not run: too many approval requests were declined or failed in the last minute, so the user is not being asked again for now. ${NO_RETRY}`);
      }
      this.promptOpen = true;
      let result: ElicitResult;
      try { result = await this.ask(elicit, summary, opts.signal); } finally { this.promptOpen = false; }
      if (result === "accept") {
        this.discardRecords(op, hash);
        return { ok: true, channel: "elicitation", opHash: hash };
      }
      this.declinedAt.push(now);
      if (result === "decline") {
        this.discardRecords(op, hash);
        return refuse("approval_declined", `The user declined ${op.tool}. Nothing was changed. ${NO_RETRY}`);
      }
      // Cancelled, failed or timed out: nobody said no, so the terminal route is offered (it still needs a human at a terminal).
      const why = result === "cancel" ? "was closed without an answer" : "failed or timed out";
      const viaTerminal = this.requestInStore(op, hash, summary, `The approval dialog ${why}.`, refuse);
      if (viaTerminal) { this.terminalFallback.add(hash); return viaTerminal; }
      return result === "cancel"
        ? refuse("approval_declined", `The user did not approve ${op.tool}: the approval dialog was closed without an answer. Nothing was changed. ${NO_RETRY}`)
        : refuse("approval_unavailable", `${op.tool} was not run: the approval request to the user failed or timed out. Nothing was changed. ${NO_RETRY}`);
    }

    const store = this.init.store;
    if (store) {
      try {
        const used = store.consume({ tool: op.tool, opHash: hash });
        if (used) return { ok: true, channel: "cli", opHash: hash, code: used.code };
      } catch (err) {
        this.init.onWarning?.(`approval store failed: ${err instanceof Error ? err.message : String(err)}`);
        return refuse("approval_unavailable", `${op.tool} was not run: the approval store failed. Nothing was changed. ${NO_RETRY}`);
      }
      return this.requestInStore(op, hash, summary, "This client cannot ask the user.", refuse) ?? refuse("approval_unavailable", `${op.tool} was not run: the approval store failed. Nothing was changed. ${NO_RETRY}`);
    }

    if (this.init.storeProblem) {
      return refuse("approval_unavailable", `${op.tool} was not run: the server is misconfigured and cannot record an approval (${this.init.storeProblem}). This is a server setting the user has to fix, not something to retry or work around. Nothing was changed. Tell the user.`);
    }
    return refuse("approval_required", `${op.tool} needs the user's approval, but this client cannot ask them and no terminal approval is set up. Nothing was changed. Tell the user; do not retry. To knowingly allow operations the assistant confirms by itself, the user can set PROTON_DRIVE_APPROVAL=model and restart the server.`);
  }

  /** Writes (or reuses) a pending record and returns the refusal that tells the model what the user must do; undefined when there is no usable store. */
  private requestInStore(op: Operation, hash: string, summary: string, preface: string, refuse: (c: "approval_required", m: string) => ApprovalResult): ApprovalResult | undefined {
    const store = this.init.store;
    if (!store) return undefined;
    try {
      // fresh: an approval that is already sitting in the store (given earlier, never used) must not answer a question that was just asked now
      const req = store.request({ tool: op.tool, opHash: hash, summary, fresh: true });
      return refuse("approval_required", `${preface} ${op.tool} needs the user's approval. Tell the user to run ${TERMINAL_HOW(req.code)} in a terminal and answer yes there; then call ${op.tool} again with exactly the same arguments. The code is only an identifier. It expires in ${Math.max(1, Math.round((req.expiresAt - this.now()) / 60_000))} minute(s).`);
    } catch (err) {
      this.init.onWarning?.(`approval store failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** After a dialog decision, no terminal record for the same operation may stay usable. Best effort; never creates the store. */
  private discardRecords(op: Operation, hash: string): void {
    try { ("storeIfPresent" in this.init ? this.init.storeIfPresent : this.init.store)?.discard?.({ tool: op.tool, opHash: hash }); }
    catch (err) { this.init.onWarning?.(`approval store cleanup failed: ${err instanceof Error ? err.message : String(err)}`); }
    this.terminalFallback.delete(hash);
  }

  private async ask(elicit: Elicit, summary: string, signal?: AbortSignal): Promise<ElicitResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ElicitResult>((resolve) => { timer = setTimeout(() => resolve("error"), this.timeoutMs); timer.unref?.(); });
    try {
      const r = await Promise.race([Promise.resolve().then(() => elicit(summary, signal)).catch((): ElicitResult => "error"), timeout]);
      return r === "accept" || r === "decline" || r === "cancel" ? r : "error";
    } finally {
      clearTimeout(timer);
    }
  }
}
