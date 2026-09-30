import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, makeSandbox, startServer } from "./helpers/mcp-client.mjs";

const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");
const manifest = JSON.parse(read("mcpb", "manifest.json"));
const pkg = JSON.parse(read("package.json"));

describe("mcpb manifest", () => {
  it("has required identity fields", () => {
    assert.equal(manifest.manifest_version, "0.3");
    assert.equal(manifest.name, pkg.name);
    assert.equal(manifest.license, pkg.license);
    assert.equal(manifest.server.type, "node");
    assert.equal(manifest.server.entry_point, "launcher.mjs");
  });

  it("version is injected by the build (placeholder in repo) and build script reads package.json", () => {
    assert.equal(manifest.version, "0.0.0");
    assert.match(read("scripts", "build-mcpb.mjs"), /manifest\.version = pkg\.version/);
  });

  it("user_config keys match the env mapping", () => {
    const env = manifest.server.mcp_config.env;
    const refs = Object.values(env).map((v) => v.match(/^\$\{user_config\.(\w+)\}$/)?.[1]);
    assert.ok(refs.every(Boolean));
    assert.deepEqual([...refs].sort(), Object.keys(manifest.user_config).sort());
    assert.deepEqual(Object.keys(env).sort(), ["PROTON_DRIVE_BIN", "PROTON_DRIVE_SYNC_PATH"]);
    assert.ok(Object.values(manifest.user_config).every((c) => c.required === false));
  });

  it("launcher exists and args point to it", () => {
    assert.deepEqual(manifest.server.mcp_config.args, ["${__dirname}/launcher.mjs"]);
    assert.match(read("mcpb", "launcher.mjs"), /delete process\.env\[key\]/);
  });

  it("tool names equal the server's real tools/list", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb);
    try {
      const real = (await c.listTools()).map((t) => t.name).sort();
      assert.deepEqual(manifest.tools.map((t) => t.name).sort(), real);
      assert.ok(manifest.tools.every((t) => t.description));
    } finally {
      await c.close();
      sb.cleanup();
    }
  });
});

describe("mcpb manifest prompts", () => {
  it("names, arguments and texts equal the server's prompts (full tier)", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb);
    try {
      await c.initialize();
      const real = (await c.request("prompts/list", {})).result.prompts;
      assert.deepEqual(manifest.prompts.map((p) => p.name).sort(), real.map((p) => p.name).sort());
      for (const mp of manifest.prompts) {
        const rp = real.find((p) => p.name === mp.name);
        assert.deepEqual(mp.arguments ?? [], rp.arguments.map((a) => a.name));
        assert.equal(mp.description, rp.description);
        // Render the server text with sentinels and map them back to the manifest placeholders.
        const args = Object.fromEntries((mp.arguments ?? []).map((n) => [n, n === "path" ? "/my-files/@@path@@" : `@@${n}@@`]));
        let text = (await c.request("prompts/get", { name: mp.name, arguments: args })).result.messages[0].content.text;
        for (const n of mp.arguments ?? []) text = text.replaceAll(n === "path" ? "/my-files/@@path@@" : `@@${n}@@`, `\${arguments.${n}}`);
        assert.equal(mp.text, text);
      }
    } finally {
      await c.close();
      sb.cleanup();
    }
  });
});

describe("mcpb-release workflow", () => {
  const wf = read(".github", "workflows", "mcpb-release.yml");
  it("triggers on release published + dispatch, SHA-pins actions, scopes write permission", () => {
    assert.match(wf, /release:\s*\n\s+types: \[published\]/);
    assert.match(wf, /workflow_dispatch:/);
    for (const m of wf.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/);
    assert.match(wf, /^permissions:\n  contents: read/m);
    assert.equal((wf.match(/contents: write/g) ?? []).length, 1);
    assert.match(wf, /gh release upload/);
  });
});
