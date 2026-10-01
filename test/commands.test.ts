import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SERVER, liveClient, loginClient } from "../src/api.ts";
import { type CliDeps, main } from "../src/commands.ts";
import { type Config, configPath, defaults, loadConfig, saveConfig } from "../src/config.ts";
import { VERSION } from "../src/version.ts";
import { canonical } from "../src/workspace.ts";
import { hello } from "./fixtures.ts";
import { captureOutput, fakeTransport, tempDir, tempHome } from "./helpers.ts";

const TOKEN = `yr_${"abcd".repeat(10)}`;
const SERVER = "https://happy-cat-1.convex.cloud";
const NO_RETRY = { attempts: 1, baseMs: 1, maxMs: 1, retryable: () => false };

function deps(
  overrides: Partial<CliDeps> = {},
  handlers: Record<string, (a: Record<string, unknown>) => unknown> = {},
) {
  const fake = fakeTransport({ hello: () => hello, ...handlers });
  const answers: string[] = [];
  const d: CliDeps = {
    loginClient: () => loginClient(fake.transport, NO_RETRY),
    liveClient: (_server, token) => liveClient(fake.transport, token, NO_RETRY),
    runDaemon: vi.fn(async () => undefined),
    ask: vi.fn(async () => answers.shift() ?? ""),
    open: vi.fn(() => true),
    cwd: () => process.cwd(),
    ...overrides,
  };
  return { d, fake, answers };
}

function signedIn(extra: Partial<Config> = {}) {
  saveConfig({ ...defaults(), server: SERVER, token: TOKEN, ...extra });
}

afterEach(() => {
  vi.useRealTimers();
  process.exitCode = undefined;
});

describe("help and version", () => {
  it("prints help, the version and help for an unknown command", async () => {
    tempHome();
    const output = captureOutput();
    await main(["--help"], deps().d);
    expect(output.text()).toContain("Usage: yokka-runner [command] [options]");
    await main(["-v"], deps().d);
    expect(output.out.at(-1)).toBe(`${VERSION}\n`);
    await main(["frobnicate"], deps().d);
    expect(process.exitCode).toBe(1);
  });

  it("explains how to check where the build came from", async () => {
    tempHome();
    const output = captureOutput();
    await main(["verify"], deps().d);
    expect(output.text()).toContain(`npm view yokka-runner@${VERSION} dist.attestations`);
  });
});

describe("login", () => {
  const started = {
    userCode: "ABCD-EFGH",
    deviceCode: "device-secret",
    verifyUrl: "https://yokka.ai/runner?device=ABCD-EFGH",
    intervalMs: 1_000,
    expiresAt: Date.now() + 600_000,
  };

  it("shows the code, opens the page, and saves the token once approved", async () => {
    tempHome();
    vi.useFakeTimers();
    const output = captureOutput();
    const polls = [
      { status: "pending" },
      { status: "approved", token: TOKEN, runnerId: "r1", workspace: { name: "Acme", slug: "acme" } },
    ];
    const { d, fake } = deps({}, { loginStart: () => started, loginPoll: () => polls.shift() });
    const done = main(["login", "--server", `${SERVER}/`, "--name", "desk"], d);
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(output.text()).toContain("Confirm this code in your browser: ABCD-EFGH");
    expect(d.open).toHaveBeenCalledWith(started.verifyUrl);
    expect(fake.callsTo("loginStart")[0]?.args).toMatchObject({ name: "desk", version: VERSION });
    expect(fake.callsTo("loginPoll")).toHaveLength(2);
    const saved = loadConfig();
    expect(saved).toMatchObject({ server: SERVER, token: TOKEN, name: "desk" });
    expect(output.text()).toContain('Connected to Acme as "desk".');
    expect(output.text()).not.toContain(TOKEN);
  });

  it("won't open a sign-in link that isn't HTTPS", async () => {
    tempHome();
    vi.useFakeTimers();
    const output = captureOutput();
    const { d } = deps(
      {},
      {
        loginStart: () => ({ ...started, verifyUrl: "file:///etc/passwd" }),
        loginPoll: () => ({ status: "denied" }),
      },
    );
    const done = main(["login", "--server", SERVER], d).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toMatchObject({ message: "The sign-in was declined." });
    expect(d.open).not.toHaveBeenCalled();
    expect(output.text()).toContain("Open the link yourself");
  });

  it("gives up when the code expires", async () => {
    tempHome();
    vi.useFakeTimers();
    captureOutput();
    const { d } = deps(
      {},
      {
        loginStart: () => ({ ...started, expiresAt: Date.now() + 1_500 }),
        loginPoll: () => ({ status: "pending" }),
      },
    );
    const done = main(["login", "--server", SERVER], d).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await done).toMatchObject({ message: "The code expired. Run login again." });
    const again = deps({}, { loginStart: () => started, loginPoll: () => ({ status: "expired" }) });
    const second = main(["login", "--server", SERVER], again.d).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await second).toMatchObject({ message: "The code expired. Run login again." });
  });

  it("signs in to Yokka's server unless told otherwise", async () => {
    tempHome();
    captureOutput();
    const denied = { loginStart: () => started, loginPoll: () => ({ status: "denied" }) };
    const serverUsed = async (argv: string[]) => {
      vi.useFakeTimers();
      const { d } = deps({}, denied);
      const loginClientFor = vi.fn(d.loginClient);
      const done = main(argv, { ...d, loginClient: loginClientFor }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await done).toMatchObject({ message: "The sign-in was declined." });
      vi.useRealTimers();
      return loginClientFor.mock.calls[0]?.[0];
    };
    vi.stubEnv("YOKKA_SERVER", "");
    expect(await serverUsed(["login"])).toBe(DEFAULT_SERVER);
    vi.stubEnv("YOKKA_SERVER", "https://self-hosted.example.com/");
    expect(await serverUsed(["login"])).toBe("https://self-hosted.example.com");
    expect(await serverUsed(["login", "--server", SERVER])).toBe(SERVER);
    saveConfig({ ...defaults(), server: SERVER });
    expect(await serverUsed(["login"])).toBe(SERVER);
  });

  it("needs an HTTPS server", async () => {
    tempHome();
    await expect(main(["login", "--server", "http://evil.example.com"], deps().d)).rejects.toThrow(
      "must start with https://",
    );
    vi.stubEnv("YOKKA_SERVER", "http://evil.example.com");
    await expect(main(["login"], deps().d)).rejects.toThrow("must start with https://");
  });
});

describe("map and unmap", () => {
  function gitRepo() {
    const dir = canonical(tempDir("yokka-map-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    return dir;
  }

  it("links a folder to the project the person picks and tells the board", async () => {
    tempHome();
    signedIn();
    const output = captureOutput();
    const folder = gitRepo();
    const { d, fake, answers } = deps();
    answers.push("1", "2");
    await main(["map", folder], d);
    expect(loadConfig().projects).toEqual({ p1: { name: "Web", path: folder, mode: "worktree" } });
    expect(fake.callsTo("hello").at(-1)?.args).toMatchObject({
      projects: [{ projectId: "p1", mode: "worktree" }],
    });
    expect(fake.callsTo("hello").at(-1)?.args).not.toHaveProperty("agents");
    expect(output.text()).toContain(`Web → ${folder} (a worktree per run).`);
    expect(fake.isClosed()).toBe(true);
  });

  it("takes the project and mode from options", async () => {
    tempHome();
    signedIn();
    captureOutput();
    const folder = tempDir();
    const { d } = deps();
    await main(["map", folder, "--project", "web", "--mode", "in-place", "--allow-dirty"], d);
    expect(loadConfig().projects.p1).toMatchObject({ mode: "in_place", allowDirty: true });
    expect(d.ask).not.toHaveBeenCalled();
  });

  it("refuses what it can't map", async () => {
    tempHome();
    await expect(main(["map", tempDir()], deps().d)).rejects.toThrow("Sign in first");
    signedIn();
    captureOutput();
    const folder = tempDir();
    await expect(main(["map", join(folder, "missing")], deps().d)).rejects.toThrow("doesn't exist.");
    await expect(main(["map", folder, "--project", "NOPE"], deps().d)).rejects.toThrow(
      "No project NOPE in Acme.",
    );
    await expect(main(["map", folder, "--project", "p1", "--mode", "sideways"], deps().d)).rejects.toThrow(
      "--mode is in-place or worktree",
    );
    await expect(main(["map", folder, "--project", "p1", "--mode", "worktree"], deps().d)).rejects.toThrow(
      "Worktrees need the folder to be a git repository.",
    );
    const picky = deps();
    picky.answers.push("7");
    await expect(main(["map", folder], picky.d)).rejects.toThrow("No project picked.");
    const empty = deps({}, { hello: () => ({ ...hello, projects: [] }) });
    await expect(main(["map", folder], empty.d)).rejects.toThrow("Acme has no projects yet.");
  });

  it("forgets a folder by project id, name, or the current folder", async () => {
    tempHome();
    const output = captureOutput();
    const folder = tempDir();
    signedIn({
      projects: {
        p1: { name: "Web", path: folder, mode: "in_place" },
        p2: { name: "Api", path: join(folder, "api"), mode: "in_place" },
      },
    });
    await main(["unmap", "Api"], deps().d);
    expect(Object.keys(loadConfig().projects)).toEqual(["p1"]);
    await main(["unmap"], deps({ cwd: () => folder }).d);
    expect(loadConfig().projects).toEqual({});
    expect(output.text()).toContain("Forgot Web.");
    await expect(main(["unmap", "p1"], deps().d)).rejects.toThrow("No such mapped project.");
  });
});

describe("start", () => {
  it("runs the daemon when signed in with projects", async () => {
    tempHome();
    signedIn({ projects: { p1: { name: "Web", path: tempDir(), mode: "in_place" } } });
    const { d } = deps();
    await main([], d);
    expect(d.runDaemon).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN }));
  });

  it("signs in and maps the current folder first when needed", async () => {
    tempHome();
    vi.useFakeTimers();
    captureOutput();
    const folder = tempDir();
    const { d, answers } = deps(
      { cwd: () => folder },
      {
        loginStart: () => ({
          userCode: "ABCD-EFGH",
          deviceCode: "d",
          verifyUrl: "https://yokka.ai/runner",
          intervalMs: 500,
          expiresAt: Date.now() + 60_000,
        }),
        loginPoll: () => ({
          status: "approved",
          token: TOKEN,
          runnerId: "r1",
          workspace: { name: "Acme", slug: "acme" },
        }),
      },
    );
    answers.push("1");
    const done = main(["start", "--server", SERVER], d);
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(d.runDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        token: TOKEN,
        projects: { p1: expect.objectContaining({ path: canonical(folder) }) },
      }),
    );
  });
});

describe("status, config and logout", () => {
  it("shows the configuration, masking the token", async () => {
    tempHome();
    signedIn({ projects: { p1: { name: "Web", path: tempDir(), mode: "in_place" } } });
    const output = captureOutput();
    await main(["config"], deps().d);
    expect(output.text()).toContain('"token": "yr_abc…"');
    expect(output.text()).not.toContain(TOKEN);
  });

  it("sets a value and saves it", async () => {
    tempHome();
    signedIn();
    captureOutput();
    await main(["config", "agents.codex.model", "gpt-5.6-sol"], deps().d);
    expect(loadConfig().agents.codex.model).toBe("gpt-5.6-sol");
    await expect(main(["config", "maxConcurrent"], deps().d)).rejects.toThrow("Give a value");
    await expect(main(["config", "server", "https://evil.example.com"], deps().d)).rejects.toThrow(
      "Use `login`",
    );
  });

  it("signs out by forgetting the token", async () => {
    tempHome();
    signedIn();
    captureOutput();
    await main(["logout"], deps().d);
    expect(JSON.parse(readFileSync(configPath(), "utf8"))).not.toHaveProperty("token");
    expect(loadConfig().server).toBe(SERVER);
  });

  it("reports whether each agent is ready", async () => {
    tempHome();
    const missing = "yokka-no-such-agent-xyz";
    writeFileSync(
      configPath(),
      JSON.stringify({ agents: { "claude-code": { command: missing }, codex: { command: missing } } }),
    );
    const output = captureOutput();
    await main(["status"], deps().d);
    expect(output.text()).toContain("Signed in: no");
    expect(output.text()).toContain(
      `Claude Code: not ready: \`${missing}\` isn't installed or isn't on PATH`,
    );
    expect(output.text()).toContain(`Codex: not ready: \`${missing}\` isn't installed`);
  });
});
