// `hotline doctor` against temporary directories and a fake HTTP layer for the
// daemon's health check and ElevenLabs. Secrets are never printed.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileSecretStore, writePrivateFile } from "@hotline/daemon";
import { AGENT_DEFINITION_VERSION } from "@hotline/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliFetch } from "../src/setup.js";
import {
  cli,
  fakeFetch,
  type Recorded,
  route,
  type TempSetup,
  tempSetup,
  testContext,
} from "./setup-helpers.js";

const SECRETS = {
  "daemon.apiToken": "fake-api-token-0123456789abcdefghijklmnopqrstu",
  "elevenlabs.apiKey": "sk_fake_elevenlabs_key_0001",
  "elevenlabs.toolSecret": "fake-tool-secret-0123456789abcdefghijklmnop",
  "elevenlabs.webhookSecret": "wsec_fake_0001",
} as const;
const TOOL_IDS = { submit_answer: "t1", verify_pin: "t2", get_status: "t3", send_instruction: "t4" };

let setup: TempSetup;
beforeEach(async () => {
  setup = await tempSetup();
});
afterEach(() => setup.cleanup());

async function writeSetup(overrides: Record<string, unknown> = {}) {
  const config = {
    version: 1,
    owner: { phoneNumber: "+15555550100", pinHash: `scrypt$15$8$1$${"s".repeat(22)}$${"h".repeat(43)}` },
    quietHours: { timeZone: "America/Toronto" },
    voice: {
      agentId: "agent_fake_1",
      agentPhoneNumberId: "phnum_fake_1",
      voiceId: "Voice0000000000000001",
      toolIds: TOOL_IDS,
      toolSecretId: "sec_fake_1",
    },
    sms: { provider: "fake" },
    tunnel: { publicUrl: "https://hotline-fake.example.com" },
    secrets: { store: "file" },
    ...overrides,
  };
  await writePrivateFile(join(setup.hotlineHome, "config.json"), JSON.stringify(config));
  const store = new FileSecretStore(join(setup.hotlineHome, "secrets.json"));
  for (const [name, value] of Object.entries(SECRETS)) await store.set(name as keyof typeof SECRETS, value);
}

async function installAll() {
  const context = testContext(setup, { fetch: fakeFetch() });
  for (const agent of ["claude", "codex"]) {
    expect((await cli(["install", agent, "--home", setup.home], context)).code).toBe(0);
  }
}

const TOOL_NAME_BY_ID = Object.fromEntries(Object.entries(TOOL_IDS).map(([name, id]) => [id, name]));

function healthy(version = AGENT_DEFINITION_VERSION, toolOrigin = "https://hotline-fake.example.com") {
  return fakeFetch(
    route("GET", "/v1/health", 200, { ok: true, version: "0.0.0" }),
    route("GET", /^\/v1\/convai\/tools\/t\d$/, 200, (request: Recorded) => {
      const id = new URL(request.url).pathname.split("/").at(-1) ?? "";
      return {
        id,
        tool_config: {
          type: "webhook",
          api_schema: {
            url: `${toolOrigin}/hooks/el/tools/${TOOL_NAME_BY_ID[id]}`,
            request_headers: { "x-hotline-tool-secret": { secret_id: "sec_fake_1" } },
          },
        },
      };
    }),
    route("GET", "/v1/convai/agents/agent_fake_1", 200, {
      agent_id: "agent_fake_1",
      tags: ["agent-hotline", `definition-v${version}`],
      conversation_config: {
        agent: { prompt: { tool_ids: Object.values(TOOL_IDS) } },
        tts: { voice_id: "Voice0000000000000001" },
      },
    }),
  );
}

function context(fetch: CliFetch = healthy(), env: Record<string, string> = {}) {
  return testContext(setup, {
    fetch,
    env: { HOTLINE_HOME: setup.hotlineHome, CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "2400000", ...env },
  });
}

const lines = (stdout: string, status: string) =>
  stdout.split("\n").filter((line) => line.startsWith(status));

describe("hotline doctor", () => {
  it("passes a complete setup and exits 0, without printing secrets or the full number", async () => {
    await writeSetup();
    await installAll();
    const fetch = healthy();
    const result = await cli(["doctor", "--home", setup.home], context(fetch));
    expect(lines(result.stdout, "FAIL")).toEqual([]);
    expect(lines(result.stdout, "WARN")).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`agent definition v${AGENT_DEFINITION_VERSION} is deployed`);
    expect(result.stdout).toContain("permission hook waits 1830s, timeout 1900s");
    expect(result.stdout).toContain("tool_timeout_sec 2100 is above the ask timeout");
    expect(result.stdout).toContain("token accepted");
    for (const value of Object.values(SECRETS)) expect(result.stdout + result.stderr).not.toContain(value);
    expect(result.stdout).not.toContain("+15555550100");
    // The health check carries the token to 127.0.0.1 only.
    const health = fetch.requests.find((r) => r.url.endsWith("/v1/health"));
    expect(new URL(health?.url ?? "").hostname).toBe("127.0.0.1");
    expect(health?.headers.authorization).toBe(`Bearer ${SECRETS["daemon.apiToken"]}`);
  });

  it("fails when the agent lacks Hotline's tools, or their ids were never recorded", async () => {
    const toolsFail = async (voice: Record<string, unknown>) => {
      await writeSetup({ voice: { agentId: "agent_fake_1", agentPhoneNumberId: "phnum_fake_1", ...voice } });
      const result = await cli(["doctor", "--home", setup.home], context());
      expect(result.code).toBe(1);
      return lines(result.stdout, "FAIL").join("\n");
    };
    // A hand-made agent with the current tag but no recorded tools.
    expect(await toolsFail({})).toContain(
      "lacks the tools submit_answer, verify_pin, get_status, send_instruction",
    );
    // Recorded, but one is no longer on the deployed agent.
    expect(await toolsFail({ toolIds: { ...TOOL_IDS, get_status: "t9" } })).toContain(
      "lacks the tools get_status",
    );
  });

  it("fails when the tools still call an old tunnel URL or use another secret", async () => {
    await writeSetup();
    await installAll();
    const moved = await cli(
      ["doctor", "--home", setup.home],
      context(healthy(AGENT_DEFINITION_VERSION, "https://old.example.com")),
    );
    expect(moved.code).toBe(1);
    expect(lines(moved.stdout, "FAIL").join("\n")).toContain(
      "the tools submit_answer, verify_pin, get_status, send_instruction call another URL or use another secret",
    );
    await writeSetup({
      voice: {
        agentId: "agent_fake_1",
        agentPhoneNumberId: "phnum_fake_1",
        voiceId: "Voice0000000000000001",
        toolIds: TOOL_IDS,
        toolSecretId: "sec_other",
      },
    });
    const rekeyed = await cli(["doctor", "--home", setup.home], context());
    expect(lines(rekeyed.stdout, "FAIL").join("\n")).toContain("use another secret");
  });

  it("fails when the deployed agent is an older definition", async () => {
    await writeSetup();
    await installAll();
    const result = await cli(
      ["doctor", "--home", setup.home],
      context(healthy(AGENT_DEFINITION_VERSION - 1)),
    );
    expect(result.code).toBe(1);
    expect(lines(result.stdout, "FAIL").join("\n")).toContain(
      `definition v${AGENT_DEFINITION_VERSION - 1}, this hotline has v${AGENT_DEFINITION_VERSION}; run hotline voice apply`,
    );
  });

  it("finds hooks installed with a wrapper --command when given the same --command", async () => {
    await writeSetup();
    const wrapper = "/opt/bin/agent-phone";
    const installContext = testContext(setup, { fetch: fakeFetch() });
    for (const agent of ["claude", "codex"]) {
      const installed = await cli(
        ["install", agent, "--home", setup.home, "--command", wrapper],
        installContext,
      );
      expect(installed.code).toBe(0);
    }
    const without = await cli(["doctor", "--home", setup.home], context());
    expect(lines(without.stdout, "WARN").join("\n")).toContain("permission hook missing");
    const withCommand = await cli(["doctor", "--home", setup.home, "--command", wrapper], context());
    expect(withCommand.stdout).toContain("permission hook waits 1830s, timeout 1900s");
    expect(lines(withCommand.stdout, "WARN")).toEqual([]);
  });

  it("fails a hook whose wait is not below its timeout, and a short Codex tool timeout", async () => {
    await writeSetup();
    await mkdir(join(setup.home, ".codex"), { recursive: true });
    await writeFile(
      join(setup.home, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          PermissionRequest: [
            { hooks: [{ type: "command", command: "hotline hook codex permission --wait-seconds 1830" }] },
          ],
          Stop: [
            {
              hooks: [
                { type: "command", command: "hotline hook codex stop --wait-seconds 1830", timeout: 1900 },
              ],
            },
          ],
        },
      }),
    );
    await writeFile(
      join(setup.home, ".codex", "config.toml"),
      '[mcp_servers.hotline]\ncommand = "hotline"\n',
    );
    const result = await cli(["doctor", "--home", setup.home], context());
    expect(result.code).toBe(1);
    const failures = lines(result.stdout, "FAIL").join("\n");
    expect(failures).toContain(
      "permission hook waits 1830s, timeout 600s: the wait must be below the timeout",
    );
    expect(failures).toContain("tool_timeout_sec 60 is not above the ask timeout (1800s)");
  });

  it("fails on missing secrets, a missing public URL and an unreachable ElevenLabs, and warns on the rest", async () => {
    await writeSetup({ tunnel: {} });
    await new FileSecretStore(join(setup.hotlineHome, "secrets.json")).delete("elevenlabs.webhookSecret");
    const fetch = fakeFetch();
    const result = await cli(
      ["doctor", "--home", setup.home],
      context(fetch, { CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "" }),
    );
    expect(result.code).toBe(1);
    const failures = lines(result.stdout, "FAIL").join("\n");
    expect(failures).toContain("ElevenLabs webhook secret is not set");
    expect(failures).toContain("tunnel.publicUrl is not set");
    expect(failures).toContain("ElevenLabs could not read the agent (HTTP 404)");
    const warnings = lines(result.stdout, "WARN").join("\n");
    expect(warnings).toContain("not installed (user); run hotline install claude");
    expect(warnings).toContain("CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT is not set");
    expect(result.stdout).toMatch(/doctor: \d+ pass, \d+ warn, \d+ fail/);
  });

  it("reports a stopped daemon as a warning and a refused token as a failure", async () => {
    await writeSetup({ voice: { provider: "fake" } });
    const unreachable = Object.assign(
      async () => {
        throw new TypeError("fetch failed");
      },
      { requests: [] },
    );
    const down = await cli(["doctor", "--home", setup.home], context(unreachable));
    expect(lines(down.stdout, "WARN").join("\n")).toContain("not running on 127.0.0.1:7341");
    const squatter = await cli(["doctor", "--home", setup.home], context(fakeFetch()));
    expect(lines(squatter.stdout, "FAIL").join("\n")).toContain("something else answers on port 7341");
    const refused = await cli(
      ["doctor", "--home", setup.home],
      context(fakeFetch(route("GET", "/v1/health", 401))),
    );
    expect(lines(refused.stdout, "FAIL").join("\n")).toContain("refused the API token");
    expect(refused.code).toBe(1);
  });

  it("fails clearly when there is no config", async () => {
    const result = await cli(["doctor", "--home", setup.home], context());
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL  config  No hotline config at");
  });
});
