import { posix as posixPath } from "node:path";
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
  async list(remotePath: string): Promise<DriveFile[]> {
    const result = await this.run(["filesystem", "list", remotePath]);
    if (result === null) return [];
    if (!Array.isArray(result)) throw new DriveParseError(`Expected array from list, got: ${JSON.stringify(result).slice(0, 100)}`);
    return result.map((item: Record<string, unknown>) => {
      const name = unwrapResult(item.name, "[unnamed]");
      return {
        name,
        path: posixPath.join(remotePath, escapeNameForPath(name)),
        type: item.type === "folder" || item.type === "album" ? "folder" : "file",
        size: typeof item.totalStorageSize === "number" ? item.totalStorageSize : undefined,
        modifiedAt: typeof item.modificationTime === "string" ? item.modificationTime : undefined,
        mimeType: typeof item.mediaType === "string" ? item.mediaType : undefined,
      };
    });
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
    const parent = posixPath.dirname(remotePath);
    const name = posixPath.basename(remotePath);
    if (!name || parent === remotePath) {
      throw new Error(`path must include a folder name to create: ${remotePath}`);
    }
    await this.run(["filesystem", "create-folder", parent, name]);
  }

  // Returns full node metadata (including latest revision details) for a
  // single file or folder. Shape comes straight from the CLI/SDK and is not
  // guaranteed — this is a deliberate raw pass-through, unlike list()'s
  // trimmed DriveFile shape, so callers get everything the CLI exposes.
  async info(remotePath: string): Promise<unknown> {
    return this.run(["filesystem", "info", remotePath]);
  }

  // Renames in place — does not move to a different folder. Returns the
  // renamed node (raw pass-through, same reasoning as info()).
  async rename(remotePath: string, newName: string): Promise<unknown> {
    return this.run(["filesystem", "rename", remotePath, newName]);
  }

  // The CLI has no single "move to any full path" command — `move` only
  // accepts a target *parent folder*, and renaming is a separate `rename`
  // command. We keep the tool's external contract (a full destination path)
  // by translating into the right combination of the two real commands.
  async move(sourcePath: string, destinationPath: string): Promise<void> {
    const srcParent = posixPath.dirname(sourcePath);
    const srcName = posixPath.basename(sourcePath);
    const dstParent = posixPath.dirname(destinationPath);
    const dstName = posixPath.basename(destinationPath);

    if (srcParent === dstParent) {
      if (srcName === dstName) return;
      await this.rename(sourcePath, dstName);
      return;
    }

    await this.run(["filesystem", "move", sourcePath, dstParent]);

    if (srcName !== dstName) {
      const movedPath = posixPath.join(dstParent, srcName);
      await this.rename(movedPath, dstName);
    }
  }

  // `filesystem delete` permanently deletes — but only items already inside
  // /trash or /photos-trash (the CLI rejects live paths). No --confirm flag
  // exists on the CLI side; our own confirmed-gate lives in the MCP layer.
  async delete(remotePath: string): Promise<void> {
    await this.run(["filesystem", "delete", remotePath]);
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
    return {
      path: remotePath,
      isShared: members.length > 0 || !!urlAccess,
      members,
      shareUrl: typeof urlAccess?.url === "string" ? urlAccess.url : undefined,
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
  async shareRevoke(remotePath: string, email: string): Promise<void> {
    await this.shareRemove(remotePath, [email], false);
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

  async shareSetUrl(
    remotePath: string,
    role: Exclude<ShareRole, "admin"> = "viewer",
    password?: string,
    expiration?: string
  ): Promise<PublicLink> {
    const args = ["sharing", "set-url", remotePath, "--role", role];
    if (password) args.push("--password", password);
    if (expiration) args.push("--expiration", expiration);
    const result = await this.run(args);
    return this.parsePublicLink(result);
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
  async listTrash(): Promise<DriveFile[]> {
    return this.list("/trash");
  }

  async trash(remotePath: string): Promise<void> {
    await this.run(["filesystem", "trash", remotePath]);
  }

  async restore(remotePath: string): Promise<void> {
    await this.run(["filesystem", "restore", remotePath]);
  }

  async emptyTrash(): Promise<void> {
    await this.run(["filesystem", "empty-trash"]);
  }

  async copy(remoteSrc: string, remoteDst: string): Promise<void> {
    await this.run(["filesystem", "copy", remoteSrc, remoteDst]);
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
    await this.run(["invitation", "accept", uid]);
  }

  async invitationReject(uid: string): Promise<void> {
    await this.run(["invitation", "reject", uid]);
  }

  async shareLeave(remotePath: string): Promise<void> {
    await this.run(["sharing", "leave", remotePath]);
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
        name: unwrapResult(item.name, "[unnamed]"),
        photoCount: typeof albumInfo.photoCount === "number" ? albumInfo.photoCount : 0,
        isShared: Boolean(item.isShared ?? false),
        creationTime: typeof item.creationTime === "string" ? item.creationTime : undefined,
      };
    });
  }

  async createAlbum(name: string): Promise<void> {
    await this.run(["album", "create", name]);
  }

  async updateAlbum(albumPath: string, name?: string, coverPhotoUid?: string): Promise<void> {
    const args = ["album", "update", albumPath];
    if (name) args.push("--name", name);
    if (coverPhotoUid) args.push("--cover-photo-uid", coverPhotoUid);
    await this.run(args);
  }

  async deleteAlbum(albumPath: string, force: boolean, save: boolean): Promise<void> {
    const args = ["album", "delete", albumPath];
    if (force) args.push("--force");
    if (save) args.push("--save");
    await this.run(args);
  }

  async listAlbumPhotos(albumPath: string): Promise<AlbumPhoto[]> {
    const result = await this.run(["album", "photos", albumPath]);
    if (result === null) return [];
    if (!Array.isArray(result)) throw new DriveParseError(`Expected array from album photos, got: ${JSON.stringify(result).slice(0, 100)}`);
    return result.map((item: Record<string, unknown>) => ({
      nodeUid: String(item.nodeUid ?? item.uid ?? ""),
    }));
  }

  async addPhotoToAlbum(albumPath: string, photoPath: string): Promise<void> {
    await this.run(["album", "add-photo", albumPath, photoPath]);
  }

  async removePhotoFromAlbum(albumPath: string, photoPath: string): Promise<void> {
    await this.run(["album", "remove-photo", albumPath, photoPath]);
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
    // confirmed live. Previously this always extracted only nodeUid, so
    // loadDetails=true paid the CLI's slower buffered call for nothing: the
    // "full node metadata" the tool description promises was thrown away.
    return result.map((item: Record<string, unknown>) => {
      const photo = (item.photo ?? {}) as Record<string, unknown>;
      return {
        nodeUid: String(item.nodeUid ?? item.uid ?? ""),
        name: item.name !== undefined ? unwrapResult(item.name) || undefined : undefined,
        mediaType: typeof item.mediaType === "string" ? item.mediaType : undefined,
        creationTime: typeof item.creationTime === "string" ? item.creationTime : undefined,
        totalStorageSize: typeof item.totalStorageSize === "number" ? item.totalStorageSize : undefined,
        captureTime: typeof (item.captureTime ?? photo.captureTime) === "string" ? (item.captureTime ?? photo.captureTime) as string : undefined,
        tags: Array.isArray(item.tags ?? photo.tags) ? (item.tags ?? photo.tags) as unknown[] : undefined,
      };
    });
  }

  async photoDownload(
    remotePaths: string[],
    localFolder: string,
    conflictStrategy: PhotoDownloadConflictStrategy = "skip"
  ): Promise<TransferSummary> {
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
