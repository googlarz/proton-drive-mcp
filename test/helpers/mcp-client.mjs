import { spawn } from "node:child_process";
import { readFileSync, existsSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..", "..");
export const DIST_INDEX = join(ROOT, "dist", "index.js");
export const DIST_CLI = join(ROOT, "dist", "cli.js");
export const FAKE_CLI = join(here, "fake-cli.mjs");

chmodSync(FAKE_CLI, 0o755);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function waitFor(pred, timeoutMs = 5000, stepMs = 25) {
  const start = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - start > timeoutMs) return false;
    await sleep(stepMs);
  }
}

/** Temp dir with argv log + pid file; call cleanup() when done. */
export function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "pdmcp-test-"));
  return {
    dir,
    argvLog: join(dir, "argv.log"),
    pidFile: join(dir, "pids.log"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function readJsonLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Every CLI invocation logged so far (includes the startup `version` probe). */
export const readArgvLog = (file) => readJsonLines(file).map((e) => e.argv);
/** CLI invocations excluding `version` (the startup probe / drive_version). */
export const nonVersionCalls = (file) => readArgvLog(file).filter((a) => a[0] !== "version");
export const readPids = (file) => readJsonLines(file);

/** Base env for a server/CLI process talking to the fake binary. */
export function fakeEnv(mode, sandbox, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("FAKE_") || k === "PROTON_DRIVE_SYNC_PATH" || k === "PROTON_DRIVE_LOCAL_ROOT") delete env[k];
  return {
    ...env,
    PROTON_DRIVE_BIN: FAKE_CLI,
    FAKE_MODE: mode,
    FAKE_ARGV_LOG: sandbox.argvLog,
    FAKE_PIDFILE: sandbox.pidFile,
    ...extra,
  };
}

/**
 * Minimal MCP stdio client. Keeps stdin open, correlates ids, has timeouts.
 * Call close() (or kill()) in `after` so no process is left behind.
 */
export class McpClient {
  constructor({ script = DIST_INDEX, args = [], env = process.env, spawnArgs } = {}) {
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
    this.stderr = "";
    this.exited = false;
    this.exitInfo = null;
    this.proc = spawn(process.execPath, spawnArgs ?? [script, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.exitPromise = new Promise((resolve) => {
      this.proc.on("exit", (code, signal) => {
        this.exited = true;
        this.exitInfo = { code, signal };
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`server exited (code=${code} signal=${signal}) before reply`)); }
        this.pending.clear();
        resolve(this.exitInfo);
      });
    });
    this.proc.stdin.on("error", () => { /* server may exit first */ });
    this.proc.stderr.on("data", (d) => { this.stderr += d.toString(); });
    this.proc.stdout.on("data", (d) => this.#onData(d));
    this.proc.stdout.on("error", () => {});
  }

  get pid() { return this.proc.pid; }

  #onData(chunk) {
    this.buf += chunk.toString();
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    }
  }

  send(obj) { this.proc.stdin.write(JSON.stringify(obj) + "\n"); }
  notify(method, params) { this.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }); }

  /** Sends a request; resolves with the full JSON-RPC response ({result} or {error}). */
  request(method, params, { timeout = 10_000 } = {}) {
    const id = this.nextId++;
    return this.requestWithId(id, method, params, { timeout });
  }

  requestWithId(id, method, params, { timeout = 10_000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeout}ms waiting for ${method} (id ${id})`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });
  }

  async initialize(opts) {
    const res = await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    }, opts);
    this.notify("notifications/initialized");
    return res;
  }

  listTools() { return this.request("tools/list", {}).then((r) => r.result.tools); }

  /** Returns the raw JSON-RPC response for tools/call. */
  callRaw(name, args = {}, opts) { return this.request("tools/call", { name, arguments: args }, opts); }

  /** Returns {isError, text, data} where data is the parsed JSON text when possible. */
  async call(name, args = {}, opts) {
    const res = await this.callRaw(name, args, opts);
    if (res.error) throw new Error(`JSON-RPC error ${res.error.code}: ${res.error.message}`);
    const text = res.result.content?.[0]?.text ?? "";
    let data;
    try { data = JSON.parse(text); } catch { data = undefined; }
    return { isError: res.result.isError === true, text, data };
  }

  kill(signal = "SIGKILL") {
    if (!this.exited) { try { this.proc.kill(signal); } catch { /* gone */ } }
  }

  async close() {
    if (this.exited) return;
    try { this.proc.stdin.end(); } catch { /* ignore */ }
    const done = await Promise.race([this.exitPromise, sleep(2000).then(() => null)]);
    if (!done) { this.kill("SIGKILL"); await this.exitPromise; }
  }
}

/** Starts a server against the fake CLI and initializes it. */
export async function startServer(mode, sandbox, extraEnv = {}, clientOpts = {}) {
  const client = new McpClient({ env: fakeEnv(mode, sandbox, extraEnv), ...clientOpts });
  await client.initialize();
  return client;
}
