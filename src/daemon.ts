import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { claudeAdapter } from "./adapters/claude.ts";
import { codexAdapter } from "./adapters/codex.ts";
import type { Adapter, Detected, Session } from "./adapters/types.ts";
import {
  type AgentId,
  type Hello,
  type Live,
  liveClient,
  type RunStatus,
  type Work,
  type WorkRun,
} from "./api.ts";
import { type Config, home, type ProjectConfig } from "./config.ts";
import { dropEntry, type LedgerEntry, putEntry, readLedger } from "./ledger.ts";
import { log, warn } from "./log.ts";
import { cleanup, gitState, PrepareError, prepare } from "./workspace.ts";

/**
 * The runner's main loop (PROTOCOL.md). The server holds the desired state; the runner makes this machine
 * match it and reports what's really there:
 * - a live subscription to its work: queued runs to take, runs to pause, resume, hand off or stop;
 * - a poll of each agent session's real state, reported when it changes. Anything that needs a person (a
 *   question, a permission prompt) is answered in the agent's own app; the runner only flags the card;
 * - a heartbeat listing the runs it holds, so the server can lose the ones it doesn't and tell it which to
 *   stop.
 */

const POLL_MS = 4_000;
/** What a paused agent is told when it's resumed. */
const RESUME_PROMPT = "Continue where you left off.";

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
  session?: Session;
  /** The last status this runner reported (the server may know more, from MCP). */
  reported?: RunStatus;
  /** A step is in flight (starting, pausing, resuming, handing off): the poll leaves it alone. */
  busy: boolean;
  paused: boolean;
  handedOff: boolean;
  ending: boolean;
  /** The run's status on the board, which also knows what the agent did over MCP. */
  serverStatus?: RunStatus;
  uploadsSeen: Set<string>;
};

export async function runDaemon(config: Config) {
  if (!config.server || !config.token) throw new Error("Not signed in. Run `yokka-runner login` first.");
  const live = liveClient(config.server, config.token);
  const adapters = new Map<AgentId, Adapter>();
  if (config.agents["claude-code"].enabled)
    adapters.set("claude-code", claudeAdapter(config.agents["claude-code"]));
  if (config.agents.codex.enabled) adapters.set("codex", codexAdapter(config.agents.codex));

  const detected = new Map<AgentId, Detected>();
  for (const [id, adapter] of adapters) {
    const d = await adapter.detect();
    detected.set(id, d);
    if (d.problem) warn(`${adapter.label}: ${d.problem}`);
    else log(`${adapter.label} ${d.version ?? ""} ready`);
  }

  const hello = await live.hello({
    agents: [...detected].map(([agent, d]) => ({ agent, version: d.version, problem: d.problem })),
    projects: Object.entries(config.projects).map(([projectId, p]) => ({ projectId, mode: p.mode })),
    maxConcurrent: config.maxConcurrent,
  });
  const mapped = Object.entries(config.projects)
    .map(
      ([id, p]) =>
        `${hello.projects.find((x) => x._id === id)?.name ?? p.name} (${p.mode.replace("_", " ")})`,
    )
    .join(", ");
  log(
    `Connected to ${hello.workspace.name} as "${hello.name}". Projects: ${mapped || "none yet (run `yokka-runner map`)"}.`,
  );

  const daemon = new Daemon(config, live, adapters, detected, hello);
  await daemon.adopt();
  daemon.run();

  await new Promise<void>((resolve) => {
    const stop = () => {
      log("Stopping. Claude sessions keep going and are picked up on the next start.");
      void daemon.shutdown().then(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    daemon.onFatal = (message) => {
      warn(message);
      void daemon.shutdown().then(() => {
        process.exitCode = 1;
        resolve();
      });
    };
  });
}

class Daemon {
  private runs = new Map<string, Local>();
  private claiming = new Set<string>();
  private work: Work = { revoked: false, runs: [] };
  private timers: NodeJS.Timeout[] = [];
  private unsubscribe: (() => void) | null = null;
  onFatal: (message: string) => void = () => undefined;

  private config: Config;
  private live: Live;
  private adapters: Map<AgentId, Adapter>;
  private detected: Map<AgentId, Detected>;
  private hello: Hello;

  constructor(
    config: Config,
    live: Live,
    adapters: Map<AgentId, Adapter>,
    detected: Map<AgentId, Detected>,
    hello: Hello,
  ) {
    this.config = config;
    this.live = live;
    this.adapters = adapters;
    this.detected = detected;
    this.hello = hello;
  }

  run() {
    const sub = this.live.onWork(
      (work) => this.onWork(work),
      (err) => this.onFatal(`Lost the connection to the server: ${err.message}`),
    );
    this.unsubscribe = () => sub();
    this.timers.push(setInterval(() => void this.heartbeat(), this.hello.heartbeatMs));
    this.timers.push(setInterval(() => void this.poll(), POLL_MS));
    void this.heartbeat();
  }

  /** Picks up the sessions a previous runner left in the ledger, or reports them lost. */
  async adopt() {
    for (const entry of readLedger()) {
      const adapter = this.adapters.get(entry.agent);
      const local = this.localFrom(entry);
      const session = adapter ? await adapter.adopt(entry, this.events(local)).catch(() => null) : null;
      if (session) {
        local.session = session;
        this.runs.set(entry.runId, local);
        log(`${entry.ref}: picked ${adapter!.label} back up`);
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
      branch: entry.branch,
      busy: false,
      paused: false,
      handedOff: false,
      ending: false,
      uploadsSeen: new Set(),
    };
  }

  private onWork(work: Work) {
    if (work.revoked) {
      this.onFatal(
        "This runner was disconnected from the workspace. Run `yokka-runner login` to connect it again.",
      );
      return;
    }
    this.work = work;
    const listed = new Set(work.runs.map((r) => r.runId));
    for (const run of work.runs) {
      const local = this.runs.get(run.runId);
      if (!local) {
        if (run.status === "queued") void this.take(run);
        continue;
      }
      if (run.attempt !== local.attempt) continue;
      local.title = run.title;
      local.serverStatus = run.status;
      // A run adopted after a restart may already be paused on the board.
      if (run.status === "paused" && !local.busy) local.paused = true;
      for (const u of run.uploads ?? []) {
        if (local.uploadsSeen.has(u._id)) continue;
        local.uploadsSeen.add(u._id);
        void this.upload(local, u);
      }
      this.reconcile(local, run);
    }
    // Runs the server ended (the agent finished, or a sweep): let go of them.
    for (const local of this.runs.values())
      if (!listed.has(local.runId) && !local.ending && !local.busy) void this.finish(local, false);
  }

  /**
   * Makes a run match what the board wants: stopped, handed over, paused or running. Called on every update
   * and every poll, so a wish that arrived while the run was busy is acted on as soon as it's free.
   */
  private reconcile(local: Local, run: WorkRun | undefined) {
    if (!run || run.attempt !== local.attempt || local.ending) return;
    if (run.cancel) void this.end(local, "cancelled", "stopped from the board", true);
    else if (local.busy || local.handedOff) return;
    else if (run.handOff) void this.handOff(local);
    else if (run.pause && !local.paused) void this.pause(local);
    else if (!run.pause && local.paused) void this.resume(local);
  }

  private project(projectId: string): ProjectConfig | undefined {
    return this.config.projects[projectId];
  }

  /** Whether this machine can take a queued run right now; it stays queued (and retried) otherwise. */
  private canTake(run: WorkRun) {
    if (this.claiming.size > 0) return false;
    if (!run.agent || run.agent === "cursor") return false;
    if (!this.adapters.has(run.agent) || this.detected.get(run.agent)?.problem) return false;
    const project = this.project(run.projectId);
    if (!project) return false;
    const going = [...this.runs.values()].filter((r) => !r.handedOff);
    if (going.length >= this.config.maxConcurrent) return false;
    const mode = run.workspaceMode ?? project.mode;
    if (mode === "in_place" && going.some((r) => r.projectId === run.projectId && !r.worktree)) return false;
    return true;
  }

  private async take(run: WorkRun) {
    if (!this.canTake(run)) return;
    this.claiming.add(run.runId);
    try {
      const claim = await this.live.claim(run.runId);
      if (!claim.ok) return;
      const project = this.project(run.projectId)!;
      const adapter = this.adapters.get(claim.agent)!;
      const local: Local = {
        runId: run.runId,
        attempt: claim.attempt,
        agent: claim.agent,
        ref: claim.ref,
        title: run.title,
        launchCode: claim.launchCode,
        projectId: run.projectId,
        worktree: false,
        busy: true,
        paused: false,
        handedOff: false,
        ending: false,
        uploadsSeen: new Set(),
      };
      this.runs.set(run.runId, local);
      log(`${claim.ref}: starting ${adapter.label} for "${run.title}"`);

      const mode = claim.workspaceMode ?? project.mode;
      try {
        const busyInPlace = [...this.runs.values()].some(
          (r) => r !== local && r.projectId === run.projectId && !r.worktree && !r.handedOff,
        );
        const where = await prepare(
          project,
          mode,
          { ref: claim.ref, title: run.title, launchCode: claim.launchCode },
          busyInPlace,
        );
        Object.assign(local, where);
        const dir = join(home, "runs", run.runId);
        mkdirSync(dir, { recursive: true });
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
          agent: local.agent,
          ref: local.ref,
          launchCode: local.launchCode,
          projectId: local.projectId,
          cwd: where.cwd,
          worktree: where.worktree,
          branch: where.branch,
          shortId: session.shortId,
          sessionId: session.sessionId,
          startedAt: Date.now(),
        });
        await this.report(local, "launched", {
          clientSessionId: session.sessionId,
          git: { branch: where.branch, worktree: where.worktree },
        });
        log(
          `${claim.ref}: ${adapter.label} is working${where.worktree ? ` in a worktree on ${where.branch}` : ""}`,
        );
      } catch (err) {
        const note =
          err instanceof PrepareError
            ? err.message
            : `couldn't start ${adapter.label}: ${(err as Error).message}`;
        warn(`${claim.ref}: ${note}`);
        await this.report(local, "failed", { note });
        this.forget(local);
      } finally {
        local.busy = false;
      }
    } catch (err) {
      warn(`Couldn't take a run: ${(err as Error).message}`);
    } finally {
      this.claiming.delete(run.runId);
    }
    // Something else may be waiting now that this one is settled.
    for (const r of this.work.runs) if (r.status === "queued" && !this.runs.has(r.runId)) void this.take(r);
  }

  /** What an adapter tells the runner about its session. */
  private events(local: Local) {
    return {
      openUrl: (url: string) =>
        void this.live.update(local.runId, local.attempt, { openUrl: url }).catch(() => undefined),
    };
  }

  private async report(local: Local, status: RunStatus, extra: Parameters<Live["update"]>[2] = {}) {
    local.reported = status;
    await this.live.update(local.runId, local.attempt, { status, ...extra }).catch((err: Error) => {
      warn(`${local.ref}: couldn't report ${status}: ${err.message}`);
    });
  }

  /**
   * Checks every session's real state and reports changes. A session stuck on something only a person can
   * answer flags the card; the answer happens in the agent's app, and the next poll sees it moving again.
   */
  private async poll() {
    for (const local of this.runs.values()) {
      this.reconcile(
        local,
        this.work.runs.find((r) => r.runId === local.runId),
      );
      if (local.busy || local.ending || !local.session || local.handedOff || local.paused) continue;
      local.busy = true;
      try {
        const state = await local.session.state();
        if (state === "working" || state === "idle") {
          if (local.reported === "waiting_approval") await this.report(local, "running");
        } else if (state === "blocked") {
          // After request_input the card already asks; Claude shows that as "blocked" too.
          if (local.serverStatus !== "waiting_input" && local.reported !== "waiting_approval") {
            const note = await local.session.blockedReason?.();
            await this.report(local, "waiting_approval", note ? { note } : {});
            log(`${local.ref}: needs you in ${this.adapters.get(local.agent)?.label ?? "the agent's app"}`);
          }
        } else if (state === "stopped") {
          await this.end(local, "cancelled", "the session was stopped on this machine", false, true);
        } else {
          const note = (await local.session.blockedReason?.()) ?? "the agent's process ended unexpectedly";
          await this.end(local, "failed", note, false, true);
        }
      } catch (err) {
        warn(`${local.ref}: ${(err as Error).message}`);
      } finally {
        local.busy = false;
      }
    }
  }

  /** Pauses the agent without losing its conversation; the run keeps its token and its folder. */
  private async pause(local: Local) {
    if (!local.session) return;
    local.busy = true;
    try {
      await local.session.pause();
      local.paused = true;
      await this.report(local, "paused");
      log(`${local.ref}: paused`);
    } catch (err) {
      warn(`${local.ref}: couldn't pause: ${(err as Error).message}`);
    } finally {
      local.busy = false;
    }
  }

  private async resume(local: Local) {
    if (!local.session) return;
    local.busy = true;
    try {
      await local.session.resume(RESUME_PROMPT);
      local.paused = false;
      await this.report(local, "running");
      log(`${local.ref}: resumed`);
    } catch (err) {
      warn(`${local.ref}: couldn't resume: ${(err as Error).message}`);
    } finally {
      local.busy = false;
    }
  }

  /**
   * A file the agent attached by path: read it from inside the run's folder (never outside it, symlinks
   * included) and PUT it to the one-use link, then say how it went.
   */
  private async upload(local: Local, u: { _id: string; path: string; uploadUrl: string }) {
    let error: string | undefined;
    try {
      if (!local.cwd) throw new Error("the run has no folder on this machine");
      const root = realpathSync(local.cwd);
      const file = realpathSync(join(root, u.path));
      const inside =
        process.platform === "win32"
          ? file.toLowerCase().startsWith(`${root.toLowerCase()}${sep}`)
          : file.startsWith(`${root}${sep}`);
      if (!inside) throw new Error(`${u.path} is outside the run's folder`);
      if (!statSync(file).isFile()) throw new Error(`${u.path} isn't a file`);
      const res = await fetch(u.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentTypeOf(file) },
        body: readFileSync(file),
      });
      if (!res.ok)
        throw new Error(`the upload was refused (${res.status}): ${(await res.text()).slice(0, 120)}`);
      log(`${local.ref}: attached ${u.path}`);
    } catch (err) {
      error =
        (err as NodeJS.ErrnoException).code === "ENOENT" ? `${u.path} doesn't exist` : (err as Error).message;
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
      const message = (err as Error).message;
      if (/disconnected/.test(message)) this.onFatal(message);
      else warn(`Heartbeat failed: ${message}`);
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
    const mcpFile = join(home, "runs", local.runId, "mcp.json");
    if (existsSync(mcpFile)) writeFileSync(mcpFile, JSON.stringify({ mcpServers: {} }));
  }

  async shutdown() {
    for (const t of this.timers) clearInterval(t);
    this.unsubscribe?.();
    for (const local of [...this.runs.values()]) {
      if (local.agent === "codex" && !local.handedOff) {
        // A Codex thread lives in this process's app-server; it can't outlive the runner.
        await local.session?.detach().catch(() => undefined);
        await this.report(local, "lost", { note: "the runner stopped" });
        this.forget(local);
      } else {
        await local.session?.detach().catch(() => undefined);
      }
    }
    await this.live.close();
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

function contentTypeOf(file: string) {
  return TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}
