// Starts the built server with an INJECTED dialog runner: osascript is never run. The injection is a parameter of main(), so
// only code that imports the server can use it. FAKE_DIALOG* are read here, by this test script, never by the server.
import "./no-dialog.mjs"; // guard first; the env value it sets is restored below for the server under test
import { appendFileSync } from "node:fs";

process.env.PROTON_DRIVE_DIALOG = process.env.FAKE_DIALOG_ENV ?? "1";
const { main } = await import("../../dist/index.js");

const exec = (file, args, options, callback) => {
  appendFileSync(process.env.FAKE_DIALOG_LOG, JSON.stringify({ file, args }) + "\n");
  const mode = process.env.FAKE_DIALOG ?? "allow";
  const done = (err, out = "", errOut = "") => setImmediate(callback, err, out, errOut);
  // "pending": nobody answers; being killed delivers a late Allow, which must not count.
  if (mode === "pending") {
    const open = setInterval(() => {}, 1000);
    return { kill() { appendFileSync(process.env.FAKE_DIALOG_LOG, JSON.stringify({ event: "killed" }) + "\n"); clearInterval(open); done(null, "Allow\tfalse\n"); } };
  }
  if (mode === "allow") done(null, "Allow\tfalse\n");
  else if (mode === "deny") done(Object.assign(new Error("failed"), { code: 1 }), "", "0:1: execution error: User cancelled. (-128)\n");
  else if (mode === "gaveup") done(null, "\ttrue\n");
  else done(Object.assign(new Error("failed"), { code: 1 }), "", "0:1: execution error: No user interaction allowed. (-1713)\n");
  return { kill() {} };
};

await main({ dialog: { platform: process.env.FAKE_PLATFORM ?? "darwin", exec } });
