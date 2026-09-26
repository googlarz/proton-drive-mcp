// End-to-end MCP tests: spawn dist/index.js over real stdio JSON-RPC, backed by
// test/helpers/fake-cli.mjs as PROTON_DRIVE_BIN. Never touches a real account.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSandbox, startServer, nonVersionCalls, readArgvLog, FAKE_CLI } from "./helpers/mcp-client.mjs";

const TMP = tmpdir();
const P = "/my-files/a.txt";
const GATED_ALWAYS = {
  drive_auth_logout: {},
  drive_share_invite: { path: P, email: "bob@example.com", role: "viewer" },
  drive_share_revoke: { path: P, email: "bob@example.com" },
  drive_share_set_url: { path: P },
  drive_share_remove_url: { path: P },
  drive_share_leave: { path: P },
  drive_invitation_reject: { uid: "inv-1" },
  photos_remove_from_album: { albumPath: "/albums/Trip", photoPath: "/photos/p1.jpg" },
  drive_delete: { path: "/trash/a.txt" },
  drive_empty_trash: {},
  drive_share_remove_all: { path: P },
  photos_delete_album: { albumPath: "/albums/Trip" },
};

/** Shared server (json mode, `[]` stdout) plus helper to count CLI calls made by one action. */
function sharedServer(mode = "json", extraEnv = {}) {
  const ctx = { sb: null, c: null };
  before(async () => {
    ctx.sb = makeSandbox();
    ctx.c = await startServer(mode, ctx.sb, extraEnv);
  });
  after(async () => {
    await ctx.c?.close();
    ctx.sb?.cleanup();
  });
  ctx.calls = () => nonVersionCalls(ctx.sb.argvLog);
  return ctx;
}

describe("initialize and tools/list", () => {
  const s = sharedServer();
  let tools;
  before(async () => { tools = await s.c.listTools(); });

  it("advertises exactly 38 tools", () => assert.equal(tools.length, 38));

  it("has unique tool names", () => {
    assert.equal(new Set(tools.map((t) => t.name)).size, tools.length);
  });

  it("gives every tool an object inputSchema with additionalProperties === false", () => {
    for (const t of tools) {
      assert.equal(t.inputSchema.type, "object", t.name);
      assert.strictEqual(t.inputSchema.additionalProperties, false, t.name);
    }
  });

  it("only lists required keys that exist in properties", () => {
    for (const t of tools) {
      for (const k of t.inputSchema.required ?? []) {
        assert.ok(k in t.inputSchema.properties, `${t.name}: required '${k}' missing from properties`);
      }
    }
  });

  it("advertises a boolean `confirmed` property on every gated tool", () => {
    const gated = [...Object.keys(GATED_ALWAYS), "drive_upload", "drive_download", "photos_download", "drive_write_file"];
    for (const name of gated) {
      const t = tools.find((x) => x.name === name);
      assert.ok(t, `${name} missing`);
      assert.equal(t.inputSchema.properties.confirmed?.type, "boolean", `${name}.confirmed`);
    }
  });

  it("advertises limit/offset on the four paginated tools", () => {
    for (const name of ["drive_list", "drive_list_trash", "photos_list_timeline", "photos_list_album_photos"]) {
      const t = tools.find((x) => x.name === name);
      assert.equal(t.inputSchema.properties.limit?.type, "integer", name);
      assert.equal(t.inputSchema.properties.offset?.type, "integer", name);
    }
  });
});

describe("confirmed gates (unconditional)", () => {
  const s = sharedServer();

  for (const [tool, args] of Object.entries(GATED_ALWAYS)) {
    it(`${tool} refuses without confirmed and does not call the CLI`, async () => {
      const before = s.calls().length;
      const r = await s.c.call(tool, args);
      assert.equal(r.isError, true);
      assert.match(r.text, /confirmed/i);
      assert.equal(s.calls().length, before);
    });

    it(`${tool} rejects confirmed:"true" (string) as a type error and does not call the CLI`, async () => {
      const before = s.calls().length;
      const r = await s.c.call(tool, { ...args, confirmed: "true" });
      assert.equal(r.isError, true);
      assert.match(r.text, /confirmed must be a boolean/);
      assert.equal(s.calls().length, before);
    });

    it(`${tool} refuses confirmed:false and does not call the CLI`, async () => {
      const before = s.calls().length;
      const r = await s.c.call(tool, { ...args, confirmed: false });
      assert.equal(r.isError, true);
      assert.equal(s.calls().length, before);
    });

    it(`${tool} reaches the CLI when confirmed:true`, async () => {
      const before = s.calls().length;
      await s.c.call(tool, { ...args, confirmed: true });
      assert.ok(s.calls().length > before, "expected at least one CLI call");
    });
  }

  // needConfirm() does `a.confirmed === true` (strict). Pin down that confirmed:false
  // and confirmed omitted both take the *gate's own* refusal path (needConfirm's message,
  // naming the action) rather than merely erroring for some other reason (e.g. a schema
  // type error) — confirmed:true (a real boolean) is the only value that gets through.
  it("drive_share_invite: confirmed:false and confirmed omitted both hit the gate's own message, not a schema error", async () => {
    const args = { path: P, email: "bob@example.com", role: "viewer" };
    const before = s.calls().length;

    const omitted = await s.c.call("drive_share_invite", args);
    assert.equal(omitted.isError, true);
    assert.match(omitted.text, /immediately emails the invitee and grants them access/);
    assert.doesNotMatch(omitted.text, /must be a boolean/);

    const withFalse = await s.c.call("drive_share_invite", { ...args, confirmed: false });
    assert.equal(withFalse.isError, true);
    assert.match(withFalse.text, /immediately emails the invitee and grants them access/);
    assert.doesNotMatch(withFalse.text, /must be a boolean/);

    const withStringTrue = await s.c.call("drive_share_invite", { ...args, confirmed: "true" });
    assert.equal(withStringTrue.isError, true);
    assert.match(withStringTrue.text, /confirmed must be a boolean/);
    assert.doesNotMatch(withStringTrue.text, /immediately emails the invitee/);

    assert.equal(s.calls().length, before, "none of the three refused calls may reach the CLI");
  });
});

describe("conditional confirmed gates", () => {
  const s = sharedServer();
  const up = { localPath: join(TMP, "x.txt"), remotePath: "/my-files" };
  const down = { remotePath: P, localPath: join(TMP, "dl") };
  const photoDown = { photoPaths: ["/photos/p1.jpg"], localFolder: join(TMP, "ph") };

  async function refused(tool, args) {
    const before = s.calls().length;
    const r = await s.c.call(tool, args);
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /confirmed=true/);
    assert.equal(s.calls().length, before, "CLI must not be called");
  }
  async function allowed(tool, args) {
    const before = s.calls().length;
    const r = await s.c.call(tool, args);
    assert.equal(r.isError, false, r.text);
    assert.ok(s.calls().length > before);
  }

  it("drive_upload fileConflictStrategy=replace is refused without confirmed", () => refused("drive_upload", { ...up, fileConflictStrategy: "replace" }));
  it("drive_upload folderConflictStrategy=replace is refused without confirmed", () => refused("drive_upload", { ...up, folderConflictStrategy: "replace" }));
  it("drive_upload replace runs with confirmed:true", () => allowed("drive_upload", { ...up, fileConflictStrategy: "replace", confirmed: true }));
  for (const strat of ["skip", "create-new-revision", "rename"]) {
    it(`drive_upload fileConflictStrategy=${strat} needs no confirmation`, () => allowed("drive_upload", { ...up, fileConflictStrategy: strat }));
  }
  it("drive_upload with defaults needs no confirmation", () => allowed("drive_upload", up));

  it("drive_download fileConflictStrategy=remove is refused without confirmed", () => refused("drive_download", { ...down, fileConflictStrategy: "remove" }));
  it("drive_download folderConflictStrategy=remove is refused without confirmed", () => refused("drive_download", { ...down, folderConflictStrategy: "remove" }));
  it("drive_download remove runs with confirmed:true", () => allowed("drive_download", { ...down, fileConflictStrategy: "remove", confirmed: true }));
  for (const strat of ["skip", "rename"]) {
    it(`drive_download fileConflictStrategy=${strat} needs no confirmation`, () => allowed("drive_download", { ...down, fileConflictStrategy: strat }));
  }

  it("photos_download conflictStrategy=remove is refused without confirmed", () => refused("photos_download", { ...photoDown, conflictStrategy: "remove" }));
  it("photos_download remove runs with confirmed:true", () => allowed("photos_download", { ...photoDown, conflictStrategy: "remove", confirmed: true }));
  for (const strat of ["skip", "rename"]) {
    it(`photos_download conflictStrategy=${strat} needs no confirmation`, () => allowed("photos_download", { ...photoDown, conflictStrategy: strat }));
  }
});

describe("drive_write_file overwrite gate", () => {
  let sync, sb, c;
  before(async () => {
    sync = mkdtempSync(join(tmpdir(), "pdmcp-sync-"));
    writeFileSync(join(sync, "existing.txt"), "old");
    sb = makeSandbox();
    c = await startServer("json", sb, { PROTON_DRIVE_SYNC_PATH: sync });
  });
  after(async () => { await c?.close(); sb?.cleanup(); if (sync) rmSync(sync, { recursive: true, force: true }); });

  it("refuses to overwrite an existing file without confirmed and leaves it untouched", async () => {
    const r = await c.call("drive_write_file", { path: "/existing.txt", content: "new" });
    assert.equal(r.isError, true);
    assert.match(r.text, /confirmed=true/);
    assert.equal(readFileSync(join(sync, "existing.txt"), "utf8"), "old");
  });

  it("overwrites an existing file with confirmed:true", async () => {
    const r = await c.call("drive_write_file", { path: "/existing.txt", content: "new", confirmed: true });
    assert.equal(r.isError, false, r.text);
    assert.equal(readFileSync(join(sync, "existing.txt"), "utf8"), "new");
  });

  it("creates a new file without confirmation", async () => {
    const r = await c.call("drive_write_file", { path: "/fresh.txt", content: "hello" });
    assert.equal(r.isError, false, r.text);
    assert.ok(existsSync(join(sync, "fresh.txt")));
  });

  it("never calls the CLI (local operation)", () => {
    assert.equal(nonVersionCalls(sb.argvLog).length, 0);
  });
});

describe("protocol errors and argument validation", () => {
  const s = sharedServer();

  it("returns JSON-RPC error -32601 for an unknown tool", async () => {
    const res = await s.c.callRaw("drive_does_not_exist", {});
    assert.equal(res.error?.code, -32601);
  });

  const bad = [
    ["unknown argument", "drive_list", { path: "/my-files", bogus: 1 }, /Unknown argument 'bogus'/],
    ["array as a path", "drive_list", { path: ["/my-files"] }, /path must be a string/],
    ["array as a path in drive_info", "drive_info", { path: ["/my-files"] }, /must be a string/],
    ["missing required argument", "drive_mkdir", {}, /Missing required argument 'path'/],
    ["invalid enum value", "drive_share_invite", { path: P, email: "b@example.com", role: "owner", confirmed: true }, /role must be one of/],
    ["invalid conflict strategy enum", "drive_upload", { localPath: join(TMP, "x"), remotePath: "/my-files", fileConflictStrategy: "explode" }, /must be one of/],
    ["limit above maximum", "drive_list", { path: "/my-files", limit: 5000 }, /limit must be <= 1000/],
    ["limit of zero", "drive_list", { path: "/my-files", limit: 0 }, /limit must be >= 1/],
    ["negative offset", "drive_list", { path: "/my-files", offset: -1 }, /offset must be >= 0/],
    ["non-integer limit", "drive_list", { path: "/my-files", limit: 1.5 }, /limit must be an integer/],
    ["string limit", "drive_list", { path: "/my-files", limit: "10" }, /limit must be an integer/],
    ["relative remote path", "drive_list", { path: "my-files" }, /absolute/],
    ["traversal in path", "drive_info", { path: "/my-files/../etc" }, /'\.' or '\.\.'/],
    ["flag-like path", "drive_info", { path: "-rf" }, /must not start with '-'/],
    ["array for a boolean", "photos_list_timeline", { loadDetails: [true] }, /loadDetails must be a boolean/],
    ["non-string element in a string array", "photos_download", { photoPaths: ["/photos/a.jpg", 123], localFolder: join(TMP, "ph2") }, /photoPaths must be an array of strings/],
  ];
  for (const [label, tool, args, re] of bad) {
    it(`${label} is an isError result and does not call the CLI`, async () => {
      const before = s.calls().length;
      const r = await s.c.call(tool, args);
      assert.equal(r.isError, true, r.text);
      assert.match(r.text, re);
      assert.equal(s.calls().length, before);
    });
  }
});

describe("argv passed to the CLI", () => {
  const s = sharedServer();
  const last = () => s.calls().at(-1);
  const find = (pred) => s.calls().findLast(pred);

  it("drive_share_set_url passes --role", async () => {
    const r = await s.c.call("drive_share_set_url", { path: P, role: "editor", confirmed: true });
    assert.equal(r.isError, false, r.text);
    const argv = find((a) => a[0] === "sharing" && a[1] === "set-url");
    assert.ok(argv, "no set-url call");
    assert.equal(argv[argv.indexOf("--role") + 1], "editor");
    assert.equal(argv.at(-1), "--json");
  });

  it("drive_share_set_url rejects role admin (viewer/editor only) without calling the CLI", async () => {
    const before = s.calls().length;
    const r = await s.c.call("drive_share_set_url", { path: P, role: "admin", confirmed: true });
    assert.equal(r.isError, true);
    assert.equal(s.calls().length, before);
  });

  it("photos_delete_album passes --force and --save", async () => {
    await s.c.call("photos_delete_album", { albumPath: "/albums/Trip", confirmed: true, force: true, save: true });
    const argv = find((a) => a[0] === "album" && a[1] === "delete");
    assert.ok(argv);
    assert.ok(argv.includes("--force"));
    assert.ok(argv.includes("--save"));
  });

  it("photos_delete_album omits --force/--save by default", async () => {
    await s.c.call("photos_delete_album", { albumPath: "/albums/Trip2", confirmed: true });
    const argv = find((a) => a[0] === "album" && a[1] === "delete" && a[2] === "/albums/Trip2");
    assert.ok(argv);
    assert.ok(!argv.includes("--force"));
    assert.ok(!argv.includes("--save"));
  });

  it("drive_copy newName becomes --name before the positionals", async () => {
    await s.c.call("drive_copy", { sourcePath: "/my-files/a.txt", destinationPath: "/my-files/dir", newName: "b.txt" });
    assert.deepEqual(last(), ["filesystem", "copy", "--name", "b.txt", "/my-files/a.txt", "/my-files/dir", "--json"]);
  });

  it("drive_copy without newName omits --name", async () => {
    await s.c.call("drive_copy", { sourcePath: "/my-files/a.txt", destinationPath: "/my-files/dir" });
    assert.deepEqual(last(), ["filesystem", "copy", "/my-files/a.txt", "/my-files/dir", "--json"]);
  });

  it("photos_list_album_photos loadDetails becomes --load-details", async () => {
    await s.c.call("photos_list_album_photos", { albumPath: "/albums/Trip", loadDetails: true });
    assert.deepEqual(last(), ["album", "photos", "/albums/Trip", "--load-details", "--json"]);
  });

  it("photos_list_album_photos omits --load-details by default", async () => {
    await s.c.call("photos_list_album_photos", { albumPath: "/albums/Trip" });
    assert.deepEqual(last(), ["album", "photos", "/albums/Trip", "--json"]);
  });

  it("drive_upload passes both conflict strategies", async () => {
    await s.c.call("drive_upload", { localPath: join(TMP, "x.txt"), remotePath: "/my-files", fileConflictStrategy: "rename", folderConflictStrategy: "merge" });
    assert.deepEqual(last(), ["filesystem", "upload", join(TMP, "x.txt"), "/my-files", "--file-conflict-strategy", "rename", "--folder-conflict-strategy", "merge", "--json"]);
  });

  it("drive_version calls `version` without --json", async () => {
    const r = await s.c.call("drive_version", {});
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.data, { cli: "0.8.0", sdk: "0.21.0" });
    const v = readArgvLog(s.sb.argvLog).filter((a) => a[0] === "version");
    assert.ok(v.every((a) => !a.includes("--json")));
  });
});

describe("ok:false result items", () => {
  const s = sharedServer("ok-false-results");

  it("drive_move surfaces the per-item error name", async () => {
    const r = await s.c.call("drive_move", { sourcePath: "/my-files/a.txt", destinationPath: "/other/a.txt" });
    assert.equal(r.isError, true);
    assert.match(r.text, /NodeWithSameNameExistsValidationError/);
  });

  it("drive_copy surfaces the per-item error name", async () => {
    const r = await s.c.call("drive_copy", { sourcePath: "/my-files/a.txt", destinationPath: "/other" });
    assert.equal(r.isError, true);
    assert.match(r.text, /NodeWithSameNameExistsValidationError/);
  });

  it("drive_trash surfaces the per-item error name", async () => {
    const r = await s.c.call("drive_trash", { path: "/my-files/a.txt" });
    assert.equal(r.isError, true);
    assert.match(r.text, /NodeWithSameNameExistsValidationError/);
  });
});

describe("pagination", () => {
  const items = ["a", "b", "c", "d", "e"].map((n) => ({ name: n, type: "file" }));
  const s = sharedServer("json", { FAKE_STDOUT: JSON.stringify(items) });

  it("drive_list honours limit and offset and reports total/hasMore", async () => {
    const r = await s.c.call("drive_list", { path: "/my-files", limit: 2, offset: 1 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.total, 5);
    assert.equal(r.data.offset, 1);
    assert.equal(r.data.limit, 2);
    assert.equal(r.data.hasMore, true);
    assert.equal(r.data.path, "/my-files");
    assert.deepEqual(r.data.items.map((i) => i.name), ["b", "c"]);
  });

  it("drive_list reports hasMore=false on the last page", async () => {
    const r = await s.c.call("drive_list", { path: "/my-files", limit: 2, offset: 4 });
    assert.equal(r.data.hasMore, false);
    assert.deepEqual(r.data.items.map((i) => i.name), ["e"]);
  });

  it("drive_list offset past the end returns no items", async () => {
    const r = await s.c.call("drive_list", { path: "/my-files", offset: 50 });
    assert.equal(r.data.total, 5);
    assert.deepEqual(r.data.items, []);
    assert.equal(r.data.hasMore, false);
  });

  it("drive_list defaults to limit 200", async () => {
    const r = await s.c.call("drive_list", { path: "/my-files" });
    assert.equal(r.data.limit, 200);
    assert.equal(r.data.items.length, 5);
  });

  it("drive_list_trash defaults to limit 100", async () => {
    const r = await s.c.call("drive_list_trash", {});
    assert.equal(r.data.limit, 100);
    assert.equal(r.data.total, 5);
  });

  it("drive_list limit at the lower boundary (1) succeeds and returns exactly one item", async () => {
    const r = await s.c.call("drive_list", { path: "/my-files", limit: 1 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.items.length, 1);
    assert.equal(r.data.hasMore, true);
  });

  it("drive_list limit at the upper boundary (1000) succeeds even though it exceeds total", async () => {
    const r = await s.c.call("drive_list", { path: "/my-files", limit: 1000 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.items.length, 5);
    assert.equal(r.data.hasMore, false);
  });

  it("drive_list limit one past the upper boundary (1001) is rejected", async () => {
    const r = await s.c.call("drive_list", { path: "/my-files", limit: 1001 });
    assert.equal(r.isError, true);
    assert.match(r.text, /limit must be <= 1000/);
  });

  it("drive_list offset at the lower boundary (0) succeeds explicitly", async () => {
    const r = await s.c.call("drive_list", { path: "/my-files", offset: 0 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.offset, 0);
    assert.equal(r.data.items.length, 5);
  });

  it("drive_list hasMore is false when total is exactly divisible by limit (one full page)", async () => {
    const r = await s.c.call("drive_list", { path: "/my-files", limit: 5, offset: 0 });
    assert.equal(r.data.items.length, 5);
    assert.equal(r.data.hasMore, false);
  });

  it("drive_list hasMore is still true on a middle page with items remaining after it", async () => {
    const r = await s.c.call("drive_list", { path: "/my-files", limit: 2, offset: 2 });
    assert.deepEqual(r.data.items.map((i) => i.name), ["c", "d"]);
    assert.equal(r.data.hasMore, true);
  });

  it("drive_list_trash limit at the lower boundary (1) succeeds", async () => {
    const r = await s.c.call("drive_list_trash", { limit: 1 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.items.length, 1);
  });

  it("drive_list_trash limit one past the upper boundary (1001) is rejected", async () => {
    const r = await s.c.call("drive_list_trash", { limit: 1001 });
    assert.equal(r.isError, true);
    assert.match(r.text, /limit must be <= 1000/);
  });

  it("photos_list_timeline defaults to limit 50 and honours limit", async () => {
    const d = await s.c.call("photos_list_timeline", {});
    assert.equal(d.data.limit, 50);
    const r = await s.c.call("photos_list_timeline", { limit: 3 });
    assert.equal(r.data.items.length, 3);
    assert.equal(r.data.hasMore, true);
  });

  it("photos_list_album_photos defaults to limit 100", async () => {
    const r = await s.c.call("photos_list_album_photos", { albumPath: "/albums/Trip" });
    assert.equal(r.data.limit, 100);
    assert.equal(r.data.total, 5);
  });

  it("responses are compact JSON (no pretty printing)", async () => {
    const r = await s.c.call("drive_list", { path: "/my-files" });
    assert.ok(!r.text.includes("\n"));
  });
});

describe("CLI output handling and error sanitization", () => {
  const SECRET = "S3cr3tPassw0rd!";

  async function withServer(mode, extraEnv, fn) {
    const sb = makeSandbox();
    const c = await startServer(mode, sb, extraEnv);
    try { await fn(c, sb); } finally { await c.close(); sb.cleanup(); }
  }

  it("fail-stderr with a --password argument never leaks the password, argv or binary path", () =>
    withServer("fail-stderr", {}, async (c) => {
      const r = await c.call("drive_share_set_url", { path: P, password: SECRET, confirmed: true });
      assert.equal(r.isError, true);
      assert.match(r.text, /quota exceeded/);
      assert.ok(!r.text.includes(SECRET), "password leaked");
      assert.ok(!r.text.includes("--password"), "argv leaked");
      assert.ok(!r.text.includes(FAKE_CLI), "binary path leaked");
      assert.ok(!r.text.includes("Command failed"), "execFile message leaked");
    }));

  it("masks --password even when the CLI itself echoes its argv on stderr", () =>
    withServer("fail-stderr-echo", {}, async (c) => {
      const r = await c.call("drive_share_set_url", { path: P, password: SECRET, confirmed: true });
      assert.equal(r.isError, true);
      assert.ok(!r.text.includes(SECRET), `password leaked: ${r.text}`);
      assert.match(r.text, /--password \*\*\*/);
    }));

  it("masks --message content echoed by the CLI", () =>
    withServer("fail-stderr-echo", {}, async (c) => {
      const r = await c.call("drive_share_invite", { path: P, email: "bob@example.com", role: "viewer", message: "topsecretnote", confirmed: true });
      assert.equal(r.isError, true);
      assert.ok(!r.text.includes("topsecretnote"), `message leaked: ${r.text}`);
    }));

  it("fail-stdout-crash surfaces the ENOENT text the CLI wrote to stdout", () =>
    withServer("fail-stdout-crash", {}, async (c) => {
      const r = await c.call("drive_info", { path: P });
      assert.equal(r.isError, true);
      assert.match(r.text, /ENOENT: no such file or directory/);
      assert.ok(!r.text.includes("====="), "banner should be dropped");
    }));

  it("big-stderr output is truncated to under 2000 characters", () =>
    withServer("big-stderr", {}, async (c) => {
      const r = await c.call("drive_info", { path: P }, { timeout: 20_000 });
      assert.equal(r.isError, true);
      assert.ok(r.text.length < 2000, `length ${r.text.length}`);
      assert.match(r.text, /line 0/);
    }));

  it("auth-fail maps to the not-authenticated message", () =>
    withServer("auth-fail", {}, async (c) => {
      const r = await c.call("drive_list", { path: "/my-files" });
      assert.equal(r.isError, true);
      assert.match(r.text, /Not authenticated/);
      assert.ok(!r.text.includes("You need to login first"));
    }));

  it("drive_auth_status reports authenticated:false on auth failure instead of erroring", () =>
    withServer("auth-fail", {}, async (c) => {
      const r = await c.call("drive_auth_status", {});
      assert.equal(r.isError, false, r.text);
      assert.deepEqual(r.data, { authenticated: false });
    }));

  it("drive_auth_status reports authenticated:true when the probe succeeds", () =>
    withServer("json", { FAKE_STDOUT: "{}" }, async (c) => {
      const r = await c.call("drive_auth_status", {});
      assert.deepEqual(r.data, { authenticated: true });
    }));

  it("ansi-prefixed-json is parsed", () =>
    withServer("ansi-prefixed-json", { FAKE_STDOUT: JSON.stringify([{ name: "z.txt", type: "file" }]) }, async (c) => {
      const r = await c.call("drive_list", { path: "/my-files" });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.data.items[0].name, "z.txt");
    }));

  it("garbage output gives a Parse error containing a snippet", () =>
    withServer("garbage", {}, async (c) => {
      const r = await c.call("drive_list", { path: "/my-files" });
      assert.equal(r.isError, true);
      assert.match(r.text, /^Parse error/);
      assert.match(r.text, /this is not json/);
    }));

  it("empty stdout on drive_list yields an empty items array", () =>
    withServer("empty", {}, async (c) => {
      const r = await c.call("drive_list", { path: "/my-files" });
      assert.equal(r.isError, false, r.text);
      assert.deepEqual(r.data.items, []);
      assert.equal(r.data.total, 0);
      assert.equal(r.data.hasMore, false);
    }));

  it("literal 'undefined' stdout is treated as null (share status of an unshared item)", () =>
    withServer("undefined-literal", {}, async (c) => {
      const r = await c.call("drive_share_status", { path: P });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.data.isShared, false);
      assert.deepEqual(r.data.members, []);
    }));

  it("a missing binary yields the CLI-not-found message and the server stays up", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb, { PROTON_DRIVE_BIN: join(sb.dir, "no-such-binary") });
    try {
      const r = await c.call("drive_list", { path: "/my-files" });
      assert.equal(r.isError, true);
      assert.match(r.text, /not found/i);
      assert.equal((await c.listTools()).length, 38);
    } finally { await c.close(); sb.cleanup(); }
  });
});
