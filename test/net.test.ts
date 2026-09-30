import { describe, expect, it, vi } from "vitest";
import {
  backoff,
  isLoopback,
  openableUrl,
  retry,
  serverUrl,
  TimeoutError,
  uploadUrlAllowed,
  withTimeout,
} from "../src/net.ts";

describe("serverUrl", () => {
  it("accepts HTTPS deployments and normalizes them to their origin", () => {
    expect(serverUrl("https://happy-cat-123.convex.cloud/")).toBe("https://happy-cat-123.convex.cloud");
    expect(serverUrl("  https://x.example.com/path?q=1 ")).toBe("https://x.example.com");
  });

  it("allows plain HTTP only for a deployment on this machine", () => {
    expect(serverUrl("http://127.0.0.1:3210")).toBe("http://127.0.0.1:3210");
    expect(serverUrl("http://localhost:3210")).toBe("http://localhost:3210");
    expect(serverUrl("http://[::1]:3210")).toBe("http://[::1]:3210");
    expect(() => serverUrl("http://deploy.example.com")).toThrow(
      "The server URL must start with https:// (got http://deploy.example.com).",
    );
    expect(() => serverUrl("ws://localhost")).toThrow("must start with https://");
  });

  it("refuses URLs with credentials and things that aren't URLs", () => {
    expect(() => serverUrl("https://me:pw@x.convex.cloud")).toThrow("can't carry a user name or password");
    expect(() => serverUrl("not a url")).toThrow(`"not a url" isn't a URL.`);
  });
});

describe("isLoopback", () => {
  it("knows the loopback names", () => {
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("app.localhost")).toBe(true);
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("localhost.example.com")).toBe(false);
  });
});

describe("openableUrl", () => {
  it("opens web pages over HTTPS and the Claude and Codex apps' links only", () => {
    expect(openableUrl("https://yokka.ai/runner?device=ABCD-EFGH")).toBe(true);
    expect(openableUrl("claude://code/new")).toBe(true);
    expect(openableUrl("codex://threads/abc")).toBe(true);
    expect(openableUrl("http://localhost:5173/runner")).toBe(true);
    expect(openableUrl("http://evil.example.com")).toBe(false);
    expect(openableUrl("file:///etc/passwd")).toBe(false);
    expect(openableUrl("ms-settings:privacy")).toBe(false);
    expect(openableUrl("::")).toBe(false);
  });
});

describe("uploadUrlAllowed", () => {
  const server = "https://happy-cat-123.convex.cloud";

  it("allows upload links on the deployment's .convex.site twin", () => {
    expect(uploadUrlAllowed("https://happy-cat-123.convex.site/mcp/upload/abc", server)).toBe(true);
  });

  it("allows the server's own origin and the run's MCP origin", () => {
    expect(uploadUrlAllowed(`${server}/mcp/upload/abc`, server)).toBe(true);
    expect(
      uploadUrlAllowed("https://api.example.com/mcp/upload/abc", server, "https://api.example.com/mcp"),
    ).toBe(true);
    expect(
      uploadUrlAllowed(
        "http://127.0.0.1:3211/mcp/upload/x",
        "http://127.0.0.1:3210",
        "http://127.0.0.1:3211/mcp",
      ),
    ).toBe(true);
  });

  it("refuses other hosts, other paths, plain HTTP and junk", () => {
    expect(uploadUrlAllowed("https://evil.example.com/mcp/upload/abc", server)).toBe(false);
    expect(uploadUrlAllowed("https://other-dog-1.convex.site/mcp/upload/abc", server)).toBe(false);
    expect(uploadUrlAllowed("https://happy-cat-123.convex.site/api/other", server)).toBe(false);
    expect(uploadUrlAllowed("http://happy-cat-123.convex.site/mcp/upload/abc", server)).toBe(false);
    expect(uploadUrlAllowed("nope", server)).toBe(false);
    expect(uploadUrlAllowed("https://evil.example.com/mcp/upload/abc", server, "not a url")).toBe(false);
  });
});

describe("withTimeout", () => {
  it("passes a prompt answer through", async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000, "call")).resolves.toBe(7);
  });

  it("fails a call that takes too long", async () => {
    vi.useFakeTimers();
    try {
      const slow = withTimeout(new Promise(() => undefined), 2_000, "runner:hello");
      const check = expect(slow).rejects.toThrow("runner:hello got no answer within 2 s");
      await vi.advanceTimersByTimeAsync(2_000);
      await check;
      const error = withTimeout(new Promise(() => undefined), 10, "x").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10);
      expect(await error).toBeInstanceOf(TimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("backoff", () => {
  it("doubles up to the cap, half of it random", () => {
    expect(backoff(1, 1_000, 10_000, () => 0)).toBe(500);
    expect(backoff(1, 1_000, 10_000, () => 1)).toBe(1_000);
    expect(backoff(3, 1_000, 10_000, () => 1)).toBe(4_000);
    expect(backoff(10, 1_000, 10_000, () => 1)).toBe(10_000);
    expect(backoff(10, 1_000, 10_000, () => 0)).toBe(5_000);
  });
});

describe("retry", () => {
  it("tries again after a retryable failure, telling onRetry how long it waits", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("ok");
      const onRetry = vi.fn();
      const result = retry(fn, {
        attempts: 3,
        baseMs: 100,
        maxMs: 1_000,
        retryable: () => true,
        onRetry,
        random: () => 1,
      });
      await vi.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ message: "offline" }), 1, 100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up at once on a failure that isn't retryable", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("denied"));
    await expect(retry(fn, { attempts: 5, baseMs: 1, maxMs: 1, retryable: () => false })).rejects.toThrow(
      "denied",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the last try", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("still offline"));
    await expect(retry(fn, { attempts: 2, baseMs: 1, maxMs: 1, retryable: () => true })).rejects.toThrow(
      "still offline",
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
