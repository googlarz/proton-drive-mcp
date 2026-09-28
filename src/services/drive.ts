import type {
  Album,
  AlbumPhoto,
  AuthStatus,
  DownloadResult,
  DriveFile,
  DriveInvitation,
  DriveVersion,
  PublicLink,
  ShareMember,
  ShareRole,
  ShareStatus,
  TransferSummary,
  UploadResult,
} from "../types/index.js";
import { runDrive as defaultRunDrive, runDriveRaw as defaultRunDriveRaw } from "../utils/subprocess.js";
import { DriveNotAuthenticatedError, DriveParseError } from "../utils/errors.js";
import { validateName } from "../utils/validation.js";

type Runner = (args: string[]) => Promise<unknown>;
type RawRunner = (args: string[]) => Promise<string>;

// CLI v0.8.0 split the old unified --conflict-strategy into separate
// per-target flags for filesystem upload/download, each with its own
// allowed values (files can get a new revision; folders can merge).
export type FileConflictStrategy = "create-new-revision" | "rename" | "replace" | "skip";
export type FolderConflictStrategy = "merge" | "rename" | "replace" | "skip";
export type FileDownloadConflictStrategy = "rename" | "remove" | "skip";
export type FolderDownloadConflictStrategy = "merge" | "rename" | "remove" | "skip";
// Photos upload/download kept a single --conflict-strategy flag (files only,
// no folder distinction) but with the same v0.8.0 value renames.
export type PhotoUploadConflictStrategy = "rename" | "skip";
export type PhotoDownloadConflictStrategy = "rename" | "remove" | "skip";

// The SDK verifies the author of every name (and several other fields)
// cryptographically and returns a `Result<string, Error>`-shaped object —
// {ok:true, value:"name"} on success, {ok:false, error:{...}} if the
// signature couldn't be verified — never a plain string. Confirmed live
// against the CLI's `filesystem list`, `filesystem info`, `album list`,
// `invitation list` output. A naive `String(item.name)` on this object
// produces the literal text "[object Object]".
function unwrapResult(value: unknown, fallback = ""): string {
  if (value && typeof value === "object" && "ok" in value) {
    const r = value as { ok: boolean; value?: unknown };
    if (r.ok && typeof r.value === "string") return r.value;
    return fallback;
  }
  return typeof value === "string" ? value : fallback;
}

// The CLI's own path syntax requires escaping a literal '/' inside a node
// name with a backslash (confirmed in `filesystem info --help`: "Escape /
// in node names with a backslash"). Our own validateName() rejects '/' in
// names WE create, but an item created by any other Proton Drive client
// (web, desktop, mobile) can still have a literal '/' in its name. Confirmed
// live: naively joining such a name into a path ("/parent/raw/slash") makes
// every path-based tool (info, download, move, rename, delete, ...) fail
// with "Node not found", while the correctly escaped form ("/parent/raw\/slash")
// resolves. list() must escape names before building the path it returns.
function escapeNameForPath(name: string): string {
  return name.replace(/\//g, "\\/");
}

function unescapeName(name: string): string {
  return name.replace(/\\\//g, "/");
}

// dirname/basename that respect the "\/" escape: node's posix.basename would
// split "/a/raw\/slash" into "slash", corrupting mkdir/move on such items.
function splitRemotePath(p: string): { parent: string; name: string } {
  for (let i = p.length - 1; i >= 0; i--) {
    if (p[i] === "/" && p[i - 1] !== "\\") {
      return { parent: i === 0 ? "/" : p.slice(0, i), name: p.slice(i + 1) };
    }
  }
  return { parent: "/", name: p };
}

function joinRemote(parent: string, escapedName: string): string {
  return `${parent === "/" ? "" : parent}/${escapedName}`;
}

// filesystem move/copy/trash/restore/delete all accept multiple paths in one
// call and report per-item success as an array of {uid, ok, error} — NOT via
// a non-zero exit code. Confirmed live: a name collision at the destination
// makes `filesystem move`/`filesystem copy` exit 0 with
// [{ok:false, error:{name:"NodeWithSameNameExistsValidationError", ...}}].
// Every one of these wrappers previously discarded the result outright, so a
// collision was silently reported as success. Worst case was move(): it then
// went on to rename whatever OTHER item happened to already be sitting at the
// computed destination path — silently renaming an unrelated file while the
// real source never moved.
// The API's bare codes are opaque; these meanings were confirmed live
// (2026-09-28) for the action they are keyed by.
const READABLE_ERRORS: Record<string, string> = {
  "Copy|InvalidRequirementsAPIError|2000": "Proton cannot copy this item: big folders cannot be copied yet (CLI limitation)",
  "Move|InvalidRequirementsAPIError|2000": "the destination is inside the source, or the source no longer exists",
  "Restore|APICodeError|2511": "its original parent folder is still in the trash — restore the parent first",
  "Add to album|APICodeError|2500": "that photo is already in the album",
};

function assertItemsOk(result: unknown, action: string): void {
  if (!Array.isArray(result)) return;
  for (const item of result as Record<string, unknown>[]) {
    if (item && item.ok === false) {
      const err = (item.error ?? {}) as Record<string, unknown>;
      const name = String(err.name ?? "unknown error");
      const code = typeof err.code !== "undefined" ? ` (code ${err.code})` : "";
      const message = typeof err.message === "string" && err.message ? `: ${err.message}` : "";
      const readable = READABLE_ERRORS[`${action}|${name}|${err.code}`];
      if (readable) throw new Error(`${action} failed: ${readable} (${name}${code}${message})`);
      // Only a real collision deserves the collision hint — the same wrapper also
      // reports move-into-itself, restore-with-trashed-parent, etc.
      const hint = name === "NodeWithSameNameExistsValidationError"
        ? " — an item with that name already exists at the destination."
        : "";
      throw new Error(`${action} failed: ${name}${code}${message}${hint}`);
    }
  }
}

// Confirmed live: `sharing status /my-files` fails with "Error decrypting
// session keys" — roots are not shareable nodes.
const ROOT_PATHS = new Set(["/my-files", "/photos", "/albums", "/trash", "/photos-trash", "/shared-with-me", "/shared-by-me", "/devices"]);

// Strips "<package-name>@" and "+<hash>" from a version token like
// "cli-drive@0.8.0+06e8c605", leaving "0.8.0". Falls back to the raw
// token if it doesn't match, so an unexpected future format still shows
// something rather than silently becoming "unknown".
function extractSemver(token: string | undefined): string {
  if (!token) return "unknown";
  const afterAt = token.includes("@") ? token.slice(token.indexOf("@") + 1) : token;
  const semverMatch = afterAt.match(/^(\d+\.\d+\.\d+)/);
  return semverMatch ? semverMatch[1] : token;
}

// drive_info used to return the raw node: ~40% of it is lossless noise — the
// {ok,value} verification wrappers, uid chains repeated per revision, and
// fields that duplicate others. Unwrap the wrappers and drop the noise; the raw
// node is still available with verbose=true.
const NODE_NOISE = new Set(["treeEventScopeId", "parentUid", "keyAuthor", "nameAuthor", "claimedDigests", "isImported"]);
function trimNode(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.map((x) => trimNode(x, depth + 1));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.ok === true && "value" in o) return trimNode(o.value, depth + 1);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) {
      if (NODE_NOISE.has(k)) continue;
      if (k === "uid" && depth > 0) continue; // nested uids (e.g. a revision's) are noise
      out[k] = trimNode(val, depth + 1);
    }
    return out;
  }
  return v;
}

function mapPhoto(item: Record<string, unknown>): AlbumPhoto {
  const photo = (item.photo ?? {}) as Record<string, unknown>;
  const captureTime = item.captureTime ?? photo.captureTime;
  const tags = item.tags ?? photo.tags;
  return {
    nodeUid: String(item.nodeUid ?? item.uid ?? ""),
    name: item.name !== undefined ? unwrapResult(item.name) || undefined : undefined,
    mediaType: typeof item.mediaType === "string" ? item.mediaType : undefined,
    creationTime: typeof item.creationTime === "string" ? item.creationTime : undefined,
    totalStorageSize: typeof item.totalStorageSize === "number" ? item.totalStorageSize : undefined,
    captureTime: typeof captureTime === "string" ? captureTime : undefined,
    tags: Array.isArray(tags) ? tags : undefined,
  };
}

export class DriveService {
  private readonly run: Runner;
  private readonly runRaw: RawRunner;

  constructor(runner?: Runner, rawRunner?: RawRunner) {
    this.run = runner ?? defaultRunDrive;
    this.runRaw = rawRunner ?? defaultRunDriveRaw;
  }

  // Auth
  //
  // The CLI has no `auth status` command (it doesn't exist). We probe by
  // resolving a path every authenticated user has (/my-files) and treating
  // a DriveNotAuthenticatedError as the signal. Any other error propagates —
  // it means something unexpected happened, not that the session is invalid.
  async authStatus(): Promise<AuthStatus> {
    try {
      await this.run(["filesystem", "info", "/my-files"]);
      return { authenticated: true };
    } catch (err) {
      if (err instanceof DriveNotAuthenticatedError) return { authenticated: false };
      throw err;
    }
  }

  async authLogout(): Promise<void> {
    await this.run(["auth", "logout"]);
  }

  // `version` ignores --json entirely and always prints plain text:
  //   Proton Drive CLI cli-drive@0.8.0+06e8c605
  //   Proton Drive SDK js@0.21.0+06e8c605
  //   ...update-check line...
  // Confirmed live: the token after "CLI"/"SDK" is <package-name>@<semver>+<hash>,
  // not a bare semver — the CLI's own version.ts extracts semver the same way
  // (slice after '@', match leading \d+.\d+.\d+) before comparing versions.
  async version(): Promise<DriveVersion> {
    const text = await this.runRaw(["version"]);
    const cliMatch = text.match(/Proton Drive CLI\s+(\S+)/);
    const sdkMatch = text.match(/Proton Drive SDK\s+(\S+)/);
    return {
      cli: extractSemver(cliMatch?.[1]),
      sdk: extractSemver(sdkMatch?.[1]),
    };
  }

  // Filesystem
  //
  // The CLI's list output has no `path` field at all — only `uid`/`parentUid`.
  // We compute a usable path by joining the listed folder with each item's
  // (unwrapped) name; confirmed live that /parent/name round-trips correctly
  // through the CLI's own name-based path resolver for every other command.
  // The path is built by concatenation, not posix.join: join() collapses a
  // "." or ".." name (created by another client) into the parent folder's path.
  //
  // Exception: listing "/" returns the roots as [{path:"/my-files"}, ...] with
  // no name at all — previously every root came out as "[unnamed]".
  async list(remotePath: string, opts: { includeUid?: boolean } = {}): Promise<DriveFile[]> {
    const result = await this.run(["filesystem", "list", remotePath]);
    if (result === null) return [];
    if (!Array.isArray(result)) throw new DriveParseError(`Expected array from list, got: ${JSON.stringify(result).slice(0, 100)}`);
    // The CLI's order changes between calls and callers page by re-listing, so
    // impose a total order: name, then uid (names are not unique).
    const uidOf = (item: Record<string, unknown>) => (typeof item.uid === "string" ? item.uid : "");
    const entries = result.map((item: Record<string, unknown>) => ({ item, file: this.mapListItem(item, remotePath, opts) }));
    entries.sort((x, y) => x.file.name.localeCompare(y.file.name) || (uidOf(x.item) < uidOf(y.item) ? -1 : uidOf(x.item) > uidOf(y.item) ? 1 : 0));
    return entries.map((e) => e.file);
  }

  private mapListItem(item: Record<string, unknown>, remotePath: string, opts: { includeUid?: boolean }): DriveFile {
    if (item.name === undefined && typeof item.path === "string") {
      return { name: item.path.replace(/^\//, ""), path: item.path, type: "folder" as const };
    }
    const name = unwrapResult(item.name, "[unnamed]");
    const rev = (item.activeRevision ?? {}) as Record<string, unknown>;
    const file: DriveFile = {
      name,
      path: joinRemote(remotePath, escapeNameForPath(name)),
      type: item.type === "folder" || item.type === "album" ? "folder" : "file",
      size: typeof rev.claimedSize === "number" ? rev.claimedSize : undefined,
      storageSize: typeof item.totalStorageSize === "number" ? item.totalStorageSize : undefined,
      modifiedAt: typeof item.modificationTime === "string" ? item.modificationTime : undefined,
      mimeType: typeof item.mediaType === "string" ? item.mediaType : undefined,
    };
    if (opts.includeUid) {
      file.uid = typeof item.uid === "string" ? item.uid : undefined;
      const trashed = item.trashTime ?? item.trashedTime;
      file.trashedAt = typeof trashed === "string" ? trashed : undefined;
    }
    return file;
  }

  async upload(
    localPath: string,
    remotePath: string,
    fileConflictStrategy: FileConflictStrategy = "skip",
    folderConflictStrategy: FolderConflictStrategy = "skip"
  ): Promise<UploadResult> {
    const result = await this.run([
      "filesystem",
      "upload",
      localPath,
      remotePath,
      "--file-conflict-strategy",
      fileConflictStrategy,
      "--folder-conflict-strategy",
      folderConflictStrategy,
    ]);
    // Real shape is TransferSummary: {transferredItems, transferredBytes,
    // skippedItems, failedItems, failures}. Confirmed live — the old
    // {uploaded, skipped, failed} field names never existed, so failures
    // were silently reported as 0 regardless of what actually happened.
    const summary = this.parseTransferSummary(result);
    return {
      path: remotePath,
      uploaded: summary.transferredItems,
      skipped: summary.skippedItems,
      failed: summary.failedItems,
    };
  }

  async download(
    remotePath: string,
    localPath: string,
    fileConflictStrategy: FileDownloadConflictStrategy = "skip",
    folderConflictStrategy: FolderDownloadConflictStrategy = "skip"
  ): Promise<DownloadResult> {
    const result = await this.run([
      "filesystem", "download", remotePath, localPath,
      "--file-conflict-strategy", fileConflictStrategy,
      "--folder-conflict-strategy", folderConflictStrategy,
    ]);
    // Same real shape as upload — TransferSummary, not {downloaded}. Previously
    // this dropped skippedItems/failedItems entirely, and the MCP dispatch
    // never checked for partial failure the way drive_upload's does — a
    // download where some files failed silently reported success.
    const summary = this.parseTransferSummary(result);
    return {
      path: remotePath,
      localPath,
      downloaded: summary.transferredItems,
      skipped: summary.skippedItems,
      failed: summary.failedItems,
    };
  }

  // The CLI has no `mkdir` — it's `create-folder <parentPath> <name>`.
  async mkdir(remotePath: string): Promise<void> {
    const { parent, name } = splitRemotePath(remotePath);
    if (!name || parent === remotePath) {
      throw new Error(`path must include a folder name to create: ${remotePath}`);
    }
    if (name.includes("\\/")) {
      throw new Error(`folder name must not contain '/': ${remotePath}`);
    }
    validateName(name);
    await this.run(["filesystem", "create-folder", parent, name]);
  }

  // Returns metadata (including latest revision details) for a single file or
  // folder. Trimmed of lossless noise by default; verbose=true returns the raw
  // CLI/SDK node, whose exact shape is not guaranteed.
  async info(remotePath: string, verbose = false): Promise<unknown> {
    const raw = await this.run(["filesystem", "info", remotePath]);
    return verbose ? raw : trimNode(raw);
  }

  // Renames in place — does not move to a different folder. Returns the
  // renamed node (raw pass-through).
  async rename(remotePath: string, newName: string): Promise<unknown> {
    return this.run(["filesystem", "rename", remotePath, newName]);
  }

  // The CLI has no single "move to any full path" command — `move` only
  // accepts a target *parent folder*, and renaming is a separate `rename`
  // command. We keep the tool's external contract (a full destination path)
  // by translating into the right combination of the two real commands.
  //
  // A cross-folder move that also renames is two mutations, so it is
  // pre-checked to avoid ending up half-done:
  //  - the destination name already taken  -> fail before touching anything
  //  - the source's *own* name taken in the destination folder (the interim
  //    name after `move`) -> rename first, then move, instead
  async move(sourcePath: string, destinationPath: string): Promise<void> {
    const src = splitRemotePath(sourcePath);
    const dst = splitRemotePath(destinationPath);
    // Only a *rename* to a slash-containing name is unsupported; moving an item
    // that already has one (same name) is fine.
    if (src.name !== dst.name && dst.name.includes("\\/")) {
      throw new Error(`destination name must not contain '/': ${destinationPath}`);
    }

    if (src.parent === dst.parent) {
      if (src.name === dst.name) {
        await this.info(sourcePath); // no-op, but a missing source must still fail
        return;
      }
      await this.rename(sourcePath, dst.name);
      return;
    }

    if (src.name === dst.name) {
      assertItemsOk(await this.run(["filesystem", "move", sourcePath, dst.parent]), "Move");
      return;
    }

    const dstItems = await this.list(dst.parent);
    const dstNames = new Set(dstItems.map((f) => f.name));
    if (dstNames.has(dst.name)) {
      // Only checked on this error path (costs a call): a missing source was
      // otherwise misreported as "Destination already exists".
      try {
        await this.info(sourcePath);
      } catch (err) {
        if (err instanceof Error && /not found/i.test(err.message)) {
          throw new Error(`Source not found: ${sourcePath}`);
        }
        throw err;
      }
      // Seen in live testing: passing the target folder itself as destinationPath is an easy mistake.
      const isFolder = dstItems.find((f) => f.name === dst.name)?.type === "folder";
      const hint = isFolder ? ` — it is a folder; to move into it, pass the full new path, e.g. ${joinRemote(destinationPath, src.name)}` : "";
      throw new Error(`Destination already exists: ${destinationPath}${hint}`);
    }

    if (!dstNames.has(unescapeName(src.name))) {
      assertItemsOk(await this.run(["filesystem", "move", sourcePath, dst.parent]), "Move");
      const movedPath = joinRemote(dst.parent, src.name);
      try {
        await this.rename(movedPath, dst.name);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new Error(`Moved to ${dst.parent} but renaming to '${dst.name}' failed (${why}). The item is now at ${movedPath}.`);
      }
      return;
    }

    // Interim-name collision in the destination folder: rename in place first.
    await this.rename(sourcePath, dst.name);
    const renamedPath = joinRemote(src.parent, escapeNameForPath(dst.name));
    try {
      assertItemsOk(await this.run(["filesystem", "move", renamedPath, dst.parent]), "Move");
    } catch (err) {
      try { await this.rename(renamedPath, unescapeName(src.name)); } catch { /* best effort rollback */ }
      throw err;
    }
  }

  // `filesystem delete` permanently deletes — but only items already inside
  // /trash or /photos-trash (the CLI rejects live paths). No --confirm flag
  // exists on the CLI side; our own confirmed-gate lives in the MCP layer.
  async delete(remotePath?: string, uid?: string): Promise<void> {
    const target = await this.resolveTrashTarget(remotePath, uid);
    assertItemsOk(await this.run(["filesystem", "delete", target]), "Delete");
  }

  // Sharing
  //
  // Real shape is the SDK's ShareResult: {protonInvitations, nonProtonInvitations,
  // members, urlAccess?, editorsCanShare} — confirmed live. There is no
  // isShared/email/addedAt/shareUrl field; those were all wrong names.
  // When nothing is shared, the CLI prints literal "undefined" (see
  // subprocess.ts) which now resolves to `result === null` here.
  //
  // `members` merges all three sources (accepted members + both invitation
  // kinds), each tagged accepted/pending. Confirmed live: inviting a
  // non-Proton email (e.g. a Gmail address) files it under
  // nonProtonInvitations, not members — reading only `members` made a real,
  // successfully-sent invite completely invisible from this tool.
  async shareStatus(remotePath: string): Promise<ShareStatus> {
    if (ROOT_PATHS.has(remotePath)) {
      throw new Error(`Roots cannot be shared — pass a file or folder inside it: ${remotePath}`);
    }
    const result = await this.run(["sharing", "status", remotePath]);
    const r = (result ?? {}) as Record<string, unknown>;
    const VALID_ROLES = new Set(["viewer", "editor", "admin"]);
    const toShareMember = (m: Record<string, unknown>, status: "accepted" | "pending"): ShareMember => ({
      email: String(m.inviteeEmail ?? ""),
      role: (VALID_ROLES.has(String(m.role)) ? String(m.role) : "viewer") as ShareRole,
      addedAt: typeof m.invitationTime === "string" ? m.invitationTime : undefined,
      status,
    });
    const accepted = Array.isArray(r.members) ? (r.members as Record<string, unknown>[]).map((m) => toShareMember(m, "accepted")) : [];
    const protonPending = Array.isArray(r.protonInvitations) ? (r.protonInvitations as Record<string, unknown>[]).map((m) => toShareMember(m, "pending")) : [];
    const nonProtonPending = Array.isArray(r.nonProtonInvitations) ? (r.nonProtonInvitations as Record<string, unknown>[]).map((m) => toShareMember(m, "pending")) : [];
    const members = [...accepted, ...protonPending, ...nonProtonPending];
    const urlAccess = (r.urlAccess ?? undefined) as Record<string, unknown> | undefined;
    const password = urlAccess?.customPassword;
    const expiresAt = urlAccess?.expirationTime;
    return {
      path: remotePath,
      isShared: members.length > 0 || !!urlAccess,
      members,
      shareUrl: typeof urlAccess?.url === "string" ? urlAccess.url : undefined,
      // Only a boolean — never echo the link password itself.
      sharePasswordProtected: urlAccess ? Boolean(password) : undefined,
      shareUrlExpiresAt: typeof expiresAt === "string" ? expiresAt : undefined,
      editorsCanShare: typeof r.editorsCanShare === "boolean" ? r.editorsCanShare : undefined,
    };
  }

  async shareInvite(
    remotePath: string,
    email: string,
    role: ShareRole,
    message?: string
  ): Promise<void> {
    await this.run([
      "sharing", "invite",
      ...(message ? ["--message", message] : []),
      "--user", email,
      "--role", role,
      remotePath,
    ]);
  }

  // `sharing revoke` doesn't exist — it's `sharing remove --email <email>`.
  // Confirmed live: the CLI exits 0 and prints "undefined" whether or not the
  // address is a member, and matches case-sensitively — so a wrong-case address
  // was reported as revoked while the real member kept access. Verify against
  // the current members first and send the canonical address.
  async shareRevoke(remotePath: string, email: string): Promise<void> {
    const status = await this.shareStatus(remotePath);
    const match = status.members.find((m) => m.email.toLowerCase() === email.toLowerCase());
    if (!match) {
      throw new Error(`${email} is not a member or pending invitee of ${remotePath}`);
    }
    await this.shareRemove(remotePath, [match.email], false);
  }

  // Removes every member and pending invitation. `removed` is how many there
  // were — 0 means nothing was sent to the CLI. `--everyone` does not touch the
  // public link, so `publicLink` reports whether one is still active.
  async shareRemoveAll(remotePath: string): Promise<{ removed: number; publicLink: boolean }> {
    const status = await this.shareStatus(remotePath);
    const publicLink = Boolean(status.shareUrl);
    if (status.members.length === 0) return { removed: 0, publicLink };
    await this.shareRemove(remotePath, [], true);
    return { removed: status.members.length, publicLink };
  }

  // General form of remove: specific emails, or --everyone to strip all
  // members and pending invitations (Proton and non-Proton) in one call.
  async shareRemove(remotePath: string, emails: string[], everyone: boolean): Promise<void> {
    const args = ["sharing", "remove"];
    for (const email of emails) args.push("--email", email);
    if (everyone) args.push("--everyone");
    args.push(remotePath);
    await this.run(args);
  }

  // NOTE: set-url REPLACES the link's settings. Confirmed live: re-running it
  // without a password/expiration silently turned a password-protected link
  // into an open one (same URL), and setting only a password cleared an
  // existing expiration. When that is about to happen, say so.
  async shareSetUrl(
    remotePath: string,
    role: Exclude<ShareRole, "admin"> = "viewer",
    password?: string,
    expiration?: string
  ): Promise<PublicLink> {
    let droppedProtection = false;
    if (!password || !expiration) {
      const before = await this.shareStatus(remotePath).catch(() => undefined);
      droppedProtection = Boolean((!password && before?.sharePasswordProtected) || (!expiration && before?.shareUrlExpiresAt));
    }
    const args = ["sharing", "set-url", remotePath, "--role", role];
    if (password) args.push("--password", password);
    if (expiration) args.push("--expiration", expiration);
    const result = await this.run(args);
    const link = this.parsePublicLink(result);
    if (droppedProtection) {
      link.warning = "This link previously had a password and/or expiration; set_url replaces link settings, so whichever of them you did not pass again was removed. Pass both password and expiration to keep them.";
    }
    return link;
  }

  async shareRemoveUrl(remotePath: string): Promise<void> {
    await this.run(["sharing", "remove-url", remotePath]);
  }

  private parsePublicLink(result: unknown): PublicLink {
    const r = (result ?? {}) as Record<string, unknown>;
    const urlAccess = (r.urlAccess ?? {}) as Record<string, unknown>;
    const url = r.url ?? urlAccess.url;
    const role = r.role ?? urlAccess.role;
    const expirationTime = r.expirationTime ?? urlAccess.expirationTime;
    return {
      url: typeof url === "string" ? url : undefined,
      role: (["viewer", "editor", "admin"].includes(String(role)) ? role : undefined) as ShareRole | undefined,
      expirationTime: typeof expirationTime === "string" ? expirationTime : undefined,
    };
  }

  // Trash
  //
  // Confirmed live: two trashed items with the same name both list as
  // /trash/<name>, so restore/delete by that path is ambiguous. uid (and the
  // trash time, when the CLI provides it) let the caller tell them apart.
  async listTrash(): Promise<DriveFile[]> {
    return this.list("/trash", { includeUid: true });
  }

  async trash(remotePath: string): Promise<void> {
    assertItemsOk(await this.run(["filesystem", "trash", remotePath]), "Trash");
  }

  async restore(remotePath?: string, uid?: string): Promise<void> {
    const target = await this.resolveTrashTarget(remotePath, uid);
    assertItemsOk(await this.run(["filesystem", "restore", target]), "Restore");
  }

  // Confirmed live against CLI v0.8.0: restore/delete accept only /trash
  // paths, and the CLI resolves /trash/<x> by decrypted NAME, taking the
  // first match — "/trash/<uid>", a bare uid and "/my-files/<uid>" are all
  // rejected, and renaming a trashed node fails. So a specific item among
  // same-named duplicates cannot be addressed at all; the only safe move is
  // to refuse. The uid pins the exact item the caller saw in drive_list_trash
  // and is translated to its /trash/<name> path once that name is unique.
  // /photos-trash gets the same duplicate check: it holds the user's trashed
  // photos, where a same-named pair is easy to end up with.
  // The lookup and the CLI call are two steps, so an item trashed under the
  // same name in between is not detected.
  async resolveTrashTarget(remotePath?: string, uid?: string): Promise<string> {
    if (!remotePath && !uid) throw new Error("Provide path or uid (from drive_list_trash).");
    const root = remotePath?.match(/^\/(trash|photos-trash)\/(?:[^/\\]|\\.)+$/)?.[1];
    if (!uid && !root) return remotePath as string;
    const trashed = await this.list(`/${root ?? "trash"}`, { includeUid: true });
    let target = remotePath as string;
    if (uid) {
      const item = trashed.find((f) => f.uid === uid);
      if (!item) throw new Error(`No item with uid ${uid} in trash. Call drive_list_trash for current uids.`);
      if (remotePath !== undefined && remotePath !== item.path) {
        throw new Error(`path ${remotePath} does not match uid ${uid} (which is ${item.path} in trash).`);
      }
      target = item.path;
    }
    const matches = trashed.filter((f) => f.path === target);
    if (matches.length > 1) {
      const list = matches.map((f) => `uid ${f.uid ?? "?"} (trashed ${f.trashedAt ?? "unknown"})`).join("; ");
      throw new Error(
        `${matches.length} trashed items share the path ${target}: ${list}. ` +
        "The proton-drive CLI can only address trashed items by name, so it would act on an arbitrary one — refusing. " +
        "Restore or delete the intended item in the Proton Drive web or desktop app instead.",
      );
    }
    return target;
  }

  async emptyTrash(): Promise<void> {
    await this.run(["filesystem", "empty-trash"]);
  }

  // The destination is the target PARENT folder (unlike move). `newName` maps to
  // the CLI's `--name`, which is the only way to copy under a new name or
  // duplicate an item inside its own folder.
  async copy(remoteSrc: string, remoteDst: string, newName?: string): Promise<void> {
    const args = ["filesystem", "copy", ...(newName ? ["--name", newName] : []), remoteSrc, remoteDst];
    assertItemsOk(await this.run(args), "Copy");
  }

  async listInvitations(): Promise<DriveInvitation[]> {
    const result = await this.run(["invitation", "list"]);
    if (result === null) return [];
    if (!Array.isArray(result)) throw new DriveParseError(`Expected array from invitation list, got: ${JSON.stringify(result).slice(0, 100)}`);
    return result.map((item: Record<string, unknown>) => {
      const node = (item.node ?? {}) as Record<string, unknown>;
      // addedByEmail is also a verified Result<string,...>, same as name —
      // confirmed via the SDK's Member type (client/js/src/interface/sharing.ts).
      return {
        uid: String(item.uid ?? ""),
        role: (["viewer", "editor", "admin"].includes(String(item.role)) ? String(item.role) : "viewer") as ShareRole,
        invitedByEmail: unwrapResult(item.addedByEmail),
        invitedAt: typeof item.invitationTime === "string" ? item.invitationTime : undefined,
        nodeName: unwrapResult(node.name, "[unnamed]"),
        nodeType: node.type === "folder" ? "folder" : "file",
      };
    });
  }

  async invitationAccept(uid: string): Promise<void> {
    assertItemsOk(await this.run(["invitation", "accept", uid]), "Accept invitation");
  }

  async invitationReject(uid: string): Promise<void> {
    assertItemsOk(await this.run(["invitation", "reject", uid]), "Reject invitation");
  }

  async shareLeave(remotePath: string): Promise<void> {
    assertItemsOk(await this.run(["sharing", "leave", remotePath]), "Leave");
  }

  // Photos / Albums
  //
  // Albums are NodeEntity too — name needs the same {ok,value} unwrap as
  // filesystem list(), and photoCount lives under a nested `album` object
  // (`item.album.photoCount`), not top-level. Both confirmed live.
  async listAlbums(): Promise<Album[]> {
    const result = await this.run(["album", "list"]);
    if (result === null) return [];
    if (!Array.isArray(result)) throw new DriveParseError(`Expected array from album list, got: ${JSON.stringify(result).slice(0, 100)}`);
    return result.map((item: Record<string, unknown>) => {
      const albumInfo = (item.album ?? {}) as Record<string, unknown>;
      return {
        uid: typeof item.uid === "string" ? item.uid : undefined,
        name: unwrapResult(item.name, "[unnamed]"),
        photoCount: typeof albumInfo.photoCount === "number" ? albumInfo.photoCount : 0,
        isShared: Boolean(item.isShared ?? false),
        creationTime: typeof item.creationTime === "string" ? item.creationTime : undefined,
      };
    });
  }

  // Confirmed live: the CLI happily creates a second album with the same name,
  // and every /albums/<name> path is then ambiguous (update renamed one album,
  // delete removed a different one, with no error). Refuse duplicates, and
  // refuse to act on a path that is already ambiguous.
  async createAlbum(name: string): Promise<void> {
    const existing = await this.listAlbums();
    if (existing.some((a) => a.name === name)) {
      throw new Error(`An album named '${name}' already exists`);
    }
    await this.run(["album", "create", name]);
  }

  private async assertAlbumUnambiguous(albumPath: string): Promise<void> {
    const name = unescapeName(albumPath.replace(/^\/albums\//, ""));
    if (name.includes("/")) return; // not a plain /albums/<name> path
    const count = (await this.listAlbums()).filter((a) => a.name === name).length;
    if (count > 1) {
      throw new Error(`Ambiguous album path ${albumPath}: ${count} albums are named '${name}'. Rename or delete one of them in the Proton Photos app first.`);
    }
  }

  async updateAlbum(albumPath: string, name?: string, coverPhotoUid?: string): Promise<void> {
    await this.assertAlbumUnambiguous(albumPath);
    const args = ["album", "update", albumPath];
    if (name) args.push("--name", name);
    if (coverPhotoUid) args.push("--cover-photo-uid", coverPhotoUid);
    await this.run(args);
  }

  async deleteAlbum(albumPath: string, force: boolean, save: boolean): Promise<void> {
    await this.assertAlbumUnambiguous(albumPath);
    // CLI 0.8.0 deletes a non-empty album even without --force (confirmed live).
    if (!force) {
      const name = unescapeName(albumPath.replace(/^\/albums\//, ""));
      const album = (await this.listAlbums()).find((a) => a.name === name);
      // Fail closed: if the album can't be matched, emptiness can't be checked.
      if (!album) {
        throw new Error(`Could not find album ${albumPath} in the album list to check that it is empty. Check the name with photos_list_albums, or pass force to delete it anyway.`);
      }
      if (album.photoCount > 0) {
        throw new Error(`Album ${albumPath} still contains ${album.photoCount} photo(s). Pass force to delete it anyway (the photos stay in your timeline).`);
      }
    }
    const args = ["album", "delete", albumPath];
    if (force) args.push("--force");
    if (save) args.push("--save");
    await this.run(args);
  }

  async listAlbumPhotos(albumPath: string, loadDetails = false): Promise<AlbumPhoto[]> {
    await this.assertAlbumUnambiguous(albumPath);
    const args = ["album", "photos", albumPath];
    if (loadDetails) args.push("--load-details");
    const result = await this.run(args);
    if (result === null) return [];
    if (!Array.isArray(result)) throw new DriveParseError(`Expected array from album photos, got: ${JSON.stringify(result).slice(0, 100)}`);
    return result.map((item: Record<string, unknown>) => mapPhoto(item));
  }

  async addPhotoToAlbum(albumPath: string, photoPath: string): Promise<void> {
    await this.assertAlbumUnambiguous(albumPath);
    assertItemsOk(await this.run(["album", "add-photo", albumPath, photoPath]), "Add to album");
  }

  async removePhotoFromAlbum(albumPath: string, photoPath: string): Promise<void> {
    await this.assertAlbumUnambiguous(albumPath);
    assertItemsOk(await this.run(["album", "remove-photo", albumPath, photoPath]), "Remove from album");
  }

  // Photos timeline / library-level transfers (distinct from album-scoped
  // filesystem-style paths above — these hit the `photo` CLI group).
  async photoTimeline(loadDetails: boolean): Promise<AlbumPhoto[]> {
    const args = ["photo", "timeline"];
    if (loadDetails) args.push("--load-details");
    const result = await this.run(args);
    if (result === null) return [];
    if (!Array.isArray(result)) throw new DriveParseError(`Expected array from photo timeline, got: ${JSON.stringify(result).slice(0, 100)}`);
    // Without --load-details the CLI returns {nodeUid, captureTime, tags}.
    // With --load-details it returns full node objects ({uid, name, mediaType,
    // creationTime, totalStorageSize, photo: {captureTime, tags}, ...}) —
    // confirmed live.
    return result.map((item: Record<string, unknown>) => mapPhoto(item));
  }

  async photoDownload(
    remotePaths: string[],
    localFolder: string,
    conflictStrategy: PhotoDownloadConflictStrategy = "skip"
  ): Promise<TransferSummary> {
    // CLI 0.8.0 treats everything after /albums/ as the album name
    // ("Album not found: <album>/<photo>"), so album paths never work.
    const albumPath = remotePaths.find((p) => p.startsWith("/albums/"));
    if (albumPath) {
      throw new Error(`Cannot download ${albumPath}: album paths are not supported by photo download. Use the photo's /photos/<name> path instead.`);
    }
    const result = await this.run([
      "photo", "download", ...remotePaths, localFolder,
      "--conflict-strategy", conflictStrategy,
    ]);
    return this.parseTransferSummary(result);
  }

  async photoUpload(
    localPaths: string[],
    conflictStrategy: PhotoUploadConflictStrategy = "skip"
  ): Promise<TransferSummary> {
    const result = await this.run([
      "photo", "upload", ...localPaths,
      "--conflict-strategy", conflictStrategy,
    ]);
    return this.parseTransferSummary(result);
  }

  private parseTransferSummary(result: unknown): TransferSummary {
    const r = (result ?? {}) as Record<string, unknown>;
    return {
      transferredItems: typeof r.transferredItems === "number" ? r.transferredItems : 0,
      transferredBytes: typeof r.transferredBytes === "number" ? r.transferredBytes : 0,
      skippedItems: typeof r.skippedItems === "number" ? r.skippedItems : 0,
      failedItems: typeof r.failedItems === "number" ? r.failedItems : 0,
    };
  }
}
