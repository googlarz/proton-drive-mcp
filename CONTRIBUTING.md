# Contributing

Bug reports and pull requests are welcome. For how the code is laid out and how to add a tool, read [ARCHITECTURE.md](ARCHITECTURE.md).

## Dev setup

You need Node.js 22 or newer (`engines` in `package.json`).

```bash
git clone https://github.com/googlarz/proton-drive-mcp.git
cd proton-drive-mcp
npm ci
npm run build   # tsc, then copies src/ocr to dist/ocr
npm run lint    # tsc --noEmit
npm test        # builds first, then runs test/*.test.mjs with node --test
```

The tests do not need a Proton account or the official `proton-drive` CLI: they run the built server against a fake CLI (`test/helpers/fake-cli.mjs`). The one exception is `test/live.test.mjs`, a read-only smoke test against the real CLI that is skipped unless `PROTON_DRIVE_LIVE=1`.

CI (`.github/workflows/ci.yml`) runs `npm run lint`, `npm test` and `node scripts/pack-smoke.mjs` on Ubuntu and macOS with Node 22 and 24. `npm run ci` runs lint and tests locally.

## Run the server locally

```bash
npm run build
PROTON_DRIVE_BIN="$(which proton-drive)" node dist/index.js   # MCP server on stdio
npm run cli -- doctor                                         # companion CLI (builds first)
```

To try your build in an MCP client, point the client at `node /absolute/path/to/dist/index.js`. This needs the official Proton Drive CLI installed and signed in (`proton-drive auth login`). Set `PROTON_DRIVE_MODE=readonly` while experimenting if you do not want a model to change your Drive.

## Pull requests

- Branch from `main` and keep the change small and focused. One topic per PR.
- A behavior change comes with a test in `test/`. A bug fix comes with a test that fails without the fix.
- Update the docs the change touches: `README.md`, `CHANGELOG.md`, and `SPEC.md` if the tool surface changes.
- Do not commit secrets, tokens, session data or real Drive paths and file names.
- `npm run lint` and `npm test` must pass.

## Security issues

Do not open a public issue. Report vulnerabilities privately through a [GitHub security advisory](https://github.com/googlarz/proton-drive-mcp/security/advisories/new). See [SECURITY.md](SECURITY.md).
