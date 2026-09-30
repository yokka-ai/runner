import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

/**
 * The runner protocol (PROTOCOL.md), as plain function references. The runner never imports the app's
 * code, so this file and PROTOCOL.md are the whole contract.
 */
export const PROTOCOL = 1;
export const VERSION = "0.1.0";

const fn = anyApi.runner;

export type AgentId = "claude-code" | "codex";
export type RunStatus =
  | "queued"
  | "starting"
  | "launched"
  | "running"
  | "paused"
  | "waiting_input"
  | "waiting_approval"
  | "handed_off"
  | "done"
  | "released"
  | "cancelled"
  | "failed"
  | "lost";

export type WorkRun = {
  runId: string;
  attempt: number;
  status: RunStatus;
  agent: AgentId | "cursor" | null;
  projectId: string;
  ref: string;
  title: string;
  workspaceMode: "in_place" | "worktree" | null;
  clientSessionId: string | null;
  cancel: boolean;
  handOff: boolean;
  /** Pause asked for on the board; cleared to resume. */
  pause: boolean;
  /** Files the agent attached by path: read `path` (relative to the run's folder) and PUT it to `uploadUrl`. */
  uploads?: { _id: string; path: string; uploadUrl: string }[];
};

export type Work = { revoked: boolean; runs: WorkRun[] };

export type Hello = {
  runnerId: string;
  name: string;
  owner: string;
  workspace: { name: string; slug: string };
  appUrl: string;
  protocol: number;
  heartbeatMs: number;
  projects: { _id: string; name: string; slug: string; cardPrefix: string }[];
};

export type Claim =
  | { ok: false; reason: string }
  | {
      ok: true;
      attempt: number;
      prompt: string;
      launchCode: string;
      ref: string;
      projectId: string;
      agent: AgentId;
      workspaceMode: "in_place" | "worktree" | null;
      mcp: { url: string; link: string | null; token: string };
    };

export type RunUpdate = {
  status?: RunStatus;
  clientSessionId?: string;
  openUrl?: string;
  note?: string;
  summary?: string;
  git?: { branch?: string; worktree: boolean; ahead?: number; dirty?: number };
};

/** One-shot calls for the CLI's commands (login, map, status). */
export function httpClient(server: string) {
  const c = new ConvexHttpClient(server);
  return {
    loginStart: (args: { name: string; machine: string; platform: string; version: string }) =>
      c.action(fn.loginStart, args) as Promise<{
        userCode: string;
        deviceCode: string;
        verifyUrl: string;
        intervalMs: number;
        expiresAt: number;
      }>,
    loginPoll: (deviceCode: string) =>
      c.action(fn.loginPoll, { deviceCode }) as Promise<
        | { status: "pending" | "denied" | "expired" }
        | { status: "approved"; token: string; runnerId: string; workspace: { name: string; slug: string } }
      >,
  };
}

/** The live connection the daemon holds: a websocket to the deployment, outbound only. */
export function liveClient(server: string, token: string) {
  const c = new ConvexClient(server);
  return {
    close: () => c.close(),
    hello: (args: {
      agents?: { agent: AgentId; version?: string; problem?: string }[];
      projects: { projectId: string; mode: "in_place" | "worktree" }[];
      maxConcurrent: number;
    }) => c.mutation(fn.hello, { token, version: VERSION, protocol: PROTOCOL, ...args }) as Promise<Hello>,
    onWork: (cb: (work: Work) => void, onError: (err: Error) => void) =>
      c.onUpdate(fn.work, { token }, (w) => cb(w as Work), onError),
    claim: (runId: string) => c.action(fn.claim, { token, runId }) as Promise<Claim>,
    update: (runId: string, attempt: number, update: RunUpdate) =>
      c.mutation(fn.update, { token, runId, attempt, ...update }) as Promise<{ ok: boolean }>,
    heartbeat: (runs: { runId: string; attempt: number }[]) =>
      c.mutation(fn.heartbeat, { token, runs }) as Promise<{ stop: string[] }>,
    uploaded: (runId: string, attempt: number, uploadId: string, error?: string) =>
      c.mutation(fn.uploaded, { token, runId, attempt, uploadId, ...(error ? { error } : {}) }) as Promise<{
        ok: boolean;
      }>,
  };
}

export type Live = ReturnType<typeof liveClient>;
