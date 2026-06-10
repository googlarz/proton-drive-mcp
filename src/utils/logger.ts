const isMcp = process.env["PROTON_DRIVE_MCP"] === "1";

export const logger = {
  info: (...args: unknown[]) => {
    if (!isMcp) console.log("[INFO]", ...args);
    else process.stderr.write(`[INFO] ${args.join(" ")}\n`);
  },
  warn: (...args: unknown[]) => {
    process.stderr.write(`[WARN] ${args.join(" ")}\n`);
  },
  error: (...args: unknown[]) => {
    process.stderr.write(`[ERROR] ${args.join(" ")}\n`);
  },
};
