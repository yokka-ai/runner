import type { AgentId } from "../api.ts";
import type { LedgerEntry } from "../ledger.ts";

/** What an agent session is doing, as the runner sees it. */
export type AgentState =
  /** Working on a turn. */
  | "working"
  /** Its turn ended; it's waiting for a message. */
  | "idle"
  /** Stuck on something only a person can do (a permission prompt, a sign-in). */
  | "blocked"
  /** Stopped on purpose. */
  | "stopped"
  /** The process died or the session is gone. */
  | "crashed";

export type Detected = { version?: string; problem?: string };

export type StartArgs = {
  runId: string;
  prompt: string;
  cwd: string;
  /** Shown in the agent's app and resume pickers: "YK-12 · r_7f3k2a". */
  name: string;
  mcp: { url: string; link: string | null; token: string };
  /** Where the adapter may keep per-run files (an MCP config). */
  dir: string;
};

export type SessionEvents = {
  /** A link to watch or continue the session became known. */
  openUrl?: (url: string) => void;
};

/** A running agent session the runner drives. */
export interface Session {
  /** The agent's own session or thread id. */
  readonly sessionId: string;
  /** For the ledger: Claude's short background id. */
  readonly shortId?: string;
  state(): Promise<AgentState>;
  /** Why it's blocked or crashed, when the adapter can tell. */
  blockedReason?(): Promise<string | undefined>;
  /** Stops the agent's work without losing its conversation. */
  pause(): Promise<void>;
  /** Wakes a paused session with `text` as its next message. */
  resume(text: string): Promise<void>;
  /** Ends the session for good. */
  stop(): Promise<void>;
  /** Lets go of the session so a person can continue it in the agent's app; returns where to open it. */
  handOff(): Promise<string | undefined>;
  /** Releases what the runner holds without ending the agent's session (runner shutting down). */
  detach(): Promise<void>;
}

export interface Adapter {
  readonly id: AgentId;
  readonly label: string;
  detect(): Promise<Detected>;
  start(args: StartArgs, events: SessionEvents): Promise<Session>;
  /** Picks a session back up after a runner restart; null when it can't (or it's gone). */
  adopt(entry: LedgerEntry, events: SessionEvents): Promise<Session | null>;
}
