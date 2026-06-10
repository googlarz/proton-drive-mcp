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
} from "./utils/errors.js";
import { logger } from "./utils/logger.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };
const VERSION = pkg.version ?? "1.0.0";

process.env["PROTON_DRIVE_MCP"] = "1";

const drive = new DriveService();

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

function handleError(err: unknown): ToolResult {
  if (err instanceof DriveCliNotFoundError) return fail(err.message);
  if (err instanceof DriveNotAuthenticatedError) return fail(err.message);
  if (err instanceof DriveCliError) return fail(`CLI error: ${err.message}`);
  return fail(`Unexpected error: ${String(err)}`);
}

const TOOLS = [
  // Auth
  {
    name: "drive_auth_status",
    description: "Check whether the Proton Drive CLI is authenticated.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "drive_auth_logout",
    description: "Log out of Proton Drive (clears stored session).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "drive_version",
    description: "Get Proton Drive CLI and SDK version information.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  // Filesystem
  {
    name: "drive_list",
    description:
      "List files and folders at a Proton Drive path (e.g. /my-files or /my-files/Reports).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Remote Drive path to list. E.g. /my-files",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "drive_upload",
    description: "Upload a local file or folder to Proton Drive.",
    inputSchema: {
      type: "object",
      properties: {
        localPath: {
          type: "string",
          description: "Absolute local path to upload.",
        },
        remotePath: {
          type: "string",
          description: "Remote Drive destination path. E.g. /my-files/Reports",
        },
        conflictStrategy: {
          type: "string",
          enum: ["skip", "overwrite", "rename"],
          description: "What to do if the file already exists. Default: skip.",
        },
      },
      required: ["localPath", "remotePath"],
    },
  },
  {
    name: "drive_download",
    description: "Download a file or folder from Proton Drive to a local path.",
    inputSchema: {
      type: "object",
      properties: {
        remotePath: {
          type: "string",
          description: "Remote Drive path to download. E.g. /my-files/report.pdf",
        },
        localPath: {
          type: "string",
          description: "Absolute local destination path.",
        },
      },
      required: ["remotePath", "localPath"],
    },
  },
  {
    name: "drive_move",
    description: "Move or rename a file or folder on Proton Drive.",
    inputSchema: {
      type: "object",
      properties: {
        sourcePath: {
          type: "string",
          description: "Current remote path of the file/folder.",
        },
        destinationPath: {
          type: "string",
          description: "New remote path.",
        },
      },
      required: ["sourcePath", "destinationPath"],
    },
  },
  {
    name: "drive_delete",
    description: "Permanently delete a file or folder from Proton Drive.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Remote Drive path to delete.",
        },
      },
      required: ["path"],
    },
  },
  // Sharing
  {
    name: "drive_share_status",
    description: "Get sharing status and member list for a Proton Drive path.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Remote Drive path to check sharing for.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "drive_share_invite",
    description: "Invite someone to access a Proton Drive file or folder.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Remote Drive path to share.",
        },
        email: {
          type: "string",
          description: "Email address of the person to invite.",
        },
        role: {
          type: "string",
          enum: ["viewer", "editor", "admin"],
          description: "Access level to grant.",
        },
        message: {
          type: "string",
          description: "Optional message to include in the invitation.",
        },
      },
      required: ["path", "email", "role"],
    },
  },
  {
    name: "drive_share_revoke",
    description: "Remove someone's access to a Proton Drive file or folder.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Remote Drive path.",
        },
        email: {
          type: "string",
          description: "Email address of the person whose access to revoke.",
        },
      },
      required: ["path", "email"],
    },
  },
  // Trash
  {
    name: "drive_trash",
    description: "Move a file or folder to trash on Proton Drive.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Remote Drive path to trash.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "drive_restore",
    description: "Restore a file or folder from trash on Proton Drive.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Remote Drive path to restore.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "drive_empty_trash",
    description: "Permanently delete all items in the Proton Drive trash.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
] as const;

async function main() {
  const cliAvailable = await checkCliAvailable();
  if (!cliAvailable) {
    logger.error(
      "proton-drive CLI not found. Download from https://proton.me/download/drive/cli/index.html"
    );
    process.exit(1);
  }

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
          return ok(await drive.list(String(a.path)));

        case "drive_upload":
          return ok(
            await drive.upload(
              String(a.localPath),
              String(a.remotePath),
              (a.conflictStrategy as "skip" | "overwrite" | "rename") ?? "skip"
            )
          );

        case "drive_download":
          return ok(await drive.download(String(a.remotePath), String(a.localPath)));

        case "drive_move":
          await drive.move(String(a.sourcePath), String(a.destinationPath));
          return ok({ message: "Moved successfully." });

        case "drive_delete":
          await drive.delete(String(a.path));
          return ok({ message: "Deleted successfully." });

        case "drive_share_status":
          return ok(await drive.shareStatus(String(a.path)));

        case "drive_share_invite":
          await drive.shareInvite(
            String(a.path),
            String(a.email),
            (a.role as "viewer" | "editor" | "admin") ?? "viewer",
            typeof a.message === "string" ? a.message : undefined
          );
          return ok({ message: `Invited ${a.email} as ${a.role}.` });

        case "drive_share_revoke":
          await drive.shareRevoke(String(a.path), String(a.email));
          return ok({ message: `Revoked access for ${a.email}.` });

        case "drive_trash":
          await drive.trash(String(a.path));
          return ok({ message: "Moved to trash." });

        case "drive_restore":
          await drive.restore(String(a.path));
          return ok({ message: "Restored from trash." });

        case "drive_empty_trash":
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
