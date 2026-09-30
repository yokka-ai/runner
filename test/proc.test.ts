import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  argText,
  killAll,
  killAllNow,
  killTree,
  openUrl,
  resolvesToBatch,
  run,
  runningChildren,
  start,
} from "../src/proc.ts";

const node = process.execPath;

function exited(child: ReturnType<typeof start>) {
  return new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });
}

describe("run", () => {
  it("collects output and the exit code", async () => {
    const res = await run(node, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
    ]);
    expect(res).toEqual({ code: 3, stdout: "out", stderr: "err" });
  });

  it("feeds its input on stdin", async () => {
    const res = await run(node, ["-e", "process.stdin.pipe(process.stdout)"], { input: "hello" });
    expect(res.stdout).toBe("hello");
  });

  it("passes arguments through untouched, shell syntax included", async () => {
    const tricky = `"; echo pwned & calc.exe | rm -rf / $(whoami) %PATH% \`id\``;
    const res = await run(node, ["-e", "process.stdout.write(process.argv[1])", tricky]);
    expect(res.stdout).toBe(tricky);
  });

  it("reports a command that can't start as exit code 127", async () => {
    const res = await run("yokka-no-such-command-xyz", ["--version"]);
    expect(res.code).toBe(127);
    expect(res.stderr).toContain("ENOENT");
  });

  it("ends a command that runs past its timeout", async () => {
    const started = Date.now();
    const res = await run(node, ["-e", "setTimeout(() => {}, 30000)"], { timeoutMs: 300 });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("(timed out after 300 ms)");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("doesn't wait forever on a grandchild that keeps the output pipes open", async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit', detached: true });",
      "process.stdout.write(String(g.pid));",
      "g.unref();",
    ].join("\n");
    const started = Date.now();
    const res = await run(node, ["-e", script]);
    const grandchild = Number(res.stdout);
    await killTree(grandchild, "SIGKILL");
    expect(res.code).toBe(0);
    expect(grandchild).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("runs in the folder it's given", async () => {
    const res = await run(node, ["-e", "process.stdout.write(process.cwd())"], { cwd: process.cwd() });
    expect(res.stdout).toBe(process.cwd());
  });
});

describe("start and killTree", () => {
  it("tracks a long-lived child until it's ended", async () => {
    const before = runningChildren();
    const child = start(node, ["-e", "setInterval(() => {}, 1000)"]);
    expect(runningChildren()).toBe(before + 1);
    await killTree(child);
    await exited(child);
    expect(runningChildren()).toBe(before);
    // Ending it again, or a process that's gone, is harmless.
    await killTree(child);
    await killTree(0);
  });

  it("ends every child at shutdown", async () => {
    const a = start(node, ["-e", "setInterval(() => {}, 1000)"]);
    const b = start(node, ["-e", "setInterval(() => {}, 1000)"]);
    await killAll();
    await Promise.all([exited(a), exited(b)]);
    expect(runningChildren()).toBe(0);
  });

  it("ends every child synchronously when the process exits", async () => {
    const child = start(node, ["-e", "setInterval(() => {}, 1000)"]);
    killAllNow();
    await exited(child);
    expect(runningChildren()).toBe(0);
  });

  it("reports a command that can't start as an error event, without throwing", async () => {
    const child = start("yokka-no-such-command-xyz", []);
    const error = await new Promise<Error>((resolve) => child.once("error", resolve));
    expect(error.message).toContain("ENOENT");
  });
});

describe("openUrl", () => {
  it("refuses links it shouldn't open", () => {
    expect(openUrl("file:///etc/passwd")).toBe(false);
    expect(openUrl("http://evil.example.com")).toBe(false);
    expect(openUrl("javascript:alert(1)")).toBe(false);
  });
});

describe("resolvesToBatch", () => {
  const dir = join(process.cwd(), "bin");
  const search = { path: dir, pathExt: ".COM;.EXE;.BAT;.CMD" };

  it("finds the first match along PATH and PATHEXT", () => {
    const files = new Set([join(dir, "claude.CMD")]);
    expect(resolvesToBatch("claude", search, (f) => files.has(f))).toBe(true);
    const exe = new Set([join(dir, "claude.EXE"), join(dir, "claude.CMD")]);
    expect(resolvesToBatch("claude", search, (f) => exe.has(f))).toBe(false);
    expect(resolvesToBatch("missing", search, () => false)).toBe(false);
  });

  it("goes by the extension when the command has one, and by the path when it has one", () => {
    expect(resolvesToBatch("C:/tools/claude.cmd", search, () => false)).toBe(true);
    expect(resolvesToBatch("claude.exe", search, () => true)).toBe(false);
    expect(resolvesToBatch("C:/tools/claude", search, (f) => f === "C:/tools/claude.BAT")).toBe(true);
  });
});

describe("argText", () => {
  it("keeps free text intact for a real executable", () => {
    expect(argText('line one\nline two\t"quoted" & more', false)).toBe('line one\nline two\t"quoted" & more');
  });

  it("drops control characters that could end or confuse a command line", () => {
    expect(argText("a\u0000b\u0007c\u001bd", false)).toBe("abcd");
  });

  it("never lets text start like an option", () => {
    expect(argText("--permission-mode bypassPermissions", false)).toBe(
      " --permission-mode bypassPermissions",
    );
    expect(argText("-p", true)).toBe(" -p");
  });

  it("folds line breaks and caps the length for cmd.exe", () => {
    expect(argText("one\r\ntwo\nthree\rfour", true)).toBe("one two three four");
    const long = argText("x".repeat(7_000), true);
    expect(long).toHaveLength(6_000);
    expect(long.endsWith("…")).toBe(true);
  });
});
