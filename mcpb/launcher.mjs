// MCPB entry point. Claude Desktop may pass an unset optional user_config value
// as "" (or leave the "${user_config.*}" placeholder). The server treats an empty
// PROTON_DRIVE_BIN as a real (broken) binary path, so drop such values first.
for (const key of ["PROTON_DRIVE_BIN", "PROTON_DRIVE_SYNC_PATH", "PROTON_DRIVE_REMOTE_ROOTS", "PROTON_DRIVE_AUDIT_LOG"]) {
  const v = process.env[key];
  if (v !== undefined && (v.trim() === "" || v.includes("${user_config."))) delete process.env[key];
}
// Boolean user_config arrives as "true"/"false": only true enables the opt-in persistent
// index (the server itself accepts "1"/"true"); anything else must leave it unset.
const idx = process.env.PROTON_DRIVE_INDEX;
if (idx !== undefined) {
  if (idx.trim().toLowerCase() === "true" || idx.trim() === "1") process.env.PROTON_DRIVE_INDEX = "1";
  else delete process.env.PROTON_DRIVE_INDEX;
}
// The same for the guard-layer booleans: only true switches them on, and the server never sees "false"
// (an unknown PROTON_DRIVE_MODE would be read as readonly).
for (const [key, on] of [["PROTON_DRIVE_MODE", "readonly"], ["PROTON_DRIVE_SNAPSHOT_BEFORE_OVERWRITE", "1"]]) {
  const v = process.env[key];
  if (v !== undefined) {
    if (v.trim().toLowerCase() === "true") process.env[key] = on;
    else delete process.env[key];
  }
}
// index.js only auto-starts when it is the entry script, so call main() explicitly.
const { main } = await import("./dist/index.js");
await main();
