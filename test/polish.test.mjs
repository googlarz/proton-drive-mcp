// 1.3.0 polish: list/info metadata, type filter, prompts, annotations/titles, _meta, elicitation.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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

  it("drive_list and drive_read_file carry the large-result hint, others do not", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb);
    try {
      for (const t of await c.listTools()) {
        if (["drive_list", "drive_read_file"].includes(t.name)) assert.deepEqual(t._meta, { "anthropic/maxResultSizeChars": 100000 });
        else assert.equal(t._meta, undefined, t.name);
      }
    } finally { await c.close(); sb.cleanup(); }
  });
});

describe("elicitation for gated tools", () => {
  async function withClient(capabilities, handler, fn) {
    const sb = makeSandbox();
    const client = new Client({ name: "t", version: "0" }, { capabilities });
    if (handler) client.setRequestHandler(ElicitRequestSchema, handler);
    const transport = new StdioClientTransport({ command: process.execPath, args: [DIST_INDEX], env: fakeEnv("json", sb) });
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
      await client.callTool({ name: "drive_delete", arguments: {} }); // schema validation fails first
      assert.equal(asked, 0);
    });
  });
});
