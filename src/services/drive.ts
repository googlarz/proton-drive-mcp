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
  ShareRole,
  ShareStatus,
  TransferSummary,
  UploadResult,
} from "../types/index.js";
import { runDrive as defaultRunDrive, runDriveRaw as defaultRunDriveRaw } from "../utils/subprocess.js";
import { DriveNotAuthenticatedError, DriveParseError } from "../utils/errors.js";

type Runner = (args: string[]) => Promise<unknown>;
type RawRunner = (args: string[]) => Promise<string>;

export type ConflictStrategy = "merge" | "keep-both" | "replace" | "skip";

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
  //   Proton Drive CLI 1.2.3
  //   Proton Drive SDK 4.5.6
  //   ...update-check line...
  async version(): Promise<DriveVersion> {
    const text = await this.runRaw(["version"]);
    const cliMatch = text.match(/Proton Drive CLI\s+(\S+)/);
    const sdkMatch = text.match(/Proton Drive SDK\s+(\S+)/);
    return {
      cli: cliMatch ? cliMatch[1] : "unknown",
      sdk: sdkMatch ? sdkMatch[1] : "unknown",
    };
  }

  // Filesystem
  async list(remotePath: string): Promise<DriveFile[]> {
    const result = await this.run(["filesystem", "list", remotePath]);
    if (result === null) return [];
    if (!Array.isArray(result)) throw new DriveParseError(`Expected array from list, got: ${JSON.stringify(result).slice(0, 100)}`);
    return result.map((item: Record<string, unknown>) => ({
      name: String(item.name ?? ""),
      path: String(item.path ?? remotePath),
      type: item.type === "folder" ? "folder" : "file",
      size: typeof item.size === "number" ? item.size : undefined,
      modifiedAt: typeof item.modifiedAt === "string" ? item.modifiedAt : undefined,
      mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined,
    }));
  }

  async upload(
    localPath: string,
    remotePath: string,
    conflictStrategy: ConflictStrategy = "skip"
  ): Promise<UploadResult> {
    const result = await this.run([
      "filesystem",
      "upload",
      localPath,
      remotePath,
      "--conflict-strategy",
      conflictStrategy,
      "--skip-thumbnails",
    ]);
    const r = (result ?? {}) as Record<string, unknown>;
    return {
      path: remotePath,
      uploaded: typeof r?.uploaded === "number" ? r.uploaded : 0,
      skipped: typeof r?.skipped === "number" ? r.skipped : 0,
      failed: typeof r?.failed === "number" ? r.failed : 0,
    };
  }

  async download(
    remotePath: string,
    localPath: string,
    conflictStrategy: Exclude<ConflictStrategy, "merge"> = "skip"
  ): Promise<DownloadResult> {
    const result = await this.run([
      "filesystem", "download", remotePath, localPath,
      "--conflict-strategy", conflictStrategy,
    ]);
    const r = (result ?? {}) as Record<string, unknown>;
    return {
      path: remotePath,
      localPath,
      downloaded: typeof r?.downloaded === "number" ? r.downloaded : 0,
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
  async shareStatus(remotePath: string): Promise<ShareStatus> {
    const result = await this.run(["sharing", "status", remotePath]);
    if (result === null) throw new DriveParseError("sharing status returned empty response");
    const r = result as Record<string, unknown>;
    const VALID_ROLES = new Set(["viewer", "editor", "admin"]);
    const members = Array.isArray(r?.members)
      ? (r.members as Record<string, unknown>[]).map((m) => ({
          email: String(m.email ?? ""),
          role: (VALID_ROLES.has(String(m.role)) ? String(m.role) : "viewer") as ShareRole,
          addedAt: typeof m.addedAt === "string" ? m.addedAt : undefined,
        }))
      : [];
    return {
      path: remotePath,
      isShared: Boolean(r?.isShared ?? members.length > 0),
      members,
      shareUrl: typeof r?.shareUrl === "string" ? r.shareUrl : undefined,
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
      const nameVal = (node.name ?? {}) as Record<string, unknown>;
      const nodeName = typeof nameVal.value === "string" ? nameVal.value : String(node.name ?? "");
      return {
        uid: String(item.uid ?? ""),
        role: (["viewer", "editor", "admin"].includes(String(item.role)) ? String(item.role) : "viewer") as ShareRole,
        invitedByEmail: String(item.addedByEmail ?? ""),
        invitedAt: typeof item.invitationTime === "string" ? item.invitationTime : undefined,
        nodeName,
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
  async listAlbums(): Promise<Album[]> {
    const result = await this.run(["album", "list"]);
    if (result === null) return [];
    if (!Array.isArray(result)) throw new DriveParseError(`Expected array from album list, got: ${JSON.stringify(result).slice(0, 100)}`);
    return result.map((item: Record<string, unknown>) => ({
      name: String(item.name ?? ""),
      photoCount: typeof item.photoCount === "number" ? item.photoCount : 0,
      isShared: Boolean(item.isShared ?? false),
      creationTime: typeof item.creationTime === "string" ? item.creationTime : undefined,
    }));
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
    return result.map((item: Record<string, unknown>) => ({
      nodeUid: String(item.nodeUid ?? item.uid ?? ""),
    }));
  }

  async photoDownload(
    remotePaths: string[],
    localFolder: string,
    conflictStrategy: "skip" | "replace" | "keep-both" = "skip"
  ): Promise<TransferSummary> {
    const result = await this.run([
      "photo", "download", ...remotePaths, localFolder,
      "--conflict-strategy", conflictStrategy,
    ]);
    return this.parseTransferSummary(result);
  }

  async photoUpload(
    localPaths: string[],
    conflictStrategy: "skip" | "keep-both" = "skip"
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
