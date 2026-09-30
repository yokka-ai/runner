/**
 * Network rules the runner holds itself to: which URLs it will talk to or open, how long it waits, and how
 * it retries.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopback(hostname: string) {
  return LOOPBACK.has(hostname) || hostname.endsWith(".localhost");
}

/**
 * A deployment URL the runner may connect to, normalized to its origin. HTTPS only, except a deployment on
 * this machine (a local Convex backend during development), so the runner token never crosses a network in
 * the clear.
 */
export function serverUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(`"${input}" isn't a URL. It looks like https://<deployment>.convex.cloud`);
  }
  if (url.username || url.password) throw new Error("The server URL can't carry a user name or password.");
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && isLoopback(url.hostname)) return url.origin;
  throw new Error(`The server URL must start with https:// (got ${url.protocol}//${url.host}).`);
}

/**
 * Whether the runner may open `url` in the person's browser or app: web pages over HTTPS (HTTP only on this
 * machine), and the Claude and Codex apps' own links. Anything else (file:, a script handler, an unknown
 * app) is refused, since the URL can come from the server.
 */
export function openableUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (url.protocol === "https:" || url.protocol === "claude:" || url.protocol === "codex:") return true;
  return url.protocol === "http:" && isLoopback(url.hostname);
}

/**
 * Whether `url` is an upload link on this deployment: the server's origin, its `.convex.site` twin (where
 * HTTP actions live on Convex cloud), or the origin the run's MCP server was given at claim time, and always
 * under `/mcp/upload/`. The runner reads files from the run's folder for these, so it won't send them
 * anywhere else, whatever the server says.
 */
export function uploadUrlAllowed(input: string, server: string, mcpUrl?: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (!(url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname)))) return false;
  if (!url.pathname.startsWith("/mcp/upload/")) return false;
  const allowed = new Set<string>();
  const base = new URL(server);
  allowed.add(base.origin);
  if (base.hostname.endsWith(".convex.cloud"))
    allowed.add(`${base.protocol}//${base.hostname.replace(/\.convex\.cloud$/, ".convex.site")}`);
  if (mcpUrl) {
    try {
      allowed.add(new URL(mcpUrl).origin);
    } catch {
      // A malformed MCP URL adds nothing.
    }
  }
  return allowed.has(url.origin);
}

export class TimeoutError extends Error {
  override name = "TimeoutError";
}

/** Rejects with a `TimeoutError` when `promise` takes longer than `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${what} got no answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export type RetryOptions = {
  /** Tries in all, the first included. */
  attempts: number;
  baseMs: number;
  maxMs: number;
  /** Whether a failure is worth another try; the last error is thrown as soon as this says no. */
  retryable: (err: unknown) => boolean;
  /** Told before each wait, to say what's going on. */
  onRetry?: (err: unknown, attempt: number, waitMs: number) => void;
  random?: () => number;
};

/**
 * The wait before try `attempt + 1`: exponential and capped, half of it random ("equal jitter"), so runners
 * that lost the server at the same moment don't all come back at the same moment, yet none retries at once.
 */
export function backoff(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Calls `fn` until it succeeds, it fails with something not retryable, or the tries run out. */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.attempts || !opts.retryable(err)) throw err;
      const wait = backoff(attempt, opts.baseMs, opts.maxMs, opts.random);
      opts.onRetry?.(err, attempt, wait);
      await sleep(wait);
    }
  }
}
