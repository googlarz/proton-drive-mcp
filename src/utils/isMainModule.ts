import { fileURLToPath } from "node:url";

/**
 * Returns true when this module is the direct entry point (i.e. the script
 * passed to `node`), false when it is being imported as a library.
 *
 * Equivalent to `require.main === module` in CommonJS.
 */
export function isMainModule(importMetaUrl: string): boolean {
  const entryPoint = process.argv[1];
  if (!entryPoint) return false;
  try {
    return fileURLToPath(importMetaUrl) === entryPoint;
  } catch {
    return false;
  }
}
