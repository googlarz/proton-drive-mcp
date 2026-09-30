export class DriveCliNotFoundError extends Error {
  constructor() {
    super(
      "proton-drive CLI not found in PATH. " +
        "Download it from https://proton.me/download/drive/cli/index.html and ensure it is in your PATH, " +
        "or set PROTON_DRIVE_BIN to its absolute path (e.g. ~/.local/bin/proton-drive; find it with `which proton-drive`). " +
        "Claude Desktop starts servers with a minimal PATH, so PROTON_DRIVE_BIN is usually needed there."
    );
    this.name = "DriveCliNotFoundError";
  }
}

export class DriveCliError extends Error {
  constructor(
    message: string,
    public readonly stderr: string = ""
  ) {
    super(message);
    this.name = "DriveCliError";
  }
}

export class DriveNotAuthenticatedError extends Error {
  constructor() {
    super(
      "Not authenticated. Run `proton-drive auth login` in your terminal first."
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
