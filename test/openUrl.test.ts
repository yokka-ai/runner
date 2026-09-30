import { describe, expect, it, vi } from "vitest";

const execFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile,
}));

const { openUrl } = await import("../src/proc.ts");

describe("openUrl", () => {
  it("hands an allowed link to the system's handler as one argument, never through a shell", () => {
    const url = "https://yokka.ai/runner?device=ABCD-EFGH&x=1";
    expect(openUrl(url)).toBe(true);
    const [command, args, ...rest] = execFile.mock.calls[0] ?? [];
    const expected: Record<string, string> = { win32: "rundll32", darwin: "open" };
    expect(command).toBe(expected[process.platform] ?? "xdg-open");
    expect(args).toContain(url);
    // A callback is always passed, so a missing handler (no xdg-open) is an error value, not a crash.
    expect(typeof rest.at(-1)).toBe("function");
  });

  it("opens the agents' own app links", () => {
    expect(openUrl("codex://threads/abc")).toBe(true);
    expect(openUrl("claude://code/new")).toBe(true);
  });
});
