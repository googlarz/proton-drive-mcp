# Changelog

## 1.0.10 — 2026-06-10

### Fixed
- **Path traversal guard** — `validatePath` now rejects paths containing `..` segments (e.g. `/my-files/../../etc/passwd`); previously only leading dashes and control characters were blocked
- **CLI path validation** — all path arguments in the CLI companion are now validated through `validatePath` (flag-injection check, control-char check, traversal check) before reaching `DriveService`; previously CLI args were passed raw
- **CLI email validation** — `share invite` and `share revoke` now run `validateEmail` (full format + leading-dash check) on the email argument; previously only a leading-dash check was applied
- **`DriveParseError` no longer leaks raw CLI output** — the error message shown to MCP clients is now the generic `"Failed to parse CLI output as JSON"`; the raw bytes are written to stderr for diagnostics
- **Subprocess auth check ordering** — stderr is now only checked for "not authenticated" when stdout is empty; previously a CLI warning on stderr could cause a valid JSON response to be discarded
- **`maxBuffer`** — `execFileAsync` now sets `maxBuffer: 50MB`; previously the 1MB default caused an unhandled `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` error on large directory listings
- **`killSignal: "SIGKILL"`** — subprocess timeouts now send `SIGKILL` instead of the default `SIGTERM`, which a process can ignore

### Added
- `src/utils/validation.ts` — shared validation module; `validatePath`, `validateEmail`, `validateMessage` are now in one place, used by both the MCP server and the CLI companion
- Tests: `validatePath` (10 cases), `validateEmail` (6 cases), `validateMessage` (4 cases), `DriveCliNotFoundError` propagation — 52 tests total

## 1.0.9 — 2026-06-10

### Fixed
- `drive_trash` and `drive_restore` success messages now include the path (e.g. `"Moved to trash: /my-files/old.pdf"`)
- `validateEmail` now rejects values starting with `-` — consistent with `validatePath` and `validateMessage`
- `drive_share_revoke` success message now uses the validated email string instead of the raw `a.email` input
- CLI `share invite` now rejects email values starting with `-` before calling the service
- Publish workflow now runs `npm run ci` (lint + test) instead of only `npm test`, ensuring type errors don't block a publish

## 1.0.8 — 2026-06-10

### Fixed
- **`--message` flag injection** — `validateMessage` now rejects values starting with `-`; an LLM could otherwise pass `--role admin` as a message and inject flags into the `proton-drive sharing invite` call
- **Timeout detection** — also catches `e.code === "ETIMEDOUT"` and `e.signal != null` in addition to `e.killed === true`; Node may set any of these depending on platform and process behavior
- **`list()` and `listTrash()` non-array results** — previously silently returned `[]` when the CLI returned an unexpected object shape; now throws `DriveParseError` with a diagnostic snippet
- **`authStatus()` null result** — when CLI returns empty output now returns `{ authenticated: false }` explicitly rather than relying on optional-chaining fallbacks through a null cast
- **`shareInvite` splice replaced** — replaced fragile `args.splice(2, 0, "--message", message)` with a declarative spread `[...(message ? ["--message", message] : []), ...]`; equivalent behavior, immune to future arg-order changes
- **`drive_move` and `drive_delete` success messages** now include the paths operated on (e.g. `"Deleted: /my-files/old.pdf"`, `"Moved: /src → /dst"`)
- **`validatePath` control characters** — now rejects paths containing `\x00–\x1f`; null bytes are silently truncated by the OS at the syscall boundary
- **`getFlag` missing value** — `--conflict` or `--message` with no following value (or another flag immediately after) now emits a clear error instead of returning `undefined`
- **CHANGELOG v1.0.6** — fixed copy-paste error that listed unpacked size as "~50 kB to ~50 kB"
- **README** — removed overclaim that "Claude will always use `drive_list_trash` first"; this is not enforced by code

### Added
- `PROTON_DRIVE_BIN` environment variable — overrides the `proton-drive` binary name/path for non-standard installations; documented in README troubleshooting
- Tests: `authStatus` null result, `authStatus` loggedIn alias now also asserts email forwarding, `list` non-array throws `DriveParseError`, `listTrash` non-array throws `DriveParseError`, upload asserts `--skip-thumbnails` is present in args (31 tests total)

## 1.0.7 — 2026-06-10

### Fixed
- `validatePath` now rejects values starting with `-`, preventing a flag-injection scenario where an LLM could pass a value like `--skip-thumbnails` as a path and alter CLI behavior
- `drive_mkdir` success message now uses the validated path string instead of the raw `a.path` input

## 1.0.6 — 2026-06-10

### Fixed
- `drive_share_invite` MCP handler now validates `role` at runtime (viewer/editor/admin), consistent with the CLI companion and the `conflictStrategy` guard added in v1.0.4
- Removed `.d.ts`, `.d.ts.map`, and `.js.map` files from the published package — this is a CLI tool, not a library; declaration files and source maps have no value for consumers (~22 kB → ~14 kB packed)

### Changed
- CI workflow: removed redundant `Build` step — `npm test` already calls `npm run build` internally, so the explicit step was building twice
- Publish workflow: added version-tag match check — fails the publish job if `package.json` version doesn't match the pushed git tag, preventing accidental version drift

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
