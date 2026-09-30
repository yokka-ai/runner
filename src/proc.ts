import type { ChildProcess, SpawnOptions } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import spawn from "cross-spawn";
import { commandSearch } from "./env.ts";
import { openableUrl } from "./net.ts";

/**
 * Process helpers that behave the same on macOS, Linux and Windows. `cross-spawn` finds commands the way a
 * shell would (PATHEXT, npm's .cmd shims on Windows) and quotes each argument on its own, so an argument is
 * never read as shell syntax: nothing here passes `shell: true`.
 *
 * Every child is tracked until it exits, so shutting down (`killAll`) or dying (`killAllNow`) takes them
 * along instead of leaving orphans holding a Codex thread or a git lock.
 */

export const isWindows = process.platform === "win32";

/** Output kept per stream; the rest is dropped (`claude agents --json` is the largest, well under this). */
const MAX_OUTPUT = 8 * 1024 * 1024;
/** How long to wait for a child's pipes to close after it exited (a grandchild may still hold them). */
const CLOSE_GRACE_MS = 2_000;

const children = new Set<ChildProcess>();

function track(child: ChildProcess) {
  children.add(child);
  const drop = () => children.delete(child);
  child.once("exit", drop);
  child.once("error", drop);
  return child;
}

export type RunResult = { code: number; stdout: string; stderr: string };

export type RunOptions = { cwd?: string; timeoutMs?: number; input?: string };

/** Runs a command to completion and collects its output. Never throws: a failure to start is exit code 127. */
export function run(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      // Its own process group on macOS and Linux, so a timeout can end whatever it started too.
      child = track(
        spawn(command, args, {
          cwd: opts.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          detached: !isWindows,
        }),
      );
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let exitCode: number | null = null;
    let graceTimer: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number, extra = "") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ code, stdout, stderr: stderr + extra });
    };
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
    });
    // A child that exits before reading its input would otherwise surface EPIPE as an uncaught error.
    child.stdin?.on("error", () => undefined);
    if (opts.timeoutMs)
      timer = setTimeout(() => {
        stderr += `\n(timed out after ${opts.timeoutMs} ms)`;
        killTree(child).catch(() => undefined);
      }, opts.timeoutMs);
    child.on("error", (err) => finish(127, String(err)));
    child.on("exit", (code) => {
      exitCode = code ?? 1;
      // Normally "close" follows at once; a grandchild that kept the pipes open mustn't hang the caller.
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(exitCode ?? 1);
      }, CLOSE_GRACE_MS);
    });
    child.on("close", (code) => finish(exitCode ?? code ?? 1));
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/**
 * Starts a long-lived child with pipes. On macOS and Linux it gets its own process group so `killTree` can
 * take everything it started with it. A failure to start arrives as the child's "error" event.
 */
export function start(command: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  const child = track(
    spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: !isWindows,
      ...opts,
    }),
  );
  child.stdin?.on("error", () => undefined);
  return child;
}

/** Ends a process and everything it started: its process group on macOS and Linux, `taskkill /T` on Windows. */
export async function killTree(child: ChildProcess | number, signal: NodeJS.Signals = "SIGTERM") {
  const pid = typeof child === "number" ? child : child.pid;
  if (!pid) return;
  if (typeof child !== "number" && child.exitCode !== null) return;
  if (isWindows) {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/** Ends every child the runner started that's still running (shutdown). */
export async function killAll() {
  await Promise.all([...children].map((child) => killTree(child)));
}

/**
 * The same, synchronously, for the process "exit" event, where nothing asynchronous runs any more: a hard
 * kill of each process group on macOS and Linux, and of each direct child on Windows.
 */
export function killAllNow() {
  for (const child of children) {
    const pid = child.pid;
    if (!pid) continue;
    try {
      if (isWindows) child.kill();
      else process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  children.clear();
}

/** How many children are running, for tests and shutdown checks. */
export function runningChildren() {
  return children.size;
}

/**
 * Opens a URL (https, claude://, codex://) with the system's handler. Refuses anything else (file:, other
 * apps' schemes), since links can come from the server. Returns whether it tried.
 */
export function openUrl(url: string) {
  if (!openableUrl(url)) return false;
  const ignore = () => undefined;
  if (isWindows) {
    // The shell's own URL handler, without going through cmd.exe (which would read `&` in the URL).
    execFile("rundll32", ["url.dll,FileProtocolHandler", url], { windowsHide: true }, ignore);
  } else if (process.platform === "darwin") {
    execFile("open", [url], ignore);
  } else {
    execFile("xdg-open", [url], ignore);
  }
  return true;
}

/**
 * Whether Windows would start `command` through cmd.exe: a `.cmd` or `.bat` file, like the shims npm
 * installs for global packages. cross-spawn escapes arguments for cmd.exe then, but cmd.exe ends a command
 * at a line break and caps the command line at 8191 characters, so free text needs folding (`argText`).
 */
export function resolvesToBatch(
  command: string,
  search = commandSearch(),
  exists: (file: string) => boolean = existsSync,
) {
  const isBatch = (file: string) => /^\.(cmd|bat)$/i.test(extname(file));
  if (extname(command)) return isBatch(command);
  const exts = search.pathExt.split(";").filter(Boolean);
  const dirs = /[\\/]/.test(command) ? [""] : search.path.split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = dir ? join(dir, command + ext) : command + ext;
      if (exists(file)) return isBatch(file);
    }
  }
  return false;
}

/** Room left for one free-text argument on a cmd.exe command line (8191 in all). */
const BATCH_TEXT_MAX = 6_000;

/**
 * Makes free text (a card's start prompt, a person's reply) safe to pass as one positional argument:
 * - control characters other than tab and line breaks are dropped (a NUL would fail the spawn outright);
 * - a leading `-` gets a space in front, so the agent's CLI can't read the text as an option
 *   (`--permission-mode …` in a comment must stay a comment);
 * - on Windows through a `.cmd` shim, line breaks become spaces and the text is capped, because cmd.exe
 *   would silently drop everything after the first line break.
 */
export function argText(text: string, viaBatch: boolean) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
  let out = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (viaBatch) {
    out = out.replace(/\r?\n|\r/g, " ");
    if (out.length > BATCH_TEXT_MAX) out = `${out.slice(0, BATCH_TEXT_MAX - 1)}…`;
  }
  return out.startsWith("-") ? ` ${out}` : out;
}
