#!/usr/bin/env node
import { errorMessage } from "./api.ts";
import { main } from "./commands.ts";
import { printError } from "./log.ts";

main(process.argv.slice(2)).catch((err: unknown) => {
  printError(errorMessage(err));
  process.exitCode = 1;
});
