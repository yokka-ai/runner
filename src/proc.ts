import type { ChildProcess, SpawnOptions } from "node:child_process";
import { execFile } from "node:child_process";
import spawn from "cross-spawn";

/**
 * Process helpers that behave the same on macOS, Linux and Windows. `cross-spawn` finds commands the way a
 * shell would (PATHEXT, npm's .cmd shims on Windows) and quotes arguments safely, so nothing we pass is ever
 * interpreted by a shell.
 */

export const isWindows = process.platform === "win32";

export type RunResult = { code: number; stdout: string; stderr: string };

/** Runs a command to completion and collects its output. Never throws for a non-zero exit. */
export function run(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          stderr += `\n(timed out after ${opts.timeoutMs} ms)`;
          void killTree(child);
        }, opts.timeoutMs)
      : null;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/**
 * Starts a long-lived child with pipes. On macOS and Linux it gets its own process group so `killTree` can
 * take everything it started with it.
 */
export function start(command: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  return spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: !isWindows,
    ...opts,
  });
}

/** Ends a process and everything it started: its process group on macOS and Linux, `taskkill /T` on Windows. */
export async function killTree(child: ChildProcess | number, signal: NodeJS.Signals = "SIGTERM") {
  const pid = typeof child === "number" ? child : child.pid;
  if (!pid) return;
  if (isWindows) {
    await new Promise<void>((resolve) =>
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve()),
    );
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

/** Whether a process id is alive. */
export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Opens a URL (https, claude://, codex://) with the system's handler. */
export function openUrl(url: string) {
  if (isWindows) {
    // The shell's own URL handler, without going through cmd.exe (which would read `&` in the URL).
    execFile("rundll32", ["url.dll,FileProtocolHandler", url], { windowsHide: true });
  } else if (process.platform === "darwin") {
    execFile("open", [url]);
  } else {
    execFile("xdg-open", [url]);
  }
}
