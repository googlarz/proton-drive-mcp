#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";
import { DriveService } from "./services/drive.js";
import { checkCliAvailable } from "./utils/subprocess.js";
import {
  DriveCliNotFoundError,
  DriveCliError,
  DriveNotAuthenticatedError,
  DriveParseError,
} from "./utils/errors.js";
import { validateRemotePath, validateLocalPath, validateEmail, validateMessage } from "./utils/validation.js";
import { logger } from "./utils/logger.js";
import { getSyncRoot, readSyncFile, writeSyncFile } from "./utils/syncfs.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };
const VERSION = pkg.version ?? "1.0.0";

process.env["PROTON_DRIVE_MCP"] = "1";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function fail(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function truncate(s: string, max = 500): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function handleError(err: unknown): ToolResult {
  if (err instanceof DriveCliNotFoundError) return fail(err.message);
  if (err instanceof DriveNotAuthenticatedError) return fail(err.message);
  if (err instanceof DriveCliError) return fail(`CLI error: ${truncate(err.message)}`);
  if (err instanceof DriveParseError) return fail(`Parse error: ${err.message}`);
  if (err instanceof Error) return fail(truncate(err.message));
  return fail(`Unexpected error: ${truncate(String(err))}`);
}

const TOOLS = [
  // Auth
  {
    name: "drive_auth_status",
    description:
      "Check whether the Proton Drive CLI has an active authenticated session. " +
      "Returns {authenticated: boolean, email?: string}. " +
      "Use before any file operation when you need to confirm the session is valid — all other drive_* tools (except drive_version) require authentication. " +
      "Does not make a network call if the session token is already cached locally.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "drive_auth_logout",
    description:
      "Clear the stored Proton Drive session from the OS keychain. " +
      "After logout all file and sharing operations will fail until the user runs `proton-drive auth login` again. " +
      "Use on shared machines to prevent session persistence. " +
      "Do not call during an active workflow — it will break all subsequent drive_* calls. " +
      "Idempotent: safe to call even if already logged out.",
    annotations: { destructiveHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "drive_version",
    description:
      "Return the installed proton-drive CLI version and SDK version as {cli: string, sdk: string}. " +
      "Does not require authentication — use to confirm the correct binary is in PATH before other operations, or to diagnose compatibility issues. " +
      "Do not use to check auth state; use drive_auth_status instead.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  // Filesystem
  {
    name: "drive_list",
    description:
      "List the immediate children of a Proton Drive folder. Requires authentication. " +
      "Returns [{name, path, type ('file'|'folder'), size?, modifiedAt?, mimeType?}]. " +
      "Not recursive — one directory level only. " +
      "Use before drive_upload to confirm the destination exists, or before drive_download to verify the remote path. " +
      "Do not use to list trash — use drive_list_trash instead.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path to list (must start with '/'). E.g. /my-files or /my-files/Reports",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_upload",
    description:
      "Upload a local file or folder to Proton Drive with end-to-end encryption. Requires authentication. " +
      "For folders, uploads recursively and preserves directory structure. " +
      "Returns {uploaded, skipped, failed} counts — fails the call if failed > 0 (common causes: quota exceeded, destination path not found, permission denied). " +
      "conflictStrategy defaults to 'skip' — only use 'overwrite' with explicit user confirmation since it permanently replaces the remote file. " +
      "Do not use to move files already on Drive (use drive_move) or to write text content directly (use drive_write_file if PROTON_DRIVE_SYNC_PATH is set). " +
      "Ensure destination folder exists first with drive_list; create it with drive_mkdir if needed.",
    annotations: { openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        localPath: {
          type: "string",
          description: "Absolute local filesystem path of the file or folder to upload (must start with '/').",
        },
        remotePath: {
          type: "string",
          description: "Absolute remote Drive destination folder path (must start with '/'). E.g. /my-files/Reports",
        },
        conflictStrategy: {
          type: "string",
          enum: ["skip", "overwrite", "rename"],
          description:
            "'skip' leaves existing remote files unchanged (default). " +
            "'overwrite' permanently replaces the remote file — confirm with user first. " +
            "'rename' uploads with a unique name to avoid conflicts.",
        },
      },
      required: ["localPath", "remotePath"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_download",
    description:
      "Download a file or folder from Proton Drive to the local filesystem. Requires authentication. " +
      "For folders, downloads recursively. " +
      "Silently overwrites any existing local file at localPath — verify the destination before calling. " +
      "Fails if the local parent directory does not exist. " +
      "Returns {downloaded} count. " +
      "Do not use to move files within Drive (use drive_move) or to read a small text file's contents (use drive_read_file if PROTON_DRIVE_SYNC_PATH is set).",
    annotations: { openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        remotePath: {
          type: "string",
          description: "Absolute remote Drive path to download (must start with '/'). E.g. /my-files/report.pdf",
        },
        localPath: {
          type: "string",
          description: "Absolute local destination path (must start with '/'). Parent directory must already exist.",
        },
      },
      required: ["remotePath", "localPath"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_mkdir",
    description:
      "Create a new empty folder on Proton Drive. Requires authentication. " +
      "Fails if the folder already exists or if the parent folder does not exist — use drive_list to check first. " +
      "Does not create intermediate directories; create each level separately. " +
      "Do not use to upload files (use drive_upload) or to create nested folder trees in one call.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path for the new folder (must start with '/'). E.g. /my-files/NewFolder",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_move",
    description:
      "Move or rename a file or folder on Proton Drive. Requires authentication. " +
      "To rename: keep the same parent, change only the filename (e.g. /my-files/old.pdf → /my-files/new.pdf). " +
      "To move: provide a different parent folder. " +
      "Fails if destinationPath is already occupied or if its parent folder does not exist. " +
      "Do not use to copy a file (no copy operation exists — upload again instead) or to download to local storage (use drive_download).",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        sourcePath: {
          type: "string",
          description: "Absolute remote path of the file or folder to move (must start with '/').",
        },
        destinationPath: {
          type: "string",
          description: "Absolute remote destination path (must start with '/'). Parent folder must exist.",
        },
      },
      required: ["sourcePath", "destinationPath"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_delete",
    description:
      "Permanently delete a file or folder from Proton Drive — no trash step, no recovery possible. Requires authentication. " +
      "Requires confirmed=true; always show the exact path to the user and get explicit confirmation before calling. " +
      "Do not use when reversible deletion is acceptable — use drive_trash instead so the item can be recovered with drive_restore.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path to permanently delete (must start with '/').",
        },
        confirmed: {
          type: "boolean",
          description: "Must be true. Confirms the user has acknowledged this deletion is permanent and cannot be undone.",
        },
      },
      required: ["path", "confirmed"],
      additionalProperties: false,
    },
  },
  // Sharing
  {
    name: "drive_share_status",
    description:
      "Return the current sharing state of a Proton Drive path. Requires authentication. " +
      "Returns {isShared: boolean, members: [{email, role, addedAt?}], shareUrl?}. " +
      "Always call this before drive_share_invite (to avoid duplicate invitations) and before drive_share_revoke (to confirm the member email). " +
      "Do not call this to modify sharing — it is read-only.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path to inspect (must start with '/').",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_list_trash",
    description:
      "List all files and folders currently in the Proton Drive trash. Requires authentication. " +
      "Returns [{name, path, type, size?, modifiedAt?}]. " +
      "Use before drive_restore to find a trashed item's exact path, or before drive_empty_trash to show the user what will be permanently deleted. " +
      "Do not use to list active (non-trashed) files — use drive_list instead.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "drive_share_invite",
    description:
      "Invite a person to access a Proton Drive file or folder by email. Requires authentication. " +
      "Immediately sends an email notification to the invitee — always confirm the email address and role with the user before calling. " +
      "role values: 'viewer' (read-only), 'editor' (read + write), 'admin' (read + write + reshare). " +
      "Do not call without first running drive_share_status — duplicate invitations may silently overwrite the existing role. " +
      "To remove access, use drive_share_revoke.",
    annotations: { openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path to share (must start with '/').",
        },
        email: {
          type: "string",
          description: "Email address of the person to invite.",
        },
        role: {
          type: "string",
          enum: ["viewer", "editor", "admin"],
          description:
            "'viewer' = read-only, 'editor' = read + write, 'admin' = read + write + reshare.",
        },
        message: {
          type: "string",
          description: "Optional message included in the invitation email (max 2000 characters).",
        },
      },
      required: ["path", "email", "role"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_share_revoke",
    description:
      "Remove a specific person's access to a Proton Drive file or folder. Requires authentication. " +
      "The revoked user receives no notification. " +
      "Always call drive_share_status first to confirm the email and current role before revoking. " +
      "To revoke all members, call this once per member listed by drive_share_status. " +
      "Do not use to modify a role — revoke and re-invite with the new role instead.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path (must start with '/').",
        },
        email: {
          type: "string",
          description: "Email address of the person whose access to revoke.",
        },
      },
      required: ["path", "email"],
      additionalProperties: false,
    },
  },
  // Trash
  {
    name: "drive_trash",
    description:
      "Move a file or folder to the Proton Drive trash. Requires authentication. " +
      "The item disappears from its original path immediately but is not permanently deleted — recover it with drive_restore or list it with drive_list_trash. " +
      "Prefer this over drive_delete whenever permanent removal is not explicitly required by the user. " +
      "Do not use when the item must be permanently gone immediately — use drive_delete with confirmed=true instead.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path to move to trash (must start with '/').",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_restore",
    description:
      "Restore a trashed file or folder back to its original Proton Drive path. Requires authentication. " +
      "Use drive_list_trash first to find the item's current path in trash. " +
      "Fails if the original parent folder no longer exists or if a new item with the same name was created at that path since it was trashed. " +
      "Do not use for items not currently in trash — it will return an error.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path of the item to restore, as shown in drive_list_trash output (must start with '/').",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_empty_trash",
    description:
      "Permanently delete ALL items in the Proton Drive trash — irreversible, no recovery. Requires authentication. " +
      "Requires confirmed=true. " +
      "Always call drive_list_trash first to show the user exactly what will be deleted, then ask for explicit confirmation. " +
      "Do not call if the user only wants to delete specific items — use drive_delete or drive_trash for individual files.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        confirmed: {
          type: "boolean",
          description: "Must be true. Confirms the user has reviewed the trash contents and acknowledged this action is permanent and irreversible.",
        },
      },
      required: ["confirmed"],
      additionalProperties: false,
    },
  },
  // Sync-folder tools (requires PROTON_DRIVE_SYNC_PATH env var)
  {
    name: "drive_read_file",
    description:
      "Read the text contents of a file from the local Proton Drive sync folder. " +
      "Requires the PROTON_DRIVE_SYNC_PATH environment variable to point to the root of the synced folder (e.g. /Users/alice/Proton Drive). " +
      "The Proton Drive desktop app must be running and the file must be synced locally. " +
      "Limited to text files up to 1 MB — returns an error for binary files or larger files (use drive_download instead). " +
      "Do not use for files not yet synced locally, binary files, or files over 1 MB — use drive_download instead.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path of the file to read (must start with '/'). Mapped to the local sync folder. E.g. /my-files/notes.txt",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_write_file",
    description:
      "Write text content to a file in the local Proton Drive sync folder. Requires authentication. " +
      "Requires the PROTON_DRIVE_SYNC_PATH environment variable to point to the sync folder root. " +
      "The Proton Drive desktop app must be running to sync the written file to the cloud. " +
      "Creates parent directories locally if they do not exist. " +
      "Overwrites the file if it already exists — confirm with the user before overwriting. " +
      "Do not use for binary content or files that need to be uploaded without the desktop app running — use drive_upload instead.",
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path of the file to write (must start with '/'). Mapped to the local sync folder. E.g. /my-files/notes.txt",
        },
        content: {
          type: "string",
          description: "UTF-8 text content to write. The file will be created or overwritten.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
] as const;

export async function main() {
  // Warn if the CLI is missing but don't exit — the server must start so MCP
  // hosts can introspect tools. Individual tool calls will return a clear error.
  const cliCheck = await checkCliAvailable();
  if (!cliCheck.available) {
    const msg = cliCheck.reason === "not_executable"
      ? "proton-drive CLI found but not executable. Run: chmod +x $(which proton-drive)"
      : "proton-drive CLI not found. Download from https://proton.me/download/drive/cli/index.html";
    logger.error(msg);
  }

  const drive = new DriveService();

  const server = new Server(
    { name: "proton-drive-mcp", version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: (t as { annotations?: Record<string, boolean> }).annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const a = args as Record<string, unknown>;

    try {
      switch (name) {
        case "drive_auth_status":
          return ok(await drive.authStatus());

        case "drive_auth_logout":
          await drive.authLogout();
          return ok({ message: "Logged out successfully." });

        case "drive_version":
          return ok(await drive.version());

        case "drive_list":
          return ok(await drive.list(validateRemotePath(a.path)));

        case "drive_mkdir": {
          const mkdirPath = validateRemotePath(a.path);
          await drive.mkdir(mkdirPath);
          return ok({ message: `Folder created: ${mkdirPath}` });
        }

        case "drive_upload": {
          const cs = typeof a.conflictStrategy === "string" ? a.conflictStrategy : "skip";
          if (!["skip", "overwrite", "rename"].includes(cs)) {
            return fail(`conflictStrategy must be skip, overwrite, or rename`);
          }
          const uploadResult = await drive.upload(
            validateLocalPath(a.localPath),
            validateRemotePath(a.remotePath),
            cs as "skip" | "overwrite" | "rename"
          );
          if (uploadResult.failed > 0) {
            return fail(`Upload completed with ${uploadResult.failed} failed file(s). uploaded=${uploadResult.uploaded} skipped=${uploadResult.skipped}`);
          }
          return ok(uploadResult);
        }

        case "drive_download":
          return ok(await drive.download(validateRemotePath(a.remotePath), validateLocalPath(a.localPath)));

        case "drive_move": {
          const moveSrc = validateRemotePath(a.sourcePath);
          const moveDst = validateRemotePath(a.destinationPath);
          await drive.move(moveSrc, moveDst);
          return ok({ message: `Moved: ${moveSrc} → ${moveDst}` });
        }

        case "drive_delete": {
          if (a.confirmed !== true) {
            return fail("drive_delete requires confirmed=true. Ask the user to confirm before deleting.");
          }
          const deletePath = validateRemotePath(a.path);
          await drive.delete(deletePath);
          return ok({ message: `Deleted: ${deletePath}` });
        }

        case "drive_list_trash":
          return ok(await drive.listTrash());

        case "drive_share_status":
          return ok(await drive.shareStatus(validateRemotePath(a.path)));

        case "drive_share_invite": {
          const email = validateEmail(a.email);
          if (typeof a.role !== "string") {
            return fail("role must be a string: viewer, editor, or admin");
          }
          const role = a.role;
          if (!["viewer", "editor", "admin"].includes(role)) {
            return fail("role must be viewer, editor, or admin");
          }
          const inviteMsg = typeof a.message === "string" ? validateMessage(a.message) : undefined;
          await drive.shareInvite(
            validateRemotePath(a.path),
            email,
            role as "viewer" | "editor" | "admin",
            inviteMsg
          );
          return ok({ message: `Invited ${email} as ${role}.` });
        }

        case "drive_share_revoke":
        {
          const revokeEmail = validateEmail(a.email);
          await drive.shareRevoke(validateRemotePath(a.path), revokeEmail);
          return ok({ message: `Revoked access for ${revokeEmail}.` });
        }

        case "drive_trash": {
          const trashPath = validateRemotePath(a.path);
          await drive.trash(trashPath);
          return ok({ message: `Moved to trash: ${trashPath}` });
        }

        case "drive_restore": {
          const restorePath = validateRemotePath(a.path);
          await drive.restore(restorePath);
          return ok({ message: `Restored from trash: ${restorePath}` });
        }

        case "drive_empty_trash":
          if (a.confirmed !== true) {
            return fail(
              "drive_empty_trash requires confirmed=true. " +
              "Use drive_list_trash first to show the user what will be deleted, then ask for confirmation."
            );
          }
          await drive.emptyTrash();
          return ok({ message: "Trash emptied." });

        case "drive_read_file": {
          const syncRoot = getSyncRoot();
          if (!syncRoot) return fail("PROTON_DRIVE_SYNC_PATH is not set. Set it to the root of your Proton Drive sync folder.");
          const content = await readSyncFile(syncRoot, validateRemotePath(a.path));
          return ok({ path: a.path, content });
        }

        case "drive_write_file": {
          const syncRoot = getSyncRoot();
          if (!syncRoot) return fail("PROTON_DRIVE_SYNC_PATH is not set. Set it to the root of your Proton Drive sync folder.");
          if (typeof a.content !== "string") return fail("content must be a string");
          await writeSyncFile(syncRoot, validateRemotePath(a.path), a.content);
          return ok({ message: `Written: ${a.path}` });
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (err) {
      if (err instanceof McpError) throw err;
      return handleError(err);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`proton-drive-mcp v${VERSION} running`);
}

main().catch((err) => {
  logger.error("Fatal:", err);
  process.exit(1);
});
