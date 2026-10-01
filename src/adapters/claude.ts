import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ClaudeConfig, restrictToOwner } from "../config.ts";
import type { LedgerEntry } from "../ledger.ts";
import { sleep as realSleep } from "../net.ts";
import { argText, isWindows, resolvesToBatch, run } from "../proc.ts";
import { absent, number, object, string } from "../schema.ts";
import { readClaudeUsage } from "../usage.ts";
import type { Adapter, AgentState, Detected, Session, SessionEvents, StartArgs } from "./types.ts";

/**
 * Claude Code, driven through its own background sessions (docs/runner.md "Claude adapter"):
 * `claude --bg --remote-control` starts a session that appears in the Claude desktop app by itself, updates
 * live, and can be continued there or from a phone; `claude agents --json` is the source of truth for its
 * state. Anything that needs the person is answered there. Pause stops the process and keeps the
 * conversation; resume wakes the same session with `claude --bg --resume <id>`, which must carry no other flag
 * (any flag starts a copy instead).
 *
 * Nothing secret goes on a command line: the run's MCP token is in `<run>/mcp.json` (readable by this user
 * only), which Claude reads itself.
 */

const listedSession = object({
  id: string,
  sessionId: string,
  pid: absent(number),
  name: absent(string),
  status: absent(string),
  state: absent(string),
});
type ListedSession = ReturnType<typeof listedSession>;

const LINK = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+/;
const BACKGROUNDED = /backgrounded\W+([0-9a-f]{8})/;
const SHORT_ID = /^[0-9a-f]{8}$/;
/** How long a session may look gone (starting up, or waking on resume) before it counts as dead. */
const GRACE_MS = 20_000;
/** How fresh the session list must be for a state check; one listing serves every run in a poll. */
const LIST_MAX_AGE_MS = 1_000;

export type ClaudeOptions = {
  /** Claude Code's own folder (job records); `~/.claude`. */
  claudeHome?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** Parses `claude agents --json`, keeping the entries that look right. */
export function parseSessions(stdout: string): ListedSession[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: ListedSession[] = [];
  for (const [i, item] of raw.entries()) {
    try {
      out.push(listedSession(item, `agents[${i}]`));
    } catch {
      // An entry from another Claude version: not one of ours to read.
    }
  }
  return out;
}

/** Why a background session failed, from the job record Claude Code keeps for it (best effort). */
export function failure(claudeHome: string, shortId: string) {
  try {
    const job: unknown = JSON.parse(readFileSync(join(claudeHome, "jobs", shortId, "state.json"), "utf8"));
    if (typeof job !== "object" || job === null) return undefined;
    const { state, detail } = job as { state?: unknown; detail?: unknown };
    if (state !== "failed" || typeof detail !== "string" || !detail) return undefined;
    // The detail ends with the prompt it was given; the reason comes first.
    return (detail.split(" — ")[0] ?? detail).slice(0, 200);
  } catch {
    return undefined;
  }
}

function lastLine(text: string) {
  return text.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 280);
}

/** What a session needs from its adapter: the CLI, the shared session list, and the clock. */
type ClaudeCli = {
  cmd: string;
  claudeHome: string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Free text made safe as one argument for this command (`argText`). */
  text: (s: string) => string;
  /** The listed session with this short id; `fresh` skips the shared cache. */
  find: (shortId: string, fresh?: boolean) => Promise<ListedSession | undefined>;
  signedIn: () => Promise<boolean>;
};

/**
 * Ends the session's process and keeps its conversation. `claude stop` returns before Claude has let go of
 * the session, so wait for the process to go; one still running after that isn't paused.
 */
async function pauseSession(cli: ClaudeCli, shortId: string) {
  await run(cli.cmd, ["stop", shortId], { timeoutMs: 30_000 });
  for (let i = 0; i < 40; i++) {
    if (!(await cli.find(shortId, true))?.pid) return;
    await cli.sleep(500);
  }
  throw new Error("Claude didn't stop the session");
}

/**
 * Wakes a paused session with `message` as its next message. Resuming a session Claude still counts as
 * running starts a copy instead, so give it a moment, and try again if Claude still starts a copy.
 */
async function resumeSession(
  cli: ClaudeCli,
  ids: { shortId: string; sessionId: string },
  cwd: string,
  message: string,
) {
  // Continued in the Claude app while paused: it's running already, and resuming it would start a copy.
  if ((await cli.find(ids.shortId, true))?.pid) return;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await cli.sleep(2_000 * attempt);
    // From the session's own folder and with no other flag: then it wakes this session with its saved
    // options. Elsewhere it quietly starts a new one; with a flag it starts a copy.
    const res = await run(cli.cmd, ["--bg", "--resume", ids.sessionId, cli.text(message)], {
      cwd,
      timeoutMs: 60_000,
    });
    const out = `${res.stdout}\n${res.stderr}`;
    const copy = /started a copy as ([0-9a-f]{8})/.exec(out)?.[1];
    if (!copy) {
      if (BACKGROUNDED.exec(res.stdout)?.[1] !== ids.shortId)
        throw new Error(lastLine(out) ?? "claude --resume didn't wake the session");
      return;
    }
    await run(cli.cmd, ["stop", copy], { timeoutMs: 30_000 });
    await run(cli.cmd, ["rm", copy], { timeoutMs: 30_000 });
  }
  throw new Error("Claude kept the session busy; try Resume again");
}

/** A session driven through the `claude` CLI. */
function claudeSession(
  cli: ClaudeCli,
  ids: { shortId: string; sessionId: string },
  cwd: string,
  events: SessionEvents,
): Session {
  const { shortId, sessionId } = ids;
  let urlSent = false;
  let goneSince: number | undefined;
  /** When a resume last woke the session: it passes through "stopped" on the way. */
  let wokeAt = 0;
  const findUrl = async () => {
    if (urlSent) return;
    const logs = await run(cli.cmd, ["logs", shortId], { timeoutMs: 20_000 });
    const url = LINK.exec(logs.stdout)?.[0];
    if (url) {
      urlSent = true;
      events.openUrl?.(url);
    }
  };
  /** Looks for the link in the background, one look at a time, so a state check never waits on it. */
  let finding: Promise<void> | undefined;
  const lookForUrl = () => {
    if (urlSent || finding !== undefined) return;
    finding = findUrl()
      .catch(() => undefined)
      .finally(() => {
        finding = undefined;
      });
  };
  /** The runner's view of a listed session's state. */
  const stateOf = (listed: ListedSession): AgentState => {
    switch (listed.state) {
      case "working":
        return "working";
      // A permission prompt or a question for the person: either way it's answered in the Claude app.
      case "blocked":
        return "blocked";
      case "stopped":
        return cli.now() - wokeAt < GRACE_MS ? "working" : "stopped";
      case "failed":
        return "crashed";
      default:
        return "idle";
    }
  };
  return {
    sessionId,
    shortId,
    async state() {
      const listed = await cli.find(shortId);
      // A session starting up (or waking on resume) can briefly be unlisted or have no pid yet; only a
      // gap that lasts means it died.
      if (!listed || (listed.state === "working" && !listed.pid)) {
        goneSince ??= cli.now();
        return cli.now() - goneSince > GRACE_MS ? "crashed" : "working";
      }
      goneSince = undefined;
      lookForUrl();
      return stateOf(listed);
    },
    async blockedReason() {
      const failed = failure(cli.claudeHome, shortId);
      if (failed) return `Claude Code stopped: ${failed}`;
      return (await cli.signedIn())
        ? "waiting for you in the Claude app"
        : "Claude Code is signed out on this machine (run `claude auth login`)";
    },
    async pause() {
      await pauseSession(cli, shortId);
    },
    async resume(message) {
      wokeAt = cli.now();
      await resumeSession(cli, ids, cwd, message);
      wokeAt = cli.now();
    },
    async stop() {
      await run(cli.cmd, ["stop", shortId], { timeoutMs: 30_000 });
    },
    async handOff() {
      // A Remote Control session is shared with the app by design; nothing to let go of.
      await findUrl();
      return undefined;
    },
    async detach() {
      // Background sessions outlive the runner; a restarted runner adopts them from its ledger.
    },
    async usage() {
      return readClaudeUsage(cli.claudeHome, ids, cwd);
    },
  };
}

/** Writes the run's MCP config: its token as a header, so it works when a workspace turns connector links off. */
function writeMcpConfig(args: StartArgs) {
  const mcpFile = join(args.dir, "mcp.json");
  const config = {
    mcpServers: {
      yokka: { type: "http", url: args.mcp.url, headers: { Authorization: `Bearer ${args.mcp.token}` } },
    },
  };
  writeFileSync(mcpFile, JSON.stringify(config), { mode: 0o600 });
  restrictToOwner(mcpFile);
  return mcpFile;
}

export function claudeAdapter(config: ClaudeConfig, options: ClaudeOptions = {}): Adapter {
  const cmd = config.command;
  const now = options.now ?? Date.now;
  // cmd.exe reads free text differently from a real executable; see `argText`.
  let batch: boolean | undefined;
  let cache: { at: number; list: Promise<ListedSession[]> } | null = null;

  /** Every background session, listed at most once per `maxAgeMs` however many runs ask. */
  function sessions(maxAgeMs: number) {
    if (!cache || now() - cache.at > maxAgeMs) {
      const list = run(cmd, ["agents", "--json", "--all"], { timeoutMs: 20_000 }).then((r) =>
        r.code === 0 ? parseSessions(r.stdout) : [],
      );
      cache = { at: now(), list };
    }
    return cache.list;
  }

  const cli: ClaudeCli = {
    cmd,
    claudeHome: options.claudeHome ?? join(homedir(), ".claude"),
    sleep: options.sleep ?? realSleep,
    now,
    text: (s) => {
      batch ??= isWindows && resolvesToBatch(cmd);
      return argText(s, batch);
    },
    find: async (shortId, fresh = false) =>
      (await sessions(fresh ? -1 : LIST_MAX_AGE_MS)).find((s) => s.id === shortId),
    signedIn: async () => {
      const res = await run(cmd, ["auth", "status"], { timeoutMs: 20_000 });
      try {
        const status: unknown = JSON.parse(res.stdout);
        return (
          typeof status === "object" && status !== null && "loggedIn" in status && status.loggedIn === true
        );
      } catch {
        return res.code === 0;
      }
    },
  };

  return {
    id: "claude-code",
    label: "Claude Code",

    async detect(): Promise<Detected> {
      const v = await run(cmd, ["--version"], { timeoutMs: 20_000 });
      if (v.code !== 0) return { problem: `\`${cmd}\` isn't installed or isn't on PATH` };
      const version = /\d+\.\d+\.\d+/.exec(v.stdout)?.[0];
      const help = await run(cmd, ["--help"], { timeoutMs: 20_000 });
      if (!help.stdout.includes("--remote-control") || !help.stdout.includes("--bg"))
        return { version, problem: "this Claude Code is too old for runners; run `claude update`" };
      if (!(await cli.signedIn())) return { version, problem: "not signed in; run `claude auth login`" };
      return { version };
    },

    async start(args: StartArgs, events: SessionEvents) {
      if ((config.permissionMode as string) === "bypassPermissions")
        throw new Error("the runner never skips permissions; pick another permissionMode");
      const mcpFile = writeMcpConfig(args);
      // `--mcp-config` and `--allowedTools` take lists and would swallow the prompt, so a single-value flag
      // always follows them. The run's own board tools are pre-approved: its token reaches this project only.
      const flags = [
        "--bg",
        "--mcp-config",
        mcpFile,
        "--allowedTools",
        "mcp__yokka",
        "--permission-mode",
        config.permissionMode,
        "-n",
        cli.text(args.name),
        ...(config.model ? ["--model", config.model] : []),
        "--remote-control",
        cli.text(args.name),
      ];
      const res = await run(cmd, [...flags, cli.text(args.prompt)], { cwd: args.cwd, timeoutMs: 90_000 });
      const shortId = BACKGROUNDED.exec(res.stdout)?.[1];
      if (!shortId)
        throw new Error(lastLine(res.stderr || res.stdout) ?? "claude --bg didn't start a session");
      const listed = await cli.find(shortId, true);
      if (!listed) throw new Error("the session started but `claude agents` doesn't list it");
      return claudeSession(cli, { shortId, sessionId: listed.sessionId }, args.cwd, events);
    },

    async adopt(entry: LedgerEntry, events: SessionEvents) {
      if (!entry.shortId || !SHORT_ID.test(entry.shortId) || !entry.sessionId) return null;
      const listed = await cli.find(entry.shortId, true);
      // A paused run's session is stopped on purpose, and resuming it wakes it again.
      if (!listed || (listed.state === "stopped" && !entry.paused)) return null;
      return claudeSession(cli, { shortId: entry.shortId, sessionId: entry.sessionId }, entry.cwd, events);
    },
  };
}
