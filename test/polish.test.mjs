// 1.3.0 polish: list/info metadata, type filter, prompts, annotations/titles, _meta, elicitation.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { describeArgs } from "../dist/index.js";
import { DriveService } from "../dist/services/drive.js";
import { makeSandbox, startServer, fakeEnv, DIST_INDEX, nonVersionCalls } from "./helpers/mcp-client.mjs";

const fileNode = {
  uid: "v~f1",
  name: { ok: true, value: "a.txt" },
  type: "file",
  modificationTime: "2026-03-17T12:27:11.000Z",
  totalStorageSize: 20,
  activeRevision: {
    uid: "v~f1~r1",
    creationTime: "2026-03-17T12:27:08.000Z",
    claimedSize: 10,
    claimedModificationTime: "2025-09-23T07:56:49.000Z",
    claimedDigests: { sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709" },
  },
};
const runnerFor = (result, calls = []) => new DriveService(async (argv) => { calls.push(argv); return result; });

describe("list/info metadata", () => {
  it("list exposes mtime, uploadedAt and sha1 and keeps existing fields", async () => {
    const [f] = await runnerFor([fileNode]).list("/my-files");
    assert.equal(f.size, 10);
    assert.equal(f.storageSize, 20);
    assert.equal(f.modifiedAt, "2026-03-17T12:27:11.000Z");
    assert.equal(f.mtime, "2025-09-23T07:56:49.000Z");
    assert.equal(f.uploadedAt, "2026-03-17T12:27:08.000Z");
    assert.equal(f.sha1, "da39a3ee5e6b4b0d3255bfef95601890afd80709");
  });

  it("list omits sha1 when the uploader claimed none, and metadata for folders", async () => {
    const node = { ...fileNode, activeRevision: { ...fileNode.activeRevision, claimedDigests: { sha1Verified: false } } };
    const [f] = await runnerFor([node]).list("/my-files");
    assert.equal("sha1" in f, false);
    const [d] = await runnerFor([{ uid: "v~d", name: { ok: true, value: "d" }, type: "folder" }]).list("/my-files");
    assert.deepEqual(Object.keys(d).filter((k) => ["mtime", "uploadedAt", "sha1"].includes(k)), []);
  });

  it("list passes -t after the subcommand, before the path", async () => {
    const calls = [];
    await runnerFor([], calls).list("/my-files", { type: "file" });
    assert.deepEqual(calls[0], ["filesystem", "list", "-t", "file", "/my-files"]);
  });

  it("info adds mtime/uploadedAt/sha1 and keeps the trimmed node; verbose stays raw", async () => {
    const out = await runnerFor(fileNode).info("/my-files/a.txt");
    assert.equal(out.mtime, "2025-09-23T07:56:49.000Z");
    assert.equal(out.uploadedAt, "2026-03-17T12:27:08.000Z");
    assert.equal(out.sha1, "da39a3ee5e6b4b0d3255bfef95601890afd80709");
    assert.equal(out.activeRevision.claimedSize, 10);
    assert.deepEqual(await runnerFor(fileNode).info("/my-files/a.txt", true), fileNode);
  });

  it("drive_list tool accepts type, rejects other values", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb);
    try {
      assert.equal((await c.call("drive_list", { path: "/my-files", type: "folder" })).isError, false);
      assert.deepEqual(nonVersionCalls(sb.argvLog).at(-1), ["filesystem", "list", "-t", "folder", "/my-files", "--json"]);
      const bad = await c.call("drive_list", { path: "/my-files", type: "album" });
      assert.equal(bad.isError, true);
      assert.match(bad.text, /type must be one of/);
    } finally { await c.close(); sb.cleanup(); }
  });
});

describe("prompts", () => {
  it("advertises the capability and lists four prompts", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb);
    try {
      const init = await c.initialize();
      assert.ok(init.result.capabilities.prompts);
      const { prompts } = (await c.request("prompts/list", {})).result;
      assert.deepEqual(prompts.map((p) => p.name).sort(), ["find-files", "organise-folder", "sharing-audit", "storage-audit"]);
      assert.ok(prompts.every((p) => p.description && p.title));
    } finally { await c.close(); sb.cleanup(); }
  });

  it("get returns text; organise-folder embeds the path and forbids permanent delete", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb);
    try {
      const r = (await c.request("prompts/get", { name: "organise-folder", arguments: { path: "/my-files/Docs" } })).result;
      const text = r.messages[0].content.text;
      assert.equal(r.messages[0].role, "user");
      assert.match(text, /\/my-files\/Docs/);
      assert.match(text, /drive_bulk_move/);
      assert.match(text, /Never permanently delete/);
      const f = (await c.request("prompts/get", { name: "find-files", arguments: { description: "tax pdf" } })).result;
      assert.match(f.messages[0].content.text, /tax pdf/);
      for (const n of ["storage-audit", "sharing-audit"]) {
        assert.ok((await c.request("prompts/get", { name: n })).result.messages[0].content.text.length > 20);
      }
    } finally { await c.close(); sb.cleanup(); }
  });

  it("unknown prompt and bad arguments are InvalidParams errors", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb);
    try {
      const unknown = await c.request("prompts/get", { name: "nope" });
      assert.equal(unknown.error.code, -32602);
      assert.match(unknown.error.message, /Unknown prompt/);
      const missing = await c.request("prompts/get", { name: "organise-folder" });
      assert.equal(missing.error.code, -32602);
      assert.match(missing.error.message, /Missing required argument 'path'/);
      const extra = await c.request("prompts/get", { name: "storage-audit", arguments: { x: "1" } });
      assert.equal(extra.error.code, -32602);
      const badPath = await c.request("prompts/get", { name: "organise-folder", arguments: { path: "/my-files/../x" } });
      assert.equal(badPath.error.code, -32602);
      const rootPath = await c.request("prompts/get", { name: "organise-folder", arguments: { path: "/" } });
      assert.equal(rootPath.error.code, -32602);
      const longDesc = await c.request("prompts/get", { name: "find-files", arguments: { description: "x".repeat(501) } });
      assert.equal(longDesc.error.code, -32602);
      for (const bad of [{ path: 5 }, { path: { a: 1 } }, { path: null }]) {
        const r = await c.request("prompts/get", { name: "organise-folder", arguments: bad });
        assert.equal(r.error.code, -32602, JSON.stringify(bad));
      }
    } finally { await c.close(); sb.cleanup(); }
  });
});

// Effective annotations for every tool. A new tool must be added here on purpose.
const R = { readOnlyHint: true, idempotentHint: true };
const W = { destructiveHint: false };
const D = { destructiveHint: true };
const EXPECTED = {
  drive_auth_status: R,
  drive_auth_logout: { destructiveHint: true, idempotentHint: true },
  drive_version: { ...R, openWorldHint: false },
  drive_list: R, drive_info: R, drive_share_status: R, drive_list_trash: R, drive_list_invitations: R,
  photos_list_albums: R, photos_list_album_photos: R, photos_list_timeline: R,
  drive_upload: { destructiveHint: false, openWorldHint: true },
  drive_download: { destructiveHint: false, openWorldHint: true },
  photos_download: { destructiveHint: false, openWorldHint: true },
  photos_upload: { destructiveHint: false, openWorldHint: true },
  drive_mkdir: W, drive_rename: W, drive_move: W, drive_restore: W, drive_invitation_accept: W,
  photos_create_album: W, photos_update_album: W, photos_add_to_album: W,
  drive_copy: { destructiveHint: false, idempotentHint: false },
  drive_trash: { destructiveHint: false, idempotentHint: true },
  drive_delete: D, drive_empty_trash: D, drive_share_revoke: D, drive_invitation_reject: D, drive_share_leave: D,
  drive_share_remove_url: D, drive_share_remove_all: D, photos_delete_album: D, photos_remove_from_album: D,
  drive_share_invite: { destructiveHint: false, openWorldHint: true },
  drive_share_set_url: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  drive_read_file: { ...R, openWorldHint: false },
  drive_read_content: { ...R, openWorldHint: false },
  drive_write_file: { destructiveHint: true, openWorldHint: true },
  drive_tree: R, drive_search: R, drive_usage: R, drive_find_duplicates: R, drive_sharing_audit: R, drive_sync_plan: R,
  drive_bulk_move: { destructiveHint: false },
  drive_bulk_trash: { destructiveHint: false, idempotentHint: true },
};

describe("tool annotations, titles and _meta", () => {
  it("every tool has a title and the expected annotations", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb);
    try {
      const tools = await c.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(EXPECTED).sort());
      for (const t of tools) {
        assert.ok(typeof t.title === "string" && t.title.length > 0 && t.title.length <= 40, `title for ${t.name}`);
        assert.deepEqual(t.annotations, EXPECTED[t.name], `annotations for ${t.name}`);
      }
    } finally { await c.close(); sb.cleanup(); }
  });

  it("drive_list, drive_read_file and drive_read_content carry the large-result hint, others do not", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb);
    try {
      for (const t of await c.listTools()) {
        if (["drive_list", "drive_read_file", "drive_read_content"].includes(t.name)) assert.deepEqual(t._meta, { "anthropic/maxResultSizeChars": 100000 });
        else assert.equal(t._meta, undefined, t.name);
      }
    } finally { await c.close(); sb.cleanup(); }
  });
});

describe("elicitation for gated tools", () => {
  async function withClient(capabilities, handler, fn, mode = "json", extraEnv = {}) {
    const sb = makeSandbox();
    const client = new Client({ name: "t", version: "0" }, { capabilities });
    if (handler) client.setRequestHandler(ElicitRequestSchema, handler);
    const transport = new StdioClientTransport({ command: process.execPath, args: [DIST_INDEX], env: fakeEnv(mode, sb, extraEnv) });
    await client.connect(transport);
    try { await fn(client, sb); } finally { await client.close(); sb.cleanup(); }
  }
  const text = (r) => r.content[0].text;

  it("human accept runs the gated call; asked once, the model never supplied confirmed", async () => {
    let asked = 0;
    await withClient({ elicitation: { form: {} } }, async (req) => { asked++; assert.match(req.params.message, /drive_delete/); return { action: "accept", content: { approve: true } }; }, async (client, sb) => {
      const r = await client.callTool({ name: "drive_delete", arguments: { path: "/trash/a.txt", confirmed: false } });
      assert.notEqual(r.isError, true);
      assert.equal(asked, 1);
      assert.ok(nonVersionCalls(sb.argvLog).some((a) => a.includes("delete") || a.includes("remove") || a.includes("/trash/a.txt")));
    });
  });

  for (const [label, reply] of [["decline", { action: "decline" }], ["cancel", { action: "cancel" }], ["accept without approve", { action: "accept", content: { approve: false } }]]) {
    it(`${label} keeps the refusal and runs nothing`, async () => {
      await withClient({ elicitation: { form: {} } }, async () => reply, async (client, sb) => {
        const r = await client.callTool({ name: "drive_delete", arguments: { path: "/trash/a.txt", confirmed: false } });
        assert.equal(r.isError, true);
        assert.match(text(r), /confirmed=true/);
        assert.deepEqual(nonVersionCalls(sb.argvLog), []);
      });
    });
  }

  it("confirmed ABSENT: accept runs the gated call, decline refuses, no capability keeps the schema error", async () => {
    let asked = 0;
    await withClient({ elicitation: { form: {} } }, async () => { asked++; return { action: "accept", content: { approve: true } }; }, async (client, sb) => {
      const r = await client.callTool({ name: "drive_delete", arguments: { path: "/trash/a.txt" } });
      assert.notEqual(r.isError, true);
      assert.equal(asked, 1);
      assert.ok(nonVersionCalls(sb.argvLog).length > 0);
    });
    await withClient({ elicitation: { form: {} } }, async () => ({ action: "decline" }), async (client, sb) => {
      const r = await client.callTool({ name: "drive_empty_trash", arguments: {} });
      assert.equal(r.isError, true);
      assert.match(text(r), /confirmed=true/);
      assert.deepEqual(nonVersionCalls(sb.argvLog), []);
    });
    await withClient({}, null, async (client, sb) => {
      const r = await client.callTool({ name: "drive_delete", arguments: { path: "/trash/a.txt" } });
      assert.equal(r.isError, true);
      assert.match(text(r), /Missing required argument 'confirmed'/);
      assert.deepEqual(nonVersionCalls(sb.argvLog), []);
    });
  });

  it("a throwing elicitation handler falls back to the refusal", async () => {
    await withClient({ elicitation: { form: {} } }, async () => { throw new Error("boom"); }, async (client, sb) => {
      const r = await client.callTool({ name: "drive_empty_trash", arguments: { confirmed: false } });
      assert.equal(r.isError, true);
      assert.match(text(r), /confirmed=true/);
      assert.deepEqual(nonVersionCalls(sb.argvLog), []);
    });
  });

  it("without the capability behaviour is unchanged", async () => {
    await withClient({}, null, async (client, sb) => {
      const r = await client.callTool({ name: "drive_delete", arguments: { path: "/trash/a.txt", confirmed: false } });
      assert.equal(r.isError, true);
      assert.match(text(r), /confirmed=true/);
      assert.deepEqual(nonVersionCalls(sb.argvLog), []);
    });
  });

  it("ungated and validation failures never trigger elicitation", async () => {
    let asked = 0;
    await withClient({ elicitation: { form: {} } }, async () => { asked++; return { action: "accept", content: { approve: true } }; }, async (client) => {
      await client.callTool({ name: "drive_list", arguments: { path: "/my-files" } });
      await client.callTool({ name: "drive_delete", arguments: { path: 123 } }); // schema validation fails first
      assert.equal(asked, 0);
    });
  });

  // ---- bulk tools: the confirmed=true APPLY path asks the human ----
  const BULK_TREE = () => { const p = join(tmpdir(), `bulk-tree-${process.pid}-${Math.random().toString(36).slice(2)}.json`); writeFileSync(p, JSON.stringify({ "/my-files/s": [{ name: "x.txt", type: "file" }], "/my-files/d": [] })); return p; };
  const mutations = (sb) => nonVersionCalls(sb.argvLog).filter((a) => a[1] !== "list");

  for (const [tool, args] of [
    ["drive_bulk_trash", { paths: ["/my-files/s/x.txt"], confirmed: true }],
    ["drive_bulk_move", { sources: ["/my-files/s/x.txt"], destinationFolder: "/my-files/d", confirmed: true }],
  ]) {
    it(`${tool} confirmed=true: human accept applies, message shows operation, count and paths`, async () => {
      let msg = "";
      await withClient({ elicitation: { form: {} } }, async (req) => { msg = req.params.message; return { action: "accept", content: { approve: true } }; }, async (client, sb) => {
        const r = await client.callTool({ name: tool, arguments: args });
        assert.notEqual(r.isError, true, text(r));
        assert.equal(mutations(sb).length, 1);
      }, "tree", { FAKE_TREE: BULK_TREE() });
      assert.match(msg, new RegExp(tool));
      assert.match(msg, /1 item/);
      assert.match(msg, /\/my-files\/s\/x\.txt/);
      if (tool === "drive_bulk_move") assert.match(msg, /\/my-files\/d/);
    });

    for (const [label, reply] of [["decline", { action: "decline" }], ["cancel", { action: "cancel" }], ["accept without approve", { action: "accept", content: { approve: false } }]]) {
      it(`${tool} confirmed=true: ${label} refuses and runs nothing`, async () => {
        await withClient({ elicitation: { form: {} } }, async () => reply, async (client, sb) => {
          const r = await client.callTool({ name: tool, arguments: args });
          assert.equal(r.isError, true);
          assert.match(text(r), /did not approve/);
          assert.deepEqual(mutations(sb), []);
        }, "tree", { FAKE_TREE: BULK_TREE() });
      });
    }

    it(`${tool} confirmed=true: an erroring handler refuses; no capability keeps today's behaviour`, async () => {
      await withClient({ elicitation: { form: {} } }, async () => { throw new Error("boom"); }, async (client, sb) => {
        assert.equal((await client.callTool({ name: tool, arguments: args })).isError, true);
        assert.deepEqual(mutations(sb), []);
      }, "tree", { FAKE_TREE: BULK_TREE() });
      await withClient({}, null, async (client, sb) => {
        assert.notEqual((await client.callTool({ name: tool, arguments: args })).isError, true);
        assert.equal(mutations(sb).length, 1);
      }, "tree", { FAKE_TREE: BULK_TREE() });
    });
  }

  it("the dry run (no confirmed) of a bulk tool never prompts", async () => {
    let asked = 0;
    await withClient({ elicitation: { form: {} } }, async () => { asked++; return { action: "accept", content: { approve: true } }; }, async (client) => {
      await client.callTool({ name: "drive_bulk_trash", arguments: { paths: ["/my-files/s/x.txt"] } });
      assert.equal(asked, 0);
    }, "tree", { FAKE_TREE: BULK_TREE() });
  });

  // ---- what the human sees ----
  it("long values keep head and tail, control characters are neutralised", async () => {
    const a = "/trash/" + "A".repeat(300) + "-first.txt";
    const b = "/trash/" + "A".repeat(300) + "-second.txt";
    const seen = [];
    await withClient({ elicitation: { form: {} } }, async (req) => { seen.push(req.params.message); return { action: "decline" }; }, async (client) => {
      await client.callTool({ name: "drive_delete", arguments: { path: a, confirmed: false } });
      await client.callTool({ name: "drive_delete", arguments: { path: b, confirmed: false } });
    });
    assert.match(seen[0], /-first\.txt/);
    assert.match(seen[1], /-second\.txt/);
    assert.ok(seen[0].includes("…"));
    assert.ok(seen[0].length < 700);
    assert.notEqual(seen[0], seen[1]);
  });

  it("newlines and control characters in a displayed name cannot forge lines", () => {
    const d = describeArgs({ path: "/trash/a\nsize: 0\u0007b", confirmed: false });
    assert.equal(d.split("\n").length, 1);
    assert.ok(!/[\x00-\x08\x0a-\x1f\x7f]/.test(d));
  });

  // ---- typed refusal detection ----
  it("a CLI error whose text contains 'confirmed=true' does not trigger a prompt", async () => {
    let asked = 0;
    await withClient({ elicitation: { form: {} } }, async () => { asked++; return { action: "accept", content: { approve: true } }; }, async (client) => {
      const r = await client.callTool({ name: "drive_info", arguments: { path: "/my-files/needs confirmed=true.txt" } });
      assert.equal(r.isError, true);
      assert.equal(asked, 0);
    }, "fail-stderr-echo");
  });

  it("after 5 declined prompts in a minute the server refuses without prompting", async () => {
    let asked = 0;
    await withClient({ elicitation: { form: {} } }, async () => { asked++; return { action: "decline" }; }, async (client, sb) => {
      for (let i = 0; i < 8; i++) {
        const r = await client.callTool({ name: "drive_delete", arguments: { path: "/trash/a.txt", confirmed: false } });
        assert.equal(r.isError, true);
        assert.match(text(r), /confirmed=true/);
      }
      assert.equal(asked, 5);
      assert.deepEqual(nonVersionCalls(sb.argvLog), []);
    });
  });
});

describe("prompts follow the tool tier", () => {
  it("core tier hides prompts whose tools are hidden; unknown name is the same error", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb, { PROTON_DRIVE_TOOL_TIER: "core" });
    try {
      await c.initialize();
      const { prompts } = (await c.request("prompts/list", {})).result;
      assert.deepEqual(prompts.map((p) => p.name), ["find-files"]);
      assert.ok(prompts.every((p) => !("requires" in p)));
      const tools = new Set((await c.listTools()).map((t) => t.name));
      assert.ok(tools.has("drive_search"));
      const hidden = await c.request("prompts/get", { name: "storage-audit" });
      assert.equal(hidden.error.code, -32602);
      assert.match(hidden.error.message, /Unknown prompt/);
      const ok = await c.request("prompts/get", { name: "find-files", arguments: { description: "x" } });
      assert.ok(ok.result.messages[0].content.text);
    } finally { await c.close(); sb.cleanup(); }
  });

  it("full tier: every prompt's required tools exist in tools/list", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb);
    try {
      await c.initialize();
      const tools = new Set((await c.listTools()).map((t) => t.name));
      const { PROMPTS } = await import("../dist/prompts.js");
      for (const p of PROMPTS) for (const r of p.requires) assert.ok(tools.has(r), `${p.name} requires ${r}`);
      assert.equal((await c.request("prompts/list", {})).result.prompts.length, PROMPTS.length);
    } finally { await c.close(); sb.cleanup(); }
  });
});
