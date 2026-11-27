const CLI_DOWNLOAD_URL = "https://proton.me/download/drive/cli/index.html";
const CLI_SETTING = 'open Claude Desktop > Settings > Extensions > Proton Drive and set "proton-drive CLI path"';

export class DriveCliNotFoundError extends Error {
  /** `configured`: the program that failed to start; omitted when no CLI was found anywhere. */
  constructor(configured?: { path: string; exists: boolean }) {
    const fix =
      `${CLI_SETTING} to the full path printed by this Terminal command: \`which proton-drive\` ` +
      "(or clear the field to search automatically), then restart Claude. Outside the extension, the same setting is the PROTON_DRIVE_BIN environment variable.";
    super(
      configured
        ? `${configured.exists
            ? `proton-drive CLI cannot be run: "${configured.path}" must be the program file itself (not a folder) with permission to run`
            : `proton-drive CLI not found: "${configured.path}" does not exist`}. To fix it, ${fix}`
        : "proton-drive CLI not found (looked in PATH, ~/.local/bin, /opt/homebrew/bin and /usr/local/bin). " +
          `Install it from ${CLI_DOWNLOAD_URL}. If it is already installed, ${fix}`
    );
    this.name = "DriveCliNotFoundError";
  }
}

export class DriveCliError extends Error {
  constructor(
    message: string,
    public readonly stderr: string = "",
    /** A change was cut off part way (timeout, cancel): what it applied is unknown. */
    public readonly interrupted: boolean = false
  ) {
    super(message);
    this.name = "DriveCliError";
  }
}

export class DriveNotAuthenticatedError extends Error {
  constructor(command = "proton-drive auth login") {
    super(
      `Not authenticated: you are not signed in to Proton Drive. Open Terminal, run \`${command}\`, finish signing in, then try again.`
    );
    this.name = "DriveNotAuthenticatedError";
  }
}

export class DriveParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveParseError";
  }
}

/** A destructive/outward gate refused because confirmed=true was missing. The message is shown to the model unchanged. */
export class NeedsConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeedsConfirmationError";
  }
}
