import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeProjectDir,
  claudeTranscript,
  claudeUsage,
  codexTokens,
  readClaudeUsage,
} from "../src/usage.ts";
import { tempDir } from "./helpers.ts";

const jsonl = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n");

/** An assistant message as Claude Code writes it, once per content block. */
const message = (id: string, usage: Record<string, number>, model = "claude-opus-4-5") => ({
  type: "assistant",
  message: { id, model, role: "assistant", usage },
});

const costState = {
  type: "cost-state",
  totalCostUSD: 1.25,
  totalAPIDuration: 50_000,
  totalToolDuration: 10_000,
  totalDuration: 9_000_000,
  modelUsage: {
    "claude-opus-4-5": {
      inputTokens: 100,
      outputTokens: 2000,
      cacheReadInputTokens: 30_000,
      cacheCreationInputTokens: 4000,
      costUSD: 1.2,
    },
    "claude-haiku-4-5": {
      inputTokens: 50,
      outputTokens: 300,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.05,
    },
  },
};

describe("Claude Code usage", () => {
  it("takes Claude Code's own totals from its last cost record, which it writes when the session ends", () => {
    const transcript = jsonl(
      { type: "user", message: { role: "user", content: "go" } },
      message("m1", { input_tokens: 100, output_tokens: 2000 }),
      { ...costState, totalCostUSD: 0.5 },
      // A resume restores the totals, and the next end writes them again, grown.
      costState,
      { type: "last-prompt" },
    );
    expect(claudeUsage(transcript)).toEqual({
      model: "claude-opus-4-5",
      inputTokens: 150,
      outputTokens: 2300,
      cacheReadTokens: 30_000,
      cacheWriteTokens: 4000,
      costUsd: 1.25,
      durationMs: 60_000,
      final: true,
    });
  });

  it("adds the tokens of calls made since then, counting each message once, but isn't final", () => {
    const transcript = jsonl(
      costState,
      message("m2", { input_tokens: 3, output_tokens: 10, cache_read_input_tokens: 500 }),
      // The same message again, for its next content block: its usage so far.
      message("m2", {
        input_tokens: 3,
        output_tokens: 40,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 70,
      }),
      { type: "system", subtype: "turn_duration", durationMs: 4000 },
      "not json",
    );
    expect(claudeUsage(transcript)).toMatchObject({
      inputTokens: 153,
      outputTokens: 2340,
      cacheReadTokens: 30_500,
      cacheWriteTokens: 4070,
      costUsd: 1.25,
      durationMs: 64_000,
      final: false,
    });
  });

  it("counts tokens and turn time without a cost while the session has never ended", () => {
    const transcript = jsonl(
      message("m1", { input_tokens: 5, output_tokens: 10 }, "<synthetic>"),
      message("m2", { input_tokens: 7, output_tokens: 20 }, "claude-sonnet-4-5"),
      { type: "system", subtype: "turn_duration", durationMs: 12_000 },
    );
    expect(claudeUsage(transcript)).toEqual({
      model: "claude-sonnet-4-5",
      inputTokens: 12,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 12_000,
      final: false,
    });
  });

  it("has nothing to say about a transcript without model calls", () => {
    expect(claudeUsage(jsonl({ type: "user", message: { content: "hi" } }))).toBeUndefined();
    expect(claudeUsage("")).toBeUndefined();
  });

  it("finds the transcript through the session's job record, else by its folder", () => {
    const home = tempDir("yokka-claude-");
    const ids = { shortId: "0a1b2c3d", sessionId: "11111111-2222" };
    const cwd = "C:\\work\\my.app";
    expect(claudeProjectDir(cwd)).toBe("C--work-my-app");
    const derived = join(home, "projects", "C--work-my-app", "11111111-2222.jsonl");
    expect(claudeTranscript(home, ids, cwd)).toBe(derived);

    const elsewhere = join(home, "elsewhere", "11111111-2222.jsonl");
    mkdirSync(join(home, "elsewhere"), { recursive: true });
    writeFileSync(elsewhere, jsonl(costState));
    mkdirSync(join(home, "jobs", ids.shortId), { recursive: true });
    writeFileSync(join(home, "jobs", ids.shortId, "state.json"), JSON.stringify({ linkScanPath: elsewhere }));
    expect(claudeTranscript(home, ids, cwd)).toBe(elsewhere);
    expect(readClaudeUsage(home, ids, cwd)).toMatchObject({ costUsd: 1.25, final: true });
    expect(readClaudeUsage(home, { ...ids, shortId: "ffffffff", sessionId: "gone" }, cwd)).toBeUndefined();
  });
});

describe("Codex usage", () => {
  it("reads a thread's running totals, with cached input apart from fresh input", () => {
    expect(
      codexTokens({
        threadId: "t1",
        turnId: "turn1",
        tokenUsage: {
          total: { totalTokens: 1600, inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 400 },
          last: { totalTokens: 10, inputTokens: 5, cachedInputTokens: 0, outputTokens: 5 },
        },
      }),
    ).toEqual({ inputTokens: 200, outputTokens: 400, cacheReadTokens: 1000, cacheWriteTokens: 0 });
  });

  it("reads the snake_case shape too, and nothing else", () => {
    expect(
      codexTokens({
        token_usage: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 3 } },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(codexTokens({ threadId: "t1" })).toBeUndefined();
  });
});
