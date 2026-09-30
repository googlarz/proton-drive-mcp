import { validateRemotePath } from "./utils/validation.js";

// Prompts are plain instructions for the model. They may name tools that ship in
// the same release. `requires` lists the tools a prompt tells the model to call; the server
// hides a prompt when any of them is outside the active tool tier.
export const PROMPTS = [
  {
    name: "organise-folder",
    title: "Organise a Drive folder",
    description: "Survey a Proton Drive folder and propose a cleaner structure, applying it only after you approve.",
    requires: ["drive_tree", "drive_usage", "drive_bulk_move", "drive_trash"],
    arguments: [{ name: "path", description: "Absolute Drive path of the folder, e.g. /my-files/Documents.", required: true }],
  },
  {
    name: "find-files",
    title: "Find files in Drive",
    description: "Locate files in Proton Drive from a plain-language description.",
    requires: ["drive_search"],
    arguments: [{ name: "description", description: "What you are looking for, e.g. 'the 2024 tax PDF from my accountant'.", required: true }],
  },
  {
    name: "storage-audit",
    title: "Audit Drive storage",
    description: "Find what uses your Proton Drive space: biggest items, duplicates and trash, with a short action list.",
    requires: ["drive_usage", "drive_find_duplicates", "drive_list_trash"],
    arguments: [],
  },
  {
    name: "sharing-audit",
    title: "Audit Drive sharing",
    description: "Review what is shared from your Proton Drive and explain the risks.",
    requires: ["drive_sharing_audit"],
    arguments: [],
  },
] as const;

const TEXTS: Record<string, (a: Record<string, string>) => string> = {
  "organise-folder": (a) => {
    const path = validateRemotePath(a.path);
    return `Help me organise my Proton Drive folder ${path}.
1. Survey it with drive_tree and drive_usage. Do not change anything yet.
2. Propose a clearer folder structure and explain the reasoning briefly.
3. Show the concrete plan by calling drive_bulk_move WITHOUT confirmed, so it is a dry run, and present the result to me.
4. Wait for my explicit OK before running anything with confirmed=true. Apply only what I approved.
Never permanently delete anything; use drive_trash (reversible) if something must go, and ask first.`;
  },
  "find-files": (a) => {
    const description = a.description;
    if (!description.trim()) throw new Error("description must not be empty");
    return `Find files in my Proton Drive matching this description: ${description}
Use drive_search with the most selective name, extension and date filters the description suggests. If there are too many or no results, refine the filters and search again rather than guessing. Report the paths of the best matches with size and modified date, and say how confident you are.`;
  },
  "storage-audit": () => `Audit my Proton Drive storage.
Use drive_usage to find the largest folders and files, drive_find_duplicates to find redundant copies, and drive_list_trash to see what the trash holds. Finish with a short prioritised action list with estimated space saved. Do not delete or move anything; propose only.`,
  "sharing-audit": () => `Audit what I share from Proton Drive.
Use drive_sharing_audit to list shared folders, members, pending invitations and public links. Explain the risks in plain language (for example public links without a password, editors who no longer need access, stale invitations) and suggest what to tighten. Do not revoke anything without my explicit OK.`,
};

export function getPromptText(name: string, args: Record<string, unknown>): string | undefined {
  const def = PROMPTS.find((p) => p.name === name);
  if (!def) return undefined;
  const allowed = new Set<string>(def.arguments.map((x) => x.name));
  for (const k of Object.keys(args)) if (!allowed.has(k)) throw new Error(`Unknown argument '${k}'. Allowed: ${[...allowed].join(", ") || "(none)"}.`);
  for (const x of def.arguments) if (x.required && typeof args[x.name] !== "string") throw new Error(`Missing required argument '${x.name}' (string).`);
  return TEXTS[name](args as Record<string, string>);
}
