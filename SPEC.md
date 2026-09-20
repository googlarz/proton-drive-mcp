# Spec: proton-drive-mcp

## Objective

An MCP server (+ companion CLI) that exposes Proton Drive and Proton Photos to Claude and other MCP clients: list, upload, download, organise, share and trash files without leaving the AI workflow.

It wraps the official `proton-drive` CLI binary as a subprocess. The CLI owns authentication (OS keychain), end-to-end encryption and every Proton API call; this project adds the MCP protocol layer, input validation, safety gates and response shaping on top. No credentials pass through this project.

**User:** Claude Code / Claude Desktop users who already have the Proton Drive CLI installed and logged in (`proton-drive auth login`).

## Tech stack

TypeScript (ESM), Node.js >= 20, `@modelcontextprotocol/sdk`, `tsc`, `node:test`, npm. Published as `proton-drive-mcp` (bins: `proton-drive-mcp`, `proton-drive-cli`).

## Commands

```
Build:   npm run build
Lint:    npm run lint          # tsc --noEmit
Test:    npm test              # build + all test/*.test.mjs
Start:   node dist/index.js    # MCP server over stdio
CLI:     node dist/cli.js <command>
```

## Project structure

```
src/index.ts              MCP server: TOOLS (schemas), tool-surface derivation (gates, pagination),
                          schema enforcement, dispatch, lifecycle (signals, cancellation)
src/cli.ts                Companion CLI (mirrors every tool except drive_read_file/drive_write_file)
src/services/drive.ts     DriveService: one method per operation, CLI argv building, response parsing
src/utils/subprocess.ts   Runs the CLI: timeouts, process-group kill, cancellation, sanitized errors
src/utils/validation.ts   Argument validators (flag injection, traversal, types)
src/utils/localguard.ts   Credential-location denylist / PROTON_DRIVE_LOCAL_ROOT allowlist
src/utils/syncfs.ts       Symlink-safe read/write inside PROTON_DRIVE_SYNC_PATH
src/utils/isMainModule.ts Entry-point detection (realpath, so npm's .bin symlink works)
src/types/index.ts        Shared response types
test/                     Unit tests (injected runner) + real-process tests (fake CLI over stdio)
```

## Tools (38)

- **Auth / meta:** `drive_auth_status`, `drive_auth_logout`, `drive_version`
- **Filesystem:** `drive_list`, `drive_info`, `drive_mkdir`, `drive_upload`, `drive_download`, `drive_rename`, `drive_move`, `drive_copy`
- **Trash:** `drive_list_trash`, `drive_trash`, `drive_restore`, `drive_delete`, `drive_empty_trash`
- **Sharing:** `drive_share_status`, `drive_share_invite`, `drive_share_revoke`, `drive_share_remove_all`, `drive_share_set_url`, `drive_share_remove_url`, `drive_share_leave`
- **Invitations:** `drive_list_invitations`, `drive_invitation_accept`, `drive_invitation_reject`
- **Photos:** `photos_list_albums`, `photos_create_album`, `photos_update_album`, `photos_delete_album`, `photos_list_album_photos`, `photos_add_to_album`, `photos_remove_from_album`, `photos_list_timeline`, `photos_download`, `photos_upload`
- **Local sync folder (needs `PROTON_DRIVE_SYNC_PATH`):** `drive_read_file`, `drive_write_file`

## Design rules learned from the live CLI

- The CLI reports per-item success of `move/copy/trash/restore/delete/...` as `[{uid, ok, error}]` with **exit code 0** — every such result must be checked (`assertItemsOk`).
- Node names, authors etc. are `{ok, value}` verification wrappers, never plain strings.
- A literal `/` in a node name is escaped as `\/` in CLI paths; names this server creates may not contain `/`, `.`/`..`, a leading `-`, or control characters.
- Names and paths are not trimmed (trailing spaces are real). Tool arguments are type-checked; non-strings are rejected.
- `set-url` replaces link settings; `sharing remove` and `album create` do not validate membership/uniqueness themselves, so the service does.

## Safety model

- All argv built as arrays for `spawn` (no shell); flag injection blocked by validators.
- `confirmed: true` required for destructive or outward-facing tools (delete, empty trash, remove-all, album delete, invite, revoke, public links, leave, reject, logout, remove-from-album) and for the `replace` / `remove` conflict strategies and overwriting a sync-folder file. The CLI requires `--confirm` for the destructive ones.
- Local paths: credential-location denylist (or `PROTON_DRIVE_LOCAL_ROOT` allowlist), symlinks resolved first.
- Errors never echo the command line; output is truncated.
- CLI children run in their own process group and are killed on timeout, cancellation, disconnect and SIGTERM/SIGINT.

## Testing strategy

- Unit tests drive `DriveService` with an injected runner (argv assertions, response parsing, collision/ambiguity handling).
- Real-process tests spawn `dist/index.js` / `dist/cli.js` against a fake `PROTON_DRIVE_BIN` over stdio (gates, schema enforcement, error sanitization, lifecycle, symlink launch, parity of tools/README/glama/smithery).
- `test/live.test.mjs` is an opt-in read-only smoke test against a real account (`PROTON_DRIVE_LIVE=1`).
- CI: lint, tests on Node 20/22/24, `npm audit`, and a pack-and-install smoke test that launches the real bin symlink.

## Boundaries

- **Always:** validate every argument, check `{ok:false}` results, keep responses bounded (pagination), test against the real CLI before claiming a behaviour.
- **Ask first:** new tools, changing a tool's response shape, dependency majors, changing CI/publish.
- **Never:** log or echo secrets, bypass a confirmation gate, run destructive tools against a real account in automated tests.
