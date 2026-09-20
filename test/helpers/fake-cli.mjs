#!/usr/bin/env node
// Fake `proton-drive` binary for tests (use as PROTON_DRIVE_BIN).
//
// Env:
//   FAKE_ARGV_LOG     file that receives one JSON line per invocation: {argv, pid}
//   FAKE_MODE         json | empty | undefined-literal | garbage | ansi-prefixed-json |
//                     fail-stderr | fail-stderr-echo | fail-stdout-crash | hang |
//                     big-stderr | auth-fail | ok-false-results
//   FAKE_STDOUT       payload printed in json / ansi-prefixed-json mode (default "[]")
//   FAKE_SLEEP_MS     delay before answering in json mode
//   FAKE_PIDFILE      hang mode appends {role,pid,argv0} lines (child + grandchild)
//   FAKE_HANG_VERSION 1 = `version` obeys FAKE_MODE (hang); otherwise it always prints version text
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_MODE ?? "json";
const isVersion = argv[0] === "version";

if (process.env.FAKE_ARGV_LOG) {
  appendFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify({ argv, pid: process.pid }) + "\n");
}

function hang() {
  if (process.env.FAKE_PIDFILE) {
    appendFileSync(process.env.FAKE_PIDFILE, JSON.stringify({ role: "child", pid: process.pid, argv0: argv[0] }) + "\n");
  }
  // Grandchild: ignores SIGTERM, stays in this process group.
  const gc = spawn("sh", ["-c", 'trap "" TERM; while :; do sleep 1; done'], { stdio: "ignore" });
  if (process.env.FAKE_PIDFILE) {
    appendFileSync(process.env.FAKE_PIDFILE, JSON.stringify({ role: "grandchild", pid: gc.pid, argv0: argv[0] }) + "\n");
  }
  process.on("SIGTERM", () => { /* ignore, like a stubborn CLI */ });
  setInterval(() => {}, 1000);
}

if (isVersion && process.env.FAKE_HANG_VERSION !== "1") {
  process.stdout.write("Proton Drive CLI cli-drive@0.8.0+abc\nProton Drive SDK js@0.21.0+abc\n");
  process.exit(0);
}

const payload = process.env.FAKE_STDOUT ?? "[]";

switch (mode) {
  case "json": {
    const ms = Number(process.env.FAKE_SLEEP_MS ?? 0);
    setTimeout(() => { process.stdout.write(payload + "\n"); process.exit(0); }, ms);
    break;
  }
  case "empty":
    process.exit(0);
    break;
  case "undefined-literal":
    process.stdout.write("undefined\n");
    process.exit(0);
    break;
  case "garbage":
    process.stdout.write("this is not json {{{ at all\n");
    process.exit(0);
    break;
  case "ansi-prefixed-json":
    process.stdout.write("\x1b[32mLoading session...\x1b[0m\n\x1b[2K\r" + payload + "\n");
    process.exit(0);
    break;
  case "fail-stderr":
    process.stderr.write("Error: quota exceeded for this account\n    at Object.run (file:///x/y.js:1:1)\n");
    process.exit(2);
    break;
  case "fail-stderr-echo":
    process.stderr.write(`usage error while running: ${argv.join(" ")}\n`);
    process.exit(2);
    break;
  case "fail-stdout-crash":
    process.stderr.write("=====\n");
    process.stdout.write("ENOENT: no such file or directory, open '/nowhere/file.bin'");
    process.exit(1);
    break;
  case "hang":
    hang();
    break;
  case "big-stderr": {
    let s = "";
    for (let i = 0; i < 3000; i++) s += `line ${i} ${"x".repeat(1000)}\n`;
    process.stderr.write(s, () => process.exit(1));
    break;
  }
  case "auth-fail":
    process.stderr.write("You need to login first\n");
    process.exit(1);
    break;
  case "ok-false-results":
    process.stdout.write(JSON.stringify([{ uid: "u1", ok: false, error: { name: "NodeWithSameNameExistsValidationError", code: 2500 } }]) + "\n");
    process.exit(0);
    break;
  default:
    process.stderr.write(`fake-cli: unknown FAKE_MODE ${mode}\n`);
    process.exit(3);
}
