import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Adapter, AgentState, Detected, SessionEvents, StartArgs } from "../src/adapters/types.ts";
import type { LedgerEntry } from "../src/ledger.ts";
import type { Reading } from "../src/usage.ts";

const workspace = vi.hoisted(() => ({
  prepare: vi.fn(),
  gitState: vi.fn(),
  cleanup: vi.fn(),
}));

vi.mock("../src/workspace.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/workspace.ts")>()),
  prepare: workspace.prepare,
  gitState: workspace.gitState,
  cleanup: workspace.cleanup,
}));

const { liveClient } = await import("../src/api.ts");
const configModule = await import("../src/config.ts");
const { Daemon, POLL_MS, RESUME_PROMPT, USAGE_EVERY_MS, USAGE_WATCH_MS, contentTypeOf, runDaemon } =
  await import("../src/daemon.ts");
const { putEntry, readLedger } = await import("../src/ledger.ts");
const { PrepareError } = await import("../src/workspace.ts");
const { claimOk, hello, workRun } = await import("./fixtures.ts");
const { captureOutput, fakeTransport, tempDir, tempHome } = await import("./helpers.ts");

const TOKEN = `yr_${"abcd".repeat(10)}`;
const SERVER = "https://happy-cat-1.convex.cloud";
const NO_RETRY = { attempts: 1, baseMs: 1, maxMs: 1, retryable: () => false };

type FakeSession = ReturnType<typeof fakeSession>;

function fakeSession(id = "sess-1") {
  const session = {
    sessionId: id,
    shortId: "0a1b2c3d",
    current: "working" as AgentState,
    state: vi.fn(async () => session.current),
    blockedReason: vi.fn(async (): Promise<string | undefined> => "waiting in the Claude app"),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async (_text: string) => undefined),
    stop: vi.fn(async () => undefined),
    handOff: vi.fn(async (): Promise<string | undefined> => "codex://threads/t1"),
    detach: vi.fn(async () => undefined),
  };
  return session;
}

function fakeAdapter(id: "claude-code" | "codex", session: FakeSession) {
  const started: { args: StartArgs; events: SessionEvents }[] = [];
  const adapter = {
    id,
    label: id === "codex" ? "Codex" : "Claude Code",
    detect: vi.fn(async (): Promise<Detected> => ({ version: "1.2.3" })),
    start: vi.fn(async (args: StartArgs, events: SessionEvents) => {
      started.push({ args, events });
      return session;
    }),
    adopt: vi.fn(async (_entry: LedgerEntry, _events: SessionEvents): Promise<FakeSession | null> => null),
  };
  return { adapter: adapter satisfies Adapter, started };
}

async function settle() {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
}

function setup(
  opts: {
    agent?: "claude-code" | "codex";
    maxConcurrent?: number;
    /** The protocol the server announces in `hello`. */
    protocol?: number;
    handlers?: Record<string, (a: Record<string, unknown>) => unknown>;
  } = {},
) {
  const home = tempHome();
  const folder = realpathSync(tempDir("yokka-project-"));
  const output = captureOutput();
  const agent = opts.agent ?? "claude-code";
  const session = fakeSession();
  const { adapter, started } = fakeAdapter(agent, session);
  const fake = fakeTransport({
    claim: () => ({ ...claimOk, agent }),
    update: () => ({ ok: true }),
    heartbeat: () => ({ stop: [] }),
    uploaded: () => ({ ok: true }),
    usage: () => ({ ok: true }),
    ...opts.handlers,
  });
  const config = {
    ...configModule.defaults(),
    server: SERVER,
    token: TOKEN,
    maxConcurrent: opts.maxConcurrent ?? 2,
    projects: { p1: { name: "Web", path: folder, mode: "in_place" as const } },
  };
  const live = liveClient(fake.transport, TOKEN, NO_RETRY);
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("ok"));
  const daemon = new Daemon(config, {
    live,
    adapters: new Map([[agent, adapter]]),
    detected: new Map([[agent, { version: "1.2.3" }]]),
    hello: { ...hello, protocol: opts.protocol ?? hello.protocol },
    server: SERVER,
    fetch: fetchMock as unknown as typeof fetch,
  });
  const fatal = vi.fn();
  daemon.onFatal = fatal;
  return { home, folder, output, session, adapter, started, fake, config, daemon, fatal, fetchMock };
}

/** Starts the daemon and lets it take the queued run from the fixtures. */
async function launched(opts: Parameters<typeof setup>[0] = {}) {
  const t = setup(opts);
  t.daemon.start();
  t.fake.push({ revoked: false, runs: [{ ...workRun, agent: opts.agent ?? "claude-code" }] });
  await settle();
  return t;
}

/** The run as the server lists it once this runner holds it. */
const held = (extra: Record<string, unknown> = {}) => ({
  ...workRun,
  attempt: 1,
  status: "running",
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers();
  workspace.prepare.mockReset().mockImplementation(async (project: { path: string }) => ({
    cwd: project.path,
    worktree: false,
    branch: "main",
  }));
  workspace.gitState.mockReset().mockResolvedValue({ branch: "main", worktree: false, ahead: 1, dirty: 0 });
  workspace.cleanup.mockReset().mockResolvedValue(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("taking a run", () => {
  it("claims a queued run, prepares its folder, starts the agent and reports it launched", async () => {
    const t = await launched();
    expect(t.fake.callsTo("claim")[0]?.args).toMatchObject({ runId: "run1" });
    expect(workspace.prepare).toHaveBeenCalledWith(
      t.config.projects.p1,
      "in_place",
      { ref: "WEB-1", title: "Fix the thing", launchCode: "r_abc123" },
      false,
    );
    expect(t.started[0]?.args).toMatchObject({
      runId: "run1",
      cwd: t.folder,
      name: "WEB-1 · r_abc123",
      prompt: claimOk.prompt,
      dir: join(t.home, "runs", "run1"),
    });
    expect(t.fake.callsTo("update")[0]?.args).toMatchObject({
      runId: "run1",
      attempt: 1,
      status: "launched",
      clientSessionId: "sess-1",
      git: { branch: "main", worktree: false },
    });
    expect(readLedger()).toEqual([
      expect.objectContaining({ runId: "run1", attempt: 1, shortId: "0a1b2c3d", mcpUrl: claimOk.mcp.url }),
    ]);
    expect(t.daemon.held()).toEqual([{ runId: "run1", attempt: 1, ref: "WEB-1" }]);
  });

  it("leaves a run alone when the claim says no", async () => {
    const t = setup({ handlers: { claim: () => ({ ok: false, reason: "no longer queued" }) } });
    t.daemon.start();
    t.fake.push({ revoked: false, runs: [workRun] });
    await settle();
    expect(t.adapter.start).not.toHaveBeenCalled();
    expect(t.daemon.held()).toEqual([]);
    // One claim per update: a refusal (a limit, say) never turns into a stream of claims.
    expect(t.fake.callsTo("claim")).toHaveLength(1);
    t.fake.push({ revoked: false, runs: [workRun] });
    await settle();
    expect(t.fake.callsTo("claim")).toHaveLength(2);
  });

  it("doesn't claim a run again right after it failed to start", async () => {
    const t = setup();
    workspace.prepare.mockRejectedValueOnce(new PrepareError("nope"));
    t.daemon.start();
    t.fake.push({ revoked: false, runs: [workRun] });
    await settle();
    expect(t.fake.callsTo("claim")).toHaveLength(1);
  });

  it("reports a run it can't start as failed, with the reason", async () => {
    const t = setup();
    workspace.prepare.mockRejectedValueOnce(new PrepareError("the folder has 2 uncommitted changes"));
    t.daemon.start();
    t.fake.push({ revoked: false, runs: [workRun] });
    await settle();
    expect(t.fake.callsTo("update").at(-1)?.args).toMatchObject({
      status: "failed",
      note: "the folder has 2 uncommitted changes",
    });
    expect(t.daemon.held()).toEqual([]);
    expect(readLedger()).toEqual([]);
  });

  it("reports an agent that fails to start", async () => {
    const t = setup();
    t.adapter.start.mockRejectedValueOnce(new Error("claude --bg didn't start a session"));
    t.daemon.start();
    t.fake.push({ revoked: false, runs: [workRun] });
    await settle();
    expect(t.fake.callsTo("update").at(-1)?.args).toMatchObject({
      status: "failed",
      note: "couldn't start Claude Code: claude --bg didn't start a session",
    });
  });

  it("fails a claim for an agent or project it has nothing for", async () => {
    const t = setup({ handlers: { claim: () => ({ ...claimOk, agent: "cursor" }) } });
    t.daemon.start();
    t.fake.push({ revoked: false, runs: [workRun] });
    await settle();
    expect(t.fake.callsTo("update").at(-1)?.args).toMatchObject({
      status: "failed",
      note: "this runner can't start cursor",
    });
    const u = setup({ handlers: { claim: () => ({ ...claimOk, projectId: "p9" }) } });
    u.daemon.start();
    u.fake.push({ revoked: false, runs: [workRun] });
    await settle();
    expect(u.fake.callsTo("update").at(-1)?.args).toMatchObject({
      status: "failed",
      note: "this runner has no folder for the project any more",
    });
  });

  it("doesn't claim what it can't run: another agent, an unmapped project, a busy folder, a full runner", async () => {
    const t = await launched({ maxConcurrent: 1 });
    t.fake.push({
      revoked: false,
      runs: [
        held(),
        { ...workRun, runId: "run2", agent: "codex" },
        { ...workRun, runId: "run3", projectId: "p9" },
        { ...workRun, runId: "run4" },
        { ...workRun, runId: "run5", agent: null },
      ],
    });
    await settle();
    expect(t.fake.callsTo("claim")).toHaveLength(1);
  });

  it("logs a claim that fails and moves on", async () => {
    const t = setup({
      handlers: {
        claim: () => {
          throw new Error("network down");
        },
      },
    });
    t.daemon.start();
    t.fake.push({ revoked: false, runs: [workRun] });
    await settle();
    expect(t.output.errors()).toContain("Couldn't take a run: network down");
  });
});

describe("watching a session", () => {
  it("flags a blocked session on the card once, with where to answer, and reports running once it moves", async () => {
    const t = await launched();
    t.session.current = "blocked";
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.fake.callsTo("update").at(-1)?.args).toMatchObject({
      status: "waiting_approval",
      note: "waiting in the Claude app",
    });
    expect(t.output.text()).toContain("WEB-1: needs you in Claude Code");
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.fake.callsTo("update").filter((c) => c.args.status === "waiting_approval")).toHaveLength(1);
    t.session.current = "working";
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.fake.callsTo("update").at(-1)?.args).toMatchObject({ status: "running" });
  });

  it("reports running again when a flagged session goes idle", async () => {
    const t = await launched();
    t.session.current = "blocked";
    t.session.blockedReason.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.fake.callsTo("update").at(-1)?.args).not.toHaveProperty("note");
    t.session.current = "idle";
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.fake.callsTo("update").map((c) => c.args.status)).toEqual([
      "launched",
      "waiting_approval",
      "running",
    ]);
  });

  it("leaves a run the card already asks about (waiting_input) alone", async () => {
    const t = await launched();
    t.session.current = "blocked";
    t.fake.push({ revoked: false, runs: [held({ status: "waiting_input" })] });
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(t.fake.callsTo("update").map((c) => c.args.status)).toEqual(["launched"]);
    expect(t.output.text()).not.toContain("needs you");
  });

  it("doesn't report a working or idle session that was never flagged", async () => {
    const t = await launched();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    t.session.current = "idle";
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.session.state).toHaveBeenCalledTimes(2);
    expect(t.fake.callsTo("update").map((c) => c.args.status)).toEqual(["launched"]);
  });

  it("ends a crashed run as failed with git state, and tidies up", async () => {
    const t = await launched();
    const mcpFile = join(t.home, "runs", "run1", "mcp.json");
    writeFileSync(
      mcpFile,
      JSON.stringify({ mcpServers: { yokka: { headers: { Authorization: "Bearer wb_x" } } } }),
    );
    t.session.current = "crashed";
    t.session.blockedReason.mockResolvedValue("Claude Code stopped: API error");
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.fake.callsTo("update").at(-1)?.args).toMatchObject({
      status: "failed",
      note: "Claude Code stopped: API error",
      git: { branch: "main", ahead: 1 },
    });
    expect(t.daemon.held()).toEqual([]);
    expect(readLedger()).toEqual([]);
    expect(JSON.parse(readFileSync(mcpFile, "utf8"))).toEqual({ mcpServers: {} });
    expect(workspace.cleanup).toHaveBeenCalled();
  });

  it("ends a session stopped on this machine as cancelled", async () => {
    const t = await launched();
    t.session.current = "stopped";
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.fake.callsTo("update").at(-1)?.args).toMatchObject({
      status: "cancelled",
      note: "the session was stopped on this machine",
    });
    expect(t.session.stop).not.toHaveBeenCalled();
  });

  it("logs a poll that fails and keeps polling", async () => {
    const t = await launched();
    t.session.state.mockRejectedValueOnce(new Error("claude agents timed out"));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.output.errors()).toContain("WEB-1: claude agents timed out");
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.session.state).toHaveBeenCalledTimes(2);
  });
});

describe("what the board asks for", () => {
  it("stops a run cancelled on the board", async () => {
    const t = await launched();
    t.fake.push({ revoked: false, runs: [held({ cancel: true })] });
    await settle();
    expect(t.session.stop).toHaveBeenCalled();
    expect(t.fake.callsTo("update").at(-1)?.args).toMatchObject({
      status: "cancelled",
      note: "stopped from the board",
    });
  });

  it("hands a run over and stops watching it", async () => {
    const t = await launched({ agent: "codex" });
    t.fake.push({ revoked: false, runs: [held({ agent: "codex", handOff: true })] });
    await settle();
    expect(t.fake.callsTo("update").at(-1)?.args).toMatchObject({
      status: "handed_off",
      openUrl: "codex://threads/t1",
    });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.session.state).not.toHaveBeenCalled();
  });

  it("lets go of a run the server ended, keeping the session", async () => {
    const t = await launched();
    t.fake.push({ revoked: false, runs: [] });
    await settle();
    expect(t.session.detach).toHaveBeenCalled();
    expect(t.session.stop).not.toHaveBeenCalled();
    expect(t.fake.callsTo("update").at(-1)?.args).toEqual({
      token: TOKEN,
      runId: "run1",
      attempt: 1,
      git: { branch: "main", worktree: false, ahead: 1, dirty: 0 },
    });
    expect(t.daemon.held()).toEqual([]);
  });

  it("ignores updates for an older attempt", async () => {
    const t = await launched();
    t.fake.push({ revoked: false, runs: [held({ attempt: 0, cancel: true })] });
    await settle();
    expect(t.session.stop).not.toHaveBeenCalled();
  });

  it("stops the runs the heartbeat names", async () => {
    let stop: string[] = [];
    const t = await launched({ handlers: { heartbeat: () => ({ stop }) } });
    expect(t.fake.callsTo("heartbeat")[0]?.args).toMatchObject({ runs: [] });
    stop = ["run1"];
    await vi.advanceTimersByTimeAsync(hello.heartbeatMs);
    expect(t.fake.callsTo("heartbeat").at(-1)?.args).toMatchObject({ runs: [{ runId: "run1", attempt: 1 }] });
    expect(t.session.stop).toHaveBeenCalled();
    expect(t.daemon.held()).toEqual([]);
  });

  it("stops everything when the runner is disconnected", async () => {
    const t = await launched({
      handlers: {
        heartbeat: () => {
          throw new ConvexError({ code: "unauthenticated", message: "This runner was disconnected." });
        },
      },
    });
    expect(t.fatal).toHaveBeenCalledWith("This runner was disconnected.");
    t.fake.push({ revoked: true, runs: [] });
    expect(t.fatal).toHaveBeenLastCalledWith(expect.stringContaining("Run `yokka-runner login`"));
  });

  it("just warns when a heartbeat fails for another reason", async () => {
    const t = await launched({
      handlers: {
        heartbeat: () => {
          throw new Error("socket hang up");
        },
      },
    });
    expect(t.fatal).not.toHaveBeenCalled();
    expect(t.output.errors()).toContain("Heartbeat failed: socket hang up");
  });
});

describe("the work subscription", () => {
  it("skips an update it can't read and resubscribes after a failed query, with backoff", async () => {
    const t = setup();
    t.daemon.start();
    t.fake.push({ revoked: false, runs: [{ runId: 5 }] });
    expect(t.output.errors()).toContain("Skipped an update from the server the runner can't read");
    expect(t.fake.subscribers).toHaveLength(1);
    t.fake.fail(new Error("Server Error"));
    expect(t.fake.subscribers[0]?.active).toBe(false);
    expect(t.output.errors()).toContain("The server couldn't list this runner's work (Server Error)");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.fake.subscribers).toHaveLength(2);
    t.fake.push({ revoked: false, runs: [workRun] });
    await settle();
    expect(t.fake.callsTo("claim")).toHaveLength(1);
  });
});

describe("pause and resume", () => {
  const statuses = (t: { fake: { callsTo: (n: string) => { args: Record<string, unknown> }[] } }) =>
    t.fake.callsTo("update").map((c) => c.args.status);

  it("pauses a run paused on the board, reports it, and stops watching it", async () => {
    const t = await launched();
    t.fake.push({ revoked: false, runs: [held({ pause: true })] });
    await settle();
    expect(t.session.pause).toHaveBeenCalledTimes(1);
    expect(t.fake.callsTo("update").at(-1)?.args).toEqual({
      token: TOKEN,
      runId: "run1",
      attempt: 1,
      status: "paused",
    });
    expect(readLedger()[0]?.paused).toBe(true);
    expect(t.output.text()).toContain("WEB-1: paused");
    // The same wish again, and the polls, leave a paused run alone.
    t.fake.push({ revoked: false, runs: [held({ status: "paused", pause: true })] });
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(t.session.pause).toHaveBeenCalledTimes(1);
    expect(t.session.state).not.toHaveBeenCalled();
  });

  it("resumes the same session when the pause is cleared, and watches it again", async () => {
    const t = await launched();
    t.fake.push({ revoked: false, runs: [held({ pause: true })] });
    await settle();
    t.fake.push({ revoked: false, runs: [held({ status: "paused", pause: false })] });
    await settle();
    expect(t.session.resume).toHaveBeenCalledTimes(1);
    expect(t.session.resume).toHaveBeenCalledWith(RESUME_PROMPT);
    expect(RESUME_PROMPT).toBe("Continue where you left off.");
    expect(statuses(t)).toEqual(["launched", "paused", "running"]);
    expect(readLedger()[0]?.paused).toBe(false);
    expect(t.output.text()).toContain("WEB-1: resumed");
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.session.state).toHaveBeenCalledTimes(1);
    expect(t.session.resume).toHaveBeenCalledTimes(1);
  });

  it("stops a run cancelled on the board rather than pausing it", async () => {
    const t = await launched();
    t.fake.push({ revoked: false, runs: [held({ pause: true, cancel: true })] });
    await settle();
    expect(t.session.pause).not.toHaveBeenCalled();
    expect(t.session.stop).toHaveBeenCalledTimes(1);
    expect(statuses(t)).toEqual(["launched", "cancelled"]);
  });

  it("stops a paused run cancelled on the board without resuming it", async () => {
    const t = await launched();
    t.fake.push({ revoked: false, runs: [held({ pause: true })] });
    await settle();
    t.fake.push({ revoked: false, runs: [held({ status: "paused", pause: false, cancel: true })] });
    await settle();
    expect(t.session.resume).not.toHaveBeenCalled();
    expect(t.session.stop).toHaveBeenCalledTimes(1);
    expect(statuses(t)).toEqual(["launched", "paused", "cancelled"]);
  });

  it("hands a run over rather than pausing it", async () => {
    const t = await launched({ agent: "codex" });
    t.fake.push({ revoked: false, runs: [held({ agent: "codex", pause: true, handOff: true })] });
    await settle();
    expect(t.session.pause).not.toHaveBeenCalled();
    expect(t.session.handOff).toHaveBeenCalledTimes(1);
    expect(statuses(t)).toEqual(["launched", "handed_off"]);
  });

  it("acts on a pause that arrived while the run was busy at the next poll", async () => {
    const t = await launched();
    let release: (state: "working") => void = () => undefined;
    t.session.state.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.session.state).toHaveBeenCalledTimes(1);
    // The poll is still waiting on the session: the wish can't be acted on yet.
    t.fake.push({ revoked: false, runs: [held({ pause: true })] });
    await settle();
    expect(t.session.pause).not.toHaveBeenCalled();
    release("working");
    await settle();
    expect(t.session.pause).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.session.pause).toHaveBeenCalledTimes(1);
    expect(statuses(t)).toEqual(["launched", "paused"]);
  });

  it("warns about a pause that failed, reports nothing, and tries again", async () => {
    const t = await launched();
    t.session.pause.mockRejectedValueOnce(new Error("Claude didn't stop the session"));
    t.fake.push({ revoked: false, runs: [held({ pause: true })] });
    await settle();
    expect(t.output.errors()).toContain("WEB-1: couldn't pause: Claude didn't stop the session");
    expect(statuses(t)).toEqual(["launched"]);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.session.pause).toHaveBeenCalledTimes(2);
    expect(statuses(t)).toEqual(["launched", "paused"]);
  });

  it("warns about a resume that failed and stays paused until it works", async () => {
    const t = await launched();
    t.fake.push({ revoked: false, runs: [held({ pause: true })] });
    await settle();
    t.session.resume.mockRejectedValueOnce(new Error("Claude kept the session busy; try Resume again"));
    t.fake.push({ revoked: false, runs: [held({ status: "paused", pause: false })] });
    await settle();
    expect(t.output.errors()).toContain(
      "WEB-1: couldn't resume: Claude kept the session busy; try Resume again",
    );
    expect(statuses(t)).toEqual(["launched", "paused"]);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.session.resume).toHaveBeenCalledTimes(2);
    expect(statuses(t)).toEqual(["launched", "paused", "running"]);
  });
});

describe("session events", () => {
  it("reports the session's link", async () => {
    const t = await launched();
    t.started[0]?.events.openUrl?.("https://claude.ai/code/session_1");
    await settle();
    expect(t.fake.callsTo("update").at(-1)?.args).toMatchObject({
      openUrl: "https://claude.ai/code/session_1",
    });
  });
});

describe("uploads", () => {
  const upload = (path: string, uploadUrl = "https://happy-cat-1.convex.site/mcp/upload/secret") => ({
    _id: `u-${path}`,
    path,
    uploadUrl,
  });

  it("PUTs a file from the run's folder to the upload link", async () => {
    const t = await launched();
    mkdirSync(join(t.folder, "shots"));
    writeFileSync(join(t.folder, "shots", "after.png"), "png-bytes");
    t.fake.push({ revoked: false, runs: [held({ uploads: [upload("shots/after.png")] })] });
    await settle();
    const [url, init] = t.fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://happy-cat-1.convex.site/mcp/upload/secret");
    expect(init).toMatchObject({
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      redirect: "error",
    });
    expect(t.fake.callsTo("uploaded")[0]?.args).toEqual({
      token: TOKEN,
      runId: "run1",
      attempt: 1,
      uploadId: "u-shots/after.png",
    });
    // The same upload listed again isn't sent twice.
    t.fake.push({ revoked: false, runs: [held({ uploads: [upload("shots/after.png")] })] });
    await settle();
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses files outside the run's folder, missing files and foreign links", async () => {
    const t = await launched();
    const outside = tempDir("yokka-outside-");
    writeFileSync(join(outside, "secret.txt"), "x");
    writeFileSync(join(t.folder, "ok.txt"), "x");
    mkdirSync(join(t.folder, "dir"));
    t.fake.push({
      revoked: false,
      runs: [
        held({
          uploads: [
            upload(join("..", outside.split(/[\\/]/).at(-1) ?? "", "secret.txt")),
            upload("missing.txt"),
            upload("dir"),
            upload("ok.txt", "https://evil.example.com/mcp/upload/x"),
          ],
        }),
      ],
    });
    await settle();
    expect(t.fetchMock).not.toHaveBeenCalled();
    const errors = t.fake.callsTo("uploaded").map((c) => c.args.error);
    expect(errors).toEqual([
      expect.stringMatching(/is outside the run's folder$/),
      "missing.txt doesn't exist",
      "dir isn't a file",
      "the upload link isn't on this deployment",
    ]);
  });

  it("reports an upload the server refused", async () => {
    const t = await launched();
    t.fetchMock.mockResolvedValueOnce(new Response("too large", { status: 413 }));
    writeFileSync(join(t.folder, "big.bin"), "x");
    t.fake.push({ revoked: false, runs: [held({ uploads: [upload("big.bin")] })] });
    await settle();
    expect(t.fake.callsTo("uploaded")[0]?.args.error).toBe("the upload was refused (413): too large");
  });

  it("knows common content types", () => {
    expect(contentTypeOf("a/b.JPG")).toBe("image/jpeg");
    expect(contentTypeOf("notes")).toBe("application/octet-stream");
  });
});

describe("restarting", () => {
  const entry = {
    runId: "run7",
    attempt: 2,
    agent: "claude-code" as const,
    ref: "WEB-7",
    launchCode: "r_abc123",
    projectId: "p1",
    cwd: "/work",
    worktree: false,
    shortId: "0a1b2c3d",
    sessionId: "s7",
    startedAt: 1,
  };

  it("adopts the sessions a previous runner left, and reports the rest lost", async () => {
    const t = setup();
    putEntry(entry);
    putEntry({ ...entry, runId: "run8", ref: "WEB-8" });
    putEntry({ ...entry, runId: "run9", agent: "codex" });
    t.adapter.adopt.mockImplementation(async (e) => (e.runId === "run7" ? t.session : null));
    await t.daemon.adopt();
    expect(t.daemon.held()).toEqual([{ runId: "run7", attempt: 2, ref: "WEB-7" }]);
    expect(t.fake.callsTo("update").map((c) => [c.args.runId, c.args.status])).toEqual([
      ["run8", "lost"],
      ["run9", "lost"],
    ]);
    expect(readLedger().map((e) => e.runId)).toEqual(["run7"]);
  });

  it("keeps an adopted run paused while the board still asks for it, and resumes it once cleared", async () => {
    const t = setup();
    putEntry({ ...entry, runId: "run1", attempt: 1, ref: "WEB-1", paused: true });
    t.adapter.adopt.mockResolvedValue(t.session);
    await t.daemon.adopt();
    t.daemon.start();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    // Before the board says anything, the stopped session of a paused run isn't mistaken for one that ended.
    expect(t.session.state).not.toHaveBeenCalled();
    t.fake.push({ revoked: false, runs: [held({ status: "paused", pause: true })] });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.session.resume).not.toHaveBeenCalled();
    expect(t.session.pause).not.toHaveBeenCalled();
    expect(t.session.state).not.toHaveBeenCalled();
    t.fake.push({ revoked: false, runs: [held({ status: "paused", pause: false })] });
    await settle();
    expect(t.session.resume).toHaveBeenCalledWith(RESUME_PROMPT);
    expect(t.fake.callsTo("update").map((c) => c.args.status)).toEqual(["running"]);
  });

  it("takes a run's paused status from the board when the ledger doesn't say", async () => {
    const t = setup();
    putEntry({ ...entry, runId: "run1", attempt: 1, ref: "WEB-1" });
    t.adapter.adopt.mockResolvedValue(t.session);
    await t.daemon.adopt();
    t.daemon.start();
    t.fake.push({ revoked: false, runs: [held({ status: "paused", pause: true })] });
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(t.session.pause).not.toHaveBeenCalled();
    expect(t.session.resume).not.toHaveBeenCalled();
    expect(t.session.state).not.toHaveBeenCalled();
    expect(t.fake.callsTo("update")).toEqual([]);
  });
});

describe("shutting down", () => {
  it("lets Claude sessions keep going, reports Codex runs lost, and closes the connection", async () => {
    const t = await launched({ agent: "codex" });
    await t.daemon.shutdown();
    await t.daemon.shutdown();
    expect(t.session.detach).toHaveBeenCalledTimes(1);
    expect(t.fake.callsTo("update").at(-1)?.args).toMatchObject({
      status: "lost",
      note: "the runner stopped",
    });
    expect(t.fake.isClosed()).toBe(true);
    expect(t.fake.subscribers[0]?.active).toBe(false);
    // Nothing runs after shutdown.
    const polls = t.session.state.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(t.session.state).toHaveBeenCalledTimes(polls);
    t.fake.push({ revoked: false, runs: [{ ...workRun, runId: "late" }] });
    await settle();
    expect(t.fake.callsTo("claim")).toHaveLength(1);
  });

  it("keeps a Claude run in the ledger for the next start", async () => {
    const t = await launched();
    await t.daemon.shutdown();
    expect(t.session.detach).toHaveBeenCalled();
    expect(readLedger().map((e) => e.runId)).toEqual(["run1"]);
  });
});

describe("runDaemon", () => {
  function daemonDeps(handlers: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
    const fake = fakeTransport({
      hello: () => hello,
      heartbeat: () => ({ stop: [] }),
      update: () => ({ ok: true }),
      ...handlers,
    });
    const session = fakeSession();
    const { adapter } = fakeAdapter("claude-code", session);
    const signals = new EventEmitter();
    const exit = vi.fn();
    return { fake, adapter, signals, exit, session };
  }

  const signedIn = () => ({
    ...configModule.defaults(),
    server: SERVER,
    token: TOKEN,
    projects: { p1: { name: "Web", path: join(process.cwd(), "web"), mode: "worktree" as const } },
  });

  it("says hello, runs until a signal, then shuts down cleanly", async () => {
    tempHome();
    const output = captureOutput();
    const d = daemonDeps();
    const running = runDaemon(signedIn(), {
      transport: d.fake.transport,
      adapters: new Map([["claude-code", d.adapter]]),
      signals: d.signals,
      exit: d.exit,
    });
    await settle();
    expect(d.fake.callsTo("hello")[0]?.args).toMatchObject({
      agents: [{ agent: "claude-code", version: "1.2.3" }],
      projects: [{ projectId: "p1", mode: "worktree" }],
      maxConcurrent: 2,
    });
    expect(output.text()).toContain('Connected to Acme as "laptop". Projects: Web (worktree).');
    d.signals.emit("SIGINT");
    await running;
    expect(d.fake.isClosed()).toBe(true);
    expect(d.signals.listenerCount("SIGINT")).toBe(0);
    expect(d.exit).not.toHaveBeenCalled();
  });

  it("forces the exit on a second Ctrl-C", async () => {
    tempHome();
    captureOutput();
    const d = daemonDeps();
    d.adapter.detect.mockResolvedValue({ problem: "not signed in" });
    const running = runDaemon(signedIn(), {
      transport: d.fake.transport,
      adapters: new Map([["claude-code", d.adapter]]),
      signals: d.signals,
      exit: d.exit,
    });
    await settle();
    // A slow shutdown: closing the connection hangs.
    d.fake.transport.close = () => new Promise(() => undefined);
    d.signals.emit("SIGTERM");
    d.signals.emit("SIGINT");
    expect(d.exit).toHaveBeenCalledWith(130);
    await vi.advanceTimersByTimeAsync(15_000);
    await running;
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("stops with exit code 1 on a fatal error", async () => {
    tempHome();
    const output = captureOutput();
    const d = daemonDeps({ hello: () => ({ ...hello, protocol: 4 }) });
    const running = runDaemon(signedIn(), {
      transport: d.fake.transport,
      adapters: new Map([["claude-code", d.adapter]]),
      signals: d.signals,
      exit: d.exit,
    });
    await settle();
    expect(output.errors()).toContain("The server speaks runner protocol 4 (this runner 3)");
    d.fake.push({ revoked: true, runs: [] });
    await running;
    expect(process.exitCode).toBe(1);
    expect(output.errors()).toContain("This runner was disconnected from the workspace.");
    process.exitCode = undefined;
  });

  it("explains a refused hello and closes the connection", async () => {
    tempHome();
    captureOutput();
    const d = daemonDeps({
      hello: () => {
        throw new ConvexError({ code: "invalid", message: "This runner is too old for Acme." });
      },
    });
    await expect(
      runDaemon(signedIn(), { transport: d.fake.transport, adapters: new Map(), signals: d.signals }),
    ).rejects.toThrow("This runner is too old for Acme.");
    expect(d.fake.isClosed()).toBe(true);
  });

  it("needs a signed-in config with an HTTPS server", async () => {
    await expect(runDaemon(configModule.defaults())).rejects.toThrow("Not signed in.");
    await expect(runDaemon({ ...signedIn(), server: "http://example.com" })).rejects.toThrow(
      "must start with https://",
    );
  });
});

describe("files", () => {
  it("keeps a run's folder for per-run files", async () => {
    const t = await launched();
    expect(existsSync(join(t.home, "runs", "run1"))).toBe(true);
  });
});

describe("reporting usage", () => {
  const reading = (extra: Partial<Reading> = {}): Reading => ({
    model: "claude-opus-4-5",
    inputTokens: 10,
    outputTokens: 200,
    cacheReadTokens: 3000,
    cacheWriteTokens: 40,
    durationMs: 60_000,
    final: false,
    ...extra,
  });

  /** A launched run whose session reports `current` as its usage. */
  async function measured(opts: Parameters<typeof setup>[0] = {}) {
    const t = await launched({ protocol: 3, ...opts });
    const usage = { current: reading() as Reading | undefined };
    const read = vi.fn(async () => usage.current);
    Object.assign(t.session, { usage: read });
    return { ...t, usage, read };
  }

  const sent = (t: { fake: ReturnType<typeof fakeTransport> }) => t.fake.callsTo("usage").map((c) => c.args);

  it("sends a working run's totals at most once a minute, and only when they changed", async () => {
    const t = await measured();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(sent(t)).toEqual([
      {
        token: TOKEN,
        runId: "run1",
        attempt: 1,
        model: "claude-opus-4-5",
        inputTokens: 10,
        outputTokens: 200,
        cacheReadTokens: 3000,
        cacheWriteTokens: 40,
        durationMs: 60_000,
      },
    ]);
    t.usage.current = reading({ outputTokens: 500 });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(sent(t)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(USAGE_EVERY_MS);
    expect(sent(t).at(-1)).toMatchObject({ outputTokens: 500 });
    const count = sent(t).length;
    await vi.advanceTimersByTimeAsync(USAGE_EVERY_MS);
    expect(sent(t)).toHaveLength(count);
  });

  it("never sends usage to a server older than protocol 3", async () => {
    const t = await measured({ protocol: 2 });
    await vi.advanceTimersByTimeAsync(USAGE_EVERY_MS * 2);
    t.fake.push({ revoked: false, runs: [] });
    await settle();
    expect(t.read).not.toHaveBeenCalled();
    expect(sent(t)).toEqual([]);
  });

  it("sends a run's last totals when it ends, and keeps reading them until Claude writes its cost", async () => {
    const t = await measured();
    t.fake.push({ revoked: false, runs: [] });
    await settle();
    expect(sent(t).at(-1)).toMatchObject({ outputTokens: 200 });
    expect(sent(t).at(-1)).not.toHaveProperty("costUsd");
    expect(sent(t).at(-1)).not.toHaveProperty("final");

    // The person carries on in the app and closes it: the session's cost appears.
    t.usage.current = reading({ outputTokens: 900, costUsd: 1.5, final: true });
    await vi.advanceTimersByTimeAsync(USAGE_EVERY_MS + POLL_MS);
    expect(sent(t).at(-1)).toMatchObject({ outputTokens: 900, costUsd: 1.5 });
    const reads = t.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(USAGE_EVERY_MS * 3);
    expect(t.read.mock.calls.length).toBe(reads);
  });

  it("stops reading a finished run's totals after a day", async () => {
    const t = await measured();
    t.fake.push({ revoked: false, runs: [] });
    await settle();
    await vi.advanceTimersByTimeAsync(USAGE_WATCH_MS + USAGE_EVERY_MS);
    const reads = t.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(USAGE_EVERY_MS * 3);
    expect(t.read.mock.calls.length).toBe(reads);
  });

  it("sends the totals right after a pause, when Claude has just written its cost", async () => {
    const t = await measured();
    t.usage.current = reading({ costUsd: 0.4, final: true });
    t.fake.push({ revoked: false, runs: [held({ pause: true })] });
    await settle();
    expect(sent(t).at(-1)).toMatchObject({ costUsd: 0.4 });
  });

  it("warns about a report the server refused and carries on", async () => {
    const t = await measured({
      handlers: {
        usage: () => {
          throw new ConvexError({ code: "invalid", message: "nope" });
        },
      },
    });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.output.errors()).toContain("WEB-1: couldn't report usage: nope");
    await vi.advanceTimersByTimeAsync(USAGE_EVERY_MS);
    expect(t.fake.callsTo("usage")).toHaveLength(2);
  });
});
