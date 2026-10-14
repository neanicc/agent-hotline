import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@hotline/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hotlinePaths, loadConfig, writePrivateFile } from "../src/index.js";

const PIN_HASH = `scrypt$15$8$1$${"s".repeat(22)}$${"h".repeat(43)}`;
const CONFIG = {
  version: 1,
  owner: { phoneNumber: "+15555550100", pinHash: PIN_HASH },
  quietHours: { timeZone: "America/Toronto" },
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hotline-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("hotlinePaths", () => {
  it("defaults to ~/.hotline", () => {
    expect(hotlinePaths({ env: {}, homeDir: "/Users/example" })).toEqual({
      home: "/Users/example/.hotline",
      config: "/Users/example/.hotline/config.json",
      secrets: "/Users/example/.hotline/secrets.json",
    });
  });

  it("honours an absolute HOTLINE_HOME and rejects a relative one", () => {
    expect(hotlinePaths({ env: { HOTLINE_HOME: "/tmp/hotline-x" }, homeDir: "/Users/example" }).config).toBe(
      "/tmp/hotline-x/config.json",
    );
    expect(hotlinePaths({ env: { HOTLINE_HOME: "" }, homeDir: "/Users/example" }).home).toBe(
      "/Users/example/.hotline",
    );
    expect(() => hotlinePaths({ env: { HOTLINE_HOME: "relative/dir" }, homeDir: "/Users/example" })).toThrow(
      ConfigError,
    );
  });
});

describe("loadConfig", () => {
  it("reads a private config and fills defaults", async () => {
    const { config } = hotlinePaths({ env: {}, homeDir: dir });
    await writePrivateFile(config, JSON.stringify(CONFIG));
    const loaded = await loadConfig(config);
    expect(loaded.owner.phoneNumber).toBe("+15555550100");
    expect(loaded.rateLimits.callsPerHour).toBe(4);
  });

  it("explains a missing config", async () => {
    await expect(loadConfig(join(dir, "config.json"))).rejects.toThrow(/run "hotline init"/);
  });

  it.skipIf(process.platform === "win32")("refuses a config other users can read", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify(CONFIG), { mode: 0o644 });
    await chmod(path, 0o644);
    await expect(loadConfig(path)).rejects.toThrow(/chmod 600/);
  });

  it("reports invalid content without quoting it", async () => {
    const path = join(dir, "config.json");
    await writePrivateFile(path, JSON.stringify({ ...CONFIG, elevenlabsApiKey: "fake-key-should-not-echo" }));
    const error = await loadConfig(path).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues).toEqual([
      expect.stringMatching(/^elevenlabsApiKey: looks like a secret/),
    ]);
    expect((error as Error).message).not.toContain("fake-key-should-not-echo");
  });
});

describe("writePrivateFile", () => {
  it("creates a 0700 directory and a 0600 file and leaves no temp files", async () => {
    const home = join(dir, "nested", ".hotline");
    const path = join(home, "config.json");
    await writePrivateFile(path, "one");
    await writePrivateFile(path, "two");
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(home)).toEqual(["config.json"]);
  });
});
