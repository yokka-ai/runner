import type { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { claudeAdapter } from "./adapters/claude.ts";
import { codexAdapter } from "./adapters/codex.ts";
import type { Adapter, Detected, Session, SessionEvents } from "./adapters/types.ts";
import {
  type AgentId,
  type Claim,
  errorMessage,
  type Hello,
  isAgentId,
  isRevoked,
  type Live,
  liveClient,
  type RunStatus,
  type RunUpdate,
  type Transport,
  type Work,
  type WorkRun,
  websocketTransport,
} from "./api.ts";
import { type Config, type ProjectConfig, projectModes } from "./config.ts";
import { runnerHome } from "./env.ts";
import { dropEntry, type LedgerEntry, putEntry, readLedger, setPaused } from "./ledger.ts";
import { log, warn } from "./log.ts";
import { backoff, serverUrl, uploadUrlAllowed } from "./net.ts";
import { killAll, killAllNow } from "./proc.ts";
import { SchemaError } from "./schema.ts";
import { PROTOCOL } from "./version.ts";
import { cleanup, gitState, isInside, PrepareError, prepare } from "./workspace.ts";

/**
 * The runner's main loop (PROTOCOL.md). The server holds the desired state; the runner makes this machine
 * match it and reports what's really there:
 * - a live subscription to its work: queued runs to take, runs to pause, resume, hand off or stop;
 * - a poll of each agent session's real state, reported when it changes. Anything that needs a person (a
 *   question, a permission prompt) is answered in the agent's own app; the runner only flags the card;
 * - a heartbeat listing the runs it holds, so the server can lose the ones it doesn't and tell it which to
 *   stop.
 */

export const POLL_MS = 4_000;
/** What a paused agent is told when it's resumed. */
export const RESUME_PROMPT = "Continue where you left off.";
/** Uploads go through a Convex HTTP action, which takes request bodies up to 20 MB. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 2 * 60_000;
/** How long shutting down may take before the runner stops waiting and ends its children outright. */
const SHUTDOWN_TIMEOUT_MS = 15_000;
/** Resubscribing after the server failed the work query: backoff bounds. */
const RESUBSCRIBE_BASE_MS = 1_000;
const RESUBSCRIBE_MAX_MS = 60_000;

type Local = {
  runId: string;
  attempt: number;
  agent: AgentId;
  ref: string;
  title: string;
  launchCode: string;
  projectId: string;
  cwd?: string;
  worktree: boolean;
  branch?: string;
  mcpUrl?: string;
  session?: Session;
  /** The last status this runner reported (the server may know more, from MCP). */
  reported?: RunStatus;
  /** A step is in flight (starting, pausing, resuming, handing off): the poll leaves it alone. */
  busy: boolean;
  /** The agent is paused (its session stopped on purpose): the poll leaves it alone until it's resumed. */
  paused: boolean;
  handedOff: boolean;
  ending: boolean;
  /** The run's status on the board, which also knows what the agent did over MCP. */
  serverStatus?: string;
  uploadsSeen: Set<string>;
};

export type DaemonDeps = {
  live: Live;
  adapters: Map<AgentId, Adapter>;
  detected: Map<AgentId, Detected>;
  hello: Hello;
  /** The deployment's URL, which bounds where uploads may go. */
  server: string;
  fetch?: typeof fetch;
};

export class Daemon {
  private runs = new Map<string, Local>();
  private claiming = new Set<string>();
  /**
   * Queued runs a claim was tried for since the last work update: the server said no (a limit, say) or the
   * call failed. They're tried again on the next update, never in a loop, so a refusal can't turn into a
   * stream of claims.
   */
  private tried = new Set<string>();
  private work: Work = { revoked: false, runs: [] };
  private timers = new Set<NodeJS.Timeout>();
  private unsubscribe: (() => void) | null = null;
  private workFailures = 0;
  private stopped = false;
  private stopping: Promise<void> | undefined;
  onFatal: (message: string) => void = () => undefined;

  private readonly config: Config;
  private readonly deps: DaemonDeps;

  constructor(config: Config, deps: DaemonDeps) {
    this.config = config;
    this.deps = deps;
  }

  private get live() {
    return this.deps.live;
  }

  /** The runs this machine holds right now, for status and tests. */
  held() {
    return [...this.runs.values()].map((r) => ({ runId: r.runId, attempt: r.attempt, ref: r.ref }));
  }

  start() {
    this.subscribe();
    this.every(this.deps.hello.heartbeatMs, () => this.heartbeat(), true);
    this.every(POLL_MS, () => this.poll());
  }

  /** Runs `task` every `ms` after the previous run finished, so a slow one never piles up. */
  private every(ms: number, task: () => Promise<void>, now = false) {
    const tick = () => {
      if (this.stopped) return;
      this.background(
        task().finally(() => {
          if (!this.stopped) this.later(ms, tick);
        }),
        "a periodic task",
      );
    };
    if (now) tick();
    else this.later(ms, tick);
  }

  private later(ms: number, fn: () => void) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  /** Lets a task run on its own; a failure is logged, never lost or fatal. */
  private background(task: Promise<unknown>, what: string) {
    task.catch((err: unknown) => warn(`${what} failed: ${errorMessage(err)}`));
  }

  private subscribe() {
    if (this.stopped) return;
    this.unsubscribe = this.live.onWork(
      (work) => {
        this.workFailures = 0;
        this.onWork(work);
      },
      (err) => this.onWorkError(err),
    );
  }

  /**
   * An update the runner can't read is skipped (the next one may be fine); a failed query ends the
   * subscription, so it's made again after a backoff. The websocket itself reconnects on its own.
   */
  private onWorkError(err: Error) {
    if (err instanceof SchemaError) {
      warn(
        `Skipped an update from the server the runner can't read (${err.message}). Is yokka-runner current?`,
      );
      return;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.workFailures++;
    const wait = backoff(this.workFailures, RESUBSCRIBE_BASE_MS, RESUBSCRIBE_MAX_MS);
    warn(
      `The server couldn't list this runner's work (${err.message}); asking again in ${Math.ceil(wait / 1000)} s`,
    );
    this.later(wait, () => this.subscribe());
  }

  /** Picks up the sessions a previous runner left in the ledger, or reports them lost. */
  async adopt() {
    for (const entry of readLedger()) {
      const adapter = this.deps.adapters.get(entry.agent);
      const local = this.localFrom(entry);
      const session = adapter ? await adapter.adopt(entry, this.events(local)).catch(() => null) : null;
      if (adapter && session) {
        local.session = session;
        this.runs.set(entry.runId, local);
        log(`${entry.ref}: picked ${adapter.label} back up`);
      } else {
        await this.live
          .update(entry.runId, entry.attempt, {
            status: "lost",
            note: "the runner restarted and couldn't pick the session back up",
          })
          .catch(() => undefined);
        dropEntry(entry.runId);
      }
    }
  }

  private localFrom(entry: LedgerEntry): Local {
    return {
      runId: entry.runId,
      attempt: entry.attempt,
      agent: entry.agent,
      ref: entry.ref,
      title: entry.ref,
      launchCode: entry.launchCode,
      projectId: entry.projectId,
      cwd: entry.cwd,
      worktree: entry.worktree,
      ...(entry.branch ? { branch: entry.branch } : {}),
      ...(entry.mcpUrl ? { mcpUrl: entry.mcpUrl } : {}),
      busy: false,
      paused: entry.paused === true,
      handedOff: false,
      ending: false,
      uploadsSeen: new Set(),
    };
  }

  private onWork(work: Work) {
    if (this.stopped) return;
    if (work.revoked) {
      this.onFatal(
        "This runner was disconnected from the workspace. Run `yokka-runner login` to connect it again.",
      );
      return;
    }
    this.work = work;
    this.tried.clear();
    const listed = new Set(work.runs.map((r) => r.runId));
    for (const run of work.runs) {
      const local = this.runs.get(run.runId);
      if (!local) {
        if (run.status === "queued") this.background(this.take(run), `Taking ${run.ref}`);
      } else if (run.attempt === local.attempt) {
        this.sync(local, run);
      }
    }
    // Runs the server ended (the agent finished, or a sweep): let go of them.
    for (const local of this.runs.values())
      if (!listed.has(local.runId) && !local.ending && !local.busy)
        this.background(this.finish(local, false), `${local.ref}: finishing`);
  }

  /** Brings one held run in line with what the board wants: uploads, then stop, handover, pause or resume. */
  private sync(local: Local, run: WorkRun) {
    local.title = run.title;
    local.serverStatus = run.status;
    // A run adopted after a restart may already be paused on the board. Only before this runner reported
    // anything for it: afterwards the board's status can lag behind the runner's own pause and resume.
    if (run.status === "paused" && local.reported === undefined && !local.busy) local.paused = true;
    for (const u of run.uploads ?? []) {
      if (local.uploadsSeen.has(u._id)) continue;
      local.uploadsSeen.add(u._id);
      this.background(this.upload(local, u), `${local.ref}: an upload`);
    }
    this.reconcile(local, run);
  }

  /**
   * Makes a run match what the board wants: stopped, handed over, paused or running. Called on every update
   * and every poll, so a wish that arrived while the run was busy is acted on as soon as it's free.
   */
  private reconcile(local: Local, run: WorkRun | undefined) {
    if (!run || run.attempt !== local.attempt || local.ending) return;
    if (run.cancel)
      this.background(this.end(local, "cancelled", "stopped from the board", true), `${local.ref}: stopping`);
    else if (local.busy || local.handedOff) return;
    else if (run.handOff) this.background(this.handOff(local), `${local.ref}: handing over`);
    else if (run.pause && !local.paused) this.background(this.pause(local), `${local.ref}: pausing`);
    else if (!run.pause && local.paused) this.background(this.resume(local), `${local.ref}: resuming`);
  }

  private project(projectId: string): ProjectConfig | undefined {
    return this.config.projects[projectId];
  }

  /** Whether this machine can take a queued run right now; it stays queued (and retried) otherwise. */
  private canTake(run: WorkRun) {
    if (this.stopped || this.claiming.size > 0) return false;
    if (!isAgentId(run.agent)) return false;
    if (!this.deps.adapters.has(run.agent) || this.deps.detected.get(run.agent)?.problem) return false;
    const project = this.project(run.projectId);
    if (!project) return false;
    const going = [...this.runs.values()].filter((r) => !r.handedOff);
    if (going.length >= this.config.maxConcurrent) return false;
    const mode = run.workspaceMode ?? project.mode;
    if (mode === "in_place" && going.some((r) => r.projectId === run.projectId && !r.worktree)) return false;
    return true;
  }

  /** Claims a queued run and starts it; one claim at a time, then looks for the next queued run. */
  private async take(run: WorkRun) {
    if (!this.canTake(run)) return;
    this.claiming.add(run.runId);
    try {
      const claim = await this.live.claim(run.runId);
      if (claim.ok) await this.launch(run, claim);
      // A refused claim, or a run that failed to start, waits for the next update.
      if (!this.runs.has(run.runId)) this.tried.add(run.runId);
    } catch (err) {
      this.tried.add(run.runId);
      warn(`Couldn't take a run: ${errorMessage(err)}`);
    } finally {
      this.claiming.delete(run.runId);
    }
    // Something else may be waiting now that this one is settled.
    for (const r of this.work.runs)
      if (r.status === "queued" && !this.runs.has(r.runId) && !this.tried.has(r.runId))
        this.background(this.take(r), `Taking ${r.ref}`);
  }

  /** Gets a claimed run's folder ready and starts its agent, or reports why it couldn't. */
  private async launch(run: WorkRun, claim: Extract<Claim, { ok: true }>) {
    const project = this.project(claim.projectId);
    const agent = isAgentId(claim.agent) ? claim.agent : undefined;
    const adapter = agent ? this.deps.adapters.get(agent) : undefined;
    // The claim names the agent and project; the runner still only runs what it has an adapter and folder for.
    if (!agent || !adapter || !project) {
      const note = adapter
        ? "this runner has no folder for the project any more"
        : `this runner can't start ${claim.agent ?? "an unnamed agent"}`;
      warn(`${claim.ref}: ${note}`);
      await this.live
        .update(run.runId, claim.attempt, { status: "failed", note })
        .catch((err: unknown) => warn(`${claim.ref}: couldn't report failed: ${errorMessage(err)}`));
      return;
    }
    const local: Local = {
      runId: run.runId,
      attempt: claim.attempt,
      agent,
      ref: claim.ref,
      title: run.title,
      launchCode: claim.launchCode,
      projectId: claim.projectId,
      mcpUrl: claim.mcp.url,
      worktree: false,
      busy: true,
      paused: false,
      handedOff: false,
      ending: false,
      uploadsSeen: new Set(),
    };
    this.runs.set(run.runId, local);
    log(`${claim.ref}: starting ${adapter.label} for "${run.title}"`);
    try {
      const busyInPlace = [...this.runs.values()].some(
        (r) => r !== local && r.projectId === claim.projectId && !r.worktree && !r.handedOff,
      );
      const where = await prepare(
        project,
        claim.workspaceMode ?? project.mode,
        { ref: claim.ref, title: run.title, launchCode: claim.launchCode },
        busyInPlace,
      );
      Object.assign(local, where);
      const dir = join(runnerHome(), "runs", run.runId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const session = await adapter.start(
        {
          runId: run.runId,
          prompt: claim.prompt,
          cwd: where.cwd,
          name: `${claim.ref} · ${claim.launchCode}`,
          mcp: claim.mcp,
          dir,
        },
        this.events(local),
      );
      local.session = session;
      putEntry({
        runId: local.runId,
        attempt: local.attempt,
        agent,
        ref: local.ref,
        launchCode: local.launchCode,
        projectId: local.projectId,
        cwd: where.cwd,
        worktree: where.worktree,
        ...(where.branch ? { branch: where.branch } : {}),
        ...(session.shortId ? { shortId: session.shortId } : {}),
        sessionId: session.sessionId,
        mcpUrl: claim.mcp.url,
        startedAt: Date.now(),
      });
      const git = where.branch
        ? { branch: where.branch, worktree: where.worktree }
        : { worktree: where.worktree };
      await this.report(local, "launched", { clientSessionId: session.sessionId, git });
      log(
        `${claim.ref}: ${adapter.label} is working${where.worktree ? ` in a worktree on ${where.branch}` : ""}`,
      );
    } catch (err) {
      const note =
        err instanceof PrepareError ? err.message : `couldn't start ${adapter.label}: ${errorMessage(err)}`;
      warn(`${claim.ref}: ${note}`);
      await this.report(local, "failed", { note });
      this.forget(local);
    } finally {
      local.busy = false;
    }
  }

  /** What an adapter tells the runner about its session. */
  private events(local: Local): SessionEvents {
    return {
      openUrl: (url: string) =>
        this.background(
          this.live.update(local.runId, local.attempt, { openUrl: url }),
          `${local.ref}: a link`,
        ),
    };
  }

  private async report(local: Local, status: RunStatus, extra: RunUpdate = {}) {
    local.reported = status;
    await this.live.update(local.runId, local.attempt, { status, ...extra }).catch((err: unknown) => {
      warn(`${local.ref}: couldn't report ${status}: ${errorMessage(err)}`);
    });
  }

  /**
   * Checks every session's real state and reports changes. A session stuck on something only a person can
   * answer flags the card; the answer happens in the agent's app, and the next poll sees it moving again.
   */
  private async poll() {
    for (const local of [...this.runs.values()]) {
      if (this.stopped) return;
      this.reconcile(
        local,
        this.work.runs.find((r) => r.runId === local.runId),
      );
      if (local.busy || local.ending || !local.session || local.handedOff || local.paused) continue;
      local.busy = true;
      try {
        await this.check(local, local.session);
      } catch (err) {
        warn(`${local.ref}: ${errorMessage(err)}`);
      } finally {
        local.busy = false;
      }
    }
  }

  private async check(local: Local, session: Session) {
    const state = await session.state();
    switch (state) {
      case "working":
      case "idle":
        if (local.reported === "waiting_approval") await this.report(local, "running");
        return;
      case "blocked":
        // After request_input the card already asks; Claude shows that as "blocked" too.
        if (local.serverStatus !== "waiting_input" && local.reported !== "waiting_approval") {
          const note = await session.blockedReason?.();
          await this.report(local, "waiting_approval", note ? { note } : {});
          log(
            `${local.ref}: needs you in ${this.deps.adapters.get(local.agent)?.label ?? "the agent's app"}`,
          );
        }
        return;
      case "stopped":
        return this.end(local, "cancelled", "the session was stopped on this machine", false, true);
      case "crashed": {
        const note = (await session.blockedReason?.()) ?? "the agent's process ended unexpectedly";
        return this.end(local, "failed", note, false, true);
      }
    }
  }

  /** Pauses the agent without losing its conversation; the run keeps its token and its folder. */
  private async pause(local: Local) {
    const session = local.session;
    if (!session) return;
    local.busy = true;
    try {
      await session.pause();
      local.paused = true;
      setPaused(local.runId, true);
      await this.report(local, "paused");
      log(`${local.ref}: paused`);
    } catch (err) {
      warn(`${local.ref}: couldn't pause: ${errorMessage(err)}`);
    } finally {
      local.busy = false;
    }
  }

  /** Wakes a paused agent's own session, which carries on where it stopped. */
  private async resume(local: Local) {
    const session = local.session;
    if (!session) return;
    local.busy = true;
    try {
      await session.resume(RESUME_PROMPT);
      local.paused = false;
      setPaused(local.runId, false);
      await this.report(local, "running");
      log(`${local.ref}: resumed`);
    } catch (err) {
      warn(`${local.ref}: couldn't resume: ${errorMessage(err)}`);
    } finally {
      local.busy = false;
    }
  }

  /**
   * A file the agent attached by path: read it from inside the run's folder (never outside it, symlinks
   * included) and PUT it to the one-use link on this deployment, then say how it went.
   */
  private async upload(local: Local, u: { _id: string; path: string; uploadUrl: string }) {
    let error: string | undefined;
    try {
      if (!local.cwd) throw new Error("the run has no folder on this machine");
      if (!uploadUrlAllowed(u.uploadUrl, this.deps.server, local.mcpUrl))
        throw new Error("the upload link isn't on this deployment");
      const root = realpathSync(local.cwd);
      const file = realpathSync(join(root, u.path));
      if (!isInside(root, file) || file === root) throw new Error(`${u.path} is outside the run's folder`);
      const stat = statSync(file);
      if (!stat.isFile()) throw new Error(`${u.path} isn't a file`);
      if (stat.size > MAX_UPLOAD_BYTES) throw new Error(`${u.path} is larger than 20 MB`);
      const res = await (this.deps.fetch ?? fetch)(u.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentTypeOf(file) },
        body: readFileSync(file),
        redirect: "error",
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (!res.ok)
        throw new Error(`the upload was refused (${res.status}): ${(await res.text()).slice(0, 120)}`);
      log(`${local.ref}: attached ${u.path}`);
    } catch (err) {
      error =
        (err as NodeJS.ErrnoException).code === "ENOENT" ? `${u.path} doesn't exist` : errorMessage(err);
      warn(`${local.ref}: couldn't attach ${u.path}: ${error}`);
    }
    await this.live.uploaded(local.runId, local.attempt, u._id, error).catch(() => undefined);
  }

  private async heartbeat() {
    const held = [...this.runs.values()].map((r) => ({ runId: r.runId, attempt: r.attempt }));
    try {
      const { stop } = await this.live.heartbeat(held);
      for (const runId of stop) {
        const local = this.runs.get(runId);
        if (local && !local.ending) await this.finish(local, !local.handedOff);
      }
    } catch (err) {
      if (isRevoked(err)) this.onFatal(errorMessage(err));
      else warn(`Heartbeat failed: ${errorMessage(err)}`);
    }
  }

  private async handOff(local: Local) {
    if (!local.session) return;
    local.busy = true;
    try {
      const url = await local.session.handOff();
      local.handedOff = true;
      await this.report(local, "handed_off", url ? { openUrl: url } : {});
      log(`${local.ref}: handed over${url ? `; open ${url}` : ""}`);
    } finally {
      local.busy = false;
    }
  }

  /** Ends a run from this side: stops the session if asked, reports the status, then finishes up. */
  private async end(
    local: Local,
    status: RunStatus,
    note: string,
    stopSession: boolean,
    alreadyGone = false,
  ) {
    if (local.ending) return;
    local.ending = true;
    if (stopSession && local.session && !alreadyGone) await local.session.stop().catch(() => undefined);
    log(`${local.ref}: ${status} (${note})`);
    const git = local.cwd ? await gitState(local.cwd, local.worktree).catch(() => undefined) : undefined;
    await this.report(local, status, { note, ...(git ? { git } : {}) });
    await this.wrapUp(local);
  }

  /** The server ended the run: let go of the session, record git state, tidy up. */
  private async finish(local: Local, stopSession: boolean) {
    if (local.ending) return;
    local.ending = true;
    if (local.session) {
      if (stopSession) await local.session.stop().catch(() => undefined);
      else await local.session.detach().catch(() => undefined);
    }
    if (local.cwd) {
      const git = await gitState(local.cwd, local.worktree).catch(() => undefined);
      if (git) await this.live.update(local.runId, local.attempt, { git }).catch(() => undefined);
    }
    log(`${local.ref}: run ended`);
    await this.wrapUp(local);
  }

  private async wrapUp(local: Local) {
    if (
      local.cwd &&
      (await cleanup(this.project(local.projectId), local.cwd, local.worktree).catch(() => false))
    )
      log(`${local.ref}: removed its worktree`);
    this.forget(local);
  }

  private forget(local: Local) {
    this.runs.delete(local.runId);
    dropEntry(local.runId);
    // Claude needs the MCP config it started with whenever it restarts the session (continuing it in the app
    // after the run, say), so it stays, emptied: the run's token is revoked and must not linger on disk.
    const mcpFile = join(runnerHome(), "runs", local.runId, "mcp.json");
    if (existsSync(mcpFile)) writeFileSync(mcpFile, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
  }

  /**
   * Stops taking work and lets go of every session: Claude's background sessions keep going (the next start
   * adopts them); Codex threads live in this process's app-servers, so those runs are reported lost. Any
   * child still running is ended. Safe to call more than once.
   */
  shutdown() {
    this.stopping ??= this.stop();
    return this.stopping;
  }

  private async stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const local of [...this.runs.values()]) {
      await local.session?.detach().catch(() => undefined);
      if (local.agent === "codex" && !local.handedOff) {
        await this.report(local, "lost", { note: "the runner stopped" });
        this.forget(local);
      }
    }
    await killAll();
    await this.live.close().catch(() => undefined);
  }
}

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
};

export function contentTypeOf(file: string) {
  return TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

export type RunDaemonOptions = {
  transport?: Transport;
  adapters?: Map<AgentId, Adapter>;
  /** Where SIGINT and SIGTERM come from; the process itself by default. */
  signals?: EventEmitter;
  /** Ends the process on a second Ctrl-C. */
  exit?: (code: number) => void;
};

export function defaultAdapters(config: Config) {
  const adapters = new Map<AgentId, Adapter>();
  if (config.agents["claude-code"].enabled)
    adapters.set("claude-code", claudeAdapter(config.agents["claude-code"]));
  if (config.agents.codex.enabled) adapters.set("codex", codexAdapter(config.agents.codex));
  return adapters;
}

/** Connects, adopts what a previous runner left, and takes runs until a signal or a fatal error. */
export async function runDaemon(config: Config, options: RunDaemonOptions = {}) {
  if (!config.server || !config.token) throw new Error("Not signed in. Run `yokka-runner login` first.");
  const server = serverUrl(config.server);
  const live = liveClient(options.transport ?? websocketTransport(server), config.token);
  const adapters = options.adapters ?? defaultAdapters(config);
  const signals: EventEmitter = options.signals ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const detected = new Map<AgentId, Detected>();
  for (const [id, adapter] of adapters) {
    const d = await adapter.detect();
    detected.set(id, d);
    if (d.problem) warn(`${adapter.label}: ${d.problem}`);
    else log(`${adapter.label} ${d.version ?? ""} ready`);
  }

  let hello: Hello;
  try {
    hello = await live.hello({
      agents: [...detected].map(([agent, d]) => ({
        agent,
        ...(d.version ? { version: d.version } : {}),
        ...(d.problem ? { problem: d.problem } : {}),
      })),
      projects: projectModes(config),
      maxConcurrent: config.maxConcurrent,
    });
  } catch (err) {
    await live.close().catch(() => undefined);
    throw new Error(errorMessage(err));
  }
  if (hello.protocol > PROTOCOL)
    warn(
      `The server speaks runner protocol ${hello.protocol} (this runner ${PROTOCOL}). Update yokka-runner soon.`,
    );
  const mapped = Object.entries(config.projects)
    .map(
      ([id, p]) =>
        `${hello.projects.find((x) => x._id === id)?.name ?? p.name} (${p.mode.replace("_", " ")})`,
    )
    .join(", ");
  log(
    `Connected to ${hello.workspace.name} as "${hello.name}". Projects: ${mapped || "none yet (run `yokka-runner map`)"}.`,
  );

  const daemon = new Daemon(config, { live, adapters, detected, hello, server });
  await daemon.adopt();
  daemon.start();
  // If the process dies without shutting down, its children go with it.
  process.once("exit", killAllNow);

  await new Promise<void>((resolve) => {
    let stopping = false;
    const done = (code?: number) => {
      signals.off("SIGINT", onSignal);
      signals.off("SIGTERM", onSignal);
      if (code) process.exitCode = code;
      resolve();
    };
    const shutDown = (code?: number) => {
      const deadline = setTimeout(() => {
        warn("Shutting down is taking too long; ending the agents' processes now.");
        killAllNow();
        done(code ?? 1);
      }, SHUTDOWN_TIMEOUT_MS);
      daemon
        .shutdown()
        .catch((err: unknown) => warn(`Shutting down: ${errorMessage(err)}`))
        .finally(() => {
          clearTimeout(deadline);
          done(code);
        });
    };
    function onSignal() {
      if (stopping) {
        warn("Stopping now.");
        killAllNow();
        exit(130);
        return;
      }
      stopping = true;
      log(
        "Stopping. Claude sessions keep going and are picked up on the next start. (Ctrl-C again to force.)",
      );
      shutDown();
    }
    signals.on("SIGINT", onSignal);
    signals.on("SIGTERM", onSignal);
    daemon.onFatal = (message) => {
      if (stopping) return;
      stopping = true;
      warn(message);
      shutDown(1);
    };
  });
  process.off("exit", killAllNow);
}
