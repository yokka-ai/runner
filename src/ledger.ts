import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "./config.ts";

/**
 * The runs this machine holds, kept on disk so a restarted runner can pick its sessions back up (Claude's
 * background sessions outlive the runner) or report the ones it lost.
 */
export type LedgerEntry = {
  runId: string;
  attempt: number;
  agent: "claude-code" | "codex";
  ref: string;
  launchCode: string;
  projectId: string;
  cwd: string;
  worktree: boolean;
  branch?: string;
  /** The agent's own id: Claude's short background id and session id, or Codex's thread id. */
  shortId?: string;
  sessionId?: string;
  startedAt: number;
};

const path = join(home, "runs.json");

export function readLedger(): LedgerEntry[] {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LedgerEntry[];
  } catch {
    return [];
  }
}

function write(entries: LedgerEntry[]) {
  mkdirSync(home, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
  renameSync(tmp, path);
}

export function putEntry(entry: LedgerEntry) {
  write([...readLedger().filter((e) => e.runId !== entry.runId), entry]);
}

export function dropEntry(runId: string) {
  write(readLedger().filter((e) => e.runId !== runId));
}
