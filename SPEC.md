# Spec: proton-drive-mcp

## Objective

An MCP server (+ companion CLI) that exposes Proton Drive and Proton Photos to Claude and other MCP clients: list, upload, download, organise, share and trash files without leaving the AI workflow.

It wraps the official `proton-drive` CLI binary as a subprocess. The CLI owns authentication (OS keychain), end-to-end encryption and every Proton API call; this project adds the MCP protocol layer, input validation, safety gates and response shaping on top. No credentials pass through this project.

**User:** Claude Code / Claude Desktop users who already have the Proton Drive CLI installed and logged in (`proton-drive auth login`).

## Tech stack

TypeScript (ESM), Node.js >= 22, `@modelcontextprotocol/sdk`, `tsc`, `node:test`, npm. Published as `proton-drive-mcp` (bins: `proton-drive-mcp`, `proton-drive-cli`).

## Commands

```
Build:   npm run build
Lint:    npm run lint          # tsc --noEmit
Test:    npm test              # build + all test/*.test.mjs
Start:   node dist/index.js    # MCP server over stdio
CLI:     node dist/cli.js <command>
Setup:   node dist/index.js init   # = `npx -y proton-drive-mcp init` = `proton-drive-cli init`; a subcommand, not an MCP tool
```

`init` (`src/utils/init.ts`, wired in `src/cli.ts`; `src/index.ts` hands over only when the first argument is exactly `init`, so a stdio launch without arguments is unchanged) runs the `doctor` checks in a child process, prints the Claude Desktop entry in the `npx -y proton-drive-mcp` form with `PROTON_DRIVE_BIN` set to the absolute CLI path plus the `claude mcp add` line, and with `--write` reuses `writeEntry` (timestamped backup, only `mcpServers["proton-drive-mcp"]`, dry run by default). An existing entry keeps all its env keys except `PROTON_DRIVE_BIN`; the server found under another key blocks `--write`. It reads and prints no session data. The CLI is looked up like the server does: `PROTON_DRIVE_BIN`, else `PATH`, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`.

Registry: `server.json` (official MCP Registry) and `package.json` `mcpName` must keep `io.github.googlarz/proton-drive-mcp`; the `version` fields in `server.json` are bumped by hand together with `package.json` (checked by `test/registry.test.mjs` and by `publish.yml` against the tag).

## Project structure

```
src/index.ts              MCP server: TOOLS (schemas), tool-surface derivation (gates, pagination),
                          schema enforcement, dispatch, lifecycle (signals, cancellation)
src/cli.ts                Companion CLI (mirrors 47 of 58 tools; drive_size/drive_read_file/drive_write_file/drive_audit_log/drive_read_many/drive_share_expiry_report/drive_recent_changes/drive_content_index/drive_search_content/drive_refresh_index/drive_cleanup are MCP-only)
src/services/content.ts   drive_read_content: private-temp download, text/docx/pdf extraction, paging
src/services/ocr.ts       Opt-in local OCR (PROTON_DRIVE_OCR=1): engine choice, Vision helper build, tesseract/pdftoppm runs, limits
src/ocr/vision-ocr.swift  macOS Vision + PDFKit helper, compiled on first use (copied to dist/ocr/ by the build)
src/services/refreshIndex.ts  drive_refresh_index: one budgeted slice of an incremental refresh of the saved folder index (engine in walk.ts)
src/services/contentIndex.ts  drive_content_index / drive_search_content: update, status, clear, search
src/services/contentSearch.ts Content index data: tokenizer, postings, BM25, snippets, line format
src/services/contentSeal.ts   Content index file: chunked AES-256-GCM container, fail-closed reader
src/utils/contentKey.ts       Content index key: macOS Keychain / secret-tool (stdin), PROTON_DRIVE_CONTENT_INDEX_KEY
src/services/drive.ts     DriveService: one method per operation, CLI argv building, response parsing
src/utils/subprocess.ts   Runs the CLI: timeouts, process-group kill, cancellation, sanitized errors
src/utils/validation.ts   Argument validators (flag injection, traversal, types)
src/utils/localguard.ts   Credential-location denylist / PROTON_DRIVE_LOCAL_ROOT allowlist
src/utils/remoteroots.ts  PROTON_DRIVE_REMOTE_ROOTS parsing and segment-boundary matching
src/utils/audit.ts        PROTON_DRIVE_AUDIT_LOG: hash-chained JSONL log, argument redaction
src/services/snapshot.ts  PROTON_DRIVE_SNAPSHOT_BEFORE_OVERWRITE: .versions copies
src/services/checkup.ts   drive_checkup: pure findings, score table (SCORE_TABLE) and finding pages
src/services/cleanupRun.ts drive_checkup / drive_cleanup plan orchestration: walk, trash listing, sharing audit, optional verify
src/services/cleanup.ts   drive_cleanup planner: eligibility rules, keeper, skips, approval-dialog lines, plan fingerprint
src/services/undo.ts      drive_undo engine: list / plan / apply, uid-verified restore and move-back
src/services/undoRecord.ts Server-side glue: opens the journal, records a batch around each changing call (beginBatch)
src/utils/undoJournal.ts  Undo journal: one JSON file per batch, PROTON_DRIVE_UNDO / PROTON_DRIVE_UNDO_DIR, 30 days / 50 bulk + 50 single-item batches
src/utils/syncfs.ts       Symlink-safe read/write inside PROTON_DRIVE_SYNC_PATH
src/utils/isMainModule.ts Entry-point detection (realpath, so npm's .bin symlink works)
src/types/index.ts        Shared response types
test/                     Unit tests (injected runner) + real-process tests (fake CLI over stdio)
```

## Tools (58)

- **Auth / meta:** `drive_auth_status`, `drive_auth_logout`, `drive_version`
- **Filesystem:** `drive_list`, `drive_info`, `drive_size`, `drive_read_content`, `drive_read_many`, `drive_tree`, `drive_search`, `drive_mkdir`, `drive_upload`, `drive_download`, `drive_rename`, `drive_move`, `drive_copy`
- **Trash:** `drive_list_trash`, `drive_trash`, `drive_restore`, `drive_delete`, `drive_empty_trash`
- **Sharing:** `drive_share_status`, `drive_share_invite`, `drive_share_revoke`, `drive_share_remove_all`, `drive_share_set_url`, `drive_share_remove_url`, `drive_share_leave`
- **Invitations:** `drive_list_invitations`, `drive_invitation_accept`, `drive_invitation_reject`
- **Plan & bulk:** `drive_sync_plan` (plan only), `drive_bulk_move`, `drive_bulk_trash` (plan first, `confirmed` to apply; applying needs human approval of the exact list)
- **Cleanup and undo (1.12.0):** `drive_cleanup` (plan first, `confirmed` to apply; the server builds the list of redundant duplicate copies and empty folders, applying needs human approval of the exact list, everything goes to the trash), `drive_undo` (`action` `list`, `plan` default or `apply`; apply always needs human approval; restores or moves back, each item verified by uid). Both hidden in `PROTON_DRIVE_MODE=readonly`. They need the undo journal (`PROTON_DRIVE_UNDO=0` switches it off).
- **Analytics:** `drive_usage`, `drive_find_duplicates`, `drive_checkup` (read-only health report with a 0-100 score; full tier only, allowed in readonly mode), `drive_sharing_audit`, `drive_share_expiry_report`, `drive_recent_changes`
- **Photos:** `photos_list_albums`, `photos_create_album`, `photos_update_album`, `photos_delete_album`, `photos_list_album_photos`, `photos_add_to_album`, `photos_remove_from_album`, `photos_list_timeline`, `photos_download`, `photos_upload`
- **Local sync folder (needs `PROTON_DRIVE_SYNC_PATH`):** `drive_read_file`, `drive_write_file`
- **OCR (needs `PROTON_DRIVE_OCR=1`):** no new tools; `drive_read_content`, `drive_read_many` and the content index read scanned PDFs and images locally (Vision or tesseract). Results carry `ocr: true`.
- **Content search (needs `PROTON_DRIVE_CONTENT_INDEX=1`):** `drive_content_index`, `drive_search_content`
  - Both are allowed in `PROTON_DRIVE_MODE=readonly` on purpose: `update` and `clear` change only the local encrypted index file (and its keychain item), never Drive. The file has no rollback detection (integrity per version, not freshness).
- **Index refresh (needs `PROTON_DRIVE_INDEX=1`):** `drive_refresh_index` re-lists the saved folder index in resumable slices (see README, "Keeping the index fresh on huge drives")
- **Audit (needs `PROTON_DRIVE_AUDIT_LOG`):** `drive_audit_log`

## Design rules learned from the live CLI

- The CLI reports per-item success of `move/copy/trash/restore/delete/...` as `[{uid, ok, error}]` with **exit code 0** — every such result must be checked (`assertItemsOk`).
- Node names, authors etc. are `{ok, value}` verification wrappers, never plain strings.
- A literal `/` in a node name is escaped as `\/` in CLI paths; names this server creates may not contain `/`, `.`/`..`, a leading `-`, or control characters.
- Names and paths are not trimmed (trailing spaces are real). Tool arguments are type-checked; non-strings are rejected.
- `set-url` replaces link settings; `sharing remove` and `album create` do not validate membership/uniqueness themselves, so the service does.

## CLI compatibility

Tested against Proton Drive CLI 0.8.x and 0.9.x (`TESTED_CLIS = ["0.8", "0.9"]` in `src/utils/cliVersion.ts`; on 0.9.0 not every operation was live-tested, see the README). `doctor` adds a `cli-version` check (warn, never fail, when the major.minor differs or cannot be parsed) and the server logs one stderr warning after `initialize` in the same cases.

## Safety model

- All argv built as arrays for `spawn` (no shell); flag injection blocked by validators.
- Human approval gate (`PROTON_DRIVE_APPROVAL`, default `human`; module `src/utils/approval.ts`, store `src/utils/approvalStore.ts`): destructive or outward-facing tools (delete, empty trash, remove-all, album delete, invite, revoke, public links, leave, accept and reject invitation, logout, remove-from-album), the `replace` / `create-new-revision` / `remove` conflict strategies, overwriting a sync-folder file, applying a bulk move or trash, and anything that reads from or writes to `/shared-with-me` need a human yes for that exact operation. Channel 1: MCP elicitation, for every gated call. Channel 2, on macOS when the client cannot elicit (or elicitation errors or is cancelled in under 1 s): the server's own `osascript` dialog (`src/utils/macDialog.ts`), the same call waits (until 45 s after the call started by default); not yet verified on screen. Channel 3, otherwise or when the text is too long for the dialog: refusal with a code, then `proton-drive-cli approve <code>` in an interactive terminal, then the same call again (single use; pending 10 min, approved 5 min). Otherwise the call is refused. `strict` gates every mutating tool; `model` restores 1.10.1 (`confirmed: true` suffices).
- `confirmed` is deprecated (removal planned for 2.0): still accepted, no longer an authorisation in `human` / `strict`, and still the plan/apply switch of `drive_bulk_move` / `drive_bulk_trash`. The CLI requires `--confirm` for the destructive ones. CLI commands `approvals`, `approve`, `deny` manage terminal approvals.
- Undo (1.12.0): `drive_cleanup` and `drive_undo` apply only after human approval of the exact list. The undo journal (plaintext names, private folder, 30 days) is written before a changing call and completed after it; `drive_undo` acts on an item only when found by uid where the journal says it is, restores from the trash only when the name is unique there (the CLI restores by name), overwrites nothing and re-checks every item by uid afterwards. Without `verify`, `drive_cleanup` acts only on unshared groups with the same claimed hash and size.
- Local paths: credential-location denylist (or `PROTON_DRIVE_LOCAL_ROOT` allowlist), symlinks resolved first.
- Errors never echo the command line; output is truncated.
- CLI children run in their own process group and are killed on timeout, cancellation, disconnect and SIGTERM/SIGINT.

## Testing strategy

- Unit tests drive `DriveService` with an injected runner (argv assertions, response parsing, collision/ambiguity handling).
- Real-process tests spawn `dist/index.js` / `dist/cli.js` against a fake `PROTON_DRIVE_BIN` over stdio (gates, schema enforcement, error sanitization, lifecycle, symlink launch, parity of tools/README/glama/smithery).
- `test/live.test.mjs` is an opt-in read-only smoke test against a real account (`PROTON_DRIVE_LIVE=1`).
- CI: lint + tests on Ubuntu and macOS × Node 22/24 (Windows is not tested or supported: Proton ships a Windows CLI, but this project has no passing Windows suite or CI job), `npm audit`, and a pack-and-install smoke test that launches the real bin symlink.

## Boundaries

- **Always:** validate every argument, check `{ok:false}` results, keep responses bounded (pagination), test against the real CLI before claiming a behaviour.
- **Ask first:** new tools, changing a tool's response shape, dependency majors, changing CI/publish.
- **Never:** log or echo secrets, bypass the approval gate, run destructive tools against a real account in automated tests.
