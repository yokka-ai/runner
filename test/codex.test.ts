import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunResult } from "../src/proc.ts";

const proc = vi.hoisted(() => ({
  run: vi.fn<(command: string, args: string[]) => Promise<RunResult>>(),
  start: vi.fn(),
  killTree: vi.fn(async () => undefined),
}));

vi.mock("../src/proc.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/proc.ts")>()),
  run: proc.run,
  start: proc.start,
  killTree: proc.killTree,
}));

const { AppServer, codexAdapter } = await import("../src/adapters/codex.ts");
const { defaults } = await import("../src/config.ts");
const { captureOutput } = await import("./helpers.ts");

type Message = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

/**
 * A fake `codex app-server`: answers requests from `handlers` by method (a handler returning undefined
 * leaves the request unanswered), records everything the runner sent, and can send notifications and
 * server requests of its own.
 */
function fakeAppServer(handlers: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 4242, exitCode: null });
  const sent: Message[] = [];
  const answers = new Map<number | string, Message>();
  createInterface({ input: stdin }).on("line", (line) => {
    const msg = JSON.parse(line) as Message;
    sent.push(msg);
    if (msg.method && msg.id !== undefined) {
      const handler = handlers[msg.method];
      const result = handler ? handler(msg.params ?? {}) : {};
      if (result !== undefined) stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
    } else if (msg.id !== undefined) {
      answers.set(msg.id, msg);
    }
  });
  const send = (msg: Message) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  return {
    child: child as unknown as ChildProcess,
    emitter: child,
    sent,
    stderr,
    notify: (method: string, params: Record<string, unknown> = {}) => send({ method, params }),
    request: (id: number | string, method: string, params: Record<string, unknown>) =>
      send({ id, method, params }),
    answer: async (id: number | string) => {
      await vi.waitFor(() => expect(answers.has(id)).toBe(true));
      return answers.get(id);
    },
    raw: (line: string) => stdout.write(`${line}\n`),
    methods: () => sent.map((m) => m.method),
  };
}

const happy = {
  initialize: () => ({}),
  "thread/start": () => ({ thread: { id: "thread-1" } }),
  "thread/name/set": () => ({}),
  "turn/start": () => ({}),
  "turn/interrupt": () => ({}),
};

const startArgs = {
  runId: "run1",
  prompt: "Work on WEB-1 in Yokka (launch r_abc123).",
  cwd: "/work/web",
  name: "WEB-1 · r_abc123",
  mcp: { url: "https://x.convex.site/mcp", link: null, token: "wb_secret" },
  dir: "/tmp/run1",
};

beforeEach(() => {
  proc.run.mockReset();
  proc.start.mockReset();
  proc.killTree.mockClear();
});

describe("codex adapter: start", () => {
  it("starts a thread with the run's MCP server over stdin, then the first turn", async () => {
    const server = fakeAppServer(happy);
    proc.start.mockReturnValue(server.child);
    const adapter = codexAdapter({ ...defaults().agents.codex, model: "gpt-5.6-sol" });
    const session = await adapter.start(startArgs, {});
    expect(proc.start).toHaveBeenCalledWith("codex", ["app-server"], { cwd: "/work/web" });
    expect(session.sessionId).toBe("thread-1");
    expect(server.methods()).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "thread/name/set",
      "turn/start",
    ]);
    const thread = server.sent.find((m) => m.method === "thread/start")?.params;
    expect(thread).toEqual({
      cwd: "/work/web",
      model: "gpt-5.6-sol",
      sandbox: "workspace-write",
      approvalPolicy: "never",
      config: {
        mcp_servers: {
          yokka: { url: "https://x.convex.site/mcp", http_headers: { Authorization: "Bearer wb_secret" } },
        },
      },
    });
    expect(server.sent.find((m) => m.method === "turn/start")?.params).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: startArgs.prompt }],
    });
    await expect(session.state()).resolves.toBe("working");
  });

  it("uses the connector link when the workspace allows links", async () => {
    const server = fakeAppServer(happy);
    proc.start.mockReturnValue(server.child);
    await codexAdapter(defaults().agents.codex).start(
      { ...startArgs, mcp: { ...startArgs.mcp, link: "https://x.convex.site/mcp/c/wb_secret" } },
      {},
    );
    const thread = server.sent.find((m) => m.method === "thread/start")?.params as {
      config: unknown;
      model: unknown;
    };
    expect(thread.config).toEqual({
      mcp_servers: { yokka: { url: "https://x.convex.site/mcp/c/wb_secret" } },
    });
    expect(thread.model).toBeNull();
  });

  it("ends a half-started app-server and says why", async () => {
    const server = fakeAppServer({
      ...happy,
      "thread/start": () => {
        server.stderr.write("model not available\n");
        return { thread: {} };
      },
    });
    proc.start.mockReturnValue(server.child);
    await expect(codexAdapter(defaults().agents.codex).start(startArgs, {})).rejects.toThrow(
      "codex started no thread (model not available)",
    );
    expect(proc.killTree).toHaveBeenCalledWith(server.child);
  });

  it("fails cleanly when codex can't start at all", async () => {
    const server = fakeAppServer();
    proc.start.mockReturnValue(server.child);
    const starting = codexAdapter(defaults().agents.codex).start(startArgs, {});
    server.emitter.emit("error", new Error("spawn codex ENOENT"));
    await expect(starting).rejects.toThrow("codex couldn't start: spawn codex ENOENT");
    expect(proc.killTree).toHaveBeenCalled();
  });

  it("gives up on a request the app-server never answers", async () => {
    vi.useFakeTimers();
    try {
      const server = fakeAppServer({ initialize: () => undefined });
      proc.start.mockReturnValue(server.child);
      const starting = codexAdapter(defaults().agents.codex).start(startArgs, {});
      const check = expect(starting).rejects.toThrow("codex initialize got no answer within 60 s");
      await vi.advanceTimersByTimeAsync(60_000);
      await check;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("codex adapter: a running thread", () => {
  async function running(events = {}) {
    const server = fakeAppServer(happy);
    proc.start.mockReturnValue(server.child);
    const session = await codexAdapter(defaults().agents.codex).start(startArgs, events);
    return { server, session };
  }

  it("follows turns and sends the thread link once", async () => {
    const openUrl = vi.fn();
    const { server, session } = await running({ openUrl });
    server.notify("turn/started", { turn: { id: "turn-1" } });
    server.notify("item/completed", { item: { type: "agentMessage", text: "Which option?" } });
    server.notify("item/completed", { item: { type: "reasoning" } });
    server.notify("turn/completed", { turn: { status: "completed" } });
    await vi.waitFor(async () => expect(await session.state()).toBe("idle"));
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith("codex://threads/thread-1");
  });

  it("pauses by interrupting the turn, keeping the app-server and the thread", async () => {
    const { server, session } = await running();
    server.notify("turn/started", { turn: { id: "turn-3" } });
    await vi.waitFor(async () => expect(await session.state()).toBe("working"));
    await session.pause();
    expect(server.sent.find((m) => m.method === "turn/interrupt")?.params).toEqual({
      threadId: "thread-1",
      turnId: "turn-3",
    });
    expect(proc.killTree).not.toHaveBeenCalled();
    await expect(session.state()).resolves.toBe("idle");
  });

  it("pauses an idle thread without interrupting anything", async () => {
    const { server, session } = await running();
    server.notify("turn/completed", { turn: {} });
    await vi.waitFor(async () => expect(await session.state()).toBe("idle"));
    await session.pause();
    expect(server.methods()).not.toContain("turn/interrupt");
  });

  it("resumes with a new turn on the same thread", async () => {
    const { server, session } = await running();
    server.notify("turn/completed", { turn: {} });
    await vi.waitFor(async () => expect(await session.state()).toBe("idle"));
    await session.resume("Continue where you left off.");
    const turns = server.sent.filter((m) => m.method === "turn/start");
    expect(turns).toHaveLength(2);
    expect(turns[1]?.params).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "Continue where you left off." }],
    });
    await expect(session.state()).resolves.toBe("working");
  });

  it("stays idle when a resumed turn couldn't start", async () => {
    let turns = 0;
    const server = fakeAppServer({
      ...happy,
      "turn/start": () => (++turns === 1 ? {} : undefined),
    });
    proc.start.mockReturnValue(server.child);
    const session = await codexAdapter(defaults().agents.codex).start(startArgs, {});
    server.notify("turn/completed", { turn: {} });
    await vi.waitFor(async () => expect(await session.state()).toBe("idle"));
    const resuming = session.resume("again");
    await vi.waitFor(() => expect(turns).toBe(2));
    const id = server.sent.filter((m) => m.method === "turn/start")[1]?.id;
    server.raw(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -1, message: "thread busy" } }));
    await expect(resuming).rejects.toThrow('codex: {"code":-1,"message":"thread busy"}');
    await expect(session.state()).resolves.toBe("idle");
  });

  it("reports a failed turn and a dead app-server as crashed", async () => {
    const { server, session } = await running();
    server.notify("turn/completed", { turn: { status: "failed", error: { message: "rate limited" } } });
    await vi.waitFor(async () => expect(await session.state()).toBe("crashed"));
    await expect(session.blockedReason?.()).resolves.toContain("rate limited");
    const other = await running();
    other.server.emitter.emit("exit", 1);
    await expect(other.session.state()).resolves.toBe("crashed");
    await expect(other.session.blockedReason?.()).resolves.toBe("codex app-server exited (1)");
    await expect(other.session.pause()).rejects.toThrow("codex app-server exited (1)");
    await expect(other.session.resume("x")).rejects.toThrow("codex app-server exited (1)");
  });

  it("interrupts the turn and ends the process on stop and handover", async () => {
    const { server, session } = await running();
    server.notify("turn/started", { turn: { id: "turn-9" } });
    await vi.waitFor(async () => expect(await session.state()).toBe("working"));
    await session.stop();
    expect(server.sent.find((m) => m.method === "turn/interrupt")?.params).toEqual({
      threadId: "thread-1",
      turnId: "turn-9",
    });
    expect(proc.killTree).toHaveBeenCalledWith(server.child);
    await expect(session.handOff()).resolves.toBe("codex://threads/thread-1");
    await session.detach();
    expect(proc.killTree).toHaveBeenCalledTimes(3);
  });
});

describe("codex adapter: requests from Codex", () => {
  async function started() {
    const output = captureOutput();
    const server = fakeAppServer(happy);
    proc.start.mockReturnValue(server.child);
    await codexAdapter(defaults().agents.codex).start(startArgs, {});
    return { server, output };
  }

  it("pre-approves the run's own MCP server and declines any other", async () => {
    const { server, output } = await started();
    server.request(5, "mcpServer/elicitation/request", { serverName: "yokka", message: "claim_card" });
    expect((await server.answer(5))?.result).toEqual({ action: "accept", content: {} });
    server.request(6, "mcpServer/elicitation/request", { serverName: "github", message: "push" });
    expect((await server.answer(6))?.result).toEqual({ action: "decline", content: null });
    // An elicitation isn't something approvals off would have prevented: no advice to change the policy.
    expect(output.errors()).toBe("");
  });

  it("declines permission requests in Codex's shape and says how to stop them", async () => {
    const { server, output } = await started();
    server.request(1, "execCommandApproval", { callId: "c-1", command: ["rm", "-rf", "/"] });
    expect((await server.answer(1))?.result).toEqual({ decision: "denied" });
    server.request(2, "applyPatchApproval", { callId: "c-2" });
    expect((await server.answer(2))?.result).toEqual({ decision: "denied" });
    server.request(3, "item/commandExecution/requestApproval", { itemId: "i-1", command: "npm test" });
    expect((await server.answer(3))?.result).toEqual({ decision: "decline" });
    server.request(4, "item/fileChange/requestApproval", { itemId: "i-2" });
    expect((await server.answer(4))?.result).toEqual({ decision: "decline" });
    expect(output.errors()).toContain(
      "Codex asked for item/commandExecution/requestApproval, which the runner doesn't answer; declined. Set agents.codex.approvalPolicy to \"never\" so it doesn't ask.",
    );
  });

  it("refuses extra permissions and requests it doesn't know with a JSON-RPC error", async () => {
    const { server, output } = await started();
    server.request(7, "item/permissions/requestApproval", { permissions: { network: true } });
    expect((await server.answer(7))?.error).toEqual({ code: -32000, message: "declined" });
    server.request(8, "account/login", {});
    const answer = await server.answer(8);
    expect(answer?.error).toEqual({ code: -32000, message: "declined" });
    expect(answer?.result).toBeUndefined();
    expect(output.errors()).toContain("Codex asked for account/login");
  });
});

describe("codex adapter: detect and adopt", () => {
  it("checks the CLI, its app-server and the sign-in", async () => {
    const adapter = codexAdapter(defaults().agents.codex);
    proc.run.mockResolvedValue({ code: 0, stdout: "codex-cli 0.154.0", stderr: "" });
    await expect(adapter.detect()).resolves.toEqual({ version: "0.154.0" });
    proc.run.mockResolvedValueOnce({ code: 127, stdout: "", stderr: "" });
    await expect(adapter.detect()).resolves.toMatchObject({
      problem: "`codex` isn't installed or isn't on PATH",
    });
    proc.run
      .mockResolvedValueOnce({ code: 0, stdout: "0.1.0", stderr: "" })
      .mockResolvedValueOnce({ code: 2, stdout: "", stderr: "" });
    await expect(adapter.detect()).resolves.toMatchObject({
      problem: expect.stringContaining("no app-server"),
    });
    proc.run
      .mockResolvedValueOnce({ code: 0, stdout: "0.1.0", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" });
    await expect(adapter.detect()).resolves.toMatchObject({ problem: "not signed in; run `codex login`" });
  });

  it("never adopts: threads end with the runner's app-server", async () => {
    await expect(
      codexAdapter(defaults().agents.codex).adopt(
        {
          runId: "r",
          attempt: 1,
          agent: "codex",
          ref: "X-1",
          launchCode: "r_abc123",
          projectId: "p",
          cwd: "/w",
          worktree: false,
          startedAt: 1,
        },
        {},
      ),
    ).resolves.toBeNull();
  });
});

describe("AppServer", () => {
  it("ignores lines that aren't JSON-RPC and answers for unknown ids", async () => {
    const server = fakeAppServer({ ping: () => "pong" });
    const rpc = new AppServer(server.child);
    server.raw("not json");
    server.raw("[1,2]");
    server.raw(JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }));
    server.raw(JSON.stringify({ jsonrpc: "2.0" }));
    await expect(rpc.request("ping", {})).resolves.toBe("pong");
    // An error answer rejects the request with Codex's own words.
    const failing = fakeAppServer({ "thread/start": () => undefined });
    const rpc2 = new AppServer(failing.child);
    const pending = rpc2.request("thread/start", {});
    await vi.waitFor(() => expect(failing.sent).toHaveLength(1));
    failing.raw(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "bad model" } }));
    await expect(pending).rejects.toThrow('codex: {"code":-1,"message":"bad model"}');
  });
});
