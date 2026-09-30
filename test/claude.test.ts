import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunResult } from "../src/proc.ts";

const proc = vi.hoisted(() => ({
  run: vi.fn<(command: string, args: string[], opts?: { cwd?: string }) => Promise<RunResult>>(),
}));

vi.mock("../src/proc.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/proc.ts")>()),
  run: proc.run,
}));

const { claudeAdapter, failure, parseSessions } = await import("../src/adapters/claude.ts");
const { defaults } = await import("../src/config.ts");
const { tempDir } = await import("./helpers.ts");

const SHORT = "0a1b2c3d";
const SESSION = "11111111-2222-3333-4444-555555555555";
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

type Listed = { id: string; sessionId: string; pid?: number; state?: string };

/** A fake `claude` CLI: `agents` lists `sessions` (or what it returns each time), other subcommands answer from `answers`. */
function fakeClaude(
  sessions: Listed[] | (() => Listed[]),
  answers: Record<string, (args: string[]) => RunResult> = {},
) {
  proc.run.mockImplementation(async (_cmd, args) => {
    const key =
      args[0] === "--bg" && args[1] === "--resume" ? "resume" : args[0] === "--bg" ? "start" : args[0];
    if (key === "agents") return ok(JSON.stringify(typeof sessions === "function" ? sessions() : sessions));
    const answer = key ? answers[key] : undefined;
    return answer ? answer(args) : ok();
  });
}

function setup(now = { t: 1_000_000 }) {
  const claudeHome = tempDir("yokka-claude-");
  const adapter = claudeAdapter(defaults().agents["claude-code"], {
    claudeHome,
    sleep: async () => undefined,
    now: () => now.t,
  });
  return { adapter, claudeHome, now };
}

const startArgs = (dir: string) => ({
  runId: "run1",
  prompt: "Work on WEB-1 in Yokka (launch r_abc123).",
  cwd: "/work/web",
  name: "WEB-1 · r_abc123",
  mcp: { url: "https://x.convex.site/mcp", link: null, token: "wb_secret_token" },
  dir,
});

beforeEach(() => {
  proc.run.mockReset();
});

describe("claude adapter: detect", () => {
  it("is ready when installed, new enough and signed in", async () => {
    fakeClaude([], {
      "--version": () => ok("2.1.285 (Claude Code)"),
      "--help": () => ok("--bg ... --remote-control"),
      auth: () => ok(JSON.stringify({ loggedIn: true })),
    });
    await expect(setup().adapter.detect()).resolves.toEqual({ version: "2.1.285" });
  });

  it("names what's missing", async () => {
    const { adapter } = setup();
    fakeClaude([], { "--version": () => ({ code: 127, stdout: "", stderr: "ENOENT" }) });
    await expect(adapter.detect()).resolves.toEqual({ problem: "`claude` isn't installed or isn't on PATH" });
    fakeClaude([], { "--version": () => ok("2.0.1"), "--help": () => ok("--bg only") });
    await expect(adapter.detect()).resolves.toMatchObject({ problem: expect.stringContaining("too old") });
    fakeClaude([], {
      "--version": () => ok("2.1.285"),
      "--help": () => ok("--bg --remote-control"),
      auth: () => ok(JSON.stringify({ loggedIn: false })),
    });
    await expect(adapter.detect()).resolves.toMatchObject({
      problem: "not signed in; run `claude auth login`",
    });
  });
});

describe("claude adapter: start", () => {
  it("starts a background session with the run's MCP config, never the token on the command line", async () => {
    const dir = tempDir();
    fakeClaude([{ id: SHORT, sessionId: SESSION, pid: 42, state: "working" }], {
      start: () => ok(`session backgrounded · ${SHORT}`),
    });
    const events = { openUrl: vi.fn() };
    const session = await setup().adapter.start(startArgs(dir), events);
    expect(session.sessionId).toBe(SESSION);
    expect(session.shortId).toBe(SHORT);
    const call = proc.run.mock.calls.find(([, args]) => args[0] === "--bg");
    const args = call?.[1] ?? [];
    expect(args).toEqual([
      "--bg",
      "--mcp-config",
      join(dir, "mcp.json"),
      "--allowedTools",
      "mcp__yokka",
      "--permission-mode",
      "acceptEdits",
      "-n",
      "WEB-1 · r_abc123",
      "--remote-control",
      "WEB-1 · r_abc123",
      "Work on WEB-1 in Yokka (launch r_abc123).",
    ]);
    expect(args.join(" ")).not.toContain("wb_secret_token");
    expect(call?.[2]).toMatchObject({ cwd: "/work/web" });
    const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
    expect(mcp.mcpServers.yokka.headers.Authorization).toBe("Bearer wb_secret_token");
  });

  it("passes the model when one is set, and refuses to skip permissions", async () => {
    const dir = tempDir();
    fakeClaude([{ id: SHORT, sessionId: SESSION, pid: 1, state: "working" }], {
      start: () => ok(`backgrounded ${SHORT}`),
    });
    const withModel = claudeAdapter(
      { ...defaults().agents["claude-code"], model: "opus" },
      { sleep: async () => undefined },
    );
    await withModel.start(startArgs(dir), {});
    expect(proc.run.mock.calls.find(([, a]) => a[0] === "--bg")?.[1]).toEqual(
      expect.arrayContaining(["--model", "opus"]),
    );
    const bypass = claudeAdapter({
      ...defaults().agents["claude-code"],
      permissionMode: "bypassPermissions" as "default",
    });
    await expect(bypass.start(startArgs(dir), {})).rejects.toThrow("the runner never skips permissions");
  });

  it("says why a session didn't start", async () => {
    const dir = tempDir();
    fakeClaude([], { start: () => ({ code: 1, stdout: "", stderr: "Error: folder not trusted\n" }) });
    await expect(setup().adapter.start(startArgs(dir), {})).rejects.toThrow("Error: folder not trusted");
    fakeClaude([], { start: () => ok(`backgrounded ${SHORT}`) });
    await expect(setup().adapter.start(startArgs(dir), {})).rejects.toThrow(
      "`claude agents` doesn't list it",
    );
  });

  it("keeps a card's text from being read as an option", async () => {
    const dir = tempDir();
    fakeClaude([{ id: SHORT, sessionId: SESSION, pid: 1, state: "working" }], {
      start: () => ok(`backgrounded ${SHORT}`),
    });
    await setup().adapter.start({ ...startArgs(dir), prompt: "--dangerously-skip-permissions" }, {});
    expect(proc.run.mock.calls.find(([, a]) => a[0] === "--bg")?.[1].at(-1)).toBe(
      " --dangerously-skip-permissions",
    );
  });
});

describe("claude adapter: session state", () => {
  async function started(listed: Listed[], clock = { t: 1_000_000 }) {
    const dir = tempDir();
    const { adapter, claudeHome, now } = setup(clock);
    fakeClaude([{ id: SHORT, sessionId: SESSION, pid: 1, state: "working" }], {
      start: () => ok(`backgrounded ${SHORT}`),
    });
    const openUrl = vi.fn();
    const session = await adapter.start(startArgs(dir), { openUrl });
    fakeClaude(listed, { logs: () => ok("see https://claude.ai/code/session_abc123 for this session") });
    return { session, claudeHome, now, openUrl };
  }

  it("maps Claude's states and sends the session link once", async () => {
    const { session, openUrl, now } = await started([
      { id: SHORT, sessionId: SESSION, pid: 1, state: "working" },
    ]);
    now.t += 5_000;
    await expect(session.state()).resolves.toBe("working");
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://claude.ai/code/session_abc123"));
    now.t += 5_000;
    await session.state();
    await Promise.resolve();
    expect(openUrl).toHaveBeenCalledTimes(1);
    for (const [state, expected] of [
      ["done", "idle"],
      ["failed", "crashed"],
      ["stopped", "stopped"],
    ] as const) {
      now.t += 5_000;
      fakeClaude([{ id: SHORT, sessionId: SESSION, pid: 1, state }]);
      await expect(session.state()).resolves.toBe(expected);
    }
  });

  it("gives a session that's briefly gone a grace period before calling it crashed", async () => {
    const { session, now } = await started([]);
    now.t += 5_000;
    await expect(session.state()).resolves.toBe("working");
    now.t += 21_000;
    await expect(session.state()).resolves.toBe("crashed");
  });

  it("reports any blocked session as blocked: the person answers in the Claude app either way", async () => {
    const { session, now } = await started([{ id: SHORT, sessionId: SESSION, pid: 1, state: "blocked" }]);
    now.t += 5_000;
    await expect(session.state()).resolves.toBe("blocked");
  });

  it("explains why a session is blocked or failed", async () => {
    const { session, claudeHome } = await started([]);
    fakeClaude([], { auth: () => ok(JSON.stringify({ loggedIn: true })) });
    await expect(session.blockedReason?.()).resolves.toBe("waiting for you in the Claude app");
    fakeClaude([], { auth: () => ({ code: 1, stdout: "not json", stderr: "" }) });
    await expect(session.blockedReason?.()).resolves.toContain("signed out");
    mkdirSync(join(claudeHome, "jobs", SHORT), { recursive: true });
    writeFileSync(
      join(claudeHome, "jobs", SHORT, "state.json"),
      JSON.stringify({ state: "failed", detail: "API error — Work on WEB-1" }),
    );
    await expect(session.blockedReason?.()).resolves.toBe("Claude Code stopped: API error");
  });

  it("stops the session and hands over without letting go", async () => {
    const { session, openUrl } = await started([]);
    await session.stop();
    expect(proc.run).toHaveBeenCalledWith("claude", ["stop", SHORT], expect.anything());
    await expect(session.handOff()).resolves.toBeUndefined();
    expect(openUrl).toHaveBeenCalledWith("https://claude.ai/code/session_abc123");
    await expect(session.detach()).resolves.toBeUndefined();
  });
});

describe("claude adapter: pause and resume", () => {
  async function running() {
    const dir = tempDir();
    const { adapter, now } = setup();
    fakeClaude([{ id: SHORT, sessionId: SESSION, pid: 1, state: "working" }], {
      start: () => ok(`backgrounded ${SHORT}`),
    });
    const session = await adapter.start(startArgs(dir), {});
    proc.run.mockClear();
    return { session, now };
  }

  const listings = () => proc.run.mock.calls.filter(([, a]) => a[0] === "agents").length;

  it("pauses with `claude stop` and waits for the session's process to go", async () => {
    const { session } = await running();
    let checks = 0;
    fakeClaude(() => {
      checks++;
      return [{ id: SHORT, sessionId: SESSION, state: "stopped", ...(checks < 3 ? { pid: 1 } : {}) }];
    });
    await session.pause();
    expect(proc.run.mock.calls[0]?.[1]).toEqual(["stop", SHORT]);
    expect(listings()).toBe(3);
    expect(proc.run.mock.calls.some(([, a]) => a[1] === "--resume")).toBe(false);
  });

  it("doesn't call a session paused while its process is still there", async () => {
    const { session } = await running();
    fakeClaude([{ id: SHORT, sessionId: SESSION, pid: 1, state: "working" }]);
    await expect(session.pause()).rejects.toThrow("Claude didn't stop the session");
    expect(listings()).toBe(40);
  });

  it("resumes the same session from its own folder, with the message as the only other argument", async () => {
    const { session, now } = await running();
    fakeClaude([{ id: SHORT, sessionId: SESSION, state: "stopped" }], {
      resume: () => ok(`backgrounded ${SHORT}`),
    });
    await session.resume('Use the "second" option & ship it');
    const resume = proc.run.mock.calls.filter(([, a]) => a[1] === "--resume");
    expect(resume).toHaveLength(1);
    expect(resume[0]?.[1]).toEqual(["--bg", "--resume", SESSION, 'Use the "second" option & ship it']);
    expect(resume[0]?.[2]).toMatchObject({ cwd: "/work/web" });
    // Waking passes through "stopped"; that isn't the session stopping.
    fakeClaude([{ id: SHORT, sessionId: SESSION, pid: 2, state: "stopped" }]);
    now.t += 5_000;
    await expect(session.state()).resolves.toBe("working");
    now.t += 30_000;
    await expect(session.state()).resolves.toBe("stopped");
  });

  it("removes a copy Claude started instead, and gives up after a few tries", async () => {
    const { session } = await running();
    fakeClaude([{ id: SHORT, sessionId: SESSION, state: "stopped" }], {
      resume: () => ok("started a copy as ffffffff"),
    });
    await expect(session.resume("hi")).rejects.toThrow("Claude kept the session busy; try Resume again");
    expect(proc.run).toHaveBeenCalledWith("claude", ["stop", "ffffffff"], expect.anything());
    expect(proc.run).toHaveBeenCalledWith("claude", ["rm", "ffffffff"], expect.anything());
    expect(proc.run.mock.calls.filter(([, a]) => a[1] === "--resume")).toHaveLength(4);
  });

  it("wakes the session on a later try once Claude has let go of it", async () => {
    const { session } = await running();
    let tries = 0;
    fakeClaude([{ id: SHORT, sessionId: SESSION, state: "stopped" }], {
      resume: () => {
        tries++;
        return ok(tries === 1 ? "started a copy as ffffffff" : `backgrounded ${SHORT}`);
      },
    });
    await session.resume("hi");
    expect(tries).toBe(2);
    expect(proc.run).toHaveBeenCalledWith("claude", ["rm", "ffffffff"], expect.anything());
  });

  it("says when resuming didn't wake the session", async () => {
    const { session } = await running();
    fakeClaude([{ id: SHORT, sessionId: SESSION, state: "stopped" }], {
      resume: () => ({ code: 1, stdout: "", stderr: "No conversation found" }),
    });
    await expect(session.resume("hi")).rejects.toThrow("No conversation found");
  });

  it("leaves a session alone that was continued in the app while paused", async () => {
    const { session } = await running();
    fakeClaude([{ id: SHORT, sessionId: SESSION, pid: 7, state: "working" }]);
    await session.resume("hi");
    expect(proc.run.mock.calls.some(([, a]) => a[1] === "--resume")).toBe(false);
  });
});

describe("claude adapter: adopt", () => {
  const entry = {
    runId: "run1",
    attempt: 1,
    agent: "claude-code" as const,
    ref: "WEB-1",
    launchCode: "r_abc123",
    projectId: "p1",
    cwd: "/work/web",
    worktree: false,
    shortId: SHORT,
    sessionId: SESSION,
    startedAt: 1,
  };

  it("picks a listed session back up and lets a stopped or unknown one go", async () => {
    const { adapter } = setup();
    fakeClaude([{ id: SHORT, sessionId: SESSION, pid: 1, state: "done" }]);
    await expect(adapter.adopt(entry, {})).resolves.toMatchObject({ sessionId: SESSION });
    fakeClaude([{ id: SHORT, sessionId: SESSION, state: "stopped" }]);
    await expect(adapter.adopt(entry, {})).resolves.toBeNull();
    await expect(adapter.adopt({ ...entry, shortId: "../../x" }, {})).resolves.toBeNull();
  });

  it("picks a paused run's stopped session back up", async () => {
    const { adapter } = setup();
    fakeClaude([{ id: SHORT, sessionId: SESSION, state: "stopped" }]);
    await expect(adapter.adopt({ ...entry, paused: true }, {})).resolves.toMatchObject({
      sessionId: SESSION,
      shortId: SHORT,
    });
    fakeClaude([]);
    await expect(adapter.adopt({ ...entry, paused: true }, {})).resolves.toBeNull();
  });
});

describe("claude adapter: parsing", () => {
  it("keeps the session list entries that look right", () => {
    expect(parseSessions("nope")).toEqual([]);
    expect(parseSessions("{}")).toEqual([]);
    expect(parseSessions(JSON.stringify([{ id: "a", sessionId: "s", pid: null }, { id: 3 }]))).toEqual([
      { id: "a", sessionId: "s" },
    ]);
  });

  it("reads no failure where Claude kept no job record", () => {
    expect(failure(tempDir(), SHORT)).toBeUndefined();
  });
});
