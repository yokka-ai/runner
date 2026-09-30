import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The only module that reads the environment. Everything is read when asked for, not at import, so a test
 * (or a caller) can point the runner at another folder before using it.
 */

/** The runner's folder: config, ledger and per-run files. `YOKKA_HOME` moves it. */
export function runnerHome() {
  const override = process.env.YOKKA_HOME?.trim();
  return override ? override : join(homedir(), ".yokka");
}

/** The deployment to sign in to when `login` gets no `--server`. */
export function serverFromEnv() {
  return process.env.YOKKA_SERVER?.trim() || undefined;
}

/** PATH and PATHEXT, to tell how Windows would start a command (see `proc.ts`). */
export function commandSearch() {
  return {
    path: process.env.PATH ?? process.env.Path ?? "",
    pathExt: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
  };
}
