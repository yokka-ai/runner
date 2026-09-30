#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { hostname, platform, release } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { claudeAdapter } from "./adapters/claude.ts";
import { codexAdapter } from "./adapters/codex.ts";
import { DEFAULT_SERVER, httpClient, liveClient, PROTOCOL, VERSION } from "./api.ts";
import { type Config, configPath, loadConfig, saveConfig, setKey, type WorkspaceModeName } from "./config.ts";
import { runDaemon } from "./daemon.ts";
import { openUrl } from "./proc.ts";
import { isRepo } from "./workspace.ts";

const HELP = `yokka-runner ${VERSION}: starts Claude Code and Codex on this machine for cards on your Yokka board.

Usage: yokka-runner [command] [options]

Commands
  start               Connect and take runs (the default)
  login               Sign this machine in to a workspace
  map [folder]        Link a folder to a project (the current folder by default)
  unmap [project]     Forget a project's folder
  status              What's configured and whether the agents are ready
  config [key value]  Show the config, or set a value (e.g. agents.codex.model gpt-5.6-sol)
  logout              Forget this machine's runner token
  verify              Show this build's version and how to check where it came from

Options
  --server <url>      Another Yokka deployment's URL, for self-hosting or development (login only)
  --name <name>       What the board calls this runner (login only)
  --project <id>      The project to map (map only; asks when left out)
  --mode <mode>       in-place or worktree (map only)
  --allow-dirty       In place: start even with uncommitted changes (map only)
  -h, --help          Show this help
  -v, --version       Show the version
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      server: { type: "string" },
      name: { type: "string" },
      project: { type: "string" },
      mode: { type: "string" },
      "allow-dirty": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) return console.log(HELP);
  if (values.version) return console.log(VERSION);
  const [command = "start", ...rest] = positionals;
  const config = loadConfig();

  switch (command) {
    case "start":
      if (!config.token) {
        console.log("This machine isn't signed in yet.\n");
        await login(config, values.server, values.name);
      }
      if (Object.keys(config.projects).length === 0) {
        console.log("\nNo project folders yet. Mapping the current folder:\n");
        await map(config, process.cwd(), values);
      }
      return runDaemon(loadConfig());
    case "login":
      return login(config, values.server, values.name);
    case "map":
      return map(config, rest[0] ?? process.cwd(), values);
    case "unmap":
      return unmap(config, rest[0]);
    case "status":
      return status(config);
    case "config":
      return configure(config, rest);
    case "logout":
      config.token = undefined;
      saveConfig(config);
      return console.log("Signed out. Disconnect the runner on the board too, under Settings, Agents.");
    case "verify":
      return verify();
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

async function login(
  config: Config,
  server = config.server ?? process.env.YOKKA_SERVER ?? DEFAULT_SERVER,
  name?: string,
) {
  config.server = server.replace(/\/$/, "");
  if (name) config.name = name;
  const api = httpClient(config.server);
  const login = await api.loginStart({
    name: config.name,
    machine: hostname(),
    platform: `${platform()} ${release()}`,
    version: VERSION,
  });
  console.log(`Confirm this code in your browser: ${login.userCode}\n  ${login.verifyUrl}\n`);
  openUrl(login.verifyUrl);
  for (;;) {
    await new Promise((r) => setTimeout(r, login.intervalMs));
    const res = await api.loginPoll(login.deviceCode);
    if (res.status === "pending") continue;
    if (res.status === "approved") {
      config.token = res.token;
      saveConfig(config);
      console.log(`Connected to ${res.workspace.name} as "${config.name}".`);
      return;
    }
    throw new Error(
      res.status === "denied" ? "The sign-in was declined." : "The code expired. Run login again.",
    );
  }
}

function modeOf(value: string | undefined): WorkspaceModeName | undefined {
  if (!value) return undefined;
  if (value === "in-place" || value === "in_place") return "in_place";
  if (value === "worktree") return "worktree";
  throw new Error("--mode is in-place or worktree");
}

async function ask(question: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function map(
  config: Config,
  folder: string,
  opts: { project?: string; mode?: string; "allow-dirty"?: boolean },
) {
  if (!config.server || !config.token) throw new Error("Sign in first: yokka-runner login");
  const path = realpathSync(resolve(folder));
  if (!existsSync(path)) throw new Error(`${path} doesn't exist.`);
  const live = liveClient(config.server, config.token);
  try {
    const hello = await live.hello({
      projects: Object.entries(config.projects).map(([projectId, p]) => ({ projectId, mode: p.mode })),
      maxConcurrent: config.maxConcurrent,
    });
    let project = hello.projects.find(
      (p) =>
        p._id === opts.project || p.slug === opts.project || p.cardPrefix === opts.project?.toUpperCase(),
    );
    if (!project) {
      console.log(`Projects in ${hello.workspace.name}:`);
      for (const [i, p] of hello.projects.entries()) console.log(`  ${i + 1}. ${p.name} (${p.cardPrefix})`);
      const pick = Number(await ask(`Which project is ${path}? `));
      project = hello.projects[pick - 1];
      if (!project) throw new Error("No project picked.");
    }
    const repo = await isRepo(path);
    let mode = modeOf(opts.mode);
    if (!mode) {
      const answer = repo
        ? await ask("Work in place (1) or give each run its own git worktree (2)? [1] ")
        : "1";
      mode = answer === "2" ? "worktree" : "in_place";
    }
    if (mode === "worktree" && !repo) throw new Error("Worktrees need the folder to be a git repository.");
    config.projects[project._id] = {
      ...config.projects[project._id],
      name: project.name,
      path,
      mode,
      allowDirty: opts["allow-dirty"] ?? config.projects[project._id]?.allowDirty,
    };
    saveConfig(config);
    // Tell the board right away, so the Start menu offers this runner.
    await live.hello({
      projects: Object.entries(config.projects).map(([projectId, p]) => ({ projectId, mode: p.mode })),
      maxConcurrent: config.maxConcurrent,
    });
    console.log(`${project.name} → ${path} (${mode === "worktree" ? "a worktree per run" : "in place"}).`);
  } finally {
    await live.close();
  }
}

function unmap(config: Config, which: string | undefined) {
  const entry = Object.entries(config.projects).find(
    ([id, p]) => id === which || p.name === which || (!which && p.path === process.cwd()),
  );
  if (!entry) throw new Error("No such mapped project. `yokka-runner status` lists them.");
  delete config.projects[entry[0]];
  saveConfig(config);
  console.log(`Forgot ${entry[1].name}.`);
}

async function status(config: Config) {
  console.log(`Config: ${configPath}`);
  console.log(
    `Server: ${config.server ?? "not set"}  Signed in: ${config.token ? "yes" : "no"}  Name: ${config.name}`,
  );
  console.log(`Runs at once: ${config.maxConcurrent}`);
  for (const [id, p] of Object.entries(config.projects))
    console.log(`  ${p.name}: ${p.path} (${p.mode.replace("_", " ")})  [${id}]`);
  for (const adapter of [claudeAdapter(config.agents["claude-code"]), codexAdapter(config.agents.codex)]) {
    const d = await adapter.detect();
    console.log(`${adapter.label}: ${d.problem ? `not ready: ${d.problem}` : `ready (${d.version ?? "?"})`}`);
  }
}

function configure(config: Config, rest: string[]) {
  if (rest.length >= 2) {
    setKey(config, rest[0], rest.slice(1).join(" "));
    saveConfig(config);
  }
  console.log(
    JSON.stringify({ ...config, token: config.token ? `${config.token.slice(0, 8)}…` : undefined }, null, 2),
  );
}

function verify() {
  console.log(`yokka-runner ${VERSION}, protocol ${PROTOCOL}, Node ${process.version} on ${platform()}.`);
  console.log(
    [
      "",
      "Published builds are made by GitHub Actions and carry an npm provenance attestation that ties the",
      "package to the commit and workflow that built it. To check the copy you installed:",
      "  npm audit signatures            (in a project that depends on yokka-runner)",
      `  npm view yokka-runner@${VERSION} dist.attestations`,
      "The source is at https://github.com/yokka-ai/runner; the protocol it speaks is in PROTOCOL.md there.",
    ].join("\n"),
  );
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exitCode = 1;
});
