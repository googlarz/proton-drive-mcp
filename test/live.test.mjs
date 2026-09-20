// READ-ONLY smoke test against the real Proton Drive CLI through the stdio server.
// Skipped unless PROTON_DRIVE_LIVE=1. Requires an authenticated `proton-drive` on PATH
// (or PROTON_DRIVE_BIN). No write, delete, share or upload call is made here.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { McpClient } from "./helpers/mcp-client.mjs";

const LIVE = process.env.PROTON_DRIVE_LIVE === "1";

describe("live read-only smoke", { skip: LIVE ? false : "set PROTON_DRIVE_LIVE=1 to run against the real CLI" }, () => {
  let c;
  before(async () => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("FAKE_")) delete env[k];
    c = new McpClient({ env });
    await c.initialize({ timeout: 15_000 });
  });
  after(async () => { await c?.close(); });

  const opts = { timeout: 90_000 };

  it("drive_version reports cli and sdk versions", async () => {
    const r = await c.call("drive_version", {}, opts);
    assert.equal(r.isError, false, r.text);
    assert.match(r.data.cli, /^\d+\.\d+\.\d+/);
  });

  it("drive_auth_status is authenticated", async () => {
    const r = await c.call("drive_auth_status", {}, opts);
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.authenticated, true);
  });

  it("drive_list /my-files returns a paginated envelope", async () => {
    const r = await c.call("drive_list", { path: "/my-files", limit: 5 }, opts);
    assert.equal(r.isError, false, r.text);
    assert.equal(typeof r.data.total, "number");
    assert.ok(Array.isArray(r.data.items));
    assert.ok(r.data.items.length <= 5);
  });

  it("drive_list / returns the root folders with real names", async () => {
    const r = await c.call("drive_list", { path: "/" }, opts);
    assert.equal(r.isError, false, r.text);
    assert.ok(r.data.items.length > 0);
    assert.ok(r.data.items.every((i) => i.name !== "[unnamed]"));
  });

  it("drive_info /my-files returns a node", async () => {
    const r = await c.call("drive_info", { path: "/my-files" }, opts);
    assert.equal(r.isError, false, r.text);
    assert.equal(typeof r.data, "object");
  });

  it("photos_list_timeline limit 3 returns at most 3 items", async () => {
    const r = await c.call("photos_list_timeline", { limit: 3 }, opts);
    assert.equal(r.isError, false, r.text);
    assert.ok(r.data.items.length <= 3);
  });

  it("photos_list_albums returns an array", async () => {
    const r = await c.call("photos_list_albums", {}, opts);
    assert.equal(r.isError, false, r.text);
    assert.ok(Array.isArray(r.data));
  });

  it("drive_list_invitations returns an array", async () => {
    const r = await c.call("drive_list_invitations", {}, opts);
    assert.equal(r.isError, false, r.text);
    assert.ok(Array.isArray(r.data));
  });

  it("drive_list_trash limit 3 returns at most 3 items", async () => {
    const r = await c.call("drive_list_trash", { limit: 3 }, opts);
    assert.equal(r.isError, false, r.text);
    assert.ok(r.data.items.length <= 3);
  });

  it("drive_share_status on a never-shared path returns isShared:false", async () => {
    const r = await c.call("drive_share_status", { path: "/my-files" }, opts);
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.isShared, false);
  });

  it("drive_info on a nonexistent path is an error", async () => {
    const r = await c.call("drive_info", { path: "/definitely-not-there" }, opts);
    assert.equal(r.isError, true);
  });
});
