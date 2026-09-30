import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Config,
  configPath,
  defaults,
  loadConfig,
  normalizeConfig,
  projectModes,
  saveConfig,
  setKey,
  settableKeys,
} from "../src/config.ts";
import { tempHome } from "./helpers.ts";

const TOKEN = `yr_${"abcd".repeat(10)}`;
const PROJECT_PATH = join(process.cwd(), "some-project");

function withProject(config: Config = defaults()): Config {
  return { ...config, projects: { p1: { name: "Web", path: PROJECT_PATH, mode: "in_place" } } };
}

describe("loading the config", () => {
  it("starts from the defaults when there's no file", () => {
    const home = tempHome();
    expect(configPath()).toBe(join(home, "runner.json"));
    const config = loadConfig();
    expect(config.maxConcurrent).toBe(2);
    expect(config.agents["claude-code"].permissionMode).toBe("acceptEdits");
    expect(config.agents.codex.sandbox).toBe("workspace-write");
    expect(config.name.length).toBeGreaterThan(0);
  });

  it("fills in what the file leaves out", () => {
    tempHome();
    writeFileSync(configPath(), JSON.stringify({ name: "laptop", agents: { codex: { model: "gpt-x" } } }));
    const config = loadConfig();
    expect(config.name).toBe("laptop");
    expect(config.agents.codex).toEqual({
      enabled: true,
      command: "codex",
      sandbox: "workspace-write",
      approvalPolicy: "never",
      model: "gpt-x",
    });
    expect(config.projects).toEqual({});
  });

  it("names the field that's wrong", () => {
    tempHome();
    writeFileSync(
      configPath(),
      JSON.stringify({ agents: { "claude-code": { permissionMode: "bypassPermissions" } } }),
    );
    expect(() => loadConfig()).toThrow(
      "agents.claude-code.permissionMode: expected one of default, acceptEdits, plan, auto",
    );
  });

  it("says when the file isn't JSON", () => {
    tempHome();
    writeFileSync(configPath(), "{ nope");
    expect(() => loadConfig()).toThrow("isn't valid JSON");
  });

  it("refuses a plain-HTTP server, a malformed token and a relative project folder", () => {
    expect(() => normalizeConfig({ server: "http://deploy.example.com" }, "cfg")).toThrow(
      "cfg.server: expected an https:// deployment URL",
    );
    expect(() => normalizeConfig({ token: "yr_short" }, "cfg")).toThrow("cfg.token: expected a runner token");
    expect(() =>
      normalizeConfig({ projects: { p: { name: "x", path: "relative/dir", mode: "in_place" } } }, "cfg"),
    ).toThrow("cfg.projects.p.path: expected an absolute folder path");
    expect(() => normalizeConfig({ maxConcurrent: 0 }, "cfg")).toThrow("a whole number from 1 to 10");
    expect(() => normalizeConfig([], "cfg")).toThrow("cfg: expected an object, got an array");
  });

  it("accepts a local development server over plain HTTP", () => {
    expect(normalizeConfig({ server: "http://127.0.0.1:3210" }, "cfg").server).toBe("http://127.0.0.1:3210");
  });
});

describe("saving the config", () => {
  it("round-trips and drops unset optional values", () => {
    tempHome();
    const config = { ...withProject(), server: "https://x.convex.cloud", token: TOKEN };
    saveConfig(config);
    expect(loadConfig()).toEqual(config);
    saveConfig({ ...config, token: undefined });
    expect(JSON.parse(readFileSync(configPath(), "utf8"))).not.toHaveProperty("token");
  });

  it.runIf(process.platform !== "win32")("is readable by its owner only", () => {
    tempHome();
    saveConfig({ ...defaults(), token: TOKEN });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary file behind", () => {
    const home = tempHome();
    saveConfig(defaults());
    expect(existsSync(join(home, `runner.json.${process.pid}.tmp`))).toBe(false);
  });

  it("refuses to save an invalid config", () => {
    tempHome();
    expect(() => saveConfig({ ...defaults(), maxConcurrent: 99 })).toThrow("config.maxConcurrent");
  });
});

describe("setKey", () => {
  it("sets numbers, booleans and strings", () => {
    let config = setKey(defaults(), "maxConcurrent", "4");
    config = setKey(config, "agents.codex.enabled", "false");
    config = setKey(config, "agents.codex.model", "gpt-5.6-sol");
    config = setKey(config, "name", "desk");
    expect(config.maxConcurrent).toBe(4);
    expect(config.agents.codex.enabled).toBe(false);
    expect(config.agents.codex.model).toBe("gpt-5.6-sol");
    expect(config.name).toBe("desk");
  });

  it("unsets an optional value given an empty one", () => {
    const config = setKey(setKey(defaults(), "agents.codex.model", "m"), "agents.codex.model", "");
    expect(config.agents.codex).not.toHaveProperty("model");
  });

  it("doesn't change the config it was given", () => {
    const config = defaults();
    setKey(config, "maxConcurrent", "5");
    expect(config.maxConcurrent).toBe(2);
  });

  it("never skips permissions", () => {
    expect(() => setKey(defaults(), "agents.claude-code.permissionMode", "bypassPermissions")).toThrow(
      "The runner never skips permissions.",
    );
  });

  it("checks the value against the config's rules", () => {
    expect(() => setKey(defaults(), "maxConcurrent", "50")).toThrow("config.maxConcurrent");
    expect(() => setKey(defaults(), "agents.codex.sandbox", "danger-full-access")).toThrow(
      "config.agents.codex.sandbox: expected one of read-only, workspace-write",
    );
  });

  it("keeps the token and server to login", () => {
    expect(() => setKey(defaults(), "token", TOKEN)).toThrow("Use `login` to change token.");
    expect(() => setKey(defaults(), "server", "https://evil.example.com")).toThrow(
      "Use `login` to change server.",
    );
  });

  it("refuses unknown keys, listing the ones it knows", () => {
    expect(() => setKey(defaults(), "agents.codex.shell", "bash")).toThrow(
      "Unknown setting agents.codex.shell.",
    );
    expect(settableKeys()).toContain("projects.<id>.worktree.setup");
  });

  it("sets a mapped project's options but not its folder", () => {
    let config = setKey(withProject(), "projects.p1.mode", "worktree");
    config = setKey(config, "projects.p1.worktree.cleanup", "delete");
    config = setKey(config, "projects.p1.allowDirty", "true");
    expect(config.projects.p1).toEqual({
      name: "Web",
      path: PROJECT_PATH,
      mode: "worktree",
      allowDirty: true,
      worktree: { cleanup: "delete" },
    });
    expect(setKey(config, "projects.p1.mode", "in-place").projects.p1?.mode).toBe("in_place");
    expect(() => setKey(config, "projects.p1.path", "/tmp")).toThrow("Projects take mode, allowDirty");
    expect(() => setKey(config, "projects.nope.mode", "worktree")).toThrow("No mapped project nope.");
    expect(() => setKey(config, "projects", "x")).toThrow("No mapped project .");
  });
});

describe("projectModes", () => {
  it("reports ids and modes, never folders", () => {
    expect(projectModes(withProject())).toEqual([{ projectId: "p1", mode: "in_place" }]);
  });
});
