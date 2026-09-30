import type { DriveService } from "./drive.js";

/** One node of a walked Drive tree. Sizes are the real (claimed) sizes, not encrypted storage sizes. */
export interface WalkNode {
  path: string;
  uid: string;
  parentUid?: string;
  type: "file" | "folder";
  mediaType?: string;
  size?: number;
  storageSize?: number;
  /** Original local modification time (activeRevision.claimedModificationTime), ISO string. */
  mtime?: string;
  /** Upload/modification time on Drive, ISO string. */
  uploadedAt?: string;
  /** Uploader-claimed sha1 (unverified, present on only some files). */
  sha1?: string;
  isShared?: boolean;
  isSharedByUrl?: boolean;
}

export interface WalkOptions {
  maxDepth?: number;
  /** Hard cap on `fs list` calls (default 300). */
  maxCalls?: number;
  /** Parallel `fs list` calls (default 8, max 12). */
  concurrency?: number;
  /** Folder names skipped entirely (default: .git, node_modules). */
  exclude?: string[];
  /** Ignore the cache and re-walk. */
  refresh?: boolean;
  signal?: AbortSignal;
}

export interface WalkResult {
  root: string;
  nodes: WalkNode[];
  /** false when maxCalls/maxDepth/failures cut the walk short. */
  complete: boolean;
  callsMade: number;
  skipped: { path: string; reason: string }[];
  fromCache: boolean;
  ageMs: number;
}

/** Stub: implemented on feat130/walk. Other branches code against this signature. */
export async function walkTree(_svc: DriveService, _root: string, _opts: WalkOptions = {}): Promise<WalkResult> {
  throw new Error("walkTree is not implemented yet");
}

/** Drop cached walks that contain `path` (call after the server itself writes there). */
export function invalidatePath(_path: string): void {
  /* implemented on feat130/walk */
}
