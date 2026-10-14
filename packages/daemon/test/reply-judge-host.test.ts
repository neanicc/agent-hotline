// HL-09d: the default judge host never starts a process under test mode, even
// when a daemon is run without an injected host. `node:child_process` is
// replaced with a spy for this file, so a spawn would be seen, not run.
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn,
}));

const { hotlinePaths, nodeJudgeHost, runDaemon, writePrivateFile } = await import("../src/index.js");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hl09d-host-"));
  spawn.mockClear();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("the default judge host in test mode", () => {
  it("refuses to run an agent CLI without spawning anything", async () => {
    const host = nodeJudgeHost({ PATH: process.env.PATH ?? "" });
    await expect(
      host.run("/usr/bin/true", [], { cwd: dir, env: {}, input: "", timeoutMs: 1_000 }),
    ).rejects.toThrow(/test mode/);
    expect(await host.find("node")).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("is what a daemon without an injected host uses: it chooses no judge and spawns nothing", async () => {
    const paths = hotlinePaths({ env: { HOTLINE_HOME: join(dir, "home") }, homeDir: "/nonexistent" });
    await writePrivateFile(
      paths.config,
      JSON.stringify({
        version: 1,
        owner: { phoneNumber: "+15555550100", pinHash: `scrypt$15$8$1$${"s".repeat(22)}$${"h".repeat(43)}` },
        quietHours: { timeZone: "America/Toronto" },
        secrets: { store: "file" },
        voice: { provider: "fake" },
        sms: { provider: "fake" },
      }),
    );
    const signals = new EventEmitter();
    const lines: string[] = [];
    let ready!: () => void;
    const listening = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const exit = runDaemon({
      env: { HOTLINE_HOME: paths.home, PATH: process.env.PATH ?? "" },
      homeDir: "/nonexistent",
      platform: process.platform,
      signals,
      logDestination: { write: (line) => lines.push(line) },
      version: "0.0.0-test",
      port: 0,
      fetch: async () => {
        throw new Error("unexpected network request");
      },
      onReady: () => ready(),
    });
    await listening;
    signals.emit("SIGTERM");
    expect(await exit).toBe(0);
    const judgeLine = lines.map((line) => JSON.parse(line)).find((entry) => entry.msg === "reply judge");
    expect(judgeLine).toMatchObject({ backend: "none" });
    expect(spawn).not.toHaveBeenCalled();
  });
});
