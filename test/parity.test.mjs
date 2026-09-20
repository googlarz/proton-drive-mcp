// Parity between the code (source of truth) and every place tools/env vars are
// listed: src/index.ts switch, glama.json, README.md, smithery.yaml, CLI usage().
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { makeSandbox, startServer, ROOT, DIST_CLI, fakeEnv } from "./helpers/mcp-client.mjs";

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const toolLike = (n) => /^(drive|photos)_[a-z_]+$/.test(n);

function diff(label, expected, actual) {
  const e = new Set(expected), a = new Set(actual);
  return {
    missing: [...e].filter((x) => !a.has(x)).sort(),
    extra: [...a].filter((x) => !e.has(x)).sort(),
    label,
  };
}
function assertSame(label, expected, actual) {
  const d = diff(label, expected, actual);
  assert.deepEqual({ missing: d.missing, extra: d.extra }, { missing: [], extra: [] }, `${label}: 'missing' = in tools/list but absent there; 'extra' = listed there but not in tools/list`);
}

let sb, client, toolNames;
before(async () => {
  sb = makeSandbox();
  client = await startServer("json", sb);
  toolNames = (await client.listTools()).map((t) => t.name);
});
after(async () => { await client?.close(); sb?.cleanup(); });

describe("tool-name parity", () => {
  it("src/index.ts `case` labels match tools/list", () => {
    const cases = [...read("src/index.ts").matchAll(/^\s*case "([a-z_]+)":/gm)].map((m) => m[1]).filter(toolLike);
    assertSame("src/index.ts switch cases", toolNames, cases);
  });

  it("glama.json tools match tools/list", () => {
    const names = JSON.parse(read("glama.json")).tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, "duplicate names in glama.json");
    assertSame("glama.json", toolNames, names);
  });

  it("smithery.yaml tools match tools/list", () => {
    const names = [...read("smithery.yaml").matchAll(/^\s+-\s+((?:drive|photos)_[a-z_]+)\s*$/gm)].map((m) => m[1]);
    assert.equal(new Set(names).size, names.length, "duplicate names in smithery.yaml");
    assertSame("smithery.yaml", toolNames, names);
  });

  it("README.md tool table matches tools/list", () => {
    const names = [...read("README.md").matchAll(/^\|\s*`((?:drive|photos)_[a-z_]+)`\s*\|/gm)].map((m) => m[1]);
    assert.equal(new Set(names).size, names.length, "duplicate rows in README tool table");
    assertSame("README tool table", toolNames, names);
  });

  it("README.md tool-group bullet list matches tools/list", () => {
    const readme = read("README.md");
    const names = new Set([...readme.matchAll(/`((?:drive|photos)_[a-z_]+)`(?:\s*·|\s*$)/gm)].map((m) => m[1]));
    assertSame("README grouped tool list", toolNames, [...names]);
  });
});

// tool -> CLI command text that must appear in the CLI's usage() output.
const CLI_COMMAND = {
  drive_auth_status: "auth status",
  drive_auth_logout: "auth logout",
  drive_version: "version",
  drive_list: "list <path>",
  drive_info: "info <path>",
  drive_mkdir: "mkdir <path>",
  drive_upload: "upload <local> <remote>",
  drive_download: "download <remote> <local>",
  drive_rename: "rename <path>",
  drive_move: "move <src> <dst>",
  drive_delete: "delete <path>",
  drive_list_trash: "trash list",
  drive_trash: "trash <path>",
  drive_restore: "restore <path>",
  drive_empty_trash: "trash empty",
  drive_copy: "copy <src>",
  drive_share_status: "share status",
  drive_share_invite: "share invite",
  drive_share_revoke: "share revoke",
  drive_share_remove_all: "share remove-all",
  drive_share_set_url: "share set-url",
  drive_share_remove_url: "share remove-url",
  drive_share_leave: "share leave",
  drive_list_invitations: "invitation list",
  drive_invitation_accept: "invitation accept",
  drive_invitation_reject: "invitation reject",
  photos_list_albums: "album list",
  photos_create_album: "album create",
  photos_update_album: "album update",
  photos_delete_album: "album delete",
  photos_list_album_photos: "album photos",
  photos_add_to_album: "album add-photo",
  photos_remove_from_album: "album remove-photo",
  photos_list_timeline: "photo timeline",
  photos_download: "photo download",
  photos_upload: "photo upload",
};
// Operate on the local sync folder via env var, so intentionally MCP-only.
const MCP_ONLY = new Set(["drive_read_file", "drive_write_file"]);

describe("CLI reachability", () => {
  let usage;
  before(async () => {
    usage = await new Promise((resolve, reject) => {
      execFile(process.execPath, [DIST_CLI, "--help"], { env: fakeEnv("json", sb) }, (e, out) => (e ? reject(e) : resolve(out)));
    });
  });

  it("every tool except the sync-folder ones has a CLI command mapping", () => {
    const unmapped = toolNames.filter((n) => !MCP_ONLY.has(n) && !(n in CLI_COMMAND));
    assert.deepEqual(unmapped, [], "add these tools to a CLI command (or to MCP_ONLY with a reason)");
  });

  it("the mapping contains no stale tool names", () => {
    const stale = Object.keys(CLI_COMMAND).filter((n) => !toolNames.includes(n));
    assert.deepEqual(stale, []);
  });

  it("usage() mentions the CLI command for every mapped tool", () => {
    for (const [tool, cmd] of Object.entries(CLI_COMMAND)) {
      assert.ok(usage.includes(cmd), `usage() lacks '${cmd}' (for ${tool})`);
    }
  });

  it("src/cli.ts dispatches every top-level command shown in usage()", () => {
    const src = read("src/cli.ts");
    const cmds = new Set(Object.values(CLI_COMMAND).map((c) => c.split(" ")[0]));
    for (const c of cmds) assert.ok(new RegExp(`case "${c}"`).test(src), `cli.ts has no case "${c}"`);
  });
});

describe("environment variable parity", () => {
  function walk(dir) {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });
  }
  const src = walk(join(ROOT, "src")).map((p) => readFileSync(p, "utf8")).join("\n");
  const reads = new Set([...src.matchAll(/process\.env\["([A-Z0-9_]+)"\](?!\s*=[^=])/g)].map((m) => m[1]));
  const internal = new Set([...src.matchAll(/process\.env\["([A-Z0-9_]+)"\]\s*=[^=]/g)].map((m) => m[1]));

  it("finds the env vars the code reads", () => {
    for (const v of ["PROTON_DRIVE_BIN", "PROTON_DRIVE_SYNC_PATH", "PROTON_DRIVE_LOCAL_ROOT", "PROTON_DRIVE_ALLOW_SENSITIVE_PATHS"]) {
      assert.ok(reads.has(v), `expected src to read ${v}`);
    }
  });

  it("README.md documents every user-facing env var the code reads", () => {
    const readme = read("README.md");
    const undocumented = [...reads].filter((v) => !internal.has(v) && !readme.includes(v));
    assert.deepEqual(undocumented, []);
  });
});
