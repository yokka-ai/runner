const tty = process.stdout.isTTY === true;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const yellow = (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s);

function stamp() {
  return dim(new Date().toTimeString().slice(0, 8));
}

export function log(message: string) {
  console.log(`${stamp()} ${message}`);
}

export function warn(message: string) {
  console.warn(`${stamp()} ${yellow(message)}`);
}
