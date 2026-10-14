// The config edits `hotline install` makes, as pure text-in, text-out functions.
import { describe, expect, it } from "vitest";
import {
  AgentConfigError,
  checkLauncher,
  editClaudeMcp,
  editCodexToml,
  editHooks,
  readClaudeMcp,
  readCodexMcp,
  readHooks,
} from "../src/agent-config.js";

const USER_SETTINGS = `${JSON.stringify(
  {
    permissions: { allow: ["Bash(ls:*)"], deny: ["Read(./.env)"], defaultMode: "default" },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }],
      Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
    },
    model: "opus",
  },
  null,
  2,
)}\n`;

describe("editHooks", () => {
  it("adds the permission and Stop hooks from docs/hooks.md and keeps everything else", () => {
    const next = editHooks(USER_SETTINGS, "settings.json", "claude", "hotline", false);
    const before = JSON.parse(USER_SETTINGS);
    const after = JSON.parse(next ?? "");
    // Never widens permissions or touches other settings or hooks.
    expect(after.permissions).toEqual(before.permissions);
    expect(after.model).toBe("opus");
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(after.hooks.PreToolUse).toEqual(before.hooks.PreToolUse);
    expect(after.hooks.Stop).toEqual([
      ...before.hooks.Stop,
      {
        hooks: [{ type: "command", command: "hotline hook claude stop --wait-seconds 1830", timeout: 1900 }],
      },
    ]);
    expect(after.hooks.PermissionRequest).toEqual([
      {
        matcher: "*",
        hooks: [
          { type: "command", command: "hotline hook claude permission --wait-seconds 1830", timeout: 1900 },
        ],
      },
    ]);
  });

  it("matches the Codex snippet (no matcher) and creates the file from nothing", () => {
    const next = JSON.parse(editHooks(undefined, "hooks.json", "codex", "hotline", false) ?? "");
    expect(next).toEqual({
      hooks: {
        PermissionRequest: [
          {
            hooks: [
              {
                type: "command",
                command: "hotline hook codex permission --wait-seconds 1830",
                timeout: 1900,
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              { type: "command", command: "hotline hook codex stop --wait-seconds 1830", timeout: 1900 },
            ],
          },
        ],
      },
    });
  });

  it("is idempotent, even with the user's hooks after Hotline's", () => {
    const once = editHooks(USER_SETTINGS, "s", "claude", "hotline", false) ?? "";
    expect(editHooks(once, "s", "claude", "hotline", false)).toBe(once);
    const parsed = JSON.parse(once);
    parsed.hooks.Stop.push({ hooks: [{ type: "command", command: "later" }] });
    const reordered = `${JSON.stringify(parsed, null, 2)}\n`;
    expect(editHooks(reordered, "s", "claude", "hotline", false)).toBe(reordered);
  });

  it("replaces an older Hotline hook (a shorter wait, another launcher) instead of adding a second", () => {
    const old = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "node /x/apps/cli/dist/main.js hook claude stop" }] }],
      },
    });
    const next = JSON.parse(editHooks(old, "s", "claude", "hotline", false) ?? "");
    expect(next.hooks.Stop).toHaveLength(1);
    expect(next.hooks.Stop[0].hooks[0].command).toBe("hotline hook claude stop --wait-seconds 1830");
  });

  it("removes only Hotline's hooks, and leaves a file without them unchanged", () => {
    const installed = editHooks(USER_SETTINGS, "s", "claude", "hotline", false) ?? "";
    const removed = editHooks(installed, "s", "claude", "hotline", true) ?? "";
    expect(JSON.parse(removed)).toEqual(JSON.parse(USER_SETTINGS));
    expect(editHooks(USER_SETTINGS, "s", "claude", "hotline", true)).toBe(USER_SETTINGS);
    expect(editHooks(undefined, "s", "claude", "hotline", true)).toBeUndefined();
  });

  it("owns hooks it wrote with any launcher, and only the exact hook shape", () => {
    const wrapper = editHooks(undefined, "s", "claude", "/opt/bin/hotline-wrapper", false);
    expect(readHooks(wrapper, "s", "claude")).toHaveLength(2);
    // A later default install replaces them; a default uninstall removes them.
    const replaced = JSON.parse(editHooks(wrapper, "s", "claude", "hotline", false) ?? "");
    expect(replaced.hooks.Stop).toHaveLength(1);
    expect(replaced.hooks.Stop[0].hooks[0].command).toBe("hotline hook claude stop --wait-seconds 1830");
    expect(editHooks(wrapper, "s", "claude", "hotline", true)).toBe("{}\n");
    const notOurs = JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "my-tool hook claude stop --verbose" }] },
          { hooks: [{ type: "command", command: "sh -c 'x' hook claude stop" }] },
        ],
      },
    });
    expect(readHooks(notOurs, "s", "claude")).toEqual([]);
    expect(editHooks(notOurs, "s", "claude", "hotline", true)).toBe(notOurs);
  });

  it("does not take another agent's hook or another event for its own", () => {
    const codexOnes = editHooks(undefined, "s", "codex", "hotline", false);
    const both = JSON.parse(editHooks(codexOnes, "s", "claude", "hotline", false) ?? "");
    expect(both.hooks.Stop).toHaveLength(2);
  });

  it("refuses files it cannot read safely, without quoting them", () => {
    expect(() => editHooks("{ not json, token=abc", "s.json", "claude", "hotline", false)).toThrow(
      /s\.json is not valid JSON/,
    );
    expect(() => editHooks("{ not json, token=abc", "s.json", "claude", "hotline", false)).not.toThrow(/abc/);
    expect(() => editHooks('{"hooks": []}', "s", "claude", "hotline", false)).toThrow(AgentConfigError);
    expect(() => editHooks('{"hooks": {"Stop": {}}}', "s", "claude", "hotline", false)).toThrow(
      /hooks\.Stop/,
    );
    expect(() => editHooks("[]", "s", "claude", "hotline", false)).toThrow(/not a JSON object/);
  });
});

describe("editClaudeMcp", () => {
  it("writes the docs/mcp.md entry without a timeout, idempotently, and removes it", () => {
    const original = `${JSON.stringify({ numStartups: 3, mcpServers: { other: { command: "x" } } }, null, 2)}\n`;
    const next = editClaudeMcp(original, "s", "hotline", false) ?? "";
    expect(JSON.parse(next)).toEqual({
      numStartups: 3,
      mcpServers: {
        other: { command: "x" },
        hotline: { type: "stdio", command: "hotline", args: ["mcp", "--agent", "claude"] },
      },
    });
    expect(editClaudeMcp(next, "s", "hotline", false)).toBe(next);
    expect(JSON.parse(editClaudeMcp(next, "s", "hotline", true) ?? "")).toEqual(JSON.parse(original));
    expect(editClaudeMcp(original, "s", "hotline", true)).toBe(original);
  });
});

describe("editCodexToml", () => {
  const userToml = 'model = "o5"\napproval_policy = "on-request"\n\n[mcp_servers.other]\ncommand = "x"\n';

  it("appends a marked [mcp_servers.hotline] block with tool_timeout_sec and leaves the rest", () => {
    const next = editCodexToml(userToml, "c", "hotline", false) ?? "";
    expect(next.startsWith(userToml)).toBe(true);
    expect(next).toContain('[mcp_servers.hotline]\ncommand = "hotline"\nargs = ["mcp", "--agent", "codex"]');
    expect(readCodexMcp(next)).toEqual({ installed: true, toolTimeoutSeconds: 2100 });
    expect(editCodexToml(next, "c", "hotline", false)).toBe(next);
    expect(editCodexToml(next, "c", "hotline", true)).toBe(userToml);
    expect(editCodexToml(userToml, "c", "hotline", true)).toBe(userToml);
  });

  it("updates its own block in place", () => {
    const next = editCodexToml(userToml, "c", "hotline", false) ?? "";
    const moved = editCodexToml(next, "c", "/opt/hotline/bin/hotline", false) ?? "";
    expect(moved).toContain('command = "/opt/hotline/bin/hotline"');
    expect(moved.match(/\[mcp_servers\.hotline\]/g)).toHaveLength(1);
  });

  it("never touches a hotline server written by hand, in any TOML form", () => {
    for (const hand of [
      '[mcp_servers.hotline]\ncommand = "hotline"\n',
      '[mcp_servers."hotline"]\ncommand = "hotline"\n',
      "[mcp_servers.'hotline']\ncommand = 'hotline'\n",
      '[ mcp_servers . hotline ]\ncommand = "hotline"\n',
      '[mcp_servers.hotline.env]\nX = "1"\n',
      '[mcp_servers]\nhotline = { command = "hotline" }\n',
      '[mcp_servers]\n"hotline" = { command = "hotline" }\n',
      '[mcp_servers]\nhotline.command = "hotline"\n',
      'mcp_servers.hotline.command = "hotline"\n',
      'mcp_servers = { hotline = { command = "hotline" } }\n',
    ]) {
      expect(() => editCodexToml(hand, "c", "hotline", false), hand).toThrow(/written by hand/);
      expect(readCodexMcp(hand).installed, hand).toBe(true);
    }
    // Other servers, and the word hotline elsewhere, are fine.
    const other = '[mcp_servers.hotline_old]\ncommand = "x"\n[mcp_servers.other]\nargs = ["hotline"]\n';
    expect(editCodexToml(other, "c", "hotline", false)).toContain("[mcp_servers.hotline]");
  });

  it("reads tool_timeout_sec from a hand-written inline table", () => {
    expect(
      readCodexMcp('[mcp_servers]\nhotline = { command = "hotline", tool_timeout_sec = 2400 }\n'),
    ).toEqual({
      installed: true,
      toolTimeoutSeconds: 2400,
    });
  });
});

describe("readers", () => {
  it("reads waits and timeouts, with the agents' defaults when unset", () => {
    const text = JSON.stringify({
      hooks: {
        PermissionRequest: [{ hooks: [{ type: "command", command: "hotline hook codex permission" }] }],
        Stop: [
          {
            hooks: [{ type: "command", command: "hotline hook codex stop --wait-seconds 700", timeout: 650 }],
          },
        ],
      },
    });
    expect(readHooks(text, "h", "codex")).toEqual([
      { event: "permission", waitSeconds: 540, timeoutSeconds: 600 },
      { event: "stop", waitSeconds: 700, timeoutSeconds: 650 },
    ]);
    expect(readHooks(text, "h", "claude")).toEqual([]);
  });

  it("reads Claude's per-server timeout and Codex's default tool timeout", () => {
    expect(readClaudeMcp(JSON.stringify({ mcpServers: { hotline: { timeout: 5000 } } }), "m")).toEqual({
      installed: true,
      timeoutMs: 5000,
    });
    expect(readClaudeMcp(undefined, "m")).toEqual({ installed: false });
    expect(
      readCodexMcp('[mcp_servers.hotline]\ncommand = "hotline"\n[other]\ntool_timeout_sec = 9000\n'),
    ).toEqual({
      installed: true,
      toolTimeoutSeconds: 60,
    });
  });
});

describe("checkLauncher", () => {
  it("allows hotline or a plain absolute path, nothing a shell would interpret", () => {
    expect(checkLauncher("hotline")).toBe("hotline");
    expect(checkLauncher("/usr/local/bin/hotline")).toBe("/usr/local/bin/hotline");
    for (const bad of ["hot line", "./hotline", "/bin/x; rm -rf ~", "/x/$(id)", "~/bin/hotline"]) {
      expect(() => checkLauncher(bad)).toThrow(AgentConfigError);
    }
  });
});
