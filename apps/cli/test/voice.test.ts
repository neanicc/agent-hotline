// `hotline voice` and `hotline test-call` through a fake HTTP layer: nothing
// reaches ElevenLabs and no phone rings.
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfigText } from "@hotline/core";
import { FileSecretStore, writePrivateFile } from "@hotline/daemon";
import { AGENT_DEFINITION_VERSION, TOOL_SECRET_HEADER } from "@hotline/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cli,
  fakeFetch,
  type Recorded,
  route,
  scriptedPrompter,
  type TempSetup,
  tempSetup,
  testContext,
} from "./setup-helpers.js";

const API_KEY = "sk_fake_elevenlabs_key_0001";
const TOOL_SECRET = "fake-tool-secret-0123456789abcdefghijklmnopqrstuv";

let setup: TempSetup;
beforeEach(async () => {
  setup = await tempSetup();
});
afterEach(() => setup.cleanup());

const configPath = () => join(setup.hotlineHome, "config.json");

async function writeSetup(voice: Record<string, unknown> = {}, secrets = true) {
  const config = {
    version: 1,
    owner: { phoneNumber: "+15555550100", pinHash: `scrypt$15$8$1$${"s".repeat(22)}$${"h".repeat(43)}` },
    quietHours: { timeZone: "America/Toronto" },
    voice: { agentPhoneNumberId: "phnum_fake_1", ...voice },
    sms: { provider: "fake" },
    tunnel: { publicUrl: "https://hotline-fake.example.com" },
    secrets: { store: "file" },
  };
  await writePrivateFile(configPath(), JSON.stringify(config, null, 2));
  if (secrets) {
    const store = new FileSecretStore(join(setup.hotlineHome, "secrets.json"));
    await store.set("elevenlabs.apiKey", API_KEY);
    await store.set("elevenlabs.toolSecret", TOOL_SECRET);
  }
}

const readConfig = async () => parseConfigText(await readFile(configPath(), "utf8"));

/** A fake ElevenLabs that hands out sequential ids. */
function fakeElevenLabs() {
  let tools = 0;
  return fakeFetch(
    route("POST", "/v1/convai/secrets", 200, { type: "stored", secret_id: "sec_fake_1", name: "x" }),
    route("PATCH", "/v1/convai/secrets/sec_fake_1", 200, {
      type: "stored",
      secret_id: "sec_fake_1",
      name: "x",
    }),
    route("POST", "/v1/convai/tools", 200, () => ({ id: `tool_fake_${++tools}` })),
    route("PATCH", /^\/v1\/convai\/tools\/tool_fake_\d$/, 200, {}),
    route("POST", "/v1/convai/agents/create", 200, { agent_id: "agent_fake_1" }),
    route("PATCH", "/v1/convai/agents/agent_fake_1", 200, {}),
    route("GET", "/v2/voices?page_size=100", 200, {
      voices: [
        { voice_id: "AbCdEfGh0123456789xy", name: "Calm\u0007 Voice\nwith newline", category: "premade" },
        { voice_id: "MyCl0neId0000000000a", name: "Me", category: "cloned" },
        { voice_id: "bad id with spaces", name: "Broken" },
      ],
      has_more: false,
    }),
  );
}

const paths = (requests: Recorded[]) => requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);

describe("hotline voice apply", () => {
  it("creates the tool secret, four tools and the agent, records their ids, then only updates", async () => {
    await writeSetup();
    const fetch = fakeElevenLabs();
    const first = await cli(["voice", "apply"], testContext(setup, { fetch }));
    expect(first.code).toBe(0);
    expect(paths(fetch.requests)).toEqual([
      "POST /v1/convai/secrets",
      "POST /v1/convai/tools",
      "POST /v1/convai/tools",
      "POST /v1/convai/tools",
      "POST /v1/convai/tools",
      "POST /v1/convai/agents/create",
    ]);
    for (const request of fetch.requests) {
      expect(new URL(request.url).origin).toBe("https://api.elevenlabs.io");
      expect(request.headers["xi-api-key"]).toBe(API_KEY);
    }
    expect(fetch.requests[0]?.body).toEqual({
      type: "new",
      name: "agent-hotline-tool-secret",
      value: TOOL_SECRET,
    });
    const tool = fetch.requests[1]?.body as {
      tool_config: { api_schema: { url: string; request_headers: unknown } };
    };
    expect(tool.tool_config.api_schema.url).toBe(
      "https://hotline-fake.example.com/hooks/el/tools/submit_answer",
    );
    expect(tool.tool_config.api_schema.request_headers).toEqual({
      [TOOL_SECRET_HEADER]: { secret_id: "sec_fake_1" },
    });
    const agent = fetch.requests[5]?.body as {
      tags: string[];
      conversation_config: { agent: { prompt: { tool_ids: string[] } } };
    };
    expect(agent.tags).toContain(`definition-v${AGENT_DEFINITION_VERSION}`);
    expect(agent.conversation_config.agent.prompt.tool_ids).toEqual([
      "tool_fake_1",
      "tool_fake_2",
      "tool_fake_3",
      "tool_fake_4",
    ]);
    const config = await readConfig();
    expect(config.voice.agentId).toBe("agent_fake_1");
    expect(config.voice.toolSecretId).toBe("sec_fake_1");
    expect(config.voice.toolIds).toEqual({
      submit_answer: "tool_fake_1",
      verify_pin: "tool_fake_2",
      get_status: "tool_fake_3",
      send_instruction: "tool_fake_4",
    });
    expect(first.stdout + first.stderr).not.toContain(API_KEY);

    const again = fakeElevenLabs();
    expect((await cli(["voice", "apply"], testContext(setup, { fetch: again }))).code).toBe(0);
    expect(paths(again.requests)).toEqual([
      "PATCH /v1/convai/secrets/sec_fake_1",
      ...[1, 2, 3, 4].map((n) => `PATCH /v1/convai/tools/tool_fake_${n}`),
      "PATCH /v1/convai/agents/agent_fake_1",
    ]);
  });

  it("sends the current local tool secret on every apply, so a changed store keeps answers working", async () => {
    await writeSetup({ toolSecretId: "sec_fake_1" });
    const rotated = "rotated-tool-secret-0123456789abcdefghijklmnopq";
    await new FileSecretStore(join(setup.hotlineHome, "secrets.json")).set("elevenlabs.toolSecret", rotated);
    const fetch = fakeElevenLabs();
    expect((await cli(["voice", "apply"], testContext(setup, { fetch }))).code).toBe(0);
    expect(fetch.requests[0]?.method).toBe("PATCH");
    expect(fetch.requests[0]?.body).toEqual({
      type: "update",
      name: "agent-hotline-tool-secret",
      value: rotated,
    });
    expect(fetch.requests.some((r) => r.method === "POST" && r.url.endsWith("/v1/convai/secrets"))).toBe(
      false,
    );
  });

  it("records ids created before a failure, so a retry does not duplicate them", async () => {
    await writeSetup();
    const failing = fakeFetch(
      route("POST", "/v1/convai/secrets", 200, { secret_id: "sec_fake_1" }),
      route("POST", "/v1/convai/tools", 500, { detail: `echo ${API_KEY}` }),
    );
    const result = await cli(["voice", "apply"], testContext(setup, { fetch: failing }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ElevenLabs could not create a tool (HTTP 500)");
    expect(result.stderr).not.toContain(API_KEY);
    expect((await readConfig()).voice.toolSecretId).toBe("sec_fake_1");
  });

  it("refuses without a public URL or API key, before any request", async () => {
    await writeSetup({}, false);
    const fetch = fakeElevenLabs();
    const result = await cli(["voice", "apply"], testContext(setup, { fetch }));
    expect(result.code).toBe(1);
    expect(fetch.requests).toEqual([]);
  });

  it("needs an injected fetch in test mode", async () => {
    await writeSetup();
    const result = await cli(["voice", "apply"], testContext(setup));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("test mode: no network");
  });
});

describe("hotline voice set", () => {
  it("refuses a malformed voice id before saving or sending anything", async () => {
    await writeSetup();
    const fetch = fakeElevenLabs();
    const before = await readFile(configPath(), "utf8");
    for (const bad of ["has spaces", "x".repeat(101), "{{voice}}", "../../etc"]) {
      const result = await cli(["voice", "set", bad], testContext(setup, { fetch }));
      expect(result.code).toBe(2);
    }
    expect(fetch.requests).toEqual([]);
    expect(await readFile(configPath(), "utf8")).toBe(before);
  });

  it("saves the voice and re-applies the agent with it", async () => {
    await writeSetup({
      agentId: "agent_fake_1",
      toolSecretId: "sec_fake_1",
      toolIds: {
        submit_answer: "tool_fake_1",
        verify_pin: "tool_fake_2",
        get_status: "tool_fake_3",
        send_instruction: "tool_fake_4",
      },
    });
    const fetch = fakeElevenLabs();
    const result = await cli(["voice", "set", "MyCl0neId0000000000a"], testContext(setup, { fetch }));
    expect(result.code).toBe(0);
    expect((await readConfig()).voice.voiceId).toBe("MyCl0neId0000000000a");
    const patch = fetch.requests.find((r) => r.url.endsWith("/v1/convai/agents/agent_fake_1"));
    expect(patch?.method).toBe("PATCH");
    const body = patch?.body as { conversation_config: { tts: unknown } } | undefined;
    expect(body?.conversation_config.tts).toEqual({
      voice_id: "MyCl0neId0000000000a",
    });
    expect(fetch.requests.some((r) => r.method === "POST")).toBe(false);
  });
});

describe("hotline voice set, when the apply fails", () => {
  it("says the voice was saved but not applied, and exits 1", async () => {
    await writeSetup({ agentId: "agent_fake_1", toolSecretId: "sec_fake_1" });
    const fetch = fakeFetch(route("PATCH", "/v1/convai/secrets/sec_fake_1", 401));
    const result = await cli(["voice", "set", "MyCl0neId0000000000a"], testContext(setup, { fetch }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("saved, but not applied");
    expect(result.stderr).toContain("keeps its old voice until hotline voice apply succeeds");
    expect((await readConfig()).voice.voiceId).toBe("MyCl0neId0000000000a");
  });
});

describe("hotline voice list", () => {
  it("lists valid voices as one safe line each and marks the current one", async () => {
    await writeSetup({ voiceId: "MyCl0neId0000000000a" });
    const fetch = fakeElevenLabs();
    const result = await cli(["voice", "list"], testContext(setup, { fetch }));
    expect(result.code).toBe(0);
    expect(result.stdout.split("\n")).toEqual([
      "AbCdEfGh0123456789xy  Calm Voice with newline [premade]",
      "MyCl0neId0000000000a  Me [cloned]  (current)",
    ]);
  });

  it("follows next_page_token and says when the list was cut short", async () => {
    await writeSetup();
    const page = (n: number) => ({
      voices: [{ voice_id: `Voice${String(n).padStart(15, "0")}`, name: `Voice ${n}` }],
      has_more: true,
      next_page_token: `page${n + 1}`,
    });
    const paged = fakeFetch(
      route("GET", "/v2/voices?page_size=100", 200, page(1)),
      route("GET", "/v2/voices?page_size=100&next_page_token=page2", 200, { ...page(2), has_more: false }),
    );
    const two = await cli(["voice", "list"], testContext(setup, { fetch: paged }));
    expect(two.stdout.split("\n")).toEqual([
      "Voice000000000000001  Voice 1",
      "Voice000000000000002  Voice 2",
    ]);

    const endless = fakeFetch(
      route("GET", /^\/v2\/voices\?page_size=100(&next_page_token=page(\d+))?$/, 200, (request: Recorded) => {
        const n = Number(/page(\d+)/.exec(request.url)?.[1] ?? "1");
        return page(n);
      }),
    );
    const cut = await cli(["voice", "list"], testContext(setup, { fetch: endless }));
    expect(endless.requests).toHaveLength(10);
    expect(cut.stdout).toContain("more voices not shown");
  });
});

describe("hotline test-call", () => {
  it("uses the fake provider when voice.provider is fake, and rings nothing", async () => {
    await writeSetup({ provider: "fake" }, false);
    const fetch = fakeFetch();
    const result = await cli(["test-call"], testContext(setup, { fetch }));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no phone will ring");
    expect(result.stdout).toContain("conversation conv_fake_1");
    expect(fetch.requests).toEqual([]);
  });

  it("says it will ring the owner's phone and asks first", async () => {
    await writeSetup({ agentId: "agent_fake_1" });
    const fetch = fakeFetch();
    const declined = await cli(["test-call"], testContext(setup, { fetch, prompt: scriptedPrompter("no") }));
    expect(declined.stdout).toContain("This will ring the owner's phone (…0100)");
    expect(declined.code).toBe(1);
    const noTerminal = await cli(["test-call"], testContext(setup, { fetch }));
    expect(noTerminal.code).toBe(1);
    expect(noTerminal.stderr).toContain("pass --yes");
    expect(fetch.requests).toEqual([]);
  });

  it("places one call to the owner through the injected fetch with --yes", async () => {
    await writeSetup({ agentId: "agent_fake_1" });
    const fetch = fakeFetch(
      route("POST", "/v1/convai/twilio/outbound-call", 200, {
        success: true,
        conversation_id: "conv_test_1",
      }),
    );
    const result = await cli(["test-call", "--yes"], testContext(setup, { fetch }));
    expect(result.code).toBe(0);
    expect(fetch.requests).toHaveLength(1);
    const body = fetch.requests[0]?.body as {
      to_number: string;
      agent_id: string;
      conversation_initiation_client_data: { dynamic_variables: { asks: string } };
    };
    expect(body.to_number).toBe("+15555550100");
    expect(body.agent_id).toBe("agent_fake_1");
    expect(body.conversation_initiation_client_data.dynamic_variables.asks).toContain("This is a test call");
  });

  it("keeps a 2-minute cooldown between real test calls", async () => {
    await writeSetup({ agentId: "agent_fake_1" });
    const fetch = fakeFetch(
      route("POST", "/v1/convai/twilio/outbound-call", 200, {
        success: true,
        conversation_id: "conv_test_1",
      }),
    );
    const at = (time: string) => testContext(setup, { fetch, now: () => new Date(time) });
    expect((await cli(["test-call", "--yes"], at("2026-10-14T12:00:00.000Z"))).code).toBe(0);
    const soon = await cli(["test-call", "--yes"], at("2026-10-14T12:01:00.000Z"));
    expect(soon.code).toBe(1);
    expect(soon.stderr).toContain("try again in 60s");
    expect((await cli(["test-call", "--yes"], at("2026-10-14T12:02:01.000Z"))).code).toBe(0);
    expect(fetch.requests).toHaveLength(2);
  });

  it("fails closed when the cooldown stamp cannot be trusted", async () => {
    await writeSetup({ agentId: "agent_fake_1" });
    const stamp = join(setup.hotlineHome, "test-call.json");
    await writeFile(stamp, '{"at": "2026-10-14T12:00:00.000Z"}', { mode: 0o644 });
    await chmod(stamp, 0o644);
    const fetch = fakeFetch();
    const result = await cli(["test-call", "--yes"], testContext(setup, { fetch }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cannot be trusted or read");
    expect(fetch.requests).toEqual([]);
  });

  it("refuses without a config, an agent or the API key", async () => {
    const fetch = fakeFetch();
    const missing = await cli(["test-call", "--yes"], testContext(setup, { fetch }));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('run "hotline init"');
    await writeSetup();
    const noAgent = await cli(["test-call", "--yes"], testContext(setup, { fetch }));
    expect(noAgent.stderr).toContain("voice.agentId is not set");
    await writeSetup({ agentId: "agent_fake_1" }, false);
    await new FileSecretStore(join(setup.hotlineHome, "secrets.json")).delete("elevenlabs.apiKey");
    const noKey = await cli(["test-call", "--yes"], testContext(setup, { fetch }));
    expect(noKey.stderr).toContain("API key is not in the secret store");
    expect(fetch.requests).toEqual([]);
  });
});
