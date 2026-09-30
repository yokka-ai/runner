import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { VERSION } from "../api.ts";
import type { CodexConfig } from "../config.ts";
import { warn } from "../log.ts";
import { killTree, run, start as startProcess } from "../proc.ts";
import type { Adapter, AgentState, Detected, Session, SessionEvents, StartArgs } from "./types.ts";

/**
 * Codex, driven through `codex app-server` over stdio JSON-RPC (docs/runner.md "Codex adapter"). Threads
 * it starts are saved like the desktop app's own, so they show up there; while this app-server holds a
 * thread the app shows it locked, which is what makes a clean handover possible: let go, then the person
 * presses Retry in the app. That is also where anything needing the person is answered; the runner starts,
 * pauses (interrupts the turn, keeps the thread), resumes and stops.
 */

type Json = Record<string, unknown>;
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** A JSON-RPC connection to one `codex app-server` process. */
class AppServer {
  private next = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, (params: Json) => void>();
  onRequest: (method: string, params: Json) => Promise<unknown> = async () => {
    throw new Error("unsupported");
  };
  exited = false;
  stderr = "";

  readonly child: ChildProcess;

  constructor(child: ChildProcess) {
    this.child = child;
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => this.receive(line));
    child.stderr?.on("data", (d) => {
      this.stderr = (this.stderr + d).slice(-4000);
    });
    child.on("exit", () => {
      this.exited = true;
      for (const p of this.pending.values()) p.reject(new Error("codex app-server exited"));
      this.pending.clear();
      this.handlers.get("__exit")?.({});
    });
  }

  on(method: string, handler: (params: Json) => void) {
    this.handlers.set(method, handler);
  }

  request<T = Json>(method: string, params: Json): Promise<T> {
    if (this.exited) return Promise.reject(new Error("codex app-server exited"));
    const id = this.next++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise<T>((resolve, reject) =>
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }),
    );
  }

  notify(method: string, params: Json) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(msg: Json) {
    this.child.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  private receive(line: string) {
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      return;
    }
    const id = msg.id as number | string | undefined;
    if (id !== undefined && ("result" in msg || "error" in msg) && !msg.method) {
      const p = this.pending.get(id as number);
      if (!p) return;
      this.pending.delete(id as number);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    const method = msg.method as string | undefined;
    if (!method) return;
    const params = (msg.params ?? {}) as Json;
    if (id !== undefined) {
      // A request from the server (a permission question): answer it.
      this.onRequest(method, params).then(
        (result) => this.write({ jsonrpc: "2.0", id, result }),
        (err: Error) => this.write({ jsonrpc: "2.0", id, error: { code: -32000, message: err.message } }),
      );
      return;
    }
    this.handlers.get(method)?.(params);
    this.handlers.get("*")?.({ method, ...params });
  }
}

export function codexAdapter(config: CodexConfig): Adapter {
  const cmd = config.command;

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
      let turnId: string | undefined;
      let working = false;
      let failed: string | undefined;
      let threadId = "";
      let urlSent = false;

      server.on("turn/started", (p) => {
        working = true;
        turnId = ((p.turn as Json | undefined)?.id as string | undefined) ?? (p.turnId as string | undefined);
      });
      server.on("turn/completed", (p) => {
        working = false;
        turnId = undefined;
        const status = (p.turn as Json | undefined)?.status;
        if (status === "failed")
          failed = JSON.stringify((p.turn as Json).error ?? "turn failed").slice(0, 280);
      });
      server.on("item/completed", () => {
        // The thread's link works once its first item is on disk.
        if (!urlSent && threadId) {
          urlSent = true;
          events.openUrl?.(`codex://threads/${threadId}`);
        }
      });
      server.onRequest = async (method, params) => {
        // Codex asks before an MCP tool writes. The run's own board tools are pre-approved: its token
        // reaches this project only. Nothing else is answered from here; run Codex with approvals off
        // (`never`, the default) inside its sandbox, and continue in the Codex app for anything else.
        if (method === "mcpServer/elicitation/request")
          return params.serverName === "yokka"
            ? { action: "accept", content: {} }
            : { action: "decline", content: null };
        warn(
          `Codex asked for ${method}, which the runner doesn't answer; declined. Set agents.codex.approvalPolicy to "never" so it doesn't ask.`,
        );
        if (method === "execCommandApproval" || method === "applyPatchApproval")
          return { decision: "denied" };
        if (/requestApproval$/.test(method) && !method.includes("permissions"))
          return { decision: "decline" };
        throw new Error("declined");
      };

      const send = async (text: string) => {
        working = true;
        await server.request("turn/start", { threadId, input: [{ type: "text", text }] });
      };

      await server.request("initialize", { clientInfo: { name: "yokka-runner", version: VERSION } });
      server.notify("initialized", {});
      // The run's MCP server: the connector link when the workspace allows it, else a bearer header.
      const yokka = args.mcp.link
        ? { url: args.mcp.link }
        : { url: args.mcp.url, http_headers: { Authorization: `Bearer ${args.mcp.token}` } };
      const started = await server.request<{ thread: { id: string } }>("thread/start", {
        cwd: args.cwd,
        model: config.model ?? null,
        sandbox: config.sandbox,
        approvalPolicy: config.approvalPolicy,
        config: { mcp_servers: { yokka } },
      });
      threadId = started.thread.id;
      await server.request("thread/name/set", { threadId, name: args.name }).catch(() => undefined);
      await send(args.prompt);

      const session: Session = {
        sessionId: threadId,
        async state(): Promise<AgentState> {
          if (server.exited) return "crashed";
          if (failed) return "crashed";
          return working ? "working" : "idle";
        },
        async blockedReason() {
          return failed;
        },
        async pause() {
          // The thread and this app-server stay; only the turn in progress stops.
          if (turnId) await server.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
          working = false;
        },
        async resume(text) {
          await send(text);
        },
        async stop() {
          if (turnId) await server.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
          await killTree(child);
        },
        async handOff() {
          if (turnId) await server.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
          await killTree(child);
          return `codex://threads/${threadId}`;
        },
        async detach() {
          // The thread stays on disk; the runner's hold on it ends with the process.
          await killTree(child);
        },
      };
      return session;
    },

    async adopt() {
      // Codex threads live in the runner's own app-server process, which ended with the old runner.
      return null;
    },
  };
}
