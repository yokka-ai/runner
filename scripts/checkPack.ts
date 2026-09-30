/**
 * Checks the file list `npm pack --dry-run --json` reports for yokka-runner (read from stdin): exactly the
 * compiled `dist/` for every source module, the docs and the license. No sources, tests, configs or source
 * maps leak into the package, and the CLI entry keeps its shebang. CI runs it (`npm run pack:check`):
 *
 *   npm pack --dry-run --json | node scripts/checkPack.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const DOCS = ["package.json", "README.md", "PROTOCOL.md", "LICENSE"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [relative(join(root, "src"), path).replaceAll("\\", "/")] : [];
  });
}

function fail(problems: string[]): never {
  process.stderr.write(`yokka-runner package check failed:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
  process.exit(1);
}

const input = readFileSync(0, "utf8");
let packed: unknown;
try {
  packed = JSON.parse(input);
} catch {
  fail([`npm pack printed something that isn't JSON: ${input.slice(0, 200)}`]);
}
const first: unknown = Array.isArray(packed) ? packed[0] : undefined;
const listed =
  typeof first === "object" && first !== null && "files" in first && Array.isArray(first.files)
    ? (first.files as { path?: unknown }[]).map((f) => String(f.path))
    : fail(["npm pack's JSON has no file list"]);

const expected = new Set([
  ...DOCS,
  ...sources(join(root, "src")).map((s) => `dist/${s.replace(/\.ts$/, ".js")}`),
]);
const problems: string[] = [];
for (const path of expected) if (!listed.includes(path)) problems.push(`missing ${path}`);
for (const path of listed) if (!expected.has(path)) problems.push(`unexpected ${path}`);

const cli = readFileSync(join(root, "dist", "cli.js"), "utf8");
if (!cli.startsWith("#!/usr/bin/env node\n")) problems.push("dist/cli.js lost its #!/usr/bin/env node line");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin?: Record<string, string> };
if (pkg.bin?.["yokka-runner"] !== "dist/cli.js")
  problems.push('package.json bin["yokka-runner"] isn\'t dist/cli.js');

if (problems.length > 0) fail(problems);
process.stdout.write(`yokka-runner package: ${listed.length} files, as expected.\n`);
