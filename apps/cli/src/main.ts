#!/usr/bin/env node
import { run } from "./cli.js";

const code = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
});
process.exitCode = code;
// Normally the event loop is empty by now and the process exits on its own. If
// something still holds it open (the daemon gave up waiting for a stuck request),
// exit anyway; the unref'd timer never delays a process that is already done.
setTimeout(() => process.exit(code), 5_000).unref();
