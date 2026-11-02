// Official MCP Registry metadata: server.json must stay in step with package.json (the registry verifies ownership through mcpName).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/mcp-client.mjs";

const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");
const pkg = JSON.parse(read("package.json"));
const server = JSON.parse(read("server.json"));
const lock = JSON.parse(read("package-lock.json"));

describe("MCP Registry server.json", () => {
  it("mcpName in package.json matches the server name", () => {
    assert.equal(pkg.mcpName, "io.github.googlarz/proton-drive-mcp");
    assert.equal(server.name, pkg.mcpName);
  });

  it("version fields equal package.json's version", () => {
    assert.equal(server.version, pkg.version);
    assert.equal(server.packages.length, 1);
    assert.equal(server.packages[0].version, pkg.version);
  });

  it("describes the npm package over stdio", () => {
    assert.match(server.$schema, /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/[\d-]+\/server\.schema\.json$/);
    const [p] = server.packages;
    assert.equal(p.registryType, "npm");
    assert.equal(p.identifier, pkg.name);
    assert.deepEqual(p.transport, { type: "stdio" });
    assert.equal(server.repository.source, "github");
    assert.equal(server.repository.url, "https://github.com/googlarz/proton-drive-mcp");
  });

  it("respects the schema limits (description <= 100 chars, title <= 100)", () => {
    assert.ok(server.description.length >= 1 && server.description.length <= 100);
    assert.ok(server.title.length <= 100);
    assert.match(server.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  });

  it("the release workflow refuses a tag that does not match server.json", () => {
    assert.match(read(".github", "workflows", "publish.yml"), /server\.json/);
  });
});

describe("dependency pin", () => {
  it("@modelcontextprotocol/sdk is an exact version that matches the lockfile", () => {
    const range = pkg.dependencies["@modelcontextprotocol/sdk"];
    assert.match(range, /^\d+\.\d+\.\d+$/, "no caret/tilde range");
    assert.equal(lock.packages["node_modules/@modelcontextprotocol/sdk"].version, range);
    assert.equal(lock.packages[""].dependencies["@modelcontextprotocol/sdk"], range);
  });
});
