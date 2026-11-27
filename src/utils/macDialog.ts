// The native macOS approval dialog, for a client that cannot ask the user itself. Only osascript's answer to a dialog on the
// screen can approve: the program path and the script are constants, and everything shown is passed as an argument, so no
// file name or setting can change what runs. See THREAT_MODEL.md.
import { execFile, type ExecFileException, type ExecFileOptionsWithStringEncoding } from "node:child_process";

export const OSASCRIPT = "/usr/bin/osascript";
export const DIALOG_TITLE = "Proton Drive (via your AI assistant)";
// argv: 1 title, 2 seconds, 3 text. The title comes first so the text can never be read as an osascript option.
// "Don't Allow" is the default and the cancel button: Return and Escape both refuse.
export const DIALOG_SCRIPT = [
  "on run argv",
  `set answer to display dialog (item 3 of argv) with title (item 1 of argv) buttons {"Don't Allow", "Allow"} default button "Don't Allow" cancel button "Don't Allow" with icon caution giving up after ((item 2 of argv) as integer)`,
  "return (button returned of answer) & tab & ((gave up of answer) as text)",
  "end run",
].join("\n");

/** "error" means the user could not be asked (no GUI session, osascript failed); "timeout" means our own backstop killed it. */
export type DialogAnswer = "accept" | "decline" | "gaveup" | "aborted" | "timeout" | "error";

export type DialogExec = (
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => { kill(signal?: NodeJS.Signals): unknown };

export function nativeDialogEnabled(env: Record<string, string | undefined>, platform: NodeJS.Platform): boolean {
  return platform === "darwin" && !["0", "false", "off", "no"].includes((env.PROTON_DRIVE_DIALOG ?? "").trim().toLowerCase());
}

/** PROTON_DRIVE_DIALOG_TIMEOUT in seconds, clamped to 10..110; 55 when unset or not a number. */
export function dialogTimeoutSeconds(env: Record<string, string | undefined>): number {
  const raw = (env.PROTON_DRIVE_DIALOG_TIMEOUT ?? "").trim();
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) ? Math.min(110, Math.max(10, Math.round(n))) : 55;
}

function readAnswer(error: ExecFileException | null, stdout: string, stderr: string): DialogAnswer {
  if (error) {
    if (error.killed) return "timeout";
    // Only stderr is read: error.message repeats the command line, which holds file names.
    return error.code === 1 && /\(-128\)\s*$/.test(stderr) ? "decline" : "error";
  }
  const out = stdout.replace(/\n$/, "");
  if (out === "Allow\tfalse") return "accept";
  if (out === "Don't Allow\tfalse") return "decline";
  return /^(Allow|Don't Allow)?\ttrue$/.test(out) ? "gaveup" : "error";
}

/** Shows the dialog and waits for the answer. `exec` is the test seam; no environment variable or setting replaces it. */
export function askMacDialog(text: string, opts: { seconds: number; signal?: AbortSignal; exec?: DialogExec }): Promise<DialogAnswer> {
  const { seconds, signal, exec = execFile as DialogExec } = opts;
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    let child: ReturnType<DialogExec> | undefined;
    // A dialog must not stay on screen after a cancelled request, or after the server is gone. Done here because execFile's
    // own `signal` option ignores killSignal.
    const kill = () => { child?.kill("SIGKILL"); };
    try {
      child = exec(
        OSASCRIPT, ["-e", DIALOG_SCRIPT, DIALOG_TITLE, String(seconds), text],
        { encoding: "utf8", killSignal: "SIGKILL", timeout: (seconds + 10) * 1000, maxBuffer: 64 * 1024 },
        (error, stdout, stderr) => {
          process.removeListener("exit", kill);
          signal?.removeEventListener("abort", kill);
          resolve(signal?.aborted ? "aborted" : readAnswer(error, stdout, stderr));
        },
      );
      process.once("exit", kill);
      signal?.addEventListener("abort", kill, { once: true });
    } catch {
      resolve("error");
    }
  });
}
