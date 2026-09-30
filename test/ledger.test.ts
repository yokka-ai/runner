import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dropEntry, type LedgerEntry, putEntry, readLedger, setPaused } from "../src/ledger.ts";
import { captureOutput, tempHome } from "./helpers.ts";

const entry = (runId: string): LedgerEntry => ({
  runId,
  attempt: 1,
  agent: "claude-code",
  ref: "YK-1",
  launchCode: "r_abc123",
  projectId: "p1",
  cwd: "/work",
  worktree: false,
  shortId: "0a1b2c3d",
  sessionId: "s-1",
  startedAt: 1,
});

describe("ledger", () => {
  it("is empty until a run is put in it", () => {
    tempHome();
    expect(readLedger()).toEqual([]);
  });

  it("keeps one entry per run and drops them", () => {
    tempHome();
    putEntry(entry("a"));
    putEntry(entry("b"));
    putEntry({ ...entry("a"), attempt: 2 });
    expect(readLedger().map((e) => [e.runId, e.attempt])).toEqual([
      ["b", 1],
      ["a", 2],
    ]);
    dropEntry("a");
    dropEntry("missing");
    expect(readLedger().map((e) => e.runId)).toEqual(["b"]);
  });

  it("records a run paused and resumed, keeping the rest of its entry", () => {
    tempHome();
    putEntry(entry("a"));
    putEntry(entry("b"));
    setPaused("a", true);
    setPaused("missing", true);
    expect(readLedger()).toEqual([{ ...entry("a"), paused: true }, entry("b")]);
    setPaused("a", false);
    expect(readLedger()[0]).toEqual({ ...entry("a"), paused: false });
  });

  it("skips entries it can't read and survives a broken file", () => {
    const home = tempHome();
    const output = captureOutput();
    writeFileSync(join(home, "runs.json"), JSON.stringify([entry("ok"), { runId: 3 }]));
    expect(readLedger().map((e) => e.runId)).toEqual(["ok"]);
    expect(output.errors()).toContain("Skipping a run in");
    writeFileSync(join(home, "runs.json"), "not json");
    expect(readLedger()).toEqual([]);
    expect(output.errors()).toContain("is unreadable; starting with an empty list of runs.");
  });

  it("writes plain JSON", () => {
    const home = tempHome();
    putEntry(entry("a"));
    expect(JSON.parse(readFileSync(join(home, "runs.json"), "utf8"))).toEqual([entry("a")]);
  });
});
