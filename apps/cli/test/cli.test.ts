import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productName } from "@hotline/core";
import { hotlinePaths, writePrivateFile } from "@hotline/daemon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliContext, run } from "../src/cli.js";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

let dir: string;
let signals: EventEmitter;
let logLines: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hotline-cli-"));
  signals = new EventEmitter();
  logLines = [];
});

afterEach(async () => {
  signals.emit("SIGTERM");
  await rm(dir, { recursive: true, force: true });
});

function context(): CliContext {
  return {
    // Never the real ~/.hotline.
    env: { HOTLINE_HOME: join(dir, "home") },
    homeDir: join(dir, "nonexistent-home"),
    platform: process.platform,
    signals,
    logDestination: { write: (line) => logLines.push(line) },
  };
}

function start(argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const watchers: Array<() => void> = [];
  const code = run(
    argv,
    {
      stdout: (text) => {
        stdout.push(text);
        for (const watcher of watchers) watcher();
      },
      stderr: (text) => stderr.push(text),
    },
    context(),
  );
  /** Resolves with the first stdout line matching `pattern`. */
  const line = (pattern: RegExp) =>
    new Promise<string>((resolve) => {
      const check = () => {
        const found = stdout.find((text) => pattern.test(text));
        if (found !== undefined) resolve(found);
      };
      watchers.push(check);
      check();
    });
  return { code, line, stdout, stderr };
}

async function capture(argv: string[]) {
  const started = start(argv);
  const code = await started.code;
  return { code, stdout: started.stdout.join("\n"), stderr: started.stderr.join("\n") };
}

function get(url: string, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    request(url, { headers, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on("error", reject)
      .end();
  });
}

describe("hotline CLI", () => {
  it.each(["--version", "-v", "version"])("%s prints the package version", async (flag) => {
    const result = await capture([flag]);
    expect(result).toEqual({ code: 0, stdout: `hotline ${manifest.version}`, stderr: "" });
  });

  it.each(["--help", "-h", "help"])("%s prints usage to stdout", async (flag) => {
    const result = await capture([flag]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: hotline <command>");
    expect(result.stdout).toContain(productName);
    expect(result.stdout).toContain("daemon");
    expect(result.stderr).toBe("");
  });

  it("exits 2 with usage on stderr when no command is given", async () => {
    const result = await capture([]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: hotline <command>");
  });

  it("rejects an unknown command with exit 2", async () => {
    const result = await capture(["approve-everything"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('unknown command "approve-everything"');
  });
});

describe("hotline daemon", () => {
  const CONFIG = {
    version: 1,
    owner: { phoneNumber: "+15555550100", pinHash: `scrypt$15$8$1$${"s".repeat(22)}$${"h".repeat(43)}` },
    quietHours: { timeZone: "America/Toronto" },
    secrets: { store: "file" },
  };
  const paths = () => hotlinePaths({ env: { HOTLINE_HOME: join(dir, "home") }, homeDir: "/nonexistent" });

  it("prints its own usage", async () => {
    const result = await capture(["daemon", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: hotline daemon");
    expect(result.stdout).toContain("127.0.0.1");
  });

  it.each([[["daemon", "--port"]], [["daemon", "--port", "abc"]], [["daemon", "--bind", "0.0.0.0"]]])(
    "rejects bad arguments %j with exit 2",
    async (argv) => {
      const result = await capture(argv);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Usage: hotline daemon");
    },
  );

  it("exits 1 with a clear message when there is no config", async () => {
    const result = await capture(["daemon", "--port", "0"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('run "hotline init"');
  });

  it("runs until SIGTERM, serving the agent API and refusing unverified webhooks", async () => {
    await writePrivateFile(paths().config, JSON.stringify(CONFIG));
    const daemon = start(["daemon", "--port", "0"]);
    const ready = await daemon.line(/^hotline daemon: agent API on /);
    const match =
      /agent API on (http:\/\/127\.0\.0\.1:\d+), webhooks on (http:\/\/127\.0\.0\.1:\d+\/hooks)$/.exec(ready);
    expect(match).not.toBeNull();
    const [, apiUrl = "", hooksUrl = ""] = match ?? [];

    const secrets = JSON.parse(await readFile(paths().secrets, "utf8")) as {
      secrets: { "daemon.apiToken": string };
    };
    const token = secrets.secrets["daemon.apiToken"];
    expect(await get(`${apiUrl}/v1/health`, token)).toBe(200);
    expect(await get(`${apiUrl}/v1/health`)).toBe(401);
    expect(await get(`${hooksUrl}/twilio/voice`)).toBe(403);

    signals.emit("SIGTERM");
    expect(await daemon.code).toBe(0);
    await expect(get(`${apiUrl}/v1/health`, token)).rejects.toThrow(/ECONNREFUSED/);

    const logs = logLines.join("");
    expect(logs).toContain("hotline daemon stopped");
    expect(logs).not.toContain(token);
  });
});
