import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, vi } from "vitest";
import type { Transport } from "../src/api.ts";

/** A fresh `YOKKA_HOME` for the current test, removed when it finishes. Call it inside the test. */
export function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), "yokka-runner-"));
  vi.stubEnv("YOKKA_HOME", dir);
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A temporary folder for the current test, removed when it finishes. */
export function tempDir(prefix = "yokka-dir-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

/** Captures what the runner prints, instead of letting it reach the test output. */
export function captureOutput() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  });
  return {
    out,
    err,
    text: () => out.join(""),
    errors: () => err.join(""),
  };
}

export type Call = { kind: "mutation" | "action"; name: string; args: Record<string, unknown> };

/**
 * A fake deployment: answers each call from `handlers` by function name, records every call, and lets the
 * test push `work` updates or subscription errors.
 */
export function fakeTransport(handlers: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  const calls: Call[] = [];
  const subscribers: { onUpdate: (v: unknown) => void; onError: (e: Error) => void; active: boolean }[] = [];
  let closed = false;
  const answer = async (kind: Call["kind"], name: string, args: Record<string, unknown>) => {
    calls.push({ kind, name, args });
    const handler = handlers[name];
    if (!handler) throw new Error(`no handler for ${name}`);
    return handler(args);
  };
  const transport: Transport = {
    mutation: (name, args) => answer("mutation", name, args),
    action: (name, args) => answer("action", name, args),
    subscribe: (_name, _args, onUpdate, onError) => {
      const sub = { onUpdate, onError, active: true };
      subscribers.push(sub);
      return () => {
        sub.active = false;
      };
    },
    close: async () => {
      closed = true;
    },
  };
  return {
    transport,
    calls,
    handlers,
    subscribers,
    /** Calls to one function, in order. */
    callsTo: (name: string) => calls.filter((c) => c.name === name),
    push: (work: unknown) => {
      for (const s of subscribers) if (s.active) s.onUpdate(work);
    },
    fail: (err: Error) => {
      for (const s of subscribers) if (s.active) s.onError(err);
    },
    isClosed: () => closed,
  };
}

/** Lets pending promise callbacks run (a few rounds, for chains of awaits). */
export async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
