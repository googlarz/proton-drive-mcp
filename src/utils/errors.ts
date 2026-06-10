export class DriveCliNotFoundError extends Error {
  constructor() {
    super(
      "proton-drive CLI not found in PATH. " +
        "Download it from https://proton.me/download/drive/cli/index.html and ensure it is in your PATH."
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
  constructor(raw: string) {
    super(`Failed to parse CLI output as JSON. Raw output: ${raw.slice(0, 200)}`);
    this.name = "DriveParseError";
  }
}
