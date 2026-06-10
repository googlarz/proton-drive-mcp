# Changelog

## 1.0.19 — 2026-06-10

### Fixed
- **`drive_write_file` annotation** — changed `destructiveHint` from `false` to `true`; overwriting files is destructive and the contradiction with the description was scoring 1/5 on Glama Behavior

## 1.0.18 — 2026-06-10

### Fixed
- CI publish workflow now has NPM_TOKEN secret configured

## 1.0.17 — 2026-06-10

### Added
- **`drive_read_file`** — read text content of a file directly from the local Proton Drive sync folder (`PROTON_DRIVE_SYNC_PATH`); 1 MB limit, binary-file detection, path traversal guard
- **`drive_write_file`** — write text content to a file in the local Proton Drive sync folder; creates parent directories automatically

### Improved
- **Tool descriptions** — all tools now include explicit "Requires authentication" flags, "Do not use when..." alternatives, and failure cause lists to improve Glama TDQS Behavior and Usage Guidelines scores
- **MCP annotations forwarded** — `ListToolsRequestSchema` handler now includes `annotations` (`readOnlyHint`, `destructiveHint`, etc.) in its response so MCP clients receive the full tool metadata

## 1.0.16 — 2026-06-10

### Improved
- **Tool descriptions rewritten** — all 16 tools now include usage guidelines (when to use vs alternatives), behavioral transparency (side effects, auth requirements, overwrite warnings), and richer parameter descriptions with format constraints
- **MCP annotations added** — `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` set correctly on all tools; improves tool selection by MCP clients and raises Glama TDQS baseline scores

## 1.0.15 — 2026-06-10

### Fixed
- **`delete()` missing `--confirm` flag** — `filesystem delete` requires `--confirm`; was silently failing or prompting interactively when the underlying CLI enforces confirmation
- **`emptyTrash()` missing `--confirm` flag** — same issue for `trash empty`

### Added
- **Integration test suite** (`test/integration.test.mjs`) — 20 tests that run against the real `proton-drive` binary; all skip gracefully when CLI is not in PATH; verify every command group exists (`filesystem`, `sharing`, `trash restore`, etc.) so wrong command strings are caught at the CLI level, not just by mocked runners
- **`npm run test:integration`** — runs integration tests only
- **`npm run test:all`** — runs both unit and integration suites

## 1.0.14 — 2026-06-10

### Fixed
- **`restore()` command group** — was calling `["restore", path]` (top-level); corrected to `["trash", "restore", path]` matching the CLI's trash command group (same pattern as `trash list`, `trash empty`)
- **`validateRemotePath`** — new function enforcing that remote Drive paths start with `/`; prevents ambiguous relative paths from being forwarded to the CLI; replaces `validatePath` in all MCP and CLI remote-path positions
- **`cli.ts` no-argument invocation** — invoking `node dist/cli.js` with no arguments now starts the MCP server instead of printing help and exiting; enables Glama/Docker environments that auto-detect `dist/cli.js` as the entry point

## 1.0.13 — 2026-06-10

### Fixed
- **`shareStatus()` null guard** — now throws `DriveParseError` when CLI returns empty output (was silently casting `null` to `Record`)
- **`shareStatus()` unsafe role cast** — member roles are now validated against `["viewer","editor","admin"]` and coerced to `"viewer"` for unknown values; was an unchecked `as ShareRole` cast
- **`upload()` / `download()` null coercion** — changed `result as Record` to `(result ?? {}) as Record` so zero counters are returned rather than a TypeError when CLI produces no output
- **`validatePath` single-dot segments** — `"."` segments (e.g. `/my-files/./secret`) are now rejected alongside `".."` traversal segments
- **`validateLocalPath`** — new exported function requiring local filesystem paths to be absolute; used by `drive_upload` and `drive_download` in both MCP and CLI, preventing relative-path exfiltration of arbitrary local files
- **`checkCliAvailable` EACCES** — binary exists but is not executable now returns `{ available: false, reason: "not_executable" }` with a `chmod` hint, instead of masquerading as "not found"
- **Timeout signal check** — removed `typeof e.signal === "string"` from timeout detection; only `e.killed === true` and `e.code === "ETIMEDOUT"` trigger the timeout error, preventing SIGHUP/SIGPIPE from being misclassified as timeouts
- **`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`** — explicitly caught and surfaced as a human-readable error instead of an opaque Node exception
- **`process.stderr.write` EPIPE** — wrapped in try/catch to prevent an unhandled EPIPE if the parent process closes stderr
- **CLI `delete` / `trash empty` confirmation** — both now require `--confirm` flag, matching the MCP server's `confirmed=true` safety contract; previously CLI had no friction and would delete immediately
- **CLI `requirePath` unreachable return** — added `return "" as never` sentinel, matching `requireEmail`
- **`conflictStrategy` validation error** — changed from `throw new Error(...)` to `return fail(...)` for consistency with other validation paths
- **`drive_upload` failed-file detection** — MCP handler now returns `isError: true` when `failed > 0`; previously all upload results returned success regardless of failure count
- **Error message truncation** — `handleError` now truncates messages to 500 chars before forwarding to MCP clients, preventing unbounded response sizes
- **`additionalProperties: false`** — added to all 16 tool `inputSchema` objects to signal to schema-validating MCP hosts that extra fields are rejected

### Added
- Tests: `version()` null→DriveParseError, `version()` empty object fallback, `shareStatus()` null→DriveParseError, `shareStatus()` unknown role coercion, `validatePath` single-dot segment, `validateLocalPath` suite (4 tests), `checkCliAvailable` return shape, upload `failed` count — 70 tests total

## 1.0.12 — 2026-06-10

### Fixed
- **`role` type guard** — `drive_share_invite` MCP handler now uses `typeof a.role === "string"` instead of `as string` cast, consistent with `conflictStrategy` fix in v1.0.11
- **`requireEmail` TypeScript** — added explicit unreachable return annotation to satisfy strict TypeScript configurations
- **`CONTROL_RE` source encoding** — regex now uses ` `/` ` escape sequences in the `RegExp` constructor string instead of literal Unicode characters, preventing silent stripping by editors or formatters

## 1.0.11 — 2026-06-10

### Fixed
- **`validateMessage` control characters and length** — `validateMessage` now rejects control characters (`\x00-\x1f`, `\x7f`, U+2028, U+2029) and messages exceeding 2000 characters; previously only leading dashes were checked
- **`validatePath` and `validateEmail` DEL and Unicode separators** — control character check now covers `\x7f` (DEL), U+2028 (LINE SEPARATOR), and U+2029 (PARAGRAPH SEPARATOR) in addition to `\x00-\x1f`
- **`conflictStrategy` type check** — changed `as string` cast to `typeof ... === "string"` check, consistent with other argument guards
- **CLI `--message` flag validated** — `share invite` now passes `--message` through `validateMessage` before `DriveService` (was missing; MCP handler already did this)

### Added
- Tests: `validatePath` DEL char, `validateMessage` control chars + length cap — 57 tests total

## 1.0.10 — 2026-06-10

### Fixed
- **Path traversal guard** — `validatePath` now rejects paths containing `..` segments (e.g. `/my-files/../../etc/passwd`); previously only leading dashes and control characters were blocked
- **CLI path validation** — all path arguments in the CLI companion are now validated through `validatePath` (flag-injection check, control-char check, traversal check) before reaching `DriveService`; previously CLI args were passed raw
- **CLI email validation** — `share invite` and `share revoke` now run `validateEmail` (full format + leading-dash check) on the email argument; previously only a leading-dash check was applied
- **CLI `--message` validation** — `share invite` now validates the `--message` flag value through `validateMessage` before passing to `DriveService`; consistent with MCP handler
- **`validateEmail` control characters** — email validation now rejects values containing `\x00–\x1f`, consistent with `validatePath`
- **`DriveParseError` no longer leaks raw CLI output** — the error message shown to MCP clients is now the generic `"Failed to parse CLI output as JSON"`; the raw bytes are written to stderr for diagnostics
- **Subprocess auth check ordering** — stderr is now only checked for "not authenticated" when stdout is empty; previously a CLI warning on stderr could cause a valid JSON response to be discarded
- **`maxBuffer`** — `execFileAsync` now sets `maxBuffer: 50MB`; previously the 1MB default caused an unhandled `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` error on large directory listings
- **`killSignal: "SIGKILL"`** — subprocess timeouts now send `SIGKILL` instead of the default `SIGTERM`, which a process can ignore

### Added
- `src/utils/validation.ts` — shared validation module; `validatePath`, `validateEmail`, `validateMessage` are now in one place, used by both the MCP server and the CLI companion
- Tests: `validatePath` (10 cases), `validateEmail` (7 cases — including control chars), `validateMessage` (4 cases), `DriveCliNotFoundError` propagation — 53 tests total

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
