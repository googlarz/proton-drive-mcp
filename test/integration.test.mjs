/**
 * Integration tests against the real proton-drive CLI binary.
 *
 * ALL tests skip gracefully when the binary is not in PATH — unit tests
 * in drive.test.mjs cover correctness independently. Run these locally
 * with the CLI installed to catch command-string bugs that mocked runners
 * cannot detect.
 *
 * Usage:
 *   PROTON_DRIVE_BIN=/path/to/proton-drive node --test test/integration.test.mjs
 *   npm run test:integration     (alias in package.json)
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI = process.env.PROTON_DRIVE_BIN ?? "proton-drive";
const TIMEOUT = 10_000;

// ─── helpers ─────────────────────────────────────────────────────────────────

let available = false;
let authenticated = false;

before(async () => {
  try {
    await execFileAsync(CLI, ["version", "--json"], { timeout: TIMEOUT });
    available = true;
  } catch {
    available = false;
    return;
  }
  try {
    const { stdout } = await execFileAsync(CLI, ["auth", "status", "--json"], { timeout: TIMEOUT });
    const parsed = JSON.parse(stdout.trim());
    authenticated = Boolean(parsed?.authenticated ?? parsed?.loggedIn);
  } catch {
    authenticated = false;
  }
});

function skip(t, reason) {
  t.skip(reason);
}

// Run a CLI command and return parsed JSON output. Throws on non-zero exit.
async function run(args) {
  const { stdout } = await execFileAsync(CLI, [...args, "--json"], {
    timeout: TIMEOUT,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim());
}

// Run --help for a command group. Returns the help text. Does NOT require --json.
async function help(args) {
  try {
    const { stdout, stderr } = await execFileAsync(CLI, [...args, "--help"], { timeout: TIMEOUT });
    return stdout + stderr;
  } catch (e) {
    // Some CLIs print help to stderr and exit non-zero
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
}

// ─── command-group existence (no auth required) ───────────────────────────────
// These tests verify that the command strings we construct actually exist in
// the CLI — the class of bug that mocked runners cannot catch.

describe("command groups exist in CLI", () => {
  it("auth subcommand is recognised", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    const text = await help(["auth"]);
    assert.ok(
      !text.toLowerCase().includes("unknown command") && !text.toLowerCase().includes("unknown subcommand"),
      `Expected auth help, got: ${text.slice(0, 200)}`
    );
  });

  it("filesystem subcommand is recognised", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    const text = await help(["filesystem"]);
    assert.ok(
      !text.toLowerCase().includes("unknown command") && !text.toLowerCase().includes("unknown subcommand"),
      `Expected filesystem help, got: ${text.slice(0, 200)}`
    );
  });

  it("filesystem list subcommand is recognised", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    const text = await help(["filesystem", "list"]);
    assert.ok(
      !text.toLowerCase().includes("unknown command") && !text.toLowerCase().includes("unknown subcommand"),
      `Expected filesystem list help, got: ${text.slice(0, 200)}`
    );
  });

  it("filesystem upload subcommand is recognised", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    const text = await help(["filesystem", "upload"]);
    assert.ok(
      !text.toLowerCase().includes("unknown command") && !text.toLowerCase().includes("unknown subcommand"),
      `Expected filesystem upload help, got: ${text.slice(0, 200)}`
    );
  });

  it("filesystem download subcommand is recognised", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    const text = await help(["filesystem", "download"]);
    assert.ok(
      !text.toLowerCase().includes("unknown command") && !text.toLowerCase().includes("unknown subcommand"),
      `Expected filesystem download help, got: ${text.slice(0, 200)}`
    );
  });

  it("filesystem mkdir subcommand is recognised", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    const text = await help(["filesystem", "mkdir"]);
    assert.ok(
      !text.toLowerCase().includes("unknown command") && !text.toLowerCase().includes("unknown subcommand"),
      `Expected filesystem mkdir help, got: ${text.slice(0, 200)}`
    );
  });

  it("filesystem move subcommand is recognised", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    const text = await help(["filesystem", "move"]);
    assert.ok(
      !text.toLowerCase().includes("unknown command") && !text.toLowerCase().includes("unknown subcommand"),
      `Expected filesystem move help, got: ${text.slice(0, 200)}`
    );
  });

  it("filesystem delete subcommand is recognised", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    const text = await help(["filesystem", "delete"]);
    assert.ok(
      !text.toLowerCase().includes("unknown command") && !text.toLowerCase().includes("unknown subcommand"),
      `Expected filesystem delete help, got: ${text.slice(0, 200)}`
    );
  });

  it("sharing subcommand is recognised", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    const text = await help(["sharing"]);
    assert.ok(
      !text.toLowerCase().includes("unknown command") && !text.toLowerCase().includes("unknown subcommand"),
      `Expected sharing help, got: ${text.slice(0, 200)}`
    );
  });

  it("sharing status subcommand is recognised", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    const text = await help(["sharing", "status"]);
    assert.ok(
      !text.toLowerCase().includes("unknown command") && !text.toLowerCase().includes("unknown subcommand"),
      `Expected sharing status help, got: ${text.slice(0, 200)}`
    );
  });

  it("sharing invite subcommand is recognised", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    const text = await help(["sharing", "invite"]);
    assert.ok(
      !text.toLowerCase().includes("unknown command") && !text.toLowerCase().includes("unknown subcommand"),
      `Expected sharing invite help, got: ${text.slice(0, 200)}`
    );
  });

  it("sharing revoke subcommand is recognised", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    const text = await help(["sharing", "revoke"]);
    assert.ok(
      !text.toLowerCase().includes("unknown command") && !text.toLowerCase().includes("unknown subcommand"),
      `Expected sharing revoke help, got: ${text.slice(0, 200)}`
    );
  });

  it("trash subcommand is recognised", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    const text = await help(["trash"]);
    assert.ok(
      !text.toLowerCase().includes("unknown command") && !text.toLowerCase().includes("unknown subcommand"),
      `Expected trash help, got: ${text.slice(0, 200)}`
    );
  });

  it("trash list subcommand is recognised", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    const text = await help(["trash", "list"]);
    assert.ok(
      !text.toLowerCase().includes("unknown command") && !text.toLowerCase().includes("unknown subcommand"),
      `Expected trash list help, got: ${text.slice(0, 200)}`
    );
  });

  it("trash restore subcommand is recognised (not top-level restore)", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    const text = await help(["trash", "restore"]);
    assert.ok(
      !text.toLowerCase().includes("unknown command") && !text.toLowerCase().includes("unknown subcommand"),
      `Expected trash restore help, got: ${text.slice(0, 200)}`
    );
  });

  it("trash empty subcommand is recognised", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    const text = await help(["trash", "empty"]);
    assert.ok(
      !text.toLowerCase().includes("unknown command") && !text.toLowerCase().includes("unknown subcommand"),
      `Expected trash empty help, got: ${text.slice(0, 200)}`
    );
  });
});

// ─── version (no auth required) ───────────────────────────────────────────────

describe("version command", () => {
  it("returns JSON with cli field", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    const result = await run(["version"]);
    assert.ok(typeof result === "object" && result !== null, "expected object");
    const hasCli = "cli" in result || "version" in result;
    assert.ok(hasCli, `expected 'cli' or 'version' field, got: ${JSON.stringify(result)}`);
  });
});

// ─── auth status (no auth required) ──────────────────────────────────────────

describe("auth status command", () => {
  it("returns JSON with authenticated field", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    const result = await run(["auth", "status"]);
    assert.ok(typeof result === "object" && result !== null, "expected object");
    const hasAuth = "authenticated" in result || "loggedIn" in result;
    assert.ok(hasAuth, `expected 'authenticated' or 'loggedIn' field, got: ${JSON.stringify(result)}`);
  });
});

// ─── filesystem operations (auth required) ───────────────────────────────────

describe("filesystem list (authenticated)", () => {
  it("returns an array for /my-files", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    if (!authenticated) return skip(t, "not authenticated — run proton-drive auth login first");
    const result = await run(["filesystem", "list", "/my-files"]);
    assert.ok(Array.isArray(result), `expected array, got: ${JSON.stringify(result).slice(0, 200)}`);
  });

  it("each item has name, path, type", async (t) => {
    if (!available) return skip(t, "proton-drive CLI not in PATH");
    if (!authenticated) return skip(t, "not authenticated");
    const result = await run(["filesystem", "list", "/my-files"]);
    assert.ok(Array.isArray(result));
    for (const item of result) {
      assert.ok(typeof item.name === "string", `item missing name: ${JSON.stringify(item)}`);
      assert.ok(typeof item.path === "string", `item missing path: ${JSON.stringify(item)}`);
      assert.ok(item.type === "file" || item.type === "folder", `unexpected type: ${item.type}`);
    }
  });
});
