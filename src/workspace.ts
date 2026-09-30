import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GitState } from "./api.ts";
import type { ProjectConfig, WorkspaceModeName } from "./config.ts";
import { isWindows, run } from "./proc.ts";

/**
 * Where a run works (docs/runner.md "Where a run works"): the mapped folder itself, or a git worktree of
 * its own on a new branch. The runner creates worktrees with plain git so every agent behaves the same.
 * Worktrees live inside the mapped folder, in `.yokka-worktrees/` (kept out of git through the repo's own
 * `.git/info/exclude`), so they inherit the folder trust Claude Code and Codex already have for it.
 */

export const WORKTREES = ".yokka-worktrees";

export type Prepared = { cwd: string; worktree: boolean; branch?: string };

async function git(cwd: string, ...args: string[]) {
  return run("git", args, { cwd, timeoutMs: 120_000 });
}

export async function isRepo(path: string) {
  return (await git(path, "rev-parse", "--is-inside-work-tree")).stdout.trim() === "true";
}

/** Uncommitted files, as `git status --porcelain` lines. */
export async function dirtyFiles(cwd: string) {
  const res = await git(cwd, "status", "--porcelain");
  return res.code === 0 ? res.stdout.split("\n").filter(Boolean) : [];
}

async function defaultBranch(cwd: string) {
  const head = await git(cwd, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim().replace(/^origin\//, "");
  const current = await git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  return current.stdout.trim() || "main";
}

/** Lowercase letters, digits and dashes only: safe in a branch name and a folder name on every system. */
export function slug(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
}

/** Whether `child` is `parent` itself or somewhere inside it (case-insensitively on Windows). */
export function isInside(parent: string, child: string) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Checks a folder the person maps: it must exist and be a folder. Returns the absolute path to store.
 * Throws a sentence the CLI can show.
 */
export function checkFolder(path: string) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`${absolute} doesn't exist.`);
  if (!statSync(absolute).isDirectory()) throw new Error(`${absolute} isn't a folder.`);
  return absolute;
}

export class PrepareError extends Error {
  override name = "PrepareError";
}

/** Gets a run's folder ready, or explains in one line why it can't. */
export async function prepare(
  project: ProjectConfig,
  mode: WorkspaceModeName,
  card: { ref: string; title: string; launchCode: string },
  busyInPlace: boolean,
): Promise<Prepared> {
  if (!existsSync(project.path))
    throw new PrepareError(`the folder ${project.path} doesn't exist on this machine`);
  return mode === "in_place" ? prepareInPlace(project, busyInPlace) : prepareWorktree(project, card);
}

/** In place: the mapped folder itself, one run at a time, and never over someone's uncommitted work. */
async function prepareInPlace(project: ProjectConfig, busy: boolean): Promise<Prepared> {
  if (busy) throw new PrepareError("another run is already working in this folder");
  if (!project.allowDirty && (await isRepo(project.path))) {
    const dirty = await dirtyFiles(project.path);
    if (dirty.length > 0)
      throw new PrepareError(
        `the folder has ${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"}; commit or stash them, or allow it with \`yokka-runner map --allow-dirty\``,
      );
  }
  const branch = (await git(project.path, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim() || undefined;
  return branch ? { cwd: project.path, worktree: false, branch } : { cwd: project.path, worktree: false };
}

/** A worktree per card, on its own branch, inside the mapped folder. */
async function prepareWorktree(
  project: ProjectConfig,
  card: { ref: string; title: string; launchCode: string },
): Promise<Prepared> {
  if (!(await isRepo(project.path)))
    throw new PrepareError("worktrees need the folder to be a git repository");
  const base = project.worktree?.base ?? (await defaultBranch(project.path));
  const branch = `yokka/${slug(card.ref) || "card"}-${slug(card.title) || "card"}`.slice(0, 80);
  const root = join(project.path, WORKTREES);
  mkdirSync(root, { recursive: true });
  await excludeWorktrees(project.path);
  // A card's earlier run keeps its worktree until the card is done: the next run carries on in it.
  const kept = await worktreeFor(project.path, branch);
  if (kept && existsSync(kept)) return { cwd: kept, worktree: true, branch };
  // Both parts are slugs, so the server's ref and launch code can't point the folder outside `root`.
  const cwd = join(root, `${slug(card.ref) || "card"}-${slug(card.launchCode.slice(2)) || "run"}`);
  // Reuse the card's branch if an earlier run made it; otherwise branch off the base.
  const exists =
    (await git(project.path, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).code === 0;
  const add = exists
    ? await git(project.path, "worktree", "add", cwd, branch)
    : await git(project.path, "worktree", "add", "-b", branch, cwd, base);
  if (add.code !== 0)
    throw new PrepareError(`git worktree add failed: ${lastLine(add.stderr) ?? `exit ${add.code}`}`);
  if (project.worktree?.setup) await runSetup(project.worktree.setup, cwd);
  return { cwd, worktree: true, branch };
}

/** The person's own setup command from their config, run the way they'd type it: through the system shell. */
async function runSetup(command: string, cwd: string) {
  const setup = isWindows
    ? await run("cmd.exe", ["/d", "/s", "/c", command], { cwd, timeoutMs: 15 * 60_000 })
    : await run("/bin/sh", ["-c", command], { cwd, timeoutMs: 15 * 60_000 });
  if (setup.code !== 0)
    throw new PrepareError(`the setup command failed: ${lastLine(setup.stderr) ?? `exit ${setup.code}`}`);
}

function lastLine(text: string) {
  return text.trim().split("\n").filter(Boolean).at(-1)?.trim();
}

/** The worktree that has `branch` checked out, if any. */
async function worktreeFor(repo: string, branch: string) {
  const res = await git(repo, "worktree", "list", "--porcelain");
  if (res.code !== 0) return undefined;
  let path: string | undefined;
  for (const line of res.stdout.split(/\r?\n/)) {
    // git prints forward slashes on Windows too; the runner compares and stores native paths.
    if (line.startsWith("worktree ")) path = resolve(line.slice("worktree ".length));
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return undefined;
}

/** Keeps `.yokka-worktrees/` out of `git status` without touching any committed file. */
async function excludeWorktrees(repo: string) {
  const res = await git(repo, "rev-parse", "--git-common-dir");
  if (res.code !== 0) return;
  const dir = res.stdout.trim();
  const infoDir = join(isAbsolute(dir) ? dir : join(repo, dir), "info");
  const exclude = join(infoDir, "exclude");
  mkdirSync(infoDir, { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const lines = current.split(/\r?\n/);
  if (lines.includes(`/${WORKTREES}/`)) return;
  const gap = current && !current.endsWith("\n") ? "\n" : "";
  appendFileSync(exclude, `${gap}/${WORKTREES}/\n`);
}

/** Branch, commits ahead of its upstream or base, and uncommitted files, for the card. */
export async function gitState(cwd: string, worktree: boolean, base?: string): Promise<GitState> {
  if (!(await isRepo(cwd))) return { worktree };
  const branch = (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim() || undefined;
  const against = base ?? (await defaultBranch(cwd));
  const ahead = Number((await git(cwd, "rev-list", "--count", `${against}..HEAD`)).stdout.trim()) || 0;
  const dirty = (await dirtyFiles(cwd)).length;
  return branch ? { branch, worktree, ahead, dirty } : { worktree, ahead, dirty };
}

/**
 * Removes a finished run's worktree when the project asks for it and nothing is left uncommitted. Only ever
 * a folder inside the project's `.yokka-worktrees/`, whatever the ledger says.
 */
export async function cleanup(project: ProjectConfig | undefined, cwd: string, worktree: boolean) {
  if (!worktree || project?.worktree?.cleanup !== "delete") return false;
  const root = join(project.path, WORKTREES);
  if (!isInside(root, cwd) || resolve(root) === resolve(cwd)) return false;
  if ((await dirtyFiles(cwd)).length > 0) return false;
  const res = await git(project.path, "worktree", "remove", cwd);
  if (res.code !== 0) return false;
  rmSync(cwd, { recursive: true, force: true });
  return true;
}
