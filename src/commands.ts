import { hostname, platform, release } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { claudeAdapter } from "./adapters/claude.ts";
import { codexAdapter } from "./adapters/codex.ts";
import {
  DEFAULT_SERVER,
  type Hello,
  httpTransport,
  type Live,
  type LoginClient,
  liveClient,
  loginClient,
  websocketTransport,
} from "./api.ts";
import {
  type Config,
  configPath,
  loadConfig,
  projectModes,
  saveConfig,
  setKey,
  settableKeys,
  type WorkspaceModeName,
} from "./config.ts";
import { runDaemon } from "./daemon.ts";
import { serverFromEnv } from "./env.ts";
import { print } from "./log.ts";
import { openableUrl, serverUrl, sleep } from "./net.ts";
import { openUrl } from "./proc.ts";
import { PROTOCOL, VERSION } from "./version.ts";
import { canonical, checkFolder, isRepo } from "./workspace.ts";

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

/** A sign-in that takes longer than this is abandoned, whatever the server says about its code. */
const LOGIN_MAX_MS = 15 * 60_000;

/** What the commands reach outside the process through; tests replace these. */
export type CliDeps = {
  loginClient: (server: string) => LoginClient;
  liveClient: (server: string, token: string) => Live;
  runDaemon: (config: Config) => Promise<void>;
  ask: (question: string) => Promise<string>;
  open: (url: string) => boolean;
  cwd: () => string;
};

async function ask(question: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export const defaultDeps: CliDeps = {
  loginClient: (server) => loginClient(httpTransport(server)),
  liveClient: (server, token) => liveClient(websocketTransport(server), token),
  runDaemon: (config) => runDaemon(config),
  ask,
  open: openUrl,
  cwd: () => process.cwd(),
};

type Options = {
  server?: string;
  name?: string;
  project?: string;
  mode?: string;
  "allow-dirty"?: boolean;
};

/** Runs one command line (without the `node cli.js` part). */
export async function main(argv: string[], deps: CliDeps = defaultDeps) {
  const { values, positionals } = parseArgs({
    args: argv,
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
  if (values.help) return print(HELP);
  if (values.version) return print(VERSION);
  const [command = "start", ...rest] = positionals;

  switch (command) {
    case "start": {
      let config = loadConfig();
      if (!config.token) {
        print("This machine isn't signed in yet.\n");
        config = await login(config, deps, values.server, values.name);
      }
      if (Object.keys(config.projects).length === 0) {
        print("\nNo project folders yet. Mapping the current folder:\n");
        config = await map(config, deps, deps.cwd(), values);
      }
      return deps.runDaemon(config);
    }
    case "login":
      await login(loadConfig(), deps, values.server, values.name);
      return;
    case "map":
      await map(loadConfig(), deps, rest[0] ?? deps.cwd(), values);
      return;
    case "unmap":
      return unmap(loadConfig(), deps, rest[0]);
    case "status":
      return status(loadConfig());
    case "config":
      return configure(loadConfig(), rest);
    case "logout": {
      saveConfig({ ...loadConfig(), token: undefined });
      return print("Signed out. Disconnect the runner on the board too, under Settings, Agents.");
    }
    case "verify":
      return verify();
    default:
      print(HELP);
      process.exitCode = 1;
  }
}

/**
 * Device-code sign-in: shows a code, opens the page to confirm it, and waits for the token. The server is
 * `--server`, else the one this machine signed in to before, else `YOKKA_SERVER`, else Yokka's own; whichever
 * it is must be HTTPS (or on this machine).
 */
export async function login(config: Config, deps: CliDeps, serverArg?: string, name?: string) {
  const server = serverUrl(serverArg ?? config.server ?? serverFromEnv() ?? DEFAULT_SERVER);
  const runnerName = name?.trim() || config.name;
  const api = deps.loginClient(server);
  const started = await api.loginStart({
    name: runnerName,
    machine: hostname(),
    platform: `${platform()} ${release()}`,
    version: VERSION,
  });
  print(`Confirm this code in your browser: ${started.userCode}\n  ${started.verifyUrl}\n`);
  if (!openableUrl(started.verifyUrl) || !deps.open(started.verifyUrl))
    print("(Open the link yourself; the runner only opens https:// links.)");
  const deadline = Math.min(started.expiresAt, Date.now() + LOGIN_MAX_MS);
  for (;;) {
    await sleep(started.intervalMs);
    if (Date.now() > deadline) throw new Error("The code expired. Run login again.");
    const res = await api.loginPoll(started.deviceCode);
    if (res.status === "pending") continue;
    if (res.status === "approved") {
      // A token belongs to the deployment that issued it; the server and token always change together.
      const next: Config = { ...config, server, token: res.token, name: runnerName };
      saveConfig(next);
      print(`Connected to ${res.workspace.name} as "${runnerName}".`);
      return next;
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

/** The project `--project` names (id, slug or card prefix), or the one the person picks from the list. */
async function pickProject(hello: Hello, deps: CliDeps, wanted: string | undefined, path: string) {
  if (wanted) {
    const named = hello.projects.find(
      (p) => p._id === wanted || p.slug === wanted || p.cardPrefix === wanted.toUpperCase(),
    );
    if (!named) throw new Error(`No project ${wanted} in ${hello.workspace.name}.`);
    return named;
  }
  if (hello.projects.length === 0) throw new Error(`${hello.workspace.name} has no projects yet.`);
  print(`Projects in ${hello.workspace.name}:`);
  for (const [i, p] of hello.projects.entries()) print(`  ${i + 1}. ${p.name} (${p.cardPrefix})`);
  const pick = Number(await deps.ask(`Which project is ${path}? `));
  const project = Number.isInteger(pick) ? hello.projects[pick - 1] : undefined;
  if (!project) throw new Error("No project picked.");
  return project;
}

/** The mode `--mode` names, or the person's answer; worktrees only in a git repository. */
async function pickMode(deps: CliDeps, option: string | undefined, path: string): Promise<WorkspaceModeName> {
  const repo = await isRepo(path);
  let mode = modeOf(option);
  if (!mode) {
    const answer = repo
      ? await deps.ask("Work in place (1) or give each run its own git worktree (2)? [1] ")
      : "1";
    mode = answer === "2" ? "worktree" : "in_place";
  }
  if (mode === "worktree" && !repo) throw new Error("Worktrees need the folder to be a git repository.");
  return mode;
}

/** Links a folder to one of the workspace's projects and tells the board, so Start offers this runner. */
export async function map(config: Config, deps: CliDeps, folder: string, opts: Options) {
  if (!config.server || !config.token) throw new Error("Sign in first: yokka-runner login");
  const path = canonical(checkFolder(folder));
  const live = deps.liveClient(config.server, config.token);
  try {
    const hello = await live.hello({ projects: projectModes(config), maxConcurrent: config.maxConcurrent });
    const project = await pickProject(hello, deps, opts.project, path);
    const mode = await pickMode(deps, opts.mode, path);
    const previous = config.projects[project._id];
    const allowDirty = opts["allow-dirty"] ?? previous?.allowDirty;
    const mapped = {
      ...previous,
      name: project.name,
      path,
      mode,
      ...(allowDirty !== undefined ? { allowDirty } : {}),
    };
    const next: Config = { ...config, projects: { ...config.projects, [project._id]: mapped } };
    saveConfig(next);
    // Tell the board right away, so the Start menu offers this runner.
    await live.hello({ projects: projectModes(next), maxConcurrent: next.maxConcurrent });
    print(`${project.name} → ${path} (${mode === "worktree" ? "a worktree per run" : "in place"}).`);
    return next;
  } finally {
    await live.close().catch(() => undefined);
  }
}

/** Forgets a mapped folder, by project id, name, or (with none given) the current folder. */
export function unmap(config: Config, deps: CliDeps, which: string | undefined) {
  const here = resolve(deps.cwd());
  const entry = Object.entries(config.projects).find(
    ([id, p]) => id === which || p.name === which || (!which && resolve(p.path) === here),
  );
  if (!entry) throw new Error("No such mapped project. `yokka-runner status` lists them.");
  const [id, project] = entry;
  saveConfig({
    ...config,
    projects: Object.fromEntries(Object.entries(config.projects).filter(([k]) => k !== id)),
  });
  print(`Forgot ${project.name}.`);
}

export async function status(config: Config) {
  print(`Config: ${configPath()}`);
  print(
    `Server: ${config.server ?? "not set"}  Signed in: ${config.token ? "yes" : "no"}  Name: ${config.name}`,
  );
  print(`Runs at once: ${config.maxConcurrent}`);
  for (const [id, p] of Object.entries(config.projects))
    print(`  ${p.name}: ${p.path} (${p.mode.replace("_", " ")})  [${id}]`);
  for (const adapter of [claudeAdapter(config.agents["claude-code"]), codexAdapter(config.agents.codex)]) {
    const d = await adapter.detect();
    print(`${adapter.label}: ${d.problem ? `not ready: ${d.problem}` : `ready (${d.version ?? "?"})`}`);
  }
}

/** Shows the config (the token masked), or sets one value and shows the result. */
export function configure(config: Config, rest: string[]) {
  const [key, ...value] = rest;
  let shown = config;
  if (key && value.length === 0)
    throw new Error(
      `Give a value: yokka-runner config ${key} <value> (settings: ${settableKeys().join(", ")})`,
    );
  if (key) {
    shown = setKey(config, key, value.join(" "));
    saveConfig(shown);
  }
  print(
    JSON.stringify({ ...shown, token: shown.token ? `${shown.token.slice(0, 6)}…` : undefined }, null, 2),
  );
}

function verify() {
  print(`yokka-runner ${VERSION}, protocol ${PROTOCOL}, Node ${process.version} on ${platform()}.`);
  print(
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
