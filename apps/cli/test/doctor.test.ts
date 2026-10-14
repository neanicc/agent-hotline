// `hotline doctor` against temporary directories and a fake HTTP layer for the
// daemon's health check and ElevenLabs. Secrets are never printed.
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_VOICE_LLM } from "@hotline/core";
import { FileSecretStore, type JudgeHost, openStore, writePrivateFile } from "@hotline/daemon";
import { AGENT_DEFINITION_VERSION } from "@hotline/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeJudgeHost } from "../../../packages/daemon/test/fake-judge.js";
import type { CliFetch } from "../src/setup.js";
import { seedTypicalUsage } from "./cost-helpers.js";
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
    // `hotline init` asked, and the owner chose the reply judge.
    judge: { backend: "auto" },
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

function healthy(
  version = AGENT_DEFINITION_VERSION,
  toolOrigin = "https://hotline-fake.example.com",
  /** `null` leaves `llm` out, as on an agent from before definition v6. */
  llm: unknown = DEFAULT_VOICE_LLM,
) {
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
        agent: {
          prompt: { tool_ids: Object.values(TOOL_IDS), ...(llm === null ? {} : { llm }) },
        },
        tts: { voice_id: "Voice0000000000000001" },
      },
    }),
  );
}

/** A complete setup has the Claude Code CLI for the reply judge (a fake one: nothing runs). */
const CLAUDE_PATH = "/fake/bin/claude";

function context(
  fetch: CliFetch = healthy(),
  env: Record<string, string> = {},
  judgeHost: JudgeHost = new FakeJudgeHost({ claude: CLAUDE_PATH }),
) {
  return testContext(setup, {
    fetch,
    env: { HOTLINE_HOME: setup.hotlineHome, CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "2400000", ...env },
    judgeHost,
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

  it("reports the deployed LLM and warns when it is not the one this config wants (HL-14d)", async () => {
    await writeSetup();
    await installAll();
    const ok = await cli(["doctor", "--home", setup.home], context());
    expect(ok.stdout).toContain("the agent runs on claude-haiku-4-5");
    const warnings = async (llm: unknown, voice: Record<string, unknown> = {}) => {
      await writeSetup({
        voice: {
          agentId: "agent_fake_1",
          agentPhoneNumberId: "phnum_fake_1",
          voiceId: "Voice0000000000000001",
          toolIds: TOOL_IDS,
          toolSecretId: "sec_fake_1",
          ...voice,
        },
      });
      const result = await cli(
        ["doctor", "--home", setup.home],
        context(healthy(AGENT_DEFINITION_VERSION, undefined, llm)),
      );
      // A different model costs friction, never safety, so it warns and does not fail.
      expect(lines(result.stdout, "FAIL")).toEqual([]);
      expect(result.code).toBe(0);
      return lines(result.stdout, "WARN").join("\n");
    };
    // An agent left on ElevenLabs' default, from before definition v6.
    expect(await warnings(null)).toContain(
      "the agent runs on ElevenLabs' default LLM, this config wants claude-haiku-4-5; run hotline voice apply",
    );
    // voice.llm changed but not applied yet.
    expect(await warnings("claude-haiku-4-5", { llm: "claude-sonnet-5-5" })).toContain(
      "the agent runs on claude-haiku-4-5, this config wants claude-sonnet-5-5; run hotline voice apply",
    );
    expect(await warnings("claude-sonnet-5-5", { llm: "claude-sonnet-5-5" })).toBe("");
    // Whatever ElevenLabs returns is never printed unless it looks like an LLM id.
    const odd = await warnings("claude\u0007\nrun this");
    expect(odd).toContain("the agent runs on ElevenLabs' default LLM");
    expect(odd).not.toContain("run this");
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

describe("hotline doctor reply judge (HL-09d)", () => {
  const judgeLines = (stdout: string) => stdout.split("\n").filter((line) => /^\w+\s+judge\s/.test(line));
  const agreed = { verdict: "agreed", conditional: false, retracted: false } as const;

  it("reports the active backend without running anything or calling a model", async () => {
    await writeSetup();
    const host = new FakeJudgeHost({ claude: CLAUDE_PATH, codex: "/fake/bin/codex" }, () => agreed);
    const result = await cli(["doctor", "--home", setup.home], context(healthy(), {}, host));
    expect(judgeLines(result.stdout)).toEqual([
      expect.stringMatching(
        /^PASS\s+judge\s+claude-code: Claude Code CLI \(\/fake\/bin\/claude\) on your login/,
      ),
    ]);
    expect(host.runs).toEqual([]);
  });

  it("falls back to Codex, then the stored API key, and warns when there is none", async () => {
    await writeSetup();
    const codex = await cli(
      ["doctor", "--home", setup.home],
      context(healthy(), {}, new FakeJudgeHost({ codex: "/fake/bin/codex" })),
    );
    expect(judgeLines(codex.stdout)).toEqual([expect.stringMatching(/^PASS\s+judge\s+codex: Codex CLI/)]);
    const none = await cli(["doctor", "--home", setup.home], context(healthy(), {}, new FakeJudgeHost({})));
    expect(judgeLines(none.stdout)).toEqual([
      expect.stringMatching(/^WARN\s+judge\s+none: neither claude nor codex is on the PATH/),
    ]);
    const key = "sk-ant-fake-judge-key-0001";
    await new FileSecretStore(join(setup.hotlineHome, "secrets.json")).set("anthropic.apiKey", key);
    const api = await cli(["doctor", "--home", setup.home], context(healthy(), {}, new FakeJudgeHost({})));
    expect(judgeLines(api.stdout)).toEqual([expect.stringMatching(/^PASS\s+judge\s+anthropic-api: /)]);
    expect(api.stdout + api.stderr).not.toContain(key);
  });

  it("warns when no judge was chosen yet, and neither looks for a CLI nor sends anything", async () => {
    await writeSetup({ judge: {} });
    const host = new FakeJudgeHost({ claude: CLAUDE_PATH }, () => agreed);
    const result = await cli(["doctor", "--home", setup.home, "--check-judge"], context(healthy(), {}, host));
    expect(judgeLines(result.stdout)).toEqual([
      expect.stringMatching(
        /^WARN\s+judge\s+not chosen: nothing is sent.*hotline init --force --non-interactive --judge <auto\|claude-code\|codex\|anthropic-api\|off>/,
      ),
    ]);
    expect(host.found).toEqual([]);
    expect(host.runs).toEqual([]);
  });

  it("names the PATH it looked on when no CLI is found", async () => {
    await writeSetup();
    const result = await cli(
      ["doctor", "--home", setup.home],
      context(healthy(), { PATH: "/usr/bin:/bin" }, new FakeJudgeHost({})),
    );
    expect(judgeLines(result.stdout)).toEqual([
      expect.stringMatching(
        /^WARN\s+judge\s+none: neither claude nor codex is on the PATH \(\/usr\/bin:\/bin\)/,
      ),
    ]);
  });

  it("passes when judge.backend is off, and sends nothing anywhere", async () => {
    await writeSetup({ judge: { backend: "off" } });
    const host = new FakeJudgeHost({ claude: CLAUDE_PATH });
    const result = await cli(["doctor", "--home", setup.home, "--check-judge"], context(healthy(), {}, host));
    expect(judgeLines(result.stdout)).toEqual([
      expect.stringMatching(/^PASS\s+judge\s+off \(judge\.backend\)/),
    ]);
    expect(host.found).toEqual([]);
    expect(host.runs).toEqual([]);
  });

  it("with --check-judge, asks one fixed question and passes only on agreed", async () => {
    await writeSetup();
    const good = new FakeJudgeHost({ claude: CLAUDE_PATH }, () => agreed);
    const passed = await cli(["doctor", "--home", setup.home, "--check-judge"], context(healthy(), {}, good));
    expect(judgeLines(passed.stdout)[1]).toMatch(
      /^PASS\s+judge\s+a test question \("yes, go ahead"\) came back agreed/,
    );
    expect(good.runs.map((run) => run.reply)).toEqual([["yes, go ahead"]]);
    const loggedOut = new FakeJudgeHost({ claude: CLAUDE_PATH }, () => ({
      raw: { exitCode: 1, stdout: "", stderr: "Invalid API key · Please run /login" },
    }));
    const failed = await cli(
      ["doctor", "--home", setup.home, "--check-judge"],
      context(healthy(), {}, loggedOut),
    );
    expect(judgeLines(failed.stdout)[1]).toMatch(
      /^FAIL\s+judge\s+a test question .* came back unclear, not agreed/,
    );
    expect(failed.code).toBe(1);
  });
});

describe("hotline doctor cost estimate", () => {
  const costInfo = (stdout: string) => lines(stdout, "INFO").filter((line) => /^INFO\s+cost\s/.test(line));
  const dbPath = () => join(setup.hotlineHome, "hotline.db");
  // Fake providers and a stopped daemon; records every URL doctor tries to reach.
  const offline = () => {
    const urls: string[] = [];
    return Object.assign(
      async (url: string) => {
        urls.push(url);
        throw new TypeError("fetch failed");
      },
      { requests: [] as Recorded[], urls },
    );
  };
  const fakeProviders = { voice: { provider: "fake" }, sms: { provider: "fake" } };

  it("prints info lines that never count as pass or fail, without a store", async () => {
    await writeSetup(fakeProviders);
    const result = await cli(["doctor", "--home", setup.home], context(offline()));
    const info = costInfo(result.stdout);
    expect(info[0]).toContain(`estimate: about $7.15 a month, with no usage: no store at ${dbPath()} yet`);
    expect(info[0]).toContain("(assumed rates, not a bill; computed locally)");
    expect(info.join("\n")).toContain("Twilio: number $1.15 (monthly)");
    expect(info.join("\n")).toContain("ElevenLabs: plan $6.00 (monthly, 75 min included)");
    // The summary counts checks only, and reading usage never creates the store.
    const counts = ["PASS", "WARN", "FAIL"].map((status) => lines(result.stdout, status).length);
    expect(result.stdout).toContain(`doctor: ${counts[0]} pass, ${counts[1]} warn, ${counts[2]} fail`);
    expect(result.code).toBe(0);
    await expect(stat(dbPath())).rejects.toThrow(/ENOENT/);
  });

  it("prices an empty store as no usage", async () => {
    await writeSetup(fakeProviders);
    (await openStore(dbPath())).close();
    const result = await cli(["doctor", "--home", setup.home], context(offline()));
    const info = costInfo(result.stdout);
    expect(info[0]).toContain(`estimate: about $7.15 a month, from the last 30 days in ${dbPath()}`);
    expect(info[1]).toContain(
      "usage: 0 calls (0 placed, 0 received), 0 billed min, 0 texts sent (including 0 replies)",
    );
  });

  it("estimates typical usage from the store with the default rates", async () => {
    await writeSetup(fakeProviders);
    await seedTypicalUsage(dbPath());
    const fetch = offline();
    const result = await cli(["doctor", "--home", setup.home], context(fetch));
    const info = costInfo(result.stdout).join("\n");
    expect(info).toContain("estimate: about $7.55 a month, from the last 30 days");
    expect(info).toContain(
      "usage: 3 calls (2 placed, 1 received), 6 billed min, 6 texts sent (including 2 replies), 3 received",
    );
    expect(info).toContain("calls $0.08 (6 min x $0.014)");
    expect(info).toContain("LLM $0.18 (6 min x $0.03)");
    // Only the daemon health check tried to connect, to 127.0.0.1.
    expect(fetch.urls).toEqual(["http://127.0.0.1:7341/v1/health"]);
  });

  it("uses the config's rate overrides and rejects a negative rate", async () => {
    await writeSetup({
      ...fakeProviders,
      costs: {
        twilioNumberPerMonth: 0,
        elevenLabsPlanPerMonth: 22,
        elevenLabsIncludedMinutes: 5,
        elevenLabsPerMinute: 0.1,
        llmPerMinute: 0,
      },
    });
    await seedTypicalUsage(dbPath());
    const result = await cli(["doctor", "--home", setup.home], context(offline()));
    const info = costInfo(result.stdout).join("\n");
    expect(info).toContain("estimate: about $22.32 a month");
    expect(info).toContain("extra minutes $0.10 (1 min x $0.1)");
    await writeSetup({ ...fakeProviders, costs: { llmPerMinute: -1 } });
    const refused = await cli(["doctor", "--home", setup.home], context(offline()));
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain("FAIL  config  Invalid hotline config:");
    expect(refused.stdout).toMatch(/costs\.llmPerMinute: .*>=0/);
  });
});
