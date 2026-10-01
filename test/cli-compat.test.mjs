// CLI version guard: doctor `cli-version` check and the one-line startup warning.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { makeSandbox, fakeEnv, DIST_CLI, McpClient, waitFor } from "./helpers/mcp-client.mjs";

const cleanups = [];
after(() => cleanups.forEach((f) => f()));

function doctor(version) {
  const sb = makeSandbox();
  cleanups.push(sb.cleanup);
  const extra = { CLAUDE_DESKTOP_CONFIG: join(sb.dir, "nope", "c.json") };
  if (version !== undefined) extra.FAKE_CLI_VERSION = version;
  return new Promise((resolve) => {
    execFile(process.execPath, [DIST_CLI, "doctor", "--json"], { env: fakeEnv("json", sb, extra), timeout: 20_000 }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, json: JSON.parse(stdout) });
    });
  });
}
const check = (r) => r.json.checks.find((c) => c.id === "cli-version");

describe("doctor cli-version", () => {
  it("tested version is ok", async () => {
    const r = await doctor();
    assert.equal(check(r).status, "ok");
  });
  it("0.9.x warns with hint, exit stays 0", async () => {
    const r = await doctor("Proton Drive CLI cli-drive@0.9.1+abc\nProton Drive SDK js@0.22.0+abc\n");
    assert.equal(check(r).status, "warn");
    assert.match(check(r).hint, /Tested with 0\.8\.x/);
    assert.equal(r.code, 0);
  });
  it("unparsable version warns", async () => {
    const r = await doctor("garbage\n");
    assert.equal(check(r).status, "warn");
    assert.equal(r.code, 0);
  });
  it("missing CLI: no cli-version check, cli check still fails", async () => {
    const sb = makeSandbox();
    cleanups.push(sb.cleanup);
    const env = fakeEnv("json", sb, { CLAUDE_DESKTOP_CONFIG: join(sb.dir, "nope", "c.json"), PROTON_DRIVE_BIN: "/no/such/bin" });
    const out = await new Promise((resolve) => execFile(process.execPath, [DIST_CLI, "doctor", "--json"], { env, timeout: 20_000 }, (_e, stdout) => resolve(JSON.parse(stdout))));
    assert.equal(out.checks.find((c) => c.id === "cli").status, "fail");
    assert.equal(out.checks.find((c) => c.id === "cli-version"), undefined);
  });
});

describe("startup probe", () => {
  async function stderrFor(version) {
    const sb = makeSandbox();
    cleanups.push(sb.cleanup);
    const extra = version === undefined ? {} : { FAKE_CLI_VERSION: version };
    const c = new McpClient({ env: fakeEnv("json", sb, extra) });
    await c.initialize({ timeout: 5000 });
    if (version !== undefined) await waitFor(() => /\[WARN\]/.test(c.stderr), 3000).catch(() => {});
    else await new Promise((r) => setTimeout(r, 500));
    const err = c.stderr;
    await c.close();
    return err;
  }
  it("warns once on stderr for a different version", async () => {
    const err = await stderrFor("Proton Drive CLI cli-drive@0.9.0+abc\n");
    assert.equal((err.match(/Tested with 0\.8\.x/g) ?? []).length, 1);
  });
  it("is silent for the tested version", async () => {
    assert.doesNotMatch(await stderrFor(), /Tested with/);
  });
});
