// `hotline install` end to end, only ever on temporary directories passed with
// --home. The real ~/.claude and ~/.codex are never read or written.
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, type TempSetup, tempSetup, testContext } from "./setup-helpers.js";

let setup: TempSetup;
beforeEach(async () => {
  setup = await tempSetup();
  await mkdir(join(setup.home, "project"), { recursive: true });
});
afterEach(() => setup.cleanup());

const install = (...args: string[]) => cli(["install", ...args, "--home", setup.home], testContext(setup));

describe("hotline install: the --home override", () => {
  it("is required in test mode, and nothing is written without it", async () => {
    // homeDir would be the temp home too, but the guard insists on the explicit flag.
    const result = await cli(["install", "claude"], testContext(setup, { homeDir: homedir() }));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("test mode needs --home");
    const codex = await cli(["install", "codex", "--project"], testContext(setup));
    expect(codex.code).toBe(2);
    await expect(lstat(join(setup.home, ".claude"))).rejects.toThrow();
  });

  it("is required by HOTLINE_TEST_MODE=1 outside the test runner too, and must be absolute", async () => {
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    let code: number;
    try {
      const env = { HOTLINE_HOME: setup.hotlineHome, HOTLINE_TEST_MODE: "1" };
      code = (await cli(["install", "claude"], testContext(setup, { env }))).code;
    } finally {
      process.env.VITEST = saved;
    }
    expect(code).toBe(2);
    await expect(lstat(join(setup.home, ".claude.json"))).rejects.toThrow();
    const relative = await cli(["install", "claude", "--home", "relative/dir"], testContext(setup));
    expect(relative.stderr).toContain("--home must be an absolute path");
  });

  it("keeps --project inside --home in test mode", async () => {
    const context = testContext(setup, { cwd: setup.dir });
    const result = await cli(["install", "claude", "--project", "--home", setup.home], context);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("project folder inside --home");
  });
});

describe("hotline install claude", () => {
  it("writes the MCP server and hooks with a backup and a diff, then changes nothing", async () => {
    await mkdir(join(setup.home, ".claude"));
    const settings = { permissions: { allow: ["Bash(ls:*)"], defaultMode: "default" }, model: "opus" };
    await writeFile(join(setup.home, ".claude", "settings.json"), JSON.stringify(settings, null, 2), {
      mode: 0o644,
    });

    const first = await install("claude");
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(`+++ ${join(setup.home, ".claude.json")} (after)`);
    expect(first.stdout).toMatch(/^\+\s+"command": "hotline hook claude permission --wait-seconds 1830",$/m);
    expect(first.stdout).toContain(
      `backup: ${join(setup.home, ".claude", "settings.json")}.hotline-backup-20261014T120000.000Z`,
    );
    expect(first.stdout).toContain("CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT");

    const written = JSON.parse(await readFile(join(setup.home, ".claude", "settings.json"), "utf8"));
    expect(written.permissions).toEqual(settings.permissions);
    expect(written.hooks.PermissionRequest[0].hooks[0].timeout).toBe(1900);
    // The existing file keeps its mode; the backup is the original, owner-only.
    expect((await lstat(join(setup.home, ".claude", "settings.json"))).mode & 0o777).toBe(0o644);
    const backups = (await readdir(join(setup.home, ".claude"))).filter((name) => name.includes("backup"));
    expect(backups).toHaveLength(1);
    const backup = join(setup.home, ".claude", backups[0] as string);
    expect(JSON.parse(await readFile(backup, "utf8"))).toEqual(settings);
    expect((await lstat(backup)).mode & 0o777).toBe(0o600);
    const mcp = JSON.parse(await readFile(join(setup.home, ".claude.json"), "utf8"));
    expect(mcp.mcpServers.hotline).toEqual({
      type: "stdio",
      command: "hotline",
      args: ["mcp", "--agent", "claude"],
    });
    expect((await lstat(join(setup.home, ".claude.json"))).mode & 0o777).toBe(0o600);

    const second = await install("claude");
    expect(second.code).toBe(0);
    expect(second.stdout).not.toContain("+++");
    expect(second.stdout.match(/^unchanged: /gm)).toHaveLength(2);
    expect(
      (await readdir(join(setup.home, ".claude"))).filter((name) => name.includes("backup")),
    ).toHaveLength(1);
  });

  it("uninstalls back to the original settings", async () => {
    await mkdir(join(setup.home, ".claude"));
    const original = `${JSON.stringify({ model: "opus" }, null, 2)}\n`;
    await writeFile(join(setup.home, ".claude", "settings.json"), original);
    await install("claude");
    const removed = await cli(
      ["install", "claude", "--uninstall", "--home", setup.home],
      testContext(setup, { now: () => new Date("2026-10-14T12:00:01.000Z") }),
    );
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("removed Hotline from");
    expect(await readFile(join(setup.home, ".claude", "settings.json"), "utf8")).toBe(original);
    expect(JSON.parse(await readFile(join(setup.home, ".claude.json"), "utf8"))).toEqual({});
  });

  it("writes .mcp.json and .claude/settings.json in the project with --project", async () => {
    const result = await install("claude", "--project");
    expect(result.code).toBe(0);
    const project = join(setup.home, "project");
    expect(JSON.parse(await readFile(join(project, ".mcp.json"), "utf8")).mcpServers.hotline.command).toBe(
      "hotline",
    );
    expect(
      JSON.parse(await readFile(join(project, ".claude", "settings.json"), "utf8")).hooks.Stop,
    ).toHaveLength(1);
    await expect(lstat(join(setup.home, ".claude.json"))).rejects.toThrow();
  });

  it("prints a diff and writes nothing with --dry-run", async () => {
    const result = await install("claude", "--dry-run");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("+++");
    expect(result.stdout).toContain("dry run: 2 file(s) would change");
    await expect(lstat(join(setup.home, ".claude.json"))).rejects.toThrow();
  });

  it("refuses a symlinked config and a launcher a shell would interpret", async () => {
    await mkdir(join(setup.home, ".claude"));
    await writeFile(join(setup.dir, "elsewhere.json"), "{}");
    await symlink(join(setup.dir, "elsewhere.json"), join(setup.home, ".claude", "settings.json"));
    const linked = await install("claude");
    expect(linked.code).toBe(1);
    expect(linked.stderr).toContain("is a symbolic link");
    expect(await readFile(join(setup.dir, "elsewhere.json"), "utf8")).toBe("{}");
    const bad = await install("claude", "--command", "/bin/x;id");
    expect(bad.code).toBe(2);
  });
});

describe("hotline install codex", () => {
  it("writes config.toml and hooks.json, idempotently, and reminds about /hooks", async () => {
    await mkdir(join(setup.home, ".codex"));
    await writeFile(join(setup.home, ".codex", "config.toml"), 'model = "o5"\n');
    const first = await install("codex");
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("+tool_timeout_sec = 2100");
    expect(first.stdout).toContain("/hooks");
    const toml = await readFile(join(setup.home, ".codex", "config.toml"), "utf8");
    expect(toml.startsWith('model = "o5"\n')).toBe(true);
    const hooks = JSON.parse(await readFile(join(setup.home, ".codex", "hooks.json"), "utf8"));
    expect(hooks.hooks.Stop[0].hooks[0].command).toBe("hotline hook codex stop --wait-seconds 1830");

    const second = await install("codex");
    expect(second.stdout.match(/^unchanged: /gm)).toHaveLength(2);
    const removed = await cli(
      ["install", "codex", "--uninstall", "--home", setup.home],
      testContext(setup, { now: () => new Date("2026-10-14T12:00:02.000Z") }),
    );
    expect(removed.code).toBe(0);
    expect(await readFile(join(setup.home, ".codex", "config.toml"), "utf8")).toBe('model = "o5"\n');
  });

  it("ignores CODEX_HOME when --home is given", async () => {
    const context = testContext(setup, {
      env: { HOTLINE_HOME: setup.hotlineHome, CODEX_HOME: "/nonexistent/codex" },
    });
    const result = await cli(["install", "codex", "--home", setup.home], context);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(join(setup.home, ".codex", "config.toml"));
  });

  it("leaves a hand-written [mcp_servers.hotline] alone and says so", async () => {
    await mkdir(join(setup.home, ".codex"));
    const hand = '[mcp_servers.hotline]\ncommand = "hotline"\n';
    await writeFile(join(setup.home, ".codex", "config.toml"), hand);
    const result = await install("codex");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("written by hand");
    expect(await readFile(join(setup.home, ".codex", "config.toml"), "utf8")).toBe(hand);
  });
});
