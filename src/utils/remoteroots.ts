import { delimiter } from "node:path";
import { validateRemotePath } from "./validation.js";
import { logger } from "./logger.js";

/**
 * PROTON_DRIVE_REMOTE_ROOTS: Drive path prefixes every remote path argument must stay inside.
 * null = not set (unrestricted). A set variable always restricts: an entry that is not a clean absolute path is
 * dropped with a warning, so a typo can only narrow access (all dropped = nothing is allowed), never widen it.
 */
export function parseRemoteRoots(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === "") return null;
  const roots: string[] = [];
  for (const entry of raw.split(delimiter)) {
    if (entry.trim() === "") continue;
    try {
      const root = validateRemotePath(entry);
      if (root.slice(1).includes("//")) throw new Error("empty path segment");
      roots.push(root);
    } catch (err) {
      logger.warn(`Ignoring invalid PROTON_DRIVE_REMOTE_ROOTS entry "${entry}": ${err instanceof Error ? err.message : String(err)}.`);
    }
  }
  if (roots.length === 0) logger.warn("PROTON_DRIVE_REMOTE_ROOTS has no valid entry: every Drive path will be refused.");
  return roots;
}

/**
 * `path` must already have passed validateRemotePath (absolute, no '.'/'..' segments, no trailing slash).
 * Matches whole segments, case-sensitively: /my-files/AB is not inside /my-files/A, and a different-case spelling is
 * refused rather than guessed at. A path with an empty segment ("//") is refused: the CLI would receive it verbatim.
 * strict: the root folder itself does not count (rename/move/trash of a root would take it out of scope).
 */
export function pathInRoots(path: string, roots: string[], strict = false): boolean {
  if (path.slice(1).includes("//")) return false;
  return roots.some((root) => {
    if (root === "/") return !strict || path !== "/";
    return path.startsWith(root + "/") || (!strict && path === root);
  });
}
