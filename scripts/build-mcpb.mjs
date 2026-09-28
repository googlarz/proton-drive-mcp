#!/usr/bin/env node
// Builds out/mcpb/proton-drive-mcp-<version>.mcpb. Pure JS, no native deps, so
// one bundle works on every platform. `--write-tools` refreshes the tools list
// in mcpb/manifest.json from the server's real tools/list.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifestPath = join(root, "mcpb", "manifest.json");
const isWindows = process.platform === "win32";
const run = (cmd, args, opts) => execFileSync(cmd, args, { ...opts, shell: isWindows });

/** Start dist/index.js (nonexistent CLI) and return [{name, description}] from tools/list. */
export function listTools() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PROTON_DRIVE_BIN: "/nonexistent/proton-drive" };
    delete env.PROTON_DRIVE_SYNC_PATH;
    const p = spawn(process.execPath, [join(root, "dist", "index.js")], { env, stdio: ["pipe", "pipe", "ignore"] });
    p.stdin.on("error", () => {});
    let buf = "";
    const timer = setTimeout(() => { p.kill(); reject(new Error("tools/list timed out")); }, 20000);
    p.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n" + JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
        if (m.id === 2) { clearTimeout(timer); p.kill(); resolve(m.result.tools.map((t) => ({ name: t.name, description: oneLine(t.description) }))); }
      }
    });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "build-mcpb", version: "0" } } }) + "\n");
  });
}

function oneLine(desc = "") {
  const first = desc.replace(/\s+/g, " ").trim().split(/(?<=\.)\s/)[0];
  return first.length > 200 ? first.slice(0, 197) + "..." : first;
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = pkg.version;

if (process.argv[2] !== "--write-tools") {
  console.log(`Building .mcpb bundle (v${pkg.version})...`);
  run("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
}
manifest.tools = await listTools();

if (process.argv[2] === "--write-tools") {
  manifest.version = "0.0.0";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Wrote ${manifest.tools.length} tools to mcpb/manifest.json`);
  process.exit(0);
}

const staging = mkdtempSync(join(tmpdir(), "proton-drive-mcpb-"));
try {
  // Stage a package.json copy (minus "prepare", which needs devDependencies) so
  // `npm ci --omit=dev` never touches the repo's node_modules.
  const stagedPkg = { ...pkg, scripts: {} };
  writeFileSync(join(staging, "package.json"), JSON.stringify(stagedPkg, null, 2));
  cpSync(join(root, "package-lock.json"), join(staging, "package-lock.json"));
  run("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: staging, stdio: "inherit" });
  cpSync(join(root, "dist"), join(staging, "dist"), { recursive: true });
  cpSync(join(root, "mcpb", "launcher.mjs"), join(staging, "launcher.mjs"));
  cpSync(join(root, "LICENSE"), join(staging, "LICENSE"));
  cpSync(join(root, "README.md"), join(staging, "README.md"));
  writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));

  const outDir = join(root, "out", "mcpb");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `proton-drive-mcp-${pkg.version}.mcpb`);
  run("npx", ["--yes", "@anthropic-ai/mcpb", "validate", join(staging, "manifest.json")], { cwd: root, stdio: "inherit" });
  run("npx", ["--yes", "@anthropic-ai/mcpb", "pack", staging, outFile], { cwd: root, stdio: "inherit" });
  console.log(`Built ${outFile}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
