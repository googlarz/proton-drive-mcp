#!/usr/bin/env node
// Fake `proton-drive` binary for tests (use as PROTON_DRIVE_BIN).
//
// Env:
//   FAKE_ARGV_LOG     file that receives one JSON line per invocation: {argv, pid}
//   FAKE_MODE         json | shuffle | empty | undefined-literal | garbage | ansi-prefixed-json |
//                     fail-stderr | fail-stderr-echo | fail-stdout-crash | hang |
//                     big-stderr | size-legacy | auth-fail | ok-false-results | locked-then-json | transient-then-json | tree | fs | download-hang
//                     download-hang: `filesystem info` prints a small text file node; `filesystem download` writes a partial file into the
//                     target dir, then hangs like `hang`. Everything else prints "[]".
//   FAKE_TREE         tree mode: path to a JSON file {"<folder path>": [list items]}; `filesystem list <path>` serves that entry
//                     (missing entry -> "Item not found" exit 1; a string entry is written to stderr, exit 1). Other commands print "[]".
//   FAKE_INFO         fs mode: path to a JSON file {"<path>": node}; `filesystem info <path>` prints that node (missing -> "Node not found" exit 1).
//                     FAKE_FAIL_CMD makes `filesystem <that subcommand>` (e.g. copy) fail with "boom". Everything else prints "[]".
//   FAKE_STATE        drive mode (stateful in-memory-on-disk Drive for the undo engine / cleanup tests): path to a JSON file
//                     {"nodes": {"<uid>": {uid, parentUid, name, type: "file"|"folder", size?, trashTime?}}}; the root folder is uid "root"
//                     (served as /my-files). Supports `filesystem` list | info | trash | restore | move | rename with the real CLI's rules:
//                     /trash/<name> resolves to the FIRST trashed node of that name, restore/move report per-item {uid, ok, error} with exit 0,
//                     a missing path fails the whole call (exit 1) before anything is applied, tests may edit the state file between calls.
//   FAKE_FAIL_UIDS         drive mode: comma list of uids whose restore/move reports ok:false (exit 0)
//   FAKE_LIE_UIDS          drive mode: comma list of uids whose restore/move reports ok:true but changes nothing
//   FAKE_COUNTER      locked-then-json: file holding the number of calls so far
//   FAKE_LOCKED_TIMES locked-then-json: how many calls fail with "database is locked" (default 2)
//   FAKE_TRANSIENT_KIND   transient-then-json: ratelimit | timeout | reset | retryafter | notfound (counter via FAKE_COUNTER)
//   FAKE_TRANSIENT_TIMES  transient-then-json: how many calls fail first (default 1)
//   FAKE_STDOUT       payload printed in json / ansi-prefixed-json mode (default "[]")
//   FAKE_SLEEP_MS     delay before answering in json mode
//   FAKE_PIDFILE      hang mode appends {role,pid,argv0} lines (child + grandchild)
//   FAKE_CLI_VERSION  version text override for `version` (default: CLI 0.8.0 / SDK 0.21.0 text; set verbatim, e.g. "garbage")
//   FAKE_HANG_VERSION 1 = `version` obeys FAKE_MODE (hang); otherwise it always prints version text
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

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
  process.stdout.write(process.env.FAKE_CLI_VERSION ?? "Proton Drive CLI cli-drive@0.8.0+abc\nProton Drive SDK js@0.21.0+abc\n");
  process.exit(0);
}

const payload = process.env.FAKE_STDOUT ?? "[]";

switch (mode) {
  case "json": {
    const ms = Number(process.env.FAKE_SLEEP_MS ?? 0);
    setTimeout(() => { process.stdout.write(payload + "\n"); process.exit(0); }, ms);
    break;
  }
  case "shuffle": {
    // Same items, different random order on every call (like the real CLI).
    const arr = JSON.parse(payload);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    process.stdout.write(JSON.stringify(arr) + "\n");
    process.exit(0);
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
  case "download-hang":
    if (argv[0] === "filesystem" && argv[1] === "info") {
      process.stdout.write(JSON.stringify({ uid: "f1", type: "file", name: { ok: true, value: "a.txt" }, mediaType: "text/plain", activeRevision: { claimedSize: 10 } }) + "\n");
      process.exit(0);
    } else if (argv[0] === "filesystem" && argv[1] === "download") {
      writeFileSync(join(argv[3], "a.txt"), "partial");
      hang();
    } else {
      process.stdout.write("[]\n");
      process.exit(0);
    }
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
  case "locked-then-json": {
    // First FAKE_LOCKED_TIMES calls fail like the real CLI's SQLite cache under
    // concurrent use; later calls succeed. FAKE_COUNTER holds the call count.
    const counter = process.env.FAKE_COUNTER;
    const n = counter && existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
    if (counter) writeFileSync(counter, String(n + 1));
    if (n < Number(process.env.FAKE_LOCKED_TIMES ?? 2)) {
      process.stderr.write("SQLiteError: database is locked (SQLITE_BUSY_RECOVERY)\n");
      process.exit(1);
    }
    process.stdout.write(payload + "\n");
    process.exit(0);
    break;
  }
  case "transient-then-json": {
    const counter = process.env.FAKE_COUNTER;
    const n = counter && existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
    if (counter) writeFileSync(counter, String(n + 1));
    if (n < Number(process.env.FAKE_TRANSIENT_TIMES ?? 1)) {
      const msgs = {
        ratelimit: "Too many server requests, please try again later (429 Too Many Requests)",
        timeout: "Request timed out: GET https://drive-api.proton.me/core/v4/users",
        reset: "read ECONNRESET",
        retryafter: "429 Too Many Requests, Retry-After: 30",
        notfound: "Item not found: /nope",
      };
      process.stderr.write((msgs[process.env.FAKE_TRANSIENT_KIND ?? "ratelimit"]) + "\n");
      process.exit(1);
    }
    process.stdout.write(payload + "\n");
    process.exit(0);
    break;
  }
  case "tree": {
    if (argv[0] === "filesystem" && argv[1] === "list") {
      const tree = JSON.parse(readFileSync(process.env.FAKE_TREE, "utf8"));
      const entry = tree[argv[2]];
      const ms = Number(process.env.FAKE_SLEEP_MS ?? 0);
      setTimeout(() => {
        if (entry === undefined) { process.stderr.write(`Item not found: ${argv[2]}\n`); process.exit(1); }
        if (typeof entry === "string") { process.stderr.write(entry + "\n"); process.exit(1); }
        process.stdout.write(JSON.stringify(entry) + "\n");
        process.exit(0);
      }, ms);
    } else {
      process.stdout.write("[]\n");
      process.exit(0);
    }
    break;
  }
  case "fs": {
    if (argv[0] === "filesystem" && argv[1] === "info") {
      const info = JSON.parse(readFileSync(process.env.FAKE_INFO, "utf8"));
      if (info[argv[2]] === undefined) { process.stderr.write(`Node not found: ${argv[2]}\n`); process.exit(1); }
      process.stdout.write(JSON.stringify(info[argv[2]]) + "\n");
    } else if (argv[0] === "filesystem" && argv[1] === process.env.FAKE_FAIL_CMD) {
      process.stderr.write("boom\n");
      process.exit(1);
    } else {
      process.stdout.write("[]\n");
    }
    process.exit(0);
    break;
  }
  case "drive": {
    const statePath = process.env.FAKE_STATE;
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const nodes = state.nodes;
    const csv = (v) => new Set((v ?? "").split(",").filter(Boolean));
    const failUids = csv(process.env.FAKE_FAIL_UIDS);
    const lieUids = csv(process.env.FAKE_LIE_UIDS);
    const save = () => writeFileSync(statePath, JSON.stringify(state));
    const fail = (msg) => { process.stderr.write(msg + "\n"); process.exit(1); };
    const out = (v) => { process.stdout.write(JSON.stringify(v) + "\n"); process.exit(0); };
    const live = (n) => n.trashTime === undefined;
    const splitPath = (p) => {
      const parts = []; let cur = "";
      for (let i = 1; i < p.length; i++) {
        if (p[i] === "/" && p[i - 1] !== "\\") { parts.push(cur); cur = ""; } else cur += p[i];
      }
      parts.push(cur);
      return parts.map((x) => x.replace(/\\\//g, "/"));
    };
    const kids = (uid) => Object.values(nodes).filter((n) => n.parentUid === uid && live(n));
    const resolve = (p) => {
      const parts = splitPath(p);
      if (parts[0] === "trash") return parts.length === 2 ? Object.values(nodes).find((n) => !live(n) && n.name === parts[1]) : undefined;
      if (parts[0] !== "my-files") return undefined;
      let cur = nodes.root;
      for (const part of parts.slice(1)) {
        cur = kids(cur.uid).find((n) => n.name === part);
        if (!cur) return undefined;
      }
      return cur;
    };
    const asItem = (n) => ({
      uid: n.uid, parentUid: n.parentUid, name: { ok: true, value: n.name }, type: n.type,
      activeRevision: n.type === "file" ? { claimedSize: n.size ?? 0 } : undefined,
      ...(n.trashTime ? { trashTime: n.trashTime } : {}),
    });
    const err = (name, code, message) => ({ name, code, message });
    const [group, sub, ...rest] = argv.filter((a) => a !== "--json");
    if (group !== "filesystem") out([]);
    if (sub === "list") {
      const p = rest[0];
      if (p === "/") out([{ path: "/my-files" }, { path: "/trash" }]);
      if (p === "/trash") out(Object.values(nodes).filter((n) => !live(n)).map(asItem));
      const node = resolve(p);
      if (!node || node.type !== "folder") fail(`Item not found: ${p}`);
      out(kids(node.uid).map(asItem));
    } else if (sub === "info") {
      const node = resolve(rest[0]);
      if (!node) fail(`Node not found: ${rest[0]}`);
      out(asItem(node));
    } else if (sub === "trash") {
      const targets = rest.map((p) => resolve(p) ?? fail(`Item not found: ${p}`));
      for (const n of targets) n.trashTime = "2026-11-19T10:00:00Z";
      save();
      out(targets.map((n) => ({ uid: n.uid, ok: true })));
    } else if (sub === "restore") {
      const targets = rest.map((p) => resolve(p) ?? fail(`Item not found: ${p}`));
      const results = targets.map((n) => {
        if (failUids.has(n.uid)) return { uid: n.uid, ok: false, error: err("APICodeError", 2999, "injected failure") };
        if (lieUids.has(n.uid)) return { uid: n.uid, ok: true };
        const parent = nodes[n.parentUid];
        if (!parent || !live(parent)) return { uid: n.uid, ok: false, error: err("APICodeError", 2511, "parent in trash") };
        if (kids(parent.uid).some((k) => k.name === n.name)) return { uid: n.uid, ok: false, error: err("NodeWithSameNameExistsValidationError", 2500, "name taken") };
        delete n.trashTime;
        return { uid: n.uid, ok: true };
      });
      save();
      out(results);
    } else if (sub === "move") {
      const dstPath = rest[rest.length - 1];
      const dst = resolve(dstPath);
      if (!dst || dst.type !== "folder") fail(`Item not found: ${dstPath}`);
      const targets = rest.slice(0, -1).map((p) => resolve(p) ?? fail(`Item not found: ${p}`));
      const results = targets.map((n) => {
        if (failUids.has(n.uid)) return { uid: n.uid, ok: false, error: err("APICodeError", 2999, "injected failure") };
        if (lieUids.has(n.uid)) return { uid: n.uid, ok: true };
        if (kids(dst.uid).some((k) => k.name === n.name)) return { uid: n.uid, ok: false, error: err("NodeWithSameNameExistsValidationError", 2500, "name taken") };
        n.parentUid = dst.uid;
        return { uid: n.uid, ok: true };
      });
      save();
      out(results);
    } else if (sub === "rename") {
      const node = resolve(rest[0]);
      if (!node) fail(`Item not found: ${rest[0]}`);
      if (kids(node.parentUid).some((k) => k.name === rest[1])) fail(`NodeWithSameNameExistsValidationError: ${rest[1]}`);
      node.name = rest[1];
      save();
      out(asItem(node));
    } else {
      out([]);
    }
    break;
  }
  case "size-legacy":
    // CLI 0.8.x has no `filesystem size`: unknown subcommand, usage text, exit 1.
    if (argv[0] === "filesystem" && argv[1] === "size") {
      process.stderr.write("error: unknown command 'size'\nUsage: proton-drive filesystem [options] [command]\n");
      process.exit(1);
    }
    process.stdout.write("[]\n");
    process.exit(0);
    break;
  case "ok-false-results":
    process.stdout.write(JSON.stringify([{ uid: "u1", ok: false, error: { name: "NodeWithSameNameExistsValidationError", code: 2500 } }]) + "\n");
    process.exit(0);
    break;
  default:
    process.stderr.write(`fake-cli: unknown FAKE_MODE ${mode}\n`);
    process.exit(3);
}
