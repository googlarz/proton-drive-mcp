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
      "Use before any file operation when you need to confirm the session is valid — all other drive_* tools require authentication. " +
      "Does not require network access if the session token is already cached locally.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "drive_auth_logout",
    description:
      "Clear the stored Proton Drive session from the OS keychain. " +
      "After logout, all file and sharing operations will fail until the user runs `proton-drive auth login` again. " +
      "Prefer this on shared machines where the session should not persist. " +
      "Idempotent — safe to call even if already logged out.",
    annotations: { destructiveHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "drive_version",
    description:
      "Return the proton-drive CLI version and SDK version as {cli: string, sdk: string}. " +
      "Use to confirm the correct binary is installed or to debug compatibility issues. " +
      "Does not require authentication.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  // Filesystem
  {
    name: "drive_list",
    description:
      "List the immediate contents of a Proton Drive folder. " +
      "Returns [{name, path, type ('file'|'folder'), size?, modifiedAt?, mimeType?}]. " +
      "Not recursive — lists one directory level only. " +
      "Use before drive_upload to verify the destination folder exists, or before drive_download to confirm the file path. " +
      "To list trash contents, use drive_list_trash instead.",
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
      "Upload a local file or folder to Proton Drive. " +
      "For folders, uploads all contents recursively. " +
      "Returns {uploaded, skipped, failed} counts — the call fails if failed > 0. " +
      "Use drive_mkdir first if the destination folder does not exist. " +
      "To download from Drive instead, use drive_download.",
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
            "What to do when a remote file with the same name already exists. " +
            "'skip' leaves the existing file unchanged (default). " +
            "'overwrite' replaces it permanently. " +
            "'rename' uploads as a uniquely named copy.",
        },
      },
      required: ["localPath", "remotePath"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_download",
    description:
      "Download a file or folder from Proton Drive to the local filesystem. " +
      "For folders, downloads all contents recursively. " +
      "Overwrites existing local files at localPath without warning — verify the destination before calling. " +
      "Returns {downloaded} count. " +
      "To upload to Drive instead, use drive_upload.",
    annotations: { openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        remotePath: {
          type: "string",
          description: "Absolute remote Drive path of the file or folder to download (must start with '/'). E.g. /my-files/report.pdf",
        },
        localPath: {
          type: "string",
          description: "Absolute local filesystem destination path (must start with '/'). Parent directory must already exist.",
        },
      },
      required: ["remotePath", "localPath"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_mkdir",
    description:
      "Create a new empty folder on Proton Drive. " +
      "Fails if the folder already exists — use drive_list first to check. " +
      "Does not create intermediate parent directories; the parent folder must already exist.",
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
      "Move or rename a file or folder on Proton Drive. " +
      "To rename without moving, keep the same parent and change only the name (e.g. /my-files/old.pdf → /my-files/new.pdf). " +
      "To move, change the parent folder. " +
      "The destination parent folder must exist. Fails if destinationPath is already occupied.",
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
          description: "Absolute remote path of the new location (must start with '/'). Parent folder must exist.",
        },
      },
      required: ["sourcePath", "destinationPath"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_delete",
    description:
      "Permanently delete a file or folder from Proton Drive — no trash step, no recovery. " +
      "Requires confirmed=true; always show the path to the user and get explicit confirmation before calling. " +
      "To delete reversibly (recoverable via drive_restore), use drive_trash instead.",
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
      "Return the sharing status of a Proton Drive path: {isShared, members: [{email, role, addedAt?}], shareUrl?}. " +
      "Use before drive_share_invite to see who already has access, or before drive_share_revoke to confirm the member's email. " +
      "Read-only — does not modify sharing.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path to check sharing for (must start with '/').",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_list_trash",
    description:
      "List all files and folders currently in the Proton Drive trash. " +
      "Returns [{name, path, type, size?, modifiedAt?}]. " +
      "Use before drive_restore to find a trashed item's path, or before drive_empty_trash to show the user exactly what will be permanently deleted.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "drive_share_invite",
    description:
      "Invite a person to access a Proton Drive file or folder by email. " +
      "Sends an email notification to the invitee — always confirm with the user before calling. " +
      "role controls access: 'viewer' (read-only), 'editor' (read + write), 'admin' (read + write + can reshare). " +
      "Use drive_share_status first to check if the person already has access. " +
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
            "Access level to grant: 'viewer' = read-only, 'editor' = read + write, 'admin' = read + write + reshare.",
        },
        message: {
          type: "string",
          description: "Optional personal message included in the invitation email (max 2000 characters).",
        },
      },
      required: ["path", "email", "role"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_share_revoke",
    description:
      "Remove a specific person's access to a Proton Drive file or folder. " +
      "The revoked user is not notified. " +
      "Use drive_share_status first to confirm the member's email and current role. " +
      "To revoke all members, call this once per entry returned by drive_share_status. " +
      "To grant access, use drive_share_invite.",
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
      "Move a file or folder to the Proton Drive trash. " +
      "The item disappears from its original path immediately but is not permanently deleted — " +
      "it can be recovered with drive_restore or listed with drive_list_trash. " +
      "Prefer this over drive_delete when permanent removal is not explicitly required.",
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
      "Restore a trashed file or folder back to its original Proton Drive path. " +
      "Use drive_list_trash first to find the trashed item's path. " +
      "Fails if the original parent folder no longer exists or if another item with the same name was created there since it was trashed.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path of the item to restore, as shown in drive_list_trash (must start with '/').",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_empty_trash",
    description:
      "Permanently delete ALL items in the Proton Drive trash — irreversible, no recovery. " +
      "Requires confirmed=true. " +
      "Always call drive_list_trash first to show the user exactly what will be deleted, then ask for explicit confirmation before calling this.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        confirmed: {
          type: "boolean",
          description: "Must be true. Confirms the user has seen the trash contents and acknowledged this is permanent and irreversible.",
        },
      },
      required: ["confirmed"],
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
