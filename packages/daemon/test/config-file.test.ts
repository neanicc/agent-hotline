import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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

  it.skipIf(process.platform === "win32")(
    "refuses a config in a directory other users can access",
    async () => {
      const { home, config } = hotlinePaths({ env: {}, homeDir: dir });
      await writePrivateFile(config, JSON.stringify(CONFIG));
      for (const mode of [0o755, 0o770, 0o701]) {
        await chmod(home, mode);
        await expect(loadConfig(config), mode.toString(8)).rejects.toThrow(/directory .*chmod 700/);
      }
    },
  );

  it.skipIf(process.platform === "win32")("refuses a symlinked config or config directory", async () => {
    const target = join(dir, "real-config.json");
    await writeFile(target, JSON.stringify(CONFIG), { mode: 0o600 });
    const home = join(dir, ".hotline");
    await mkdir(home, { mode: 0o700 });
    await symlink(target, join(home, "config.json"));
    await expect(loadConfig(join(home, "config.json"))).rejects.toThrow(/symbolic link/);

    const realHome = join(dir, "real-home");
    await mkdir(realHome, { mode: 0o700 });
    await writePrivateFile(join(realHome, "config.json"), JSON.stringify(CONFIG));
    await symlink(realHome, join(dir, "linked-home"));
    await expect(loadConfig(join(dir, "linked-home", "config.json"))).rejects.toThrow(/symbolic link/);
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

  it.skipIf(process.platform === "win32")(
    "refuses an existing directory other users can access",
    async () => {
      const home = join(dir, "shared");
      await mkdir(home, { mode: 0o700 });
      await chmod(home, 0o777);
      await expect(writePrivateFile(join(home, "config.json"), "x")).rejects.toThrow(/mode 777.*chmod 700/);
      expect(await readdir(home)).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")("does not write through a symlink", async () => {
    const target = join(dir, "target.txt");
    await writeFile(target, "original", { mode: 0o600 });
    await symlink(target, join(dir, "config.json"));
    await expect(writePrivateFile(join(dir, "config.json"), "replaced")).rejects.toThrow(/symbolic link/);
    expect(await readFile(target, "utf8")).toBe("original");
  });
});
