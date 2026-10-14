// `hotline hook` and `hotline away` end to end: the CLI commands with the agent's
// payload on an in-process stdin, against a real daemon on 127.0.0.1 with a
// temporary HOTLINE_HOME (never the real ~/.hotline). The owner's answers are
// recorded through the daemon store's `recordAnswer`.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Ask, Decision } from "@hotline/core";
import {
  createRedactor,
  type Daemon,
  FileSecretStore,
  generateApiToken,
  hotlinePaths,
  openStore,
  startDaemon,
  writePrivateFile,
} from "@hotline/daemon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliContext, run } from "../src/cli.js";

const fixtures = new URL("../../../packages/agents/test/fixtures/hooks/", import.meta.url);
const fixtureText = (path: string) => readFileSync(new URL(path, fixtures), "utf8");
const fixture = (path: string): unknown => JSON.parse(fixtureText(path));

const CONFIG = {
  version: 1,
  owner: { phoneNumber: "+15555550100", pinHash: `scrypt$15$8$1$${"s".repeat(22)}$${"h".repeat(43)}` },
  quietHours: { timeZone: "America/Toronto" },
  policy: { maxConsecutiveContinuations: 2 },
  secrets: { store: "file" },
};

let dir: string;
let signals: EventEmitter;
const cleanups: Array<() => Promise<unknown>> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hotline-cli-hook-"));
  signals = new EventEmitter();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

const home = () => join(dir, "home");
const paths = () => hotlinePaths({ env: { HOTLINE_HOME: home() }, homeDir: "/nonexistent" });

function context(stdin?: PassThrough): CliContext {
  return {
    env: { HOTLINE_HOME: home() },
    homeDir: join(dir, "nonexistent-home"),
    platform: process.platform,
    signals,
    logDestination: { write: () => {} },
    ...(stdin === undefined ? {} : { stdin }),
  };
}

async function cli(argv: string[], input?: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let stdin: PassThrough | undefined;
  if (input !== undefined) {
    stdin = new PassThrough();
    stdin.end(input);
  }
  const code = await run(
    argv,
    { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) },
    context(stdin),
  );
  return { code, stdout, stderr };
}

async function setUp(): Promise<Daemon> {
  await writePrivateFile(paths().config, JSON.stringify(CONFIG));
  const token = generateApiToken();
  await new FileSecretStore(paths().secrets).set("daemon.apiToken", token);
  const daemon = await startDaemon({
    apiToken: token,
    store: await openStore(join(dir, "hotline.db")),
    apiPort: 0,
    hooksPort: 0,
    log: { level: "silent", destination: { write: () => {} }, redactor: createRedactor([token]) },
    version: "0.0.0-test",
  });
  cleanups.push(() => daemon.close());
  return daemon;
}

function answer(
  daemon: Daemon,
  kind: Ask["kind"],
  decision: Decision,
  confirmation: "none" | "pin" = "none",
) {
  return new Promise<Ask>((resolve) => {
    const timer = setInterval(() => {
      const ask = daemon.store.listAsks(["pending"]).find((open) => open.kind === kind);
      if (ask === undefined) return;
      clearInterval(timer);
      const at = new Date();
      daemon.store.recordAnswer(
        {
          askId: ask.id,
          decision,
          channel: "voice",
          ownerExcerpt: "yes",
          sourceId: "call-1",
          confirmation,
          answeredAt: at.toISOString(),
        },
        at,
      );
      resolve(ask);
    }, 5);
    cleanups.push(async () => clearInterval(timer));
  });
}

describe("hotline away", () => {
  it("switches away mode in a private file and reports it", async () => {
    expect((await cli(["away"])).stdout.join("")).toContain("Away mode is off");
    const on = await cli(["away", "on"]);
    expect(on.code).toBe(0);
    expect(on.stdout.join("")).toContain("Away mode is on");
    expect((await stat(paths().away)).mode & 0o777).toBe(0o600);
    expect((await stat(home())).mode & 0o777).toBe(0o700);
    expect((await cli(["away", "status"])).stdout.join("")).toContain("Away mode is on");
    expect((await cli(["away", "off"])).stdout.join("")).toContain("Away mode is off");
    expect((await cli(["away", "maybe"])).code).toBe(2);
  });
});

describe("hotline hook", () => {
  it("prints usage to stderr and never exits 2, which a Stop hook would read as 'keep going'", async () => {
    const help = await cli(["hook", "--help"]);
    expect(help).toMatchObject({ code: 0, stdout: [] });
    expect(help.stderr.join("")).toContain("Usage: hotline hook");
    for (const argv of [
      ["hook"],
      ["hook", "cursor", "stop"],
      ["hook", "claude", "start"],
      ["hook", "claude", "stop", "extra"],
      ["hook", "claude", "stop", "--port", "x"],
      ["hook", "claude", "stop", "--wait-seconds", "0"],
      ["hook", "claude", "stop", "--verbose"],
    ]) {
      const result = await cli(argv, "{}");
      expect(result.code, argv.join(" ")).toBe(1);
      expect(result.stdout).toEqual([]);
    }
  });

  it("stays out of the way outside away mode", async () => {
    for (const [agent, dirName] of [
      ["claude", "claude-code"],
      ["codex", "codex"],
    ] as const) {
      const permission = await cli(
        ["hook", agent, "permission"],
        fixtureText(`${dirName}/permission-request.input.json`),
      );
      expect(permission).toMatchObject({ code: 0, stdout: [] });
      const stop = await cli(["hook", agent, "stop"], fixtureText(`${dirName}/stop.input.json`));
      expect(stop).toMatchObject({ code: 0, stdout: [] });
    }
  });

  it("denies in away mode when Hotline is not set up, and says why on stderr", async () => {
    await cli(["away", "on"]);
    const result = await cli(
      ["hook", "codex", "permission"],
      fixtureText("codex/permission-request.input.json"),
    );
    expect(result.code).toBe(0);
    expect(result.stdout.map((line) => JSON.parse(line))).toEqual([
      fixture("codex/permission-request.deny.output.json"),
    ]);
    expect(result.stderr.join("\n")).toContain("not set up");
    const stop = await cli(["hook", "codex", "stop"], fixtureText("codex/stop.input.json"));
    expect(stop).toMatchObject({ code: 0, stdout: [] });
  });

  it("phones through the daemon and prints the agent's documented output", async () => {
    const daemon = await setUp();
    await cli(["away", "on"]);
    const port = String(daemon.apiPort);

    const allowed = answer(daemon, "permission", { type: "allow" }, "pin");
    const permission = await cli(
      ["hook", "claude", "permission", "--port", port],
      fixtureText("claude-code/permission-request.input.json"),
    );
    await allowed;
    expect(permission.code).toBe(0);
    expect(permission.stdout.map((line) => JSON.parse(line))).toEqual([
      fixture("claude-code/permission-request.allow.output.json"),
    ]);

    const continued = answer(daemon, "stop", { type: "text", text: "Now write the tests for the parser." });
    const stop = await cli(
      ["hook", "claude", "stop", "--port", port],
      fixtureText("claude-code/stop.input.json"),
    );
    await continued;
    expect(stop.stdout.map((line) => JSON.parse(line))).toEqual([
      fixture("claude-code/stop.block.output.json"),
    ]);
    const counts = await readdir(paths().hookState);
    expect(counts).toHaveLength(1);
    expect((await stat(join(paths().hookState, counts[0] ?? ""))).mode & 0o777).toBe(0o600);

    // The second continuation in a row is the configured cap of 2.
    const again = answer(daemon, "stop", { type: "text", text: "And the docs." });
    const second = await cli(
      ["hook", "claude", "stop", "--port", port],
      fixtureText("claude-code/stop.continued.input.json"),
    );
    await again;
    expect(second.stdout.map((line) => JSON.parse(line))).toEqual([
      { decision: "block", reason: "And the docs." },
    ]);
    const capped = await cli(
      ["hook", "claude", "stop", "--port", port],
      fixtureText("claude-code/stop.continued.input.json"),
    );
    expect(capped.stdout).toEqual([]);
    expect(capped.stderr.join("\n")).toContain("continuation cap");

    // Switching away mode off clears the counts.
    await cli(["away", "off"]);
    await expect(readdir(paths().hookState)).rejects.toThrow();
  });

  it("denies and cancels the ask when the agent kills the hook", async () => {
    const daemon = await setUp();
    await cli(["away", "on"]);
    const pending = cli(
      ["hook", "codex", "permission", "--port", String(daemon.apiPort)],
      fixtureText("codex/permission-request.input.json"),
    );
    const asked = await new Promise<Ask>((resolve) => {
      const timer = setInterval(() => {
        const ask = daemon.store.listAsks(["pending"]).find((open) => open.kind === "permission");
        if (ask === undefined) return;
        clearInterval(timer);
        resolve(ask);
      }, 5);
    });
    signals.emit("SIGTERM");
    const result = await pending;
    expect(result.stdout.map((line) => JSON.parse(line))).toEqual([
      fixture("codex/permission-request.deny.output.json"),
    ]);
    expect(daemon.store.getAsk(asked.id)?.status).toBe("cancelled");
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});
