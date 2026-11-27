// One sentence in everyday English for each gated operation: what happens, to which item, and the consequence. Built only
// from the validated Operation; names are escaped and quoted, so they cannot add lines or pass for the server's words.
import type { Operation } from "./approval.js";
import { showValueStrict } from "./text.js";

export function describeOperation(op: Operation): string {
  const v = { ...op.fields, ...(op.display ?? {}) };
  const quote = (x: string) => `"${showValueStrict(x, 60, 30).replace(/"/g, '\\"')}"`;
  /** The last part of a path, quoted; the whole path is in the details below the sentence. */
  const name = (key: string, otherwise = "an item") => {
    const x = v[key];
    return typeof x === "string" && x !== "" ? quote(x.replace(/\/+$/, "").split("/").pop() || x) : otherwise;
  };
  const whole = (key: string, otherwise = "another folder") => (typeof v[key] === "string" && v[key] !== "" ? quote(v[key] as string) : otherwise);
  const who = (key: string, otherwise = "a person") => (typeof v[key] === "string" && v[key] !== "" ? showValueStrict(v[key]) : otherwise);
  const items = (key: string, one = "item") => {
    const x = v[key];
    const n = Array.isArray(x) ? x.length : 0;
    return n === 1 ? `1 ${one}` : `${n || "several"} ${one}s`;
  };
  const replacing = ["fileConflictStrategy", "folderConflictStrategy", "conflictStrategy"].some((k) => v[k] === "replace");
  const removing = ["fileConflictStrategy", "folderConflictStrategy", "conflictStrategy"].some((k) => v[k] === "remove");
  const replaced = replacing ? " Items with the same name in Proton Drive may be replaced." : "";
  const localDelete = removing ? " Files or folders on this computer with the same name are deleted first. This cannot be undone." : "";

  const sentence = ((): string => {
    switch (op.tool) {
      case "drive_auth_logout": return "Sign this computer out of Proton Drive. Nothing works with your Drive until you sign in again.";
      case "drive_delete": return `Permanently delete ${v.path ? name("path") : name("item")} from the trash. This cannot be undone.`;
      case "drive_empty_trash": return "Permanently delete everything in the trash. This cannot be undone.";
      case "drive_share_invite": {
        const may = v.role === "admin" ? "view, change and share it" : v.role === "editor" ? "view and change it" : "view it";
        return `Invite ${who("email")} to ${name("path")}. They will be able to ${may}, and they get an email right away.`;
      }
      case "drive_share_revoke": return `Remove the access of ${who("email")} to ${name("path")}. They can no longer open it.`;
      case "drive_share_set_url": {
        const link = v.password === true ? "the link and the password" : "the link";
        const may = v.role === "editor" ? "view, download and change it" : "view and download it";
        return `${v.replacesExistingLink === true ? "Change the" : "Create a"} public link to ${name("path")}. Anyone with ${link} can ${may}.`;
      }
      case "drive_share_remove_url": return `Turn off the public link to ${name("path")}. The link stops working.`;
      case "drive_share_remove_all": return `Remove every member and pending invitation from ${name("path")}. A public link, if there is one, stays active.`;
      case "drive_share_leave": return `Leave the shared folder ${name("path")}. You lose your access to it.`;
      case "drive_invitation_accept": return `Accept the invitation from ${who("inviter", "someone")} to ${whole("invitedFolder", "a shared item")}. It is added to the items shared with you.`;
      case "drive_invitation_reject": return `Decline the invitation from ${who("inviter", "someone")} to ${whole("invitedFolder", "a shared item")}. You would need a new invitation to get access.`;
      case "photos_delete_album": return `Delete the album ${name("albumPath", "(unnamed)")}. This cannot be undone. Your own photos stay in your timeline.`;
      case "photos_remove_from_album": return `Remove the photo ${name("photoPath")} from the album ${name("albumPath", "(unnamed)")}.`;
      case "drive_bulk_move": return `Move ${items("moves")} into ${whole("destinationFolder")}.`;
      case "drive_bulk_trash": return `Move ${items("paths")} to the trash. You can restore them from the trash.`;
      case "drive_cleanup": return `Move ${items("trash", "redundant item")} (extra copies and empty folders) to the trash.`;
      case "drive_undo": {
        const n = (k: string) => (Array.isArray(v[k]) ? (v[k] as string[]).length : 0);
        return `Undo an earlier change: restore ${n("restore")} item(s) from the trash and move or rename ${n("moveBack")} item(s) back.`;
      }
      case "drive_upload": return `Upload ${name("localPath", "files")} from this computer to ${whole("remotePath", "Proton Drive")}.${replaced}`;
      case "drive_download": return `Download ${name("remotePath")} to ${whole("localPath", "a folder")} on this computer.${localDelete}`;
      case "photos_download": return `Download ${items("photoPaths", "photo")} to ${whole("localFolder", "a folder")} on this computer.${localDelete}`;
      case "drive_write_file": return v.overwritesExisting === true
        ? `Overwrite the file ${name("path")} with new content. Its current content is replaced.`
        : `Write the file ${name("path")} in Proton Drive.`;
      case "drive_copy": return `Copy ${name("sourcePath")} to ${whole("destinationPath")}.`;
      case "drive_move": return `Move ${name("sourcePath")} to ${whole("destinationPath")}.`;
      case "drive_mkdir": return `Create the folder ${name("path")}.`;
      case "drive_rename": return `Rename ${name("path")} to ${whole("newName", "a new name")}.`;
      case "drive_trash": return `Move ${name("path")} to the trash. You can restore it from the trash.`;
      case "drive_restore": return `Restore ${v.path ? name("path") : name("item")} from the trash.`;
      case "photos_create_album": return `Create the photo album ${name("name", "(unnamed)")}.`;
      case "photos_update_album": return `Change the photo album ${name("albumPath", "(unnamed)")}.`;
      case "photos_add_to_album": return `Add the photo ${name("photoPath")} to the album ${name("albumPath", "(unnamed)")}.`;
      case "photos_upload": return `Upload ${items("localPaths", "photo")} from this computer to Proton Photos.${replaced}`;
      default: return `Run ${showValueStrict(op.tool, 60, 30)} on your Proton Drive.`;
    }
  })();

  if (op.effect === "reversible-no-undo") return `${sentence} Automatic undo is not available; the items stay in the trash.`;
  // Sharing tools already say who is affected; anything else is "outward" because it touches a folder shared with the user.
  if (op.effect === "outward" && !/^drive_(share|invitation)_/.test(op.tool)) return `${sentence} Other people who share that folder are affected.`;
  return sentence;
}
