import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { CodexConfig } from "../config.ts";
import { messageOf, warn } from "../log.ts";
import { withTimeout } from "../net.ts";
import { killTree, run, start as startProcess } from "../proc.ts";
import { codexTokens, type Usage } from "../usage.ts";
import { VERSION } from "../version.ts";
import type { Adapter, AgentState, Detected, Session, SessionEvents, StartArgs } from "./types.ts";

/**
 * Codex, driven through `codex app-server` over stdio JSON-RPC (docs/runner.md "Codex adapter"). Threads
 * it starts are saved like the desktop app's own, so they show up there; while this app-server holds a
 * thread the app shows it locked, which is what makes a clean handover possible: let go, then the person
 * presses Retry in the app. That is also where anything needing the person is answered; the runner starts,
 * pauses (interrupts the turn, keeps the thread), resumes and stops.
 *
 * Nothing secret goes on a command line: the run's MCP token reaches Codex inside `thread/start`, over the
 * app-server's stdin.
 */

type Json = Record<string, unknown>;
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** How long a request to the app-server may take before the runner gives up on it. */
const REQUEST_TIMEOUT_MS = 60_000;

function isJson(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A JSON-RPC connection to one `codex app-server` process. */
export class AppServer {
  private next = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, (params: Json) => void>();
  onRequest: (method: string, params: Json) => Promise<unknown> = () =>
    Promise.reject(new Error("unsupported"));
  exited = false;
  /** Why it ended, when it didn't end on purpose. */
  exitReason: string | undefined;
  stderr = "";

  readonly child: ChildProcess;

  constructor(child: ChildProcess) {
    this.child = child;
    if (child.stdout) createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
    child.stderr?.on("data", (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-4000);
    });
    child.on("error", (err) => this.close(`codex couldn't start: ${err.message}`));
    child.on("exit", (code) => this.close(`codex app-server exited (${code ?? "signal"})`));
  }

  private close(reason: string) {
    if (this.exited) return;
    this.exited = true;
    this.exitReason = reason;
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }

  on(method: string, handler: (params: Json) => void) {
    this.handlers.set(method, handler);
  }

  request<T = Json>(method: string, params: Json, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.exited) return Promise.reject(new Error(this.exitReason ?? "codex app-server exited"));
    const id = this.next++;
    const answer = new Promise<T>((resolve, reject) =>
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }),
    );
    this.write({ jsonrpc: "2.0", id, method, params });
    return withTimeout(answer, timeoutMs, `codex ${method}`).finally(() => this.pending.delete(id));
  }

  notify(method: string, params: Json) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(msg: Json) {
    if (!this.exited) this.child.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  private receive(line: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isJson(parsed)) return;
    const msg = parsed;
    const id = typeof msg.id === "number" || typeof msg.id === "string" ? msg.id : undefined;
    const method = typeof msg.method === "string" ? msg.method : undefined;
    if (id !== undefined && !method && ("result" in msg || "error" in msg)) {
      const p = typeof id === "number" ? this.pending.get(id) : undefined;
      if (!p) return;
      this.pending.delete(id as number);
      if (msg.error) p.reject(new Error(`codex: ${JSON.stringify(msg.error).slice(0, 300)}`));
      else p.resolve(msg.result);
      return;
    }
    if (!method) return;
    const params = isJson(msg.params) ? msg.params : {};
    if (id !== undefined) {
      // A request from the server (a permission question): answer it, whatever happens while deciding.
      this.onRequest(method, params).then(
        (result) => this.write({ jsonrpc: "2.0", id, result }),
        (err: unknown) =>
          this.write({ jsonrpc: "2.0", id, error: { code: -32000, message: messageOf(err) } }),
      );
      return;
    }
    this.handlers.get(method)?.(params);
  }
}

/**
 * Answers Codex's server requests. Codex asks before an MCP tool writes; the run's own board tools are
 * pre-approved (its token reaches this project only). Nothing else is answered from here: a person can't
 * answer a thread the runner holds, so Codex runs with approvals off (`never`, the default) inside its
 * sandbox, and anything else is declined in the shape Codex expects, or refused outright.
 */
export async function answerRequest(method: string, params: Json): Promise<unknown> {
  if (method === "mcpServer/elicitation/request")
    return params.serverName === "yokka"
      ? { action: "accept", content: {} }
      : { action: "decline", content: null };
  warn(
    `Codex asked for ${method}, which the runner doesn't answer; declined. Set agents.codex.approvalPolicy to "never" so it doesn't ask.`,
  );
  if (method === "execCommandApproval" || method === "applyPatchApproval") return { decision: "denied" };
  if (method.endsWith("/requestApproval") && !method.includes("permissions")) return { decision: "decline" };
  throw new Error("declined");
}

export function codexAdapter(config: CodexConfig): Adapter {
  const cmd = config.command;

  async function begin(args: StartArgs, events: SessionEvents, server: AppServer): Promise<Session> {
    const child = server.child;
    let turnId: string | undefined;
    let working = false;
    let failed: string | undefined;
    let threadId = "";
    let urlSent = false;
    // What the thread spent: Codex's running token totals, and the time its turns took.
    let tokens: ReturnType<typeof codexTokens>;
    let model: string | undefined = config.model;
    let turnStartedAt: number | undefined;
    let turnMs = 0;

    const send = async (text: string) => {
      working = true;
      try {
        await server.request("turn/start", { threadId, input: [{ type: "text", text }] });
      } catch (err) {
        working = false;
        throw err;
      }
    };

    server.on("turn/started", (p) => {
      working = true;
      turnStartedAt ??= Date.now();
      const turn = isJson(p.turn) ? p.turn : {};
      turnId = typeof turn.id === "string" ? turn.id : typeof p.turnId === "string" ? p.turnId : undefined;
    });
    server.on("turn/completed", (p) => {
      working = false;
      turnId = undefined;
      if (turnStartedAt !== undefined) turnMs += Date.now() - turnStartedAt;
      turnStartedAt = undefined;
      const turn = isJson(p.turn) ? p.turn : {};
      if (turn.status === "failed") failed = JSON.stringify(turn.error ?? "turn failed").slice(0, 280);
    });
    server.on("item/completed", () => {
      // The thread's link works once its first item is on disk.
      if (!urlSent && threadId) {
        urlSent = true;
        events.openUrl?.(`codex://threads/${threadId}`);
      }
    });
    server.on("thread/tokenUsage/updated", (p) => {
      tokens = codexTokens(p) ?? tokens;
    });
    server.onRequest = answerRequest;

    await server.request("initialize", { clientInfo: { name: "yokka-runner", version: VERSION } });
    server.notify("initialized", {});
    // The run's MCP server: the connector link when the workspace allows it, else a bearer header.
    const yokka = args.mcp.link
      ? { url: args.mcp.link }
      : { url: args.mcp.url, http_headers: { Authorization: `Bearer ${args.mcp.token}` } };
    const started = await server.request("thread/start", {
      cwd: args.cwd,
      model: config.model ?? null,
      sandbox: config.sandbox,
      approvalPolicy: config.approvalPolicy,
      config: { mcp_servers: { yokka } },
    });
    const thread = isJson(started.thread) ? started.thread : {};
    if (typeof thread.id !== "string" || !thread.id) throw new Error("codex started no thread");
    threadId = thread.id;
    if (typeof started.model === "string" && started.model) model = started.model;
    await server.request("thread/name/set", { threadId, name: args.name }).catch(() => undefined);
    await send(args.prompt);

    const interrupt = async () => {
      if (turnId && !server.exited)
        await server.request("turn/interrupt", { threadId, turnId }, 10_000).catch(() => undefined);
    };
    return {
      sessionId: threadId,
      async state(): Promise<AgentState> {
        if (server.exited || failed) return "crashed";
        return working ? "working" : "idle";
      },
      async blockedReason() {
        return failed ?? server.exitReason;
      },
      async pause() {
        // The thread and this app-server stay; only the turn in progress stops.
        if (server.exited) throw new Error(server.exitReason ?? "codex app-server exited");
        await interrupt();
        working = false;
      },
      async resume(text) {
        if (server.exited) throw new Error(server.exitReason ?? "codex app-server exited");
        await send(text);
      },
      async stop() {
        await interrupt();
        await killTree(child);
      },
      async handOff() {
        await interrupt();
        await killTree(child);
        return `codex://threads/${threadId}`;
      },
      async detach() {
        // The thread stays on disk; the runner's hold on it ends with the process.
        await killTree(child);
      },
      async usage() {
        if (!tokens) return undefined;
        const running = turnStartedAt === undefined ? 0 : Date.now() - turnStartedAt;
        const usage: Usage = { ...tokens, durationMs: turnMs + running, ...(model ? { model } : {}) };
        // Codex reports no cost, so there is nothing more to wait for.
        return { ...usage, final: true };
      },
    };
  }

  return {
    id: "codex",
    label: "Codex",

    async detect(): Promise<Detected> {
      const v = await run(cmd, ["--version"], { timeoutMs: 20_000 });
      if (v.code !== 0) return { problem: `\`${cmd}\` isn't installed or isn't on PATH` };
      const version = /\d+\.\d+\.\d+/.exec(v.stdout)?.[0];
      const help = await run(cmd, ["app-server", "--help"], { timeoutMs: 20_000 });
      if (help.code !== 0) return { version, problem: "this Codex has no app-server; run `codex update`" };
      const login = await run(cmd, ["login", "status"], { timeoutMs: 20_000 });
      if (login.code !== 0) return { version, problem: "not signed in; run `codex login`" };
      return { version };
    },

    async start(args: StartArgs, events: SessionEvents) {
      const child = startProcess(cmd, ["app-server"], { cwd: args.cwd });
      const server = new AppServer(child);
      try {
        return await begin(args, events, server);
      } catch (err) {
        // A half-started app-server would hold the thread (and a process) forever.
        await killTree(child);
        const detail = server.stderr.trim().split("\n").at(-1);
        throw new Error(detail ? `${messageOf(err)} (${detail.slice(0, 200)})` : messageOf(err));
      }
    },

    async adopt() {
      // Codex threads live in the runner's own app-server process, which ended with the old runner.
      return null;
    },
  };
}
