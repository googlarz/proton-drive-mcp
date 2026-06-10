# Spec: proton-drive-mcp

## Objective

Build an MCP server (+ companion CLI) that exposes Proton Drive operations to Claude and other MCP clients. The user can list, upload, download, manage, and share files on Proton Drive without leaving their AI workflow.

Modelled after `proton-mail-bridge-client` in structure and conventions. Wraps the official `proton-drive` CLI binary via subprocess — the CLI handles auth, E2E encryption, and all Proton API calls. This MCP adds the protocol layer on top.

**User:** Claude Code / Claude Desktop users who already have Proton Drive CLI installed.

**Success looks like:**
- Claude can list, upload, download, share, and trash files on Proton Drive via MCP tools
- Published to npm as `proton-drive-mcp`
- Installable in Claude Desktop via one `npx` command
- Works on macOS, Linux, Windows (where `proton-drive` binary is in PATH)

---

## Tech Stack

- **Language:** TypeScript (ESM, same as proton-mail-bridge-client)
- **Runtime:** Node.js 20+
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **CLI dependency:** `proton-drive` binary (official Proton Drive CLI, user-installed)
- **Build:** `tsc`
- **Test:** Node built-in `node:test`
- **Package manager:** npm

---

## Commands

```
Build:   npm run build
Dev:     npm run dev          # tsc --watch
Test:    npm test
Start:   node dist/index.js   # MCP server (stdio)
Install: npm run install:claude-desktop
```

---

## Project Structure

```
proton-drive-mcp/
├── src/
│   ├── index.ts              # MCP server entry — registers tools, starts stdio transport
│   ├── services/
│   │   └── drive.ts          # DriveService — wraps proton-drive CLI subprocess calls
│   ├── tools/
│   │   ├── filesystem.ts     # list, upload, download, move, delete tools
│   │   ├── sharing.ts        # sharing status, invite, revoke tools
│   │   └── trash.ts          # trash, restore tools
│   ├── types/
│   │   └── index.ts          # Shared types (DriveFile, ShareStatus, etc.)
│   └── utils/
│       ├── subprocess.ts     # execFile wrapper with timeout + JSON parsing
│       └── errors.ts         # Typed error classes
├── test/
│   └── drive.test.mjs        # Unit tests (mock subprocess)
├── package.json
├── tsconfig.json
├── SPEC.md                   # This file
├── README.md
├── CHANGELOG.md
└── glama.json
```

---

## Code Style

Match `proton-mail-bridge-client` conventions. Use `execFile` (not `exec`) to prevent shell injection — user-supplied paths are passed as discrete arguments, never interpolated into a shell string:

```typescript
// utils/subprocess.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function runDrive(args: string[]): Promise<unknown> {
  const { stdout, stderr } = await execFileAsync(
    'proton-drive',
    [...args, '--json'],
    { timeout: 30_000 }
  )
  if (stderr) throw new DriveCliError(stderr)
  return JSON.parse(stdout)
}
```

- ESM modules (`"type": "module"`)
- Named exports, no default exports except entry points
- `unknown` return types narrowed at call sites
- Errors always typed, never swallowed
- No `any`

---

## MCP Tools (v1)

### Filesystem
| Tool | Maps to CLI |
|------|------------|
| `drive_list` | `proton-drive filesystem list <path>` |
| `drive_upload` | `proton-drive filesystem upload <local> <remote>` |
| `drive_download` | `proton-drive filesystem download <remote> <local>` |
| `drive_move` | `proton-drive filesystem move <src> <dst>` |
| `drive_delete` | `proton-drive filesystem delete <path>` |

### Sharing
| Tool | Maps to CLI |
|------|------------|
| `drive_share_status` | `proton-drive sharing status <path>` |
| `drive_share_invite` | `proton-drive sharing invite --user <email> --role <role> <path>` |
| `drive_share_revoke` | `proton-drive sharing revoke --user <email> <path>` |

### Trash
| Tool | Maps to CLI |
|------|------------|
| `drive_trash` | `proton-drive trash <path>` |
| `drive_restore` | `proton-drive restore <path>` |
| `drive_empty_trash` | `proton-drive trash empty` |

### Auth
| Tool | Maps to CLI |
|------|------------|
| `drive_auth_status` | `proton-drive auth status` |

(Login excluded from v1 — `proton-drive auth login` is interactive; user must authenticate via terminal before using the MCP server.)

---

## Testing Strategy

- **Framework:** Node built-in `node:test`
- **Unit tests:** Mock subprocess calls; test JSON parsing, error handling, argument construction
- **Coverage:** All tools must have at least one passing test
- **No integration tests** against real Proton Drive API (requires auth)

---

## Boundaries

**Always do:**
- Pass `--json` flag on every CLI call
- Validate that `proton-drive` binary exists in PATH before starting server
- Use `execFile` with args array — never interpolate user input into shell strings
- Commit `SPEC.md` and `CHANGELOG.md` alongside code

**Ask first:**
- Adding new CLI commands not listed in v1 tools above
- Publishing under a different npm scope
- Adding non-CLI dependencies (SDK import instead of subprocess)

**Never do:**
- Store Proton credentials in the MCP server (auth is handled entirely by the CLI)
- Use `exec()` or `shell: true` with user-supplied input
- Commit with unresolved TypeScript errors

---

## Success Criteria

- [ ] `npm run build` succeeds with zero TypeScript errors
- [ ] `npm test` passes all unit tests
- [ ] MCP server registers all 11 tools and starts on stdio
- [ ] `drive_list /my-files` returns a parsed file listing when CLI is authenticated
- [ ] Claude Desktop config snippet documented in README
- [ ] `npx proton-drive-mcp` starts the server
- [ ] Published to npm

---

## Open Questions

1. npm package name: `proton-drive-mcp` (public) or `@googlarz/proton-drive-mcp` (scoped)?
2. Should `drive_move` be included in v1 — does the CLI support it? (Need to verify against `proton-drive filesystem --help`)
