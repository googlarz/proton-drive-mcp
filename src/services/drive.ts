import type {
  AuthStatus,
  DownloadResult,
  DriveFile,
  DriveInvitation,
  DriveVersion,
  ShareRole,
  ShareStatus,
  UploadResult,
} from "../types/index.js";
import { runDrive as defaultRunDrive } from "../utils/subprocess.js";
import { DriveParseError } from "../utils/errors.js";

type Runner = (args: string[]) => Promise<unknown>;

export class DriveService {
  private readonly run: Runner;

  constructor(runner?: Runner) {
    this.run = runner ?? defaultRunDrive;
  }

  // Auth
  async authStatus(): Promise<AuthStatus> {
    const result = await this.run(["auth", "status"]);
    if (result === null) return { authenticated: false };
    const r = result as Record<string, unknown>;
    return {
      authenticated: Boolean(r?.authenticated ?? r?.loggedIn ?? false),
      email: typeof r?.email === "string" ? r.email : undefined,
    };
  }

  async authLogout(): Promise<void> {
    await this.run(["auth", "logout"]);
  }

  async version(): Promise<DriveVersion> {
    const result = await this.run(["version"]);
    if (result === null) throw new DriveParseError("version command returned no output");
    const r = result as Record<string, unknown>;
    return {
      cli: typeof r.cli === "string" ? r.cli : String(r.version ?? "unknown"),
      sdk: typeof r.sdk === "string" ? r.sdk : "unknown",
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
    conflictStrategy: "skip" | "overwrite" | "rename" = "skip"
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

  async download(remotePath: string, localPath: string): Promise<DownloadResult> {
    const result = await this.run(["filesystem", "download", remotePath, localPath]);
    const r = (result ?? {}) as Record<string, unknown>;
    return {
      path: remotePath,
      localPath,
      downloaded: typeof r?.downloaded === "number" ? r.downloaded : 0,
    };
  }

  async mkdir(remotePath: string): Promise<void> {
    await this.run(["filesystem", "mkdir", remotePath]);
  }

  async move(remoteSrc: string, remoteDst: string): Promise<void> {
    await this.run(["filesystem", "move", remoteSrc, remoteDst]);
  }

  async delete(remotePath: string): Promise<void> {
    await this.run(["filesystem", "delete", "--confirm", remotePath]);
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

  async shareRevoke(remotePath: string, email: string): Promise<void> {
    await this.run(["sharing", "revoke", "--user", email, remotePath]);
  }

  // Trash
  async listTrash(): Promise<DriveFile[]> {
    const result = await this.run(["trash", "list"]);
    if (result === null) return [];
    if (!Array.isArray(result)) throw new DriveParseError(`Expected array from trash list, got: ${JSON.stringify(result).slice(0, 100)}`);
    return result.map((item: Record<string, unknown>) => ({
      name: String(item.name ?? ""),
      path: String(item.path ?? ""),
      type: item.type === "folder" ? "folder" : "file",
      size: typeof item.size === "number" ? item.size : undefined,
      modifiedAt: typeof item.modifiedAt === "string" ? item.modifiedAt : undefined,
      mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined,
    }));
  }

  async trash(remotePath: string): Promise<void> {
    await this.run(["trash", remotePath]);
  }

  async restore(remotePath: string): Promise<void> {
    await this.run(["trash", "restore", remotePath]);
  }

  async emptyTrash(): Promise<void> {
    await this.run(["trash", "empty", "--confirm"]);
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
}
