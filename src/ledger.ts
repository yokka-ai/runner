import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateJson } from "./config.ts";
import { runnerHome } from "./env.ts";
import { warn } from "./log.ts";
import {
  anything,
  array,
  boolean,
  type Infer,
  literal,
  number,
  object,
  optional,
  parse,
  string,
} from "./schema.ts";

/**
 * The runs this machine holds, kept on disk so a restarted runner can pick its sessions back up (Claude's
 * background sessions outlive the runner) or report the ones it lost.
 */
const entrySchema = object({
  runId: string,
  attempt: number,
  agent: literal("claude-code", "codex"),
  ref: string,
  launchCode: string,
  projectId: string,
  cwd: string,
  worktree: boolean,
  branch: optional(string),
  /** The agent's own id: Claude's short background id and session id, or Codex's thread id. */
  shortId: optional(string),
  sessionId: optional(string),
  /** Where the run's MCP server lives, which is also where its uploads may go (`net.uploadUrlAllowed`). */
  mcpUrl: optional(string),
  /** Paused from the board: its session is stopped on purpose, so a restarted runner still picks it up. */
  paused: optional(boolean),
  startedAt: number,
});

export type LedgerEntry = Infer<typeof entrySchema>;

function ledgerPath() {
  return join(runnerHome(), "runs.json");
}

/** The ledger's entries. An unreadable file or entry is skipped with a warning rather than stopping the runner. */
export function readLedger(): LedgerEntry[] {
  const path = ledgerPath();
  if (!existsSync(path)) return [];
  let list: unknown[];
  try {
    list = parse(array(anything), JSON.parse(readFileSync(path, "utf8")), "ledger");
  } catch {
    warn(`${path} is unreadable; starting with an empty list of runs.`);
    return [];
  }
  const entries: LedgerEntry[] = [];
  for (const [i, item] of list.entries()) {
    try {
      entries.push(parse(entrySchema, item, `ledger[${i}]`));
    } catch (err) {
      warn(`Skipping a run in ${path}: ${(err as Error).message}`);
    }
  }
  return entries;
}

function write(entries: LedgerEntry[]) {
  writePrivateJson(ledgerPath(), entries);
}

export function putEntry(entry: LedgerEntry) {
  write([...readLedger().filter((e) => e.runId !== entry.runId), entry]);
}

/** Records whether a run is paused, keeping the rest of its entry. */
export function setPaused(runId: string, paused: boolean) {
  const entries = readLedger();
  if (entries.some((e) => e.runId === runId))
    write(entries.map((e) => (e.runId === runId ? { ...e, paused } : e)));
}

export function dropEntry(runId: string) {
  const entries = readLedger();
  if (entries.some((e) => e.runId === runId)) write(entries.filter((e) => e.runId !== runId));
}
