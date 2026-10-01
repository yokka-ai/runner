import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/config.ts";
import {
  canonical,
  checkFolder,
  cleanup,
  dirtyFiles,
  gitState,
  isInside,
  isRepo,
  PrepareError,
  prepare,
  slug,
  WORKTREES,
} from "../src/workspace.ts";
import { tempDir } from "./helpers.ts";

const card = { ref: "WEB-1", title: "Fix the thing!", launchCode: "r_abc123" };

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * A repository with one commit on `main`. Its path keeps any Windows short names (RUNNER~1 on CI), like a
 * folder mapped before the runner stored paths canonically.
 */
function repo() {
  const dir = realpathSync(tempDir("yokka-repo-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

function project(path: string, extra: Partial<ProjectConfig> = {}): ProjectConfig {
  return { name: "Web", path, mode: "in_place", ...extra };
}

describe("helpers", () => {
  it("slugs text into branch- and folder-safe pieces", () => {
    expect(slug("Fix the thing!")).toBe("fix-the-thing");
    expect(slug("../../etc/passwd")).toBe("etc-passwd");
    expect(slug("ÄÖ")).toBe("");
    expect(slug(`${"a".repeat(39)}-b`)).toBe("a".repeat(39));
  });

  it("tells whether a path is inside a folder", () => {
    const root = join(process.cwd(), "root");
    expect(isInside(root, join(root, "a", "b"))).toBe(true);
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, join(root, "..", "other"))).toBe(false);
    expect(isInside(root, join(process.cwd(), "rootless"))).toBe(false);
    expect(isInside(root, join(root, "..foo"))).toBe(true);
  });

  it("checks a folder to map", () => {
    const dir = tempDir();
    expect(checkFolder(dir)).toBe(join(dir));
    expect(() => checkFolder(join(dir, "missing"))).toThrow("doesn't exist.");
    writeFileSync(join(dir, "file.txt"), "x");
    expect(() => checkFolder(join(dir, "file.txt"))).toThrow("isn't a folder.");
  });
});

describe("prepare in place", () => {
  it("works in a folder that isn't a repository", async () => {
    const dir = tempDir();
    await expect(isRepo(dir)).resolves.toBe(false);
    await expect(prepare(project(dir), "in_place", card, false)).resolves.toEqual({
      cwd: dir,
      worktree: false,
    });
  });

  it("works in a clean repository and reports its branch", async () => {
    const dir = repo();
    await expect(prepare(project(dir), "in_place", card, false)).resolves.toEqual({
      cwd: dir,
      worktree: false,
      branch: "main",
    });
  });

  it("refuses uncommitted changes unless the project allows them", async () => {
    const dir = repo();
    writeFileSync(join(dir, "README.md"), "changed\n");
    await expect(prepare(project(dir), "in_place", card, false)).rejects.toThrow(
      "the folder has 1 uncommitted change; commit or stash them",
    );
    await expect(prepare(project(dir, { allowDirty: true }), "in_place", card, false)).resolves.toMatchObject(
      {
        cwd: dir,
      },
    );
  });

  it("refuses a second run in the same folder and a folder that's gone", async () => {
    const dir = tempDir();
    await expect(prepare(project(dir), "in_place", card, true)).rejects.toThrow(
      "another run is already working in this folder",
    );
    await expect(prepare(project(join(dir, "gone")), "in_place", card, false)).rejects.toBeInstanceOf(
      PrepareError,
    );
  });
});

describe("prepare a worktree", () => {
  it("makes a worktree on the card's branch, kept out of git status", async () => {
    const dir = repo();
    const where = await prepare(project(dir, { mode: "worktree" }), "worktree", card, false);
    expect(where).toEqual({
      // Canonical: on Windows the temp folder can come back as a short name (RUNNER~1) that git expands.
      cwd: join(canonical(dir), WORKTREES, "web-1-abc123"),
      worktree: true,
      branch: "yokka/web-1-fix-the-thing",
    });
    expect(existsSync(join(where.cwd, "README.md"))).toBe(true);
    expect(readFileSync(join(dir, ".git", "info", "exclude"), "utf8")).toContain(`/${WORKTREES}/`);
    await expect(dirtyFiles(dir)).resolves.toEqual([]);
    // The card's next run carries on in the same worktree; the exclude line isn't added twice.
    const again = await prepare(project(dir), "worktree", { ...card, launchCode: "r_zzz999" }, false);
    expect(again.cwd).toBe(where.cwd);
    const lines = readFileSync(join(dir, ".git", "info", "exclude"), "utf8").split("\n");
    expect(lines.filter((l) => l === `/${WORKTREES}/`)).toHaveLength(1);
  });

  it("keeps the folder inside .yokka-worktrees whatever the ref and code say", async () => {
    const dir = repo();
    const where = await prepare(
      project(dir),
      "worktree",
      { ref: "../../x", title: "", launchCode: "r_../../y" },
      false,
    );
    expect(isInside(join(canonical(dir), WORKTREES), where.cwd)).toBe(true);
    expect(where.branch).toBe("yokka/x-card");
  });

  it("reuses a branch an earlier run left", async () => {
    const dir = repo();
    git(dir, "branch", "yokka/web-1-fix-the-thing");
    const where = await prepare(project(dir, { worktree: { base: "main" } }), "worktree", card, false);
    expect(git(where.cwd, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("yokka/web-1-fix-the-thing");
  });

  it("runs the project's setup command in a new worktree, and says when it fails", async () => {
    const dir = repo();
    const ok = await prepare(project(dir, { worktree: { setup: "git status" } }), "worktree", card, false);
    expect(existsSync(ok.cwd)).toBe(true);
    const failing = project(dir, { worktree: { setup: "git no-such-command" } });
    await expect(prepare(failing, "worktree", { ...card, ref: "WEB-2" }, false)).rejects.toThrow(
      "the setup command failed:",
    );
  });

  it("needs a repository, and says why git refused", async () => {
    await expect(prepare(project(tempDir()), "worktree", card, false)).rejects.toThrow(
      "worktrees need the folder to be a git repository",
    );
    const dir = repo();
    await expect(
      prepare(project(dir, { worktree: { base: "no-such-branch" } }), "worktree", card, false),
    ).rejects.toThrow("git worktree add failed:");
  });
});

describe("gitState and cleanup", () => {
  it("reports the branch, commits ahead and uncommitted files", async () => {
    const dir = repo();
    const where = await prepare(project(dir), "worktree", card, false);
    writeFileSync(join(where.cwd, "new.txt"), "x\n");
    git(where.cwd, "add", "new.txt");
    git(where.cwd, "commit", "-q", "-m", "work");
    writeFileSync(join(where.cwd, "README.md"), "dirty\n");
    await expect(gitState(where.cwd, true, "main")).resolves.toEqual({
      branch: "yokka/web-1-fix-the-thing",
      worktree: true,
      ahead: 1,
      dirty: 1,
    });
    await expect(gitState(tempDir(), false)).resolves.toEqual({ worktree: false });
  });

  it("removes a finished worktree only when asked and clean", async () => {
    const dir = repo();
    const keep = project(dir);
    const del = project(dir, { worktree: { cleanup: "delete" } });
    const where = await prepare(del, "worktree", card, false);
    await expect(cleanup(keep, where.cwd, true)).resolves.toBe(false);
    await expect(cleanup(del, where.cwd, false)).resolves.toBe(false);
    writeFileSync(join(where.cwd, "wip.txt"), "x");
    await expect(cleanup(del, where.cwd, true)).resolves.toBe(false);
    execFileSync("git", ["clean", "-fq"], { cwd: where.cwd });
    await expect(cleanup(del, where.cwd, true)).resolves.toBe(true);
    expect(existsSync(where.cwd)).toBe(false);
  });

  it("never removes a folder outside .yokka-worktrees", async () => {
    const dir = repo();
    const outside = join(dir, "src");
    mkdirSync(outside);
    const del = project(dir, { worktree: { cleanup: "delete" } });
    await expect(cleanup(del, outside, true)).resolves.toBe(false);
    await expect(cleanup(del, join(dir, WORKTREES), true)).resolves.toBe(false);
    await expect(cleanup(undefined, outside, true)).resolves.toBe(false);
    expect(existsSync(outside)).toBe(true);
  });
});
