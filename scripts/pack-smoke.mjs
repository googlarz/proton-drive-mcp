#!/usr/bin/env node
// Packaging smoke test. Requires `npm run build` to have run already.
// Packs the project, installs the tarball into a fresh project, then launches the
// installed bin symlink (as npx does) and speaks MCP over stdio.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const MIN_TOOLS = 38;
const TIMEOUT_MS = 15_000;
const tmp = mkdtempSync(join(tmpdir(), "pack-smoke-"));

function fail(msg) {
  console.error(`pack-smoke FAILED: ${msg}`);
  cleanup();
  process.exit(1);
}
function cleanup() {
  rmSync(tmp, { recursive: true, force: true });
}

function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    fail(`\`${cmd} ${args.join(" ")}\` exited ${e.status}\n${e.stdout ?? ""}${e.stderr ?? ""}`);
  }
}

async function main() {
  const packDir = join(tmp, "pack");
  const projDir = join(tmp, "project");
  for (const d of [packDir, projDir]) run("mkdir", ["-p", d], tmp);

  run(npm, ["pack", "--pack-destination", packDir], root);
  const tarball = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
  if (!tarball) fail("npm pack produced no tarball");

  writeFileSync(join(projDir, "package.json"), JSON.stringify({ name: "smoke", version: "0.0.0", private: true }));
  run(npm, ["install", "--no-audit", "--no-fund", join(packDir, tarball)], projDir);

  const bin = join(projDir, "node_modules", ".bin");

  const help = spawnSync(join(bin, "proton-drive-cli"), ["--help"], { cwd: projDir, encoding: "utf8" });
  if (help.status !== 0) fail(`proton-drive-cli --help exited ${help.status}\n${help.stdout}${help.stderr}`);

  const child = spawn(join(bin, "proton-drive-mcp"), [], {
    cwd: projDir,
    env: { ...process.env, PROTON_DRIVE_BIN: join(tmp, "does-not-exist") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));

  const replies = new Map();
  let buf = "";
  let notify = () => {};
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) replies.set(msg.id, msg);
        notify();
      } catch {
        fail(`non-JSON on stdout: ${line}`);
      }
    }
  });
  const exited = new Promise((res) => child.on("exit", (code) => res(code)));

  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const waitFor = (id) =>
    new Promise((res, rej) => {
      const timer = setTimeout(
        () => rej(new Error(`no reply to id ${id} within ${TIMEOUT_MS}ms; stderr: ${stderr}`)),
        TIMEOUT_MS,
      );
      const check = () => {
        if (replies.has(id)) {
          clearTimeout(timer);
          res(replies.get(id));
        }
      };
      notify = check;
      exited.then((code) => rej(new Error(`server exited (code ${code}) before replying to id ${id}; stderr: ${stderr}`)));
      check();
    });

  try {
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pack-smoke", version: "0" } } });
    const init = await waitFor(1);
    if (init.error || init.result?.serverInfo?.name !== "proton-drive-mcp")
      fail(`invalid initialize reply: ${JSON.stringify(init)}`);
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list", params: {} });
    const list = await waitFor(2);
    const n = list.result?.tools?.length ?? 0;
    if (n < MIN_TOOLS) fail(`tools/list returned ${n} tools, expected >= ${MIN_TOOLS}`);
    console.log(`pack-smoke OK: ${init.result.serverInfo.name}@${init.result.serverInfo.version}, ${n} tools, proton-drive-cli --help exit 0`);
  } catch (e) {
    fail(e.message);
  } finally {
    child.kill();
  }
}

main().then(
  () => {
    cleanup();
    process.exit(0);
  },
  (e) => fail(e.message),
);
