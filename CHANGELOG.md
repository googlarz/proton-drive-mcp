# Changelog

## 1.0.5 — 2026-06-10

### Fixed
- **Logger MCP mode detection** — `isMcp` was evaluated at module import time (before `main()` set the env var), causing `logger.info` to write to stdout in MCP mode and corrupt JSON-RPC framing. Now evaluated lazily on each call.
- `drive_upload` MCP handler now validates `conflictStrategy` at runtime (schema restriction alone is insufficient for misbehaving clients)
- `shareInvite` test now uses `deepEqual` to assert exact argument order, catching any future splice regression
- `checkCliAvailable` now passes `--json` to `proton-drive version` for consistency with all other subprocess calls; added a comment explaining the ENOENT-only semantics

## 1.0.4 — 2026-06-10

### Fixed
- Timeout errors now surface as "CLI process timed out after Xs" instead of the generic "Command failed" message
- `--conflict` flag in CLI `upload` command now validates the value (skip/overwrite/rename) before calling the service
- `role` argument in CLI `share invite` command now validates the value (viewer/editor/admin) before calling the service

### Added
- Tests for `drive_version` covering both standard `{ cli, sdk }` response and the `{ version }` fallback shape (28 tests total)

## 1.0.3 — 2026-06-10

### Fixed
- CLI error handler now surfaces `DriveParseError` as "Parse error: ..." (was "Error: Error: ...")
- CLI catch-all for plain `Error` instances now prints `err.message` directly (was `String(err)` → "Error: Error: message")
- Removed unused `CliResult<T>` type from `src/types/index.ts`
- Removed stray double blank line in `src/cli.ts`

## 1.0.2 — 2026-06-10

### Fixed
- `DriveParseError` now surfaces as "Parse error: ..." instead of "Unexpected error: Error: ..."
- Validation errors (empty path, invalid email) now show the message directly without the misleading "Unexpected error:" prefix

## 1.0.1 — 2026-06-10

### Added
- `drive_mkdir` — create empty folders on Proton Drive
- `drive_list_trash` — list trash contents before emptying or restoring
- `drive_delete` and `drive_empty_trash` now require `confirmed: true` to prevent accidental data loss
- CLI `--json` flag for pipe-friendly single-line output
- CLI `trash list` subcommand
- CLI `mkdir` command
- `smithery.yaml` for MCP registry submission
- Path validation: empty strings are rejected before reaching the CLI
- Email validation on `drive_share_invite`
- Friendly CLI error when `proton-drive` binary is not in PATH
- Upload/download timeout extended to 30 minutes (was 60 seconds)
- `DriveCliError.stderr` shown in CLI error output

## 1.0.0 — 2026-06-10

Initial release.

### MCP Tools
- `drive_auth_status`, `drive_auth_logout`, `drive_version`
- `drive_list`, `drive_upload`, `drive_download`, `drive_move`, `drive_delete`
- `drive_share_status`, `drive_share_invite`, `drive_share_revoke`
- `drive_trash`, `drive_restore`, `drive_empty_trash`

### CLI
- `proton-drive-cli` companion CLI exposing all 14 tools
