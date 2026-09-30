import { readFileSync } from "node:fs";

/**
 * The runner's version, from its own package.json, so a release bumps one place. The file sits one level up
 * from both `src/` (running from source) and `dist/` (the published build).
 */
function packageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as unknown;
    if (typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string")
      return pkg.version;
  } catch {
    // Unreadable: fall through.
  }
  return "0.0.0";
}

export const VERSION = packageVersion();

/**
 * The runner protocol this build speaks (PROTOCOL.md). The server says which it speaks in `hello` and
 * refuses runners older than its minimum.
 */
export const PROTOCOL = 2;
