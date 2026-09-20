import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Returns true when this module is the direct entry point (i.e. the script
 * passed to `node`), false when it is being imported as a library.
 *
 * Equivalent to `require.main === module` in CommonJS.
 *
 * Compares real paths: under `npx`, a global install or node_modules/.bin,
 * process.argv[1] is the bin *symlink*, not dist/index.js itself. A plain string
 * comparison was false there, so the published server started, printed nothing
 * and exited 0 without ever serving MCP.
 */
export function isMainModule(importMetaUrl: string): boolean {
  const entryPoint = process.argv[1];
  if (!entryPoint) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(entryPoint);
  } catch {
    return false;
  }
}
