import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { RUNNER_TOKEN } from "./config.ts";
import { log, messageOf, warn } from "./log.ts";
import { isLoopback, type RetryOptions, retry, withTimeout } from "./net.ts";
import {
  absent,
  array,
  boolean,
  type Infer,
  literal,
  nullable,
  number,
  object,
  parse,
  refine,
  SchemaError,
  string,
  union,
} from "./schema.ts";
import type { Usage } from "./usage.ts";
import { PROTOCOL, VERSION } from "./version.ts";

/**
 * The runner protocol (PROTOCOL.md): the `runner:*` functions on the deployment, called by name. The runner
 * never imports the app's code, so this file and PROTOCOL.md are the whole contract. Every answer is
 * checked against the schemas below before the runner acts on it.
 */

/** Yokka's own server. `login --server` or `YOKKA_SERVER` points the runner at another deployment. */
export const DEFAULT_SERVER = "https://sync.yokka.ai";

// What the server sends ---------------------------------------------------------------------------------

const agentId = literal("claude-code", "codex");
const workspaceMode = literal("in_place", "worktree");
const LAUNCH_CODE = /^r_[A-Za-z0-9]{4,16}$/;

function httpUrl(s: string) {
  try {
    const url = new URL(s);
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
  } catch {
    return false;
  }
}

const workRunSchema = object({
  runId: string,
  attempt: number,
  /** Kept as a string: a status added on the server later must not make the whole update unreadable. */
  status: string,
  agent: absent(string),
  projectId: string,
  ref: string,
  title: string,
  /** A one-run override of the project's mode, from the Start menu. */
  workspaceMode: absent(workspaceMode),
  clientSessionId: absent(string),
  cancel: boolean,
  handOff: boolean,
  /** Pause asked for on the board; cleared to resume. */
  pause: boolean,
  /** Files the agent attached by path: read `path` (relative to the run's folder) and PUT it to `uploadUrl`. */
  uploads: absent(array(object({ _id: string, path: string, uploadUrl: string }))),
});

const workSchema = object({ revoked: boolean, runs: array(workRunSchema) });

const helloSchema = object({
  runnerId: string,
  name: string,
  owner: string,
  workspace: object({ name: string, slug: string }),
  appUrl: string,
  protocol: number,
  heartbeatMs: refine(number, (n) => n >= 1_000 && n <= 10 * 60_000, "between 1 s and 10 min"),
  projects: array(object({ _id: string, name: string, slug: string, cardPrefix: string })),
});

const claimSchema = union(
  object({ ok: literal(false), reason: string }),
  object({
    ok: literal(true),
    attempt: number,
    prompt: string,
    launchCode: refine(string, (c) => LAUNCH_CODE.test(c), "a launch code (r_ and letters or digits)"),
    ref: string,
    projectId: string,
    /** Any agent name; the daemon turns down one it has no adapter for. */
    agent: absent(string),
    workspaceMode: absent(workspaceMode),
    mcp: object({
      url: refine(string, httpUrl, "an https:// URL"),
      link: nullable(refine(string, httpUrl, "an https:// URL")),
      token: string,
    }),
  }),
);

const okSchema = object({ ok: boolean });
const heartbeatSchema = object({ stop: array(string) });

const loginStartSchema = object({
  userCode: string,
  deviceCode: string,
  verifyUrl: string,
  intervalMs: refine(number, (n) => n >= 500 && n <= 60_000, "between 0.5 s and 60 s"),
  expiresAt: number,
});

const loginPollSchema = union(
  object({ status: literal("pending", "denied", "expired") }),
  object({
    status: literal("approved"),
    token: refine(string, (t) => RUNNER_TOKEN.test(t), "a runner token"),
    runnerId: string,
    workspace: object({ name: string, slug: string }),
  }),
);

export type AgentId = Infer<typeof agentId>;
export type WorkRun = Infer<typeof workRunSchema>;
export type Work = Infer<typeof workSchema>;
export type Hello = Infer<typeof helloSchema>;
export type Claim = Infer<typeof claimSchema>;
export type LoginStart = Infer<typeof loginStartSchema>;
export type LoginPoll = Infer<typeof loginPollSchema>;

export function isAgentId(value: string | undefined): value is AgentId {
  return value === "claude-code" || value === "codex";
}

// What the runner sends ---------------------------------------------------------------------------------

/** The statuses a runner may report (the rest come from the agent over MCP). */
export type RunStatus =
  | "launched"
  | "running"
  | "paused"
  | "waiting_approval"
  | "handed_off"
  | "done"
  | "failed"
  | "cancelled"
  | "lost";

const FINAL: ReadonlySet<RunStatus> = new Set(["done", "failed", "cancelled", "lost"]);

export type GitState = { branch?: string; worktree: boolean; ahead?: number; dirty?: number };

export type RunUpdate = {
  status?: RunStatus;
  clientSessionId?: string;
  openUrl?: string;
  note?: string;
  summary?: string;
  git?: GitState;
};

export type HelloArgs = {
  agents?: { agent: AgentId; version?: string; problem?: string }[];
  projects: { projectId: string; mode: "in_place" | "worktree" }[];
  maxConcurrent: number;
};

// Errors -----------------------------------------------------------------------------------------------

/** The `code` of an app error the server threw on purpose (`unauthenticated`, `invalid`…), if it was one. */
export function errorCode(err: unknown): string | undefined {
  if (!(err instanceof ConvexError)) return undefined;
  const data: unknown = err.data;
  if (typeof data === "object" && data !== null && "code" in data && typeof data.code === "string")
    return data.code;
  return undefined;
}

/** The sentence to show for an error: an app error's own message, otherwise the error's. */
export function errorMessage(err: unknown): string {
  if (err instanceof ConvexError) {
    const data: unknown = err.data;
    if (typeof data === "object" && data !== null && "message" in data && typeof data.message === "string")
      return data.message;
    if (typeof data === "string") return data;
  }
  return messageOf(err);
}

/**
 * Whether trying again could help: a network failure, a timeout or a server hiccup, but not an answer the
 * server gave on purpose (an app error) nor an answer the runner can't read (a protocol mismatch).
 */
export function isTransient(err: unknown) {
  return !(err instanceof ConvexError) && !(err instanceof SchemaError);
}

/** The runner token was revoked or its workspace is gone. */
export function isRevoked(err: unknown) {
  return errorCode(err) === "unauthenticated";
}

// Transports -------------------------------------------------------------------------------------------

/** How the client reaches the deployment; the real one is the Convex client, tests pass a fake. */
export type Transport = {
  mutation(name: string, args: Record<string, unknown>): Promise<unknown>;
  action(name: string, args: Record<string, unknown>): Promise<unknown>;
  subscribe(
    name: string,
    args: Record<string, unknown>,
    onUpdate: (value: unknown) => void,
    onError: (err: Error) => void,
  ): () => void;
  close(): Promise<void>;
};

/** Convex's own console logging, through the runner's redacting log. */
const convexLogger = {
  logVerbose: () => undefined,
  log: (...args: unknown[]) => log(args.map(messageOf).join(" ")),
  warn: (...args: unknown[]) => warn(args.map(messageOf).join(" ")),
  error: (...args: unknown[]) => warn(args.map(messageOf).join(" ")),
};

const ref = {
  query: (name: string) => makeFunctionReference<"query">(`runner:${name}`),
  mutation: (name: string) => makeFunctionReference<"mutation">(`runner:${name}`),
  action: (name: string) => makeFunctionReference<"action">(`runner:${name}`),
};

/** The live connection the daemon holds: one websocket to the deployment, outbound only. */
export function websocketTransport(server: string): Transport {
  const c = new ConvexClient(server, { logger: convexLogger, unsavedChangesWarning: false });
  return {
    mutation: (name, args) => c.mutation(ref.mutation(name), args),
    action: (name, args) => c.action(ref.action(name), args),
    subscribe: (name, args, onUpdate, onError) => {
      const unsubscribe = c.onUpdate(ref.query(name), args, onUpdate, onError);
      return () => unsubscribe();
    },
    close: () => c.close(),
  };
}

/** Plain HTTPS calls for one-off commands (sign-in), each with a deadline. */
export function httpTransport(server: string, timeoutMs = 30_000): Pick<Transport, "action"> {
  const c = new ConvexHttpClient(server, {
    logger: convexLogger,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  });
  return { action: (name, args) => c.action(ref.action(name), args) };
}

// Clients ----------------------------------------------------------------------------------------------

/** How long the runner waits for any one call before treating it as failed. */
export const CALL_TIMEOUT_MS = 30_000;
/** Claims mint a token and render a prompt: an action, so a little slower. */
const CLAIM_TIMEOUT_MS = 60_000;

const RETRY: RetryOptions = {
  attempts: 4,
  baseMs: 1_000,
  maxMs: 15_000,
  retryable: isTransient,
  onRetry: (err: unknown, attempt: number, waitMs: number) =>
    warn(`${errorMessage(err)}; trying again in ${Math.ceil(waitMs / 1000)} s (${attempt})`),
};

/** Sign-in calls for `login`. */
export function loginClient(transport: Pick<Transport, "action">, retryOptions: RetryOptions = RETRY) {
  return {
    loginStart: (args: { name: string; machine: string; platform: string; version: string }) =>
      retry(
        async () => parse(loginStartSchema, await transport.action("loginStart", args), "loginStart"),
        retryOptions,
      ),
    loginPoll: (deviceCode: string) =>
      retry(
        async () => parse(loginPollSchema, await transport.action("loginPoll", { deviceCode }), "loginPoll"),
        retryOptions,
      ),
  };
}

export type LoginClient = ReturnType<typeof loginClient>;

/**
 * The daemon's calls. Every call has a deadline. Only calls that are safe to repeat are retried: `hello` and
 * final status reports (a run that already ended ignores them). Claims never are: a claim that timed out may
 * still have gone through.
 */
export function liveClient(transport: Transport, token: string, retryOptions: RetryOptions = RETRY) {
  const call = async <T>(
    kind: "mutation" | "action",
    name: string,
    args: Record<string, unknown>,
    schema: (v: unknown, p: string) => T,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<T> => {
    const value = await withTimeout(transport[kind](name, { token, ...args }), timeoutMs, `runner:${name}`);
    return parse(schema, value, name);
  };
  const again = <T>(fn: () => Promise<T>) => retry(fn, retryOptions);
  return {
    close: () => transport.close(),
    hello: (args: HelloArgs) =>
      again(() => call("mutation", "hello", { version: VERSION, protocol: PROTOCOL, ...args }, helloSchema)),
    /** Subscribes to the runner's work; `onUpdate` only ever sees answers that passed the schema. */
    onWork: (onUpdate: (work: Work) => void, onError: (err: Error) => void) =>
      transport.subscribe(
        "work",
        { token },
        (value) => {
          try {
            onUpdate(parse(workSchema, value, "work"));
          } catch (err) {
            onError(err instanceof Error ? err : new Error(messageOf(err)));
          }
        },
        onError,
      ),
    claim: (runId: string) => call("action", "claim", { runId }, claimSchema, CLAIM_TIMEOUT_MS),
    update: (runId: string, attempt: number, update: RunUpdate) => {
      const send = () => call("mutation", "update", { runId, attempt, ...update }, okSchema);
      return update.status && FINAL.has(update.status) ? again(send) : send();
    },
    heartbeat: (runs: { runId: string; attempt: number }[]) =>
      call("mutation", "heartbeat", { runs }, heartbeatSchema),
    uploaded: (runId: string, attempt: number, uploadId: string, error?: string) =>
      call("mutation", "uploaded", { runId, attempt, uploadId, ...(error ? { error } : {}) }, okSchema),
    /** What the run's agent spent so far (protocol 3): running totals, which replace the last report. */
    usage: (runId: string, attempt: number, usage: Usage) =>
      call("mutation", "usage", { runId, attempt, ...usage }, okSchema),
  };
}

export type Live = ReturnType<typeof liveClient>;
