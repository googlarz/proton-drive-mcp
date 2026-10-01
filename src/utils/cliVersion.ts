/** CLI major.minor this server is tested against (live-tested: CLI 0.8.0, SDK js 0.21.0). */
export const TESTED_CLI = "0.8";
export const ISSUES_URL = "https://github.com/googlarz/proton-drive-mcp/issues";

/** Extracts the CLI's "major.minor" from `proton-drive version` output ("Proton Drive CLI cli-drive@0.8.0+abc"), or undefined. */
export function parseCliMajorMinor(text: string): string | undefined {
  const m = text.match(/Proton Drive CLI\s+\S*?(\d+\.\d+)\.\d+/);
  return m?.[1];
}

/** Returns a warning message when the CLI version differs from the tested one or is unreadable; undefined when it matches. */
export function cliCompatWarning(text: string): string | undefined {
  const mm = parseCliMajorMinor(text);
  if (!mm) return `Could not read the proton-drive CLI version. Tested with ${TESTED_CLI}.x; behaviour of other versions is unverified — report issues at ${ISSUES_URL}`;
  if (mm !== TESTED_CLI) return `proton-drive CLI ${mm}.x found. Tested with ${TESTED_CLI}.x; behaviour of other versions is unverified — report issues at ${ISSUES_URL}`;
  return undefined;
}
