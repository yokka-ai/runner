import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

/**
 * Everything the runner knows lives in one folder on this machine (`~/.yokka`, or `YOKKA_HOME`): the config
 * with the runner token and the project folders, and the ledger of runs. Folders never go to the server.
 */
export const home = process.env.YOKKA_HOME ?? join(homedir(), ".yokka");
export const configPath = join(home, "runner.json");

export type WorkspaceModeName = "in_place" | "worktree";

export type ProjectConfig = {
  name: string;
  path: string;
  mode: WorkspaceModeName;
  /** In place: start even when the folder has uncommitted changes. */
  allowDirty?: boolean;
  worktree?: {
    /** Branch new worktrees start from; the repo's default branch when unset. */
    base?: string;
    /** Run once in each new worktree, like `npm ci`. */
    setup?: string;
    /** `keep` until the card is done (default), or `delete` when the run ends with nothing uncommitted. */
    cleanup?: "keep" | "delete";
  };
};

export type ClaudeConfig = {
  enabled: boolean;
  command: string;
  /** Never bypassPermissions: the runner refuses it. */
  permissionMode: "default" | "acceptEdits" | "plan" | "auto";
  model?: string;
};

export type CodexConfig = {
  enabled: boolean;
  command: string;
  model?: string;
  sandbox: "read-only" | "workspace-write";
  approvalPolicy: "untrusted" | "on-request" | "never";
};

export type Config = {
  server?: string;
  token?: string;
  name: string;
  maxConcurrent: number;
  projects: Record<string, ProjectConfig>;
  agents: { "claude-code": ClaudeConfig; codex: CodexConfig };
};

export function defaults(): Config {
  return {
    name: hostname().split(".")[0] || "runner",
    maxConcurrent: 2,
    projects: {},
    agents: {
      "claude-code": { enabled: true, command: "claude", permissionMode: "acceptEdits" },
      codex: { enabled: true, command: "codex", sandbox: "workspace-write", approvalPolicy: "never" },
    },
  };
}

export function loadConfig(): Config {
  const base = defaults();
  if (!existsSync(configPath)) return base;
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<Config>;
  return {
    ...base,
    ...raw,
    projects: raw.projects ?? {},
    agents: {
      "claude-code": { ...base.agents["claude-code"], ...raw.agents?.["claude-code"] },
      codex: { ...base.agents.codex, ...raw.agents?.codex },
    },
  };
}

/** Writes atomically, readable only by this user on macOS and Linux (it holds the runner token). */
export function saveConfig(config: Config) {
  mkdirSync(home, { recursive: true });
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, configPath);
  try {
    chmodSync(configPath, 0o600);
  } catch {
    // Windows keeps the user profile private already.
  }
}

/** Sets a dotted key (`agents.codex.model`) from the command line, parsing numbers and booleans. */
export function setKey(config: Config, key: string, value: string) {
  const parts = key.split(".");
  if (parts[0] === "token" || parts[0] === "projects")
    throw new Error(`Use \`login\` or \`map\` to change ${parts[0]}.`);
  let target = config as unknown as Record<string, unknown>;
  for (const p of parts.slice(0, -1)) {
    if (typeof target[p] !== "object" || target[p] === null) target[p] = {};
    target = target[p] as Record<string, unknown>;
  }
  const parsed =
    value === "true" ? true : value === "false" ? false : /^\d+$/.test(value) ? Number(value) : value;
  if (key === "agents.claude-code.permissionMode" && value === "bypassPermissions")
    throw new Error("The runner never skips permissions.");
  target[parts.at(-1)!] = parsed;
}
