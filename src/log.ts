/**
 * Everything the runner prints goes through here. Two kinds of output:
 * - `print`/`printError`: plain lines for the CLI's commands (help, status, prompts);
 * - `log`/`warn`: timestamped lines from the daemon.
 * Every line is redacted first: runner tokens (`yr_…`), run tokens (`wb_…`) and MCP connector links never
 * reach a terminal or a log file, whatever error message they end up in.
 */

const TOKEN = /\b(yr|wb)_[A-Za-z0-9]{12,}/g;
const CONNECTOR_LINK = /(\/mcp\/c\/)[^\s"'/?#]+/g;
const UPLOAD_LINK = /(\/mcp\/upload\/)[^\s"'/?#]+/g;

/** Masks secrets in text that's about to be shown. */
export function redact(text: string) {
  return text
    .replace(TOKEN, (_, kind: string) => `${kind}_…`)
    .replace(CONNECTOR_LINK, "$1…")
    .replace(UPLOAD_LINK, "$1…");
}

function colors() {
  return process.stdout.isTTY === true;
}

const dim = (s: string) => (colors() ? `\x1b[2m${s}\x1b[0m` : s);
const yellow = (s: string) => (colors() ? `\x1b[33m${s}\x1b[0m` : s);

function stamp() {
  return dim(new Date().toTimeString().slice(0, 8));
}

/** A line of CLI output on stdout. */
export function print(text = "") {
  process.stdout.write(`${redact(text)}\n`);
}

/** A line of CLI output on stderr (errors). */
export function printError(text: string) {
  process.stderr.write(`${redact(text)}\n`);
}

/** A timestamped daemon line on stdout. */
export function log(message: string) {
  process.stdout.write(`${stamp()} ${redact(message)}\n`);
}

/** A timestamped daemon warning on stderr. */
export function warn(message: string) {
  process.stderr.write(`${stamp()} ${yellow(redact(message))}\n`);
}

/** The message of anything thrown, for a log line. */
export function messageOf(err: unknown) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}
