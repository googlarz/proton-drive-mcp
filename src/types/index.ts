export type DriveFileType = "file" | "folder";

export interface DriveFile {
  name: string;
  path: string;
  type: DriveFileType;
  size?: number;
  modifiedAt?: string;
  mimeType?: string;
}

export interface ShareStatus {
  path: string;
  isShared: boolean;
  members: ShareMember[];
  shareUrl?: string;
}

export interface ShareMember {
  email: string;
  role: ShareRole;
  addedAt?: string;
  // "pending" covers both Proton and non-Proton invitations that haven't
  // been accepted yet (e.g. inviting a Gmail address, which Proton files as
  // a nonProtonInvitation rather than a member). Confirmed live: without
  // this, a real invite to a non-Proton email was completely invisible —
  // isShared reported true but members was empty.
  status: "accepted" | "pending";
}

export type ShareRole = "viewer" | "editor" | "admin";

export interface UploadResult {
  path: string;
  uploaded: number;
  skipped: number;
  failed: number;
}

export interface DownloadResult {
  path: string;
  localPath: string;
  downloaded: number;
  skipped: number;
  failed: number;
}

export interface AuthStatus {
  authenticated: boolean;
}

export interface DriveVersion {
  cli: string;
  sdk: string;
}

export interface DriveInvitation {
  uid: string;
  role: ShareRole;
  invitedByEmail: string;
  invitedAt?: string;
  nodeName: string;
  nodeType: DriveFileType;
}

export interface Album {
  name: string;
  photoCount: number;
  isShared: boolean;
  creationTime?: string;
}

export interface AlbumPhoto {
  nodeUid: string;
  // Populated only when photos_list_timeline is called with loadDetails=true.
  name?: string;
  mediaType?: string;
  creationTime?: string;
  totalStorageSize?: number;
  captureTime?: string;
  tags?: unknown[];
}

export interface PublicLink {
  url?: string;
  role?: ShareRole;
  expirationTime?: string;
}

export interface TransferSummary {
  transferredItems: number;
  transferredBytes: number;
  skippedItems: number;
  failedItems: number;
}

