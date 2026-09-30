import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeConfig } from "../config.ts";
import type { LedgerEntry } from "../ledger.ts";
import { run } from "../proc.ts";
import type { Adapter, AgentState, Detected, Session, SessionEvents, StartArgs } from "./types.ts";

/**
 * Claude Code, driven through its own background sessions (docs/runner.md "Claude adapter"):
 * `claude --bg --remote-control` starts a session that appears in the Claude desktop app by itself, updates
 * live, and can be continued there or from a phone; `claude agents --json` is the source of truth for its
 * state. Anything that needs the person is answered there. Pause stops the process and keeps the
 * conversation; resume wakes the same session with `claude --bg --resume <id>`, which must carry no other flag
 * (any flag starts a copy instead).
 */

type ListedSession = {
  id: string;
  sessionId: string;
  pid?: number;
  name?: string;
  status?: string;
  state?: string;
};

const LINK = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+/;
const BACKGROUNDED = /backgrounded\W+([0-9a-f]{8})/;
/** How long a session may look gone (starting up, or waking on resume) before it counts as dead. */
const GRACE_MS = 20_000;

export function claudeAdapter(config: ClaudeConfig): Adapter {
  const cmd = config.command;
  let cache: { at: number; list: Promise<ListedSession[]> } | null = null;

  /** Every background session, fetched at most every two seconds however many runs ask. */
  function sessions() {
    if (!cache || Date.now() - cache.at > 2_000) {
      cache = {
        at: Date.now(),
        list: run(cmd, ["agents", "--json", "--all"], { timeoutMs: 20_000 }).then((r) => {
          try {
            return r.code === 0 ? (JSON.parse(r.stdout) as ListedSession[]) : [];
          } catch {
            return [];
          }
        }),
      };
    }
    return cache.list;
  }

  async function signedIn() {
    const res = await run(cmd, ["auth", "status"], { timeoutMs: 20_000 });
    try {
      return (JSON.parse(res.stdout) as { loggedIn?: boolean }).loggedIn === true;
    } catch {
      return res.code === 0;
    }
  }

  function session(shortId: string, sessionId: string, cwd: string, events: SessionEvents): Session {
    let urlSent = false;
    let goneSince: number | undefined;
    /** When a resume last woke the session: it passes through "stopped" on the way. */
    let wokeAt = 0;
    const findUrl = async () => {
      if (urlSent) return;
      const logs = await run(cmd, ["logs", shortId], { timeoutMs: 20_000 });
      const url = LINK.exec(logs.stdout)?.[0];
      if (url) {
        urlSent = true;
        events.openUrl?.(url);
      }
    };
    return {
      sessionId,
      shortId,
      async state(): Promise<AgentState> {
        cache = null;
        const s = (await sessions()).find((x) => x.id === shortId);
        // A session starting up (or waking on resume) can briefly be unlisted or have no pid yet; only a
        // gap that lasts means it died.
        const gone = !s || (s.state === "working" && !s.pid);
        if (gone) {
          goneSince ??= Date.now();
          if (Date.now() - goneSince > GRACE_MS) return "crashed";
          return "working";
        }
        goneSince = undefined;
        void findUrl();
        if (s.state === "working") return "working";
        // A permission prompt or a question for the person: either way it's answered in the Claude app.
        if (s.state === "blocked") return "blocked";
        if (s.state === "stopped") return Date.now() - wokeAt < GRACE_MS ? "working" : "stopped";
        if (s.state === "failed") return "crashed";
        return "idle";
      },
      async blockedReason() {
        const failed = failure(shortId);
        if (failed) return `Claude Code stopped: ${failed}`;
        return (await signedIn())
          ? "waiting for you in the Claude app"
          : "Claude Code is signed out on this machine (run `claude auth login`)";
      },
      async pause() {
        // `claude stop` ends the process and keeps the conversation. It returns before Claude has let go of
        // the session, so wait for the process to go.
        await run(cmd, ["stop", shortId], { timeoutMs: 30_000 });
        for (let i = 0; i < 40; i++) {
          cache = null;
          const s = (await sessions()).find((x) => x.id === shortId);
          if (!s?.pid) break;
          await sleep(500);
        }
      },
      async resume(text) {
        wokeAt = Date.now();
        for (let attempt = 1; ; attempt++) {
          // Resuming a session Claude still counts as running starts a copy instead; give it a moment.
          await sleep(2_000 * attempt);
          // From the session's own folder and with no other flag: then it wakes this session with its saved
          // options. Elsewhere it quietly starts a new one; with a flag it starts a copy.
          const res = await run(cmd, ["--bg", "--resume", sessionId, text], { cwd, timeoutMs: 60_000 });
          const out = `${res.stdout}\n${res.stderr}`;
          const copy = /started a copy as ([0-9a-f]{8})/.exec(out)?.[1];
          if (copy) {
            await run(cmd, ["stop", copy], { timeoutMs: 30_000 });
            await run(cmd, ["rm", copy], { timeoutMs: 30_000 });
            if (attempt < 4) continue;
            throw new Error("Claude kept the session busy; try Resume again");
          }
          if (BACKGROUNDED.exec(res.stdout)?.[1] !== shortId)
            throw new Error(lastLine(out) ?? "claude --resume didn't wake the session");
          break;
        }
        wokeAt = Date.now();
        cache = null;
      },
      async stop() {
        await run(cmd, ["stop", shortId], { timeoutMs: 30_000 });
      },
      async handOff() {
        // A Remote Control session is shared with the app by design; nothing to let go of.
        await findUrl();
        return undefined;
      },
      async detach() {
        // Background sessions outlive the runner; a restarted runner adopts them from its ledger.
      },
    };
  }

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
      if (!(await signedIn())) return { version, problem: "not signed in; run `claude auth login`" };
      return { version };
    },

    async start(args: StartArgs, events: SessionEvents) {
      if ((config.permissionMode as string) === "bypassPermissions")
        throw new Error("the runner never skips permissions; pick another permissionMode");
      // The run's own MCP token, as a header so it works when a workspace turns connector links off.
      const mcpFile = join(args.dir, "mcp.json");
      writeFileSync(
        mcpFile,
        JSON.stringify({
          mcpServers: {
            yokka: {
              type: "http",
              url: args.mcp.url,
              headers: { Authorization: `Bearer ${args.mcp.token}` },
            },
          },
        }),
        { mode: 0o600 },
      );
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
        args.name,
        ...(config.model ? ["--model", config.model] : []),
        "--remote-control",
        args.name,
      ];
      const res = await run(cmd, [...flags, args.prompt], { cwd: args.cwd, timeoutMs: 90_000 });
      const shortId = BACKGROUNDED.exec(res.stdout)?.[1];
      if (!shortId)
        throw new Error(lastLine(res.stderr || res.stdout) ?? "claude --bg didn't start a session");
      cache = null;
      const listed = (await sessions()).find((s) => s.id === shortId);
      if (!listed) throw new Error("the session started but `claude agents` doesn't list it");
      return session(shortId, listed.sessionId, args.cwd, events);
    },

    async adopt(entry: LedgerEntry, events: SessionEvents) {
      if (!entry.shortId || !entry.sessionId) return null;
      cache = null;
      const listed = (await sessions()).find((s) => s.id === entry.shortId);
      if (!listed || listed.state === "stopped") return null;
      return session(entry.shortId, entry.sessionId, entry.cwd, events);
    },
  };
}

/** Why a background session failed, from the job record Claude Code keeps for it (best effort). */
function failure(shortId: string) {
  try {
    const job = JSON.parse(
      readFileSync(join(homedir(), ".claude", "jobs", shortId, "state.json"), "utf8"),
    ) as {
      state?: string;
      detail?: string;
    };
    if (job.state !== "failed" || !job.detail) return undefined;
    // The detail ends with the prompt it was given; the reason comes first.
    return job.detail.split(" — ")[0].slice(0, 200);
  } catch {
    return undefined;
  }
}

function lastLine(text: string) {
  return text.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 280);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
