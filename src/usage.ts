import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a run's agent has spent so far (PROTOCOL.md, `runner:usage`): running totals for the run, never
 * increments, so the runner can send them as often as it likes and the board replaces its last report.
 */
export type Usage = {
  model?: string;
  /** Fresh input tokens, not counting cache reads. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** US dollars, as the agent itself counted them; unset when it doesn't say. */
  costUsd?: number;
  /** Time the agent spent working (model calls and tools), not the time it sat waiting. */
  durationMs: number;
};

/** A reading of a session's usage, and whether its cost covers every token in it. */
export type Reading = Usage & { final: boolean };

type Json = Record<string, unknown>;

const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

function lines(text: string): Json[] {
  const out: Json[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isJson(value)) out.push(value);
    } catch {
      // A line being written as we read, or one from another version: skip it.
    }
  }
  return out;
}

// Claude Code -----------------------------------------------------------------------------------------

/**
 * Reads a Claude Code session's transcript (`~/.claude/projects/<folder>/<session>.jsonl`). Claude Code
 * writes its own running totals there as a `cost-state` line (cost, tokens per model, time) whenever the
 * session's process ends, and restores them when it resumes, so the last one counts everything up to it.
 * Model calls made after it (the session is still open) add their tokens from each message's `usage`, but
 * not yet their cost: the reading is `final` only when nothing came after the last `cost-state`.
 */
export function claudeUsage(transcript: string): Reading | undefined {
  const entries = lines(transcript);
  let costAt = -1;
  for (let i = entries.length - 1; i >= 0; i--)
    if (entries[i]?.type === "cost-state") {
      costAt = i;
      break;
    }
  const cost = costAt >= 0 ? entries[costAt] : undefined;

  // A message is written once per content block, each with the message's usage so far: the last one counts.
  const messages = new Map<string, { at: number; usage: Json; model: string | undefined }>();
  let turnMs = 0;
  entries.forEach((e, at) => {
    if (e.type === "system" && e.subtype === "turn_duration" && at > costAt) turnMs += num(e.durationMs);
    if (e.type !== "assistant" || !isJson(e.message) || !isJson(e.message.usage)) return;
    const id = typeof e.message.id === "string" ? e.message.id : `line-${at}`;
    const model = typeof e.message.model === "string" ? e.message.model : undefined;
    messages.set(id, { at, usage: e.message.usage, model });
  });

  const tally = tokenTally();
  let after = 0;
  for (const m of messages.values()) {
    if (m.at < costAt) continue;
    after++;
    tally.add(m.model, {
      input: m.usage.input_tokens,
      output: m.usage.output_tokens,
      cacheRead: m.usage.cache_read_input_tokens,
      cacheWrite: m.usage.cache_creation_input_tokens,
    });
  }
  if (!cost && messages.size === 0) return undefined;
  const models = cost && isJson(cost.modelUsage) ? cost.modelUsage : {};
  for (const [model, u] of Object.entries(models))
    if (isJson(u))
      tally.add(model, {
        input: u.inputTokens,
        output: u.outputTokens,
        cacheRead: u.cacheReadInputTokens,
        cacheWrite: u.cacheCreationInputTokens,
      });
  const usage: Usage = {
    ...tally.usage,
    durationMs: turnMs + (cost ? num(cost.totalAPIDuration) + num(cost.totalToolDuration) : 0),
  };
  const costUsd = cost?.totalCostUSD;
  if (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0) usage.costUsd = costUsd;
  const model = tally.mainModel();
  if (model) usage.model = model;
  return { ...usage, final: cost !== undefined && after === 0 };
}

/** Sums token counts, and remembers which model wrote the most output: the one the run is shown under. */
function tokenTally() {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const outputByModel = new Map<string, number>();
  return {
    usage,
    add(
      model: string | undefined,
      t: { input: unknown; output: unknown; cacheRead: unknown; cacheWrite: unknown },
    ) {
      usage.inputTokens += num(t.input);
      usage.outputTokens += num(t.output);
      usage.cacheReadTokens += num(t.cacheRead);
      usage.cacheWriteTokens += num(t.cacheWrite);
      // "<synthetic>" marks messages Claude Code made up itself, not a model.
      if (model && !model.startsWith("<"))
        outputByModel.set(model, (outputByModel.get(model) ?? 0) + num(t.output));
    },
    mainModel: () => [...outputByModel].sort((a, b) => b[1] - a[1])[0]?.[0],
  };
}

/** Claude Code's folder name for a project: the path with every character but letters and digits as `-`. */
export function claudeProjectDir(cwd: string) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Where a background session's transcript is: the path its job record names, else the one Claude Code
 * derives from the session's folder and id.
 */
export function claudeTranscript(
  claudeHome: string,
  ids: { shortId: string; sessionId: string },
  cwd: string,
) {
  try {
    const job: unknown = JSON.parse(
      readFileSync(join(claudeHome, "jobs", ids.shortId, "state.json"), "utf8"),
    );
    const path = isJson(job) ? job.linkScanPath : undefined;
    if (typeof path === "string" && path.endsWith(`${ids.sessionId}.jsonl`) && existsSync(path)) return path;
  } catch {
    // No job record: fall back to the derived path.
  }
  return join(claudeHome, "projects", claudeProjectDir(cwd), `${ids.sessionId}.jsonl`);
}

/** The session's usage from its transcript, or undefined when there's none yet. */
export function readClaudeUsage(
  claudeHome: string,
  ids: { shortId: string; sessionId: string },
  cwd: string,
) {
  try {
    return claudeUsage(readFileSync(claudeTranscript(claudeHome, ids, cwd), "utf8"));
  } catch {
    return undefined;
  }
}

// Codex -------------------------------------------------------------------------------------------------

/**
 * The thread's running token totals from a Codex app-server `thread/tokenUsage/updated` notification
 * (`tokenUsage.total`). Codex counts cached input inside its input tokens and reasoning inside its output
 * tokens; the board counts cache reads apart. Codex reports no cost. Undefined for anything else.
 */
export function codexTokens(params: Json) {
  const usage = isJson(params.tokenUsage)
    ? params.tokenUsage
    : isJson(params.token_usage)
      ? params.token_usage
      : null;
  const total = usage
    ? isJson(usage.total)
      ? usage.total
      : isJson(usage.total_token_usage)
        ? usage.total_token_usage
        : null
    : null;
  if (!total) return undefined;
  const input = num(total.inputTokens ?? total.input_tokens);
  const cached = Math.min(input, num(total.cachedInputTokens ?? total.cached_input_tokens));
  return {
    inputTokens: input - cached,
    outputTokens: num(total.outputTokens ?? total.output_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}
