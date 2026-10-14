#!/usr/bin/env node
// Checks the packaged CLI (dist/hotline, from scripts/package.mjs) the way an
// owner would run it: copied to a temporary folder outside the workspace, so a
// dependency the bundle left out cannot be found in node_modules, and started
// through a symlink to its launcher. Called by `scripts/ci/run.sh package`.
//
// Fakes only: HOME and HOTLINE_HOME are temporary, the voice and SMS providers
// are `fake`, the secret store is a 0600 file, and the only network traffic is
// to the daemon on 127.0.0.1. Nothing reads or writes the real ~/.hotline,
// ~/.claude, ~/.codex or Keychain, and nothing calls Twilio or ElevenLabs.
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = await realpath(fileURLToPath(new URL("../..", import.meta.url)));
const packaged = join(root, "dist/hotline");
const { version } = JSON.parse(await readFile(join(root, "apps/cli/package.json"), "utf8"));

const OWNER = "+15555550100";
const FAKE_PIN = "480213";
const STEP_TIMEOUT_MS = 30_000;

const temp = await realpath(await mkdtemp(join(tmpdir(), "hotline-package-")));
if (temp === root || temp.startsWith(`${root}${sep}`)) {
  console.error(`package check failed: temporary folder ${temp} is inside the workspace`);
  process.exit(1);
}
let daemon;
try {
  await main();
} catch (error) {
  console.error(`package check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  daemon?.child.kill("SIGKILL");
  await rm(temp, { recursive: true, force: true });
}

async function main() {
  await cp(packaged, join(temp, "hotline"), { recursive: true });
  await mkdir(join(temp, "bin"));
  const hotline = join(temp, "bin/hotline");
  await symlink(join(temp, "hotline/bin/hotline"), hotline);
  const home = join(temp, "home");
  await mkdir(home, { mode: 0o700 });
  // Only what Node needs to start, plus the temporary homes. No HOTLINE_*
  // variables or credentials leak in from the caller's environment.
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    HOTLINE_HOME: join(home, ".hotline"),
    CODEX_HOME: join(home, ".codex"),
    TZ: "UTC",
  };
  const run = (args, options = {}) => runProcess(hotline, args, { cwd: temp, env, ...options });

  const versionRun = await run(["--version"]);
  expect(versionRun, 0, (out) => out === `hotline ${version}\n`, `prints "hotline ${version}"`);
  const viaNode = await runProcess(process.execPath, [join(temp, "hotline/lib/main.mjs"), "--version"], {
    cwd: temp,
    env,
    label: "node hotline/lib/main.mjs --version",
  });
  expect(viaNode, 0, (out) => out === `hotline ${version}\n`, "the bundle without the launcher");
  expect(await run(["--help"]), 0, (out) => out.includes("Usage: hotline <command>"), "--help");

  // Setup commands, each from its own lazily loaded chunk.
  const init = await run(
    [
      "init",
      "--non-interactive",
      "--owner",
      OWNER,
      "--time-zone",
      "UTC",
      "--voice-provider",
      "fake",
      "--sms-provider",
      "fake",
      "--secret-store",
      "file",
    ],
    { env: { ...env, HOTLINE_PIN: FAKE_PIN } },
  );
  expect(init, 0, () => true, "init with fake providers");
  const configPath = join(env.HOTLINE_HOME, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const port = await freePortPair();
  config.daemon = { ...config.daemon, port };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  for (const agent of ["claude", "codex"]) {
    const install = await run(["install", agent, "--home", home, "--command", hotline]);
    expect(install, 0, () => true, `install ${agent} into the temporary home`);
  }
  expect(await run(["away", "status"]), 0, (out) => out.includes("off"), "away status");

  // The daemon: Fastify, SQLite and the webhook routes.
  daemon = startDaemon(hotline, temp, env);
  await daemon.ready;

  const doctor = await run(["doctor", "--command", hotline]);
  expect(doctor, 0, (out) => /^PASS\s+daemon\b/m.test(out), "doctor reaches the daemon");

  // The MCP server: the SDK's stdio transport, registered with the daemon.
  const mcp = await run(["mcp", "--agent", "claude"], { input: mcpHandshake() });
  expect(
    mcp,
    0,
    (out) => out.includes('"serverInfo"') && out.includes('"ask_human"'),
    "mcp answers initialize and lists ask_human",
  );

  // A hook outside away mode prints nothing and lets the agent carry on.
  const hook = await run(["hook", "claude", "stop"], {
    input: JSON.stringify({
      session_id: "package-check",
      transcript_path: join(temp, "transcript.jsonl"),
      cwd: temp,
      hook_event_name: "Stop",
      stop_hook_active: false,
    }),
  });
  expect(hook, 0, (out) => out === "", "hook claude stop outside away mode");

  daemon.child.kill("SIGTERM");
  const stopped = await daemon.exited;
  if (stopped.code !== 0) fail(`daemon exited with ${stopped.code ?? stopped.signal} after SIGTERM`);
  daemon = undefined;

  console.log(`package check: hotline ${version} runs from ${temp} (outside the workspace)`);
}

function mcpHandshake() {
  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "claude-code", version: "0.0.0-package-check" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ];
  return messages.map((message) => `${JSON.stringify(message)}\n`).join("");
}

function startDaemon(command, cwd, env) {
  const child = spawn(command, ["daemon"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon did not start in time")), STEP_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("hotline daemon: agent API on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    exited.then(({ code, signal }) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited early (${code ?? signal})\n${stdout}${stderr}`));
    });
  }).catch((error) => fail(error.message));
  return { child, ready, exited };
}

function runProcess(command, args, { cwd, env, input = "", label = `hotline ${args.join(" ")}` }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${label} timed out`));
    }, STEP_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ label: label.replaceAll(temp, "$TMP"), code, stdout, stderr });
    });
    child.stdin.end(input);
  }).catch((error) => fail(error.message));
}

function expect(result, code, check, what) {
  if (result.code === code && check(result.stdout)) {
    console.log(`ok    ${result.label}  (${what})`);
    return;
  }
  fail(
    `${result.label}: expected exit ${code} (${what}), got ${result.code}\n` +
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

/** A free port whose next port is free too: the daemon serves webhooks on port + 1. */
async function freePortPair() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await listenOnce(0);
    if (port < 65535 && (await listenOnce(port + 1).catch(() => undefined)) !== undefined) return port;
  }
  fail("no free pair of ports on 127.0.0.1");
}

function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const { port: bound } = server.address();
      server.close(() => resolve(bound));
    });
  });
}

function fail(message) {
  throw new Error(message);
}
