import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { runnerHome } from "./env.ts";
import { serverUrl } from "./net.ts";
import {
  boolean,
  type Infer,
  literal,
  number,
  object,
  optional,
  parse,
  record,
  refine,
  string,
} from "./schema.ts";

/**
 * Everything the runner knows lives in one folder on this machine (`~/.yokka`, or `YOKKA_HOME`): the config
 * with the runner token and the project folders, and the ledger of runs. Folders never go to the server.
 */
export function configPath() {
  return join(runnerHome(), "runner.json");
}

export const RUNNER_TOKEN = /^yr_[A-Za-z0-9]{40}$/;
export const MAX_CONCURRENT = 10;

const nonEmpty = refine(string, (s) => s.trim().length > 0, "a non-empty string");
const workspaceMode = literal("in_place", "worktree");

const projectSchema = object({
  name: string,
  /** Absolute, as `map` stores it; a relative path would depend on where the runner happens to start. */
  path: refine(string, (p) => isAbsolute(p), "an absolute folder path"),
  mode: workspaceMode,
  /** In place: start even when the folder has uncommitted changes. */
  allowDirty: optional(boolean),
  worktree: optional(
    object({
      /** Branch new worktrees start from; the repo's default branch when unset. */
      base: optional(nonEmpty),
      /** Run once in each new worktree, like `npm ci`, through the system shell: it's the person's own command. */
      setup: optional(nonEmpty),
      /** `keep` until the card is done (default), or `delete` when the run ends with nothing uncommitted. */
      cleanup: optional(literal("keep", "delete")),
    }),
  ),
});

/** Never `bypassPermissions`: the runner refuses to start agents that skip permission prompts. */
export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto"] as const;

const claudeSchema = object({
  enabled: boolean,
  command: nonEmpty,
  permissionMode: literal(...PERMISSION_MODES),
  model: optional(nonEmpty),
});

const codexSchema = object({
  enabled: boolean,
  command: nonEmpty,
  model: optional(nonEmpty),
  sandbox: literal("read-only", "workspace-write"),
  approvalPolicy: literal("untrusted", "on-request", "never"),
});

const configSchema = object({
  server: optional(refine(string, validServer, "an https:// deployment URL")),
  token: optional(refine(string, (t) => RUNNER_TOKEN.test(t), "a runner token (yr_ and 40 characters)")),
  name: nonEmpty,
  maxConcurrent: refine(
    number,
    (n) => Number.isInteger(n) && n >= 1 && n <= MAX_CONCURRENT,
    `a whole number from 1 to ${MAX_CONCURRENT}`,
  ),
  projects: record(projectSchema),
  agents: object({ "claude-code": claudeSchema, codex: codexSchema }),
});

export type WorkspaceModeName = Infer<typeof workspaceMode>;
export type ProjectConfig = Infer<typeof projectSchema>;
export type ClaudeConfig = Infer<typeof claudeSchema>;
export type CodexConfig = Infer<typeof codexSchema>;
export type Config = Infer<typeof configSchema>;

function validServer(s: string) {
  try {
    return serverUrl(s) === s;
  } catch {
    return false;
  }
}

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Fills in defaults for what the file leaves out, then checks the whole thing. */
export function normalizeConfig(raw: unknown, where: string): Config {
  const base = defaults();
  const file = isRecord(raw) ? raw : {};
  const agents = isRecord(file.agents) ? file.agents : {};
  const claude = isRecord(agents["claude-code"]) ? agents["claude-code"] : {};
  const codex = isRecord(agents.codex) ? agents.codex : {};
  const merged = {
    ...base,
    ...file,
    projects: file.projects ?? {},
    agents: {
      "claude-code": { ...base.agents["claude-code"], ...claude },
      codex: { ...base.agents.codex, ...codex },
    },
  };
  if (!isRecord(raw)) parse(object({}), raw, where);
  return parse(configSchema, merged, where);
}

/** Reads the config, or the defaults when there's none yet. Throws, naming the field, when it's invalid. */
export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) return defaults();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} isn't valid JSON (${(err as Error).message}). Fix or delete it.`);
  }
  return normalizeConfig(raw, path);
}

/**
 * Makes a file readable by this user only. POSIX: mode 0600. Windows: best effort, by removing inherited
 * permissions and granting only the current user (the profile folder is usually private already).
 */
export function restrictToOwner(path: string) {
  if (process.platform !== "win32") {
    chmodSync(path, 0o600);
    return;
  }
  try {
    execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${userInfo().username}:F`], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
  } catch {
    // icacls missing or the account name not resolvable: the profile folder's own permissions still apply.
  }
}

/** Writes JSON atomically (temp file, then rename), readable by this user only. */
export function writePrivateJson(path: string, value: unknown) {
  mkdirSync(runnerHome(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  restrictToOwner(path);
}

/** Saves the config (it holds the runner token). */
export function saveConfig(config: Config) {
  writePrivateJson(configPath(), parse(configSchema, config, "config"));
}

/**
 * The keys `config <key> <value>` may set, with how to read the value. The token, the server and the list
 * of projects change only through `login` and `map`: pointing the token at another server from a one-line
 * command would hand it to that server.
 */
const SETTABLE = new Set([
  "name",
  "maxConcurrent",
  "agents.claude-code.enabled",
  "agents.claude-code.command",
  "agents.claude-code.permissionMode",
  "agents.claude-code.model",
  "agents.codex.enabled",
  "agents.codex.command",
  "agents.codex.model",
  "agents.codex.sandbox",
  "agents.codex.approvalPolicy",
]);

const PROJECT_KEYS = ["mode", "allowDirty", "worktree.base", "worktree.setup", "worktree.cleanup"];

/** The keys `setKey` accepts, for help text. */
export function settableKeys() {
  return [...SETTABLE, ...PROJECT_KEYS.map((k) => `projects.<id>.${k}`)];
}

function parseValue(key: string, value: string): unknown {
  if (value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  if (key.endsWith(".mode") && value === "in-place") return "in_place";
  return value;
}

/**
 * Sets a dotted key (`agents.codex.model`) from the command line, parsing numbers and booleans; an empty
 * value unsets an optional one. Returns the new config, checked as a whole; throws on an unknown key or a
 * value the config doesn't allow.
 */
export function setKey(config: Config, key: string, value: string): Config {
  if (key === "agents.claude-code.permissionMode" && value === "bypassPermissions")
    throw new Error("The runner never skips permissions.");
  const parts = key.split(".");
  const top = parts[0];
  if (top === "token" || top === "server") throw new Error(`Use \`login\` to change ${top}.`);
  if (top === "projects") {
    const [, id, ...rest] = parts;
    if (!id || !config.projects[id]) throw new Error(`No mapped project ${id ?? ""}. \`status\` lists them.`);
    if (!PROJECT_KEYS.includes(rest.join(".")))
      throw new Error(`Projects take ${PROJECT_KEYS.join(", ")}. Use \`map\` or \`unmap\` for the folder.`);
  } else if (!SETTABLE.has(key)) {
    throw new Error(`Unknown setting ${key}. Settings: ${settableKeys().join(", ")}.`);
  }
  const next = structuredClone(config) as unknown as Record<string, unknown>;
  let target = next;
  for (const p of parts.slice(0, -1)) {
    const child = target[p];
    if (isRecord(child)) target = child;
    else {
      const created: Record<string, unknown> = {};
      target[p] = created;
      target = created;
    }
  }
  const leaf = parts.at(-1) ?? key;
  const parsed = parseValue(key, value);
  if (parsed === undefined) delete target[leaf];
  else target[leaf] = parsed;
  return parse(configSchema, next, "config");
}

/** Projects as `hello` reports them: ids and modes, never folders. */
export function projectModes(config: Config) {
  return Object.entries(config.projects).map(([projectId, p]) => ({ projectId, mode: p.mode }));
}
