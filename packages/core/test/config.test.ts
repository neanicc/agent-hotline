import { scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_COST_RATES,
  MAX_PIN_SCRYPT_LOG_N,
  MAX_PIN_SCRYPT_P,
  MAX_PIN_SCRYPT_R,
  MIN_PIN_SCRYPT_LOG_N,
  parseConfig,
  parseConfigText,
  parsePinHash,
  pinScryptMaxmem,
} from "../src/index.js";

const PIN_HASH = `scrypt$15$8$1$${"s".repeat(22)}$${"h".repeat(43)}`;

const minimal = {
  version: 1,
  owner: { phoneNumber: "+15555550100", pinHash: PIN_HASH },
  quietHours: { timeZone: "America/Toronto" },
};

function issuesOf(input: unknown): readonly string[] {
  try {
    parseConfig(input);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error("expected the config to be rejected");
}

describe("parseConfig", () => {
  it("fills every default from a minimal config", () => {
    expect(parseConfig(minimal)).toEqual({
      version: 1,
      owner: { phoneNumber: "+15555550100", pinHash: PIN_HASH },
      quietHours: { start: "22:00", end: "08:00", timeZone: "America/Toronto", allowUrgentCalls: false },
      rateLimits: { callsPerHour: 4, callsPerDay: 20, textsPerHour: 10, textsPerDay: 50 },
      policy: { batchWindowSeconds: 20, askTimeoutMinutes: 30, maxConsecutiveContinuations: 5 },
      voice: { provider: "elevenlabs" },
      sms: { provider: "twilio" },
      tunnel: {},
      daemon: { port: 7341 },
      secrets: { store: "auto" },
      judge: {},
      costs: { ...DEFAULT_COST_RATES },
      nicknames: {},
    });
  });

  it("takes cost rate overrides and refuses negative or non-numeric rates", () => {
    const costs = parseConfig({ ...minimal, costs: { llmPerMinute: 0, elevenLabsPlanPerMonth: 22 } }).costs;
    expect(costs).toEqual({ ...DEFAULT_COST_RATES, llmPerMinute: 0, elevenLabsPlanPerMonth: 22 });
    expect(issuesOf({ ...minimal, costs: { twilioCallPerMinute: -0.01 } })).toEqual([
      expect.stringMatching(/^costs\.twilioCallPerMinute:/),
    ]);
    expect(issuesOf({ ...minimal, costs: { twilioNumberPerMonth: "1.15" } })).toEqual([
      expect.stringMatching(/^costs\.twilioNumberPerMonth:/),
    ]);
    expect(issuesOf({ ...minimal, costs: { textPerSegment: 0.01 } })).toEqual([
      "costs.textPerSegment: unknown setting",
    ]);
  });

  it("keeps explicit settings", () => {
    const config = parseConfig({
      ...minimal,
      quietHours: { start: "23:30", end: "07:15", timeZone: "Europe/Berlin", allowUrgentCalls: true },
      rateLimits: { callsPerHour: 2 },
      voice: { provider: "fake", voiceId: "voice-fake-1" },
      sms: { provider: "fake", fromNumber: "+15555550101" },
      tunnel: { publicUrl: "https://hotline-demo.example.com" },
      secrets: { store: "file" },
      nicknames: { "demo-app": "the demo" },
    });
    expect(config.quietHours.allowUrgentCalls).toBe(true);
    expect(config.rateLimits).toEqual({
      callsPerHour: 2,
      callsPerDay: 20,
      textsPerHour: 10,
      textsPerDay: 50,
    });
    expect(config.voice).toEqual({ provider: "fake", voiceId: "voice-fake-1" });
    expect(config.sms.fromNumber).toBe("+15555550101");
    expect(config.tunnel.publicUrl).toBe("https://hotline-demo.example.com");
    expect(config.nicknames).toEqual({ "demo-app": "the demo" });
  });

  it("keeps the ElevenLabs deployment ids hotline voice apply records", () => {
    const voice = {
      provider: "elevenlabs",
      agentId: "agent_fake_1",
      toolSecretId: "sec_fake_1",
      toolIds: { submit_answer: "tool_fake_1", verify_pin: "tool_fake_2" },
    };
    expect(parseConfig({ ...minimal, voice }).voice).toEqual(voice);
    expect(issuesOf({ ...minimal, voice: { toolIds: { "Not A Name": "x" } } })).toEqual([
      expect.stringMatching(/^voice\.toolIds/),
    ]);
  });

  it("requires the owner number, PIN hash and quiet-hours time zone", () => {
    expect(issuesOf({ version: 1 })).toEqual(
      expect.arrayContaining([expect.stringMatching(/^owner:/), expect.stringMatching(/^quietHours:/)]),
    );
    expect(issuesOf({ ...minimal, owner: { phoneNumber: "+15555550100" } })).toEqual([
      expect.stringMatching(/^owner\.pinHash:/),
    ]);
  });

  it("rejects a number that is not E.164", () => {
    for (const phoneNumber of ["5555550100", "+1 555 555 0100", "+05555550100", ""]) {
      expect(issuesOf({ ...minimal, owner: { ...minimal.owner, phoneNumber } })).toEqual([
        expect.stringMatching(/^owner\.phoneNumber:/),
      ]);
    }
  });

  it("refuses rate limits of zero, so limits cannot be switched off", () => {
    expect(issuesOf({ ...minimal, rateLimits: { callsPerHour: 0 } })).toEqual([
      expect.stringMatching(/^rateLimits\.callsPerHour:/),
    ]);
    expect(issuesOf({ ...minimal, policy: { maxConsecutiveContinuations: 0 } })).toEqual([
      expect.stringMatching(/^policy\.maxConsecutiveContinuations:/),
    ]);
  });

  it("validates quiet hours and the time zone", () => {
    expect(issuesOf({ ...minimal, quietHours: { timeZone: "Mars/Olympus" } })).toEqual([
      expect.stringMatching(/^quietHours\.timeZone:/),
    ]);
    expect(issuesOf({ ...minimal, quietHours: { timeZone: "UTC", start: "24:00" } })).toEqual([
      expect.stringMatching(/^quietHours\.start:/),
    ]);
  });

  it("accepts only a bare https origin as the tunnel URL", () => {
    for (const publicUrl of [
      "http://hotline-demo.example.com",
      "https://hotline-demo.example.com/hooks",
      "https://user:pass@hotline-demo.example.com",
      "https://hotline-demo.example.com/?x=1",
      "not a url",
    ]) {
      expect(issuesOf({ ...minimal, tunnel: { publicUrl } }), publicUrl).toEqual([
        expect.stringMatching(/^tunnel\.publicUrl:/),
      ]);
    }
  });

  it("sends secrets to the secret store and never echoes their values", () => {
    const issues = issuesOf({
      ...minimal,
      twilioAuthToken: "fake-token-value-123",
      voice: { apiKey: "fake-api-key-value-456" },
      colour: "blue",
    });
    expect(issues).toEqual([
      expect.stringMatching(/^voice\.apiKey: looks like a secret/),
      expect.stringMatching(/^twilioAuthToken: looks like a secret/),
      "colour: unknown setting",
    ]);
    expect(issues.join("\n")).not.toMatch(/fake-token-value|fake-api-key-value/);
  });

  it("rejects an unknown version", () => {
    expect(issuesOf({ ...minimal, version: 2 })).toEqual([expect.stringMatching(/^version:/)]);
  });
});

describe("parseConfigText", () => {
  it("parses JSON text", () => {
    expect(parseConfigText(JSON.stringify(minimal)).owner.phoneNumber).toBe("+15555550100");
  });

  it("reports malformed JSON without quoting the file", () => {
    const text = '{"owner": {"phoneNumber": "+15555550100", "pinHash": "scrypt$fake-secret-ish"';
    expect(() => parseConfigText(text)).toThrow(ConfigError);
    try {
      parseConfigText(text);
    } catch (error) {
      expect((error as Error).message).toBe("Hotline config is not valid JSON");
    }
  });
});

describe("PIN hash", () => {
  it("parses the documented format", () => {
    expect(parsePinHash(PIN_HASH)).toEqual({
      logN: 15,
      r: 8,
      p: 1,
      salt: "s".repeat(22),
      hash: "h".repeat(43),
    });
  });

  it("rejects a plain PIN, a short salt or hash, and a weak cost", () => {
    const weak = `scrypt$${MIN_PIN_SCRYPT_LOG_N - 1}$8$1$${"s".repeat(22)}$${"h".repeat(43)}`;
    for (const pinHash of [
      "123456",
      `scrypt$15$8$1$short$${"h".repeat(43)}`,
      `scrypt$15$8$1$${"s".repeat(22)}$x`,
      weak,
    ]) {
      expect(issuesOf({ ...minimal, owner: { ...minimal.owner, pinHash } }), pinHash).toEqual([
        expect.stringMatching(/^owner\.pinHash:/),
      ]);
    }
  });

  const withCost = (logN: number, r: number, p: number) =>
    `scrypt$${logN}$${r}$${p}$${"s".repeat(22)}$${"h".repeat(43)}`;

  it("accepts scrypt costs at both ends of the allowed range", () => {
    expect([MIN_PIN_SCRYPT_LOG_N, MAX_PIN_SCRYPT_LOG_N, MAX_PIN_SCRYPT_R, MAX_PIN_SCRYPT_P]).toEqual([
      15, 20, 16, 4,
    ]);
    for (const [logN, r, p] of [
      [MIN_PIN_SCRYPT_LOG_N, 1, 1],
      [MAX_PIN_SCRYPT_LOG_N, MAX_PIN_SCRYPT_R, MAX_PIN_SCRYPT_P],
    ] as const) {
      const pinHash = withCost(logN, r, p);
      expect(parsePinHash(pinHash), pinHash).toMatchObject({ logN, r, p });
      expect(parseConfig({ ...minimal, owner: { ...minimal.owner, pinHash } }).owner.pinHash).toBe(pinHash);
    }
  });

  it("rejects scrypt costs just outside the allowed range, so a config cannot hang the PIN check", () => {
    for (const pinHash of [
      withCost(MIN_PIN_SCRYPT_LOG_N - 1, 8, 1),
      withCost(MAX_PIN_SCRYPT_LOG_N + 1, 8, 1),
      withCost(40, 99, 99),
      withCost(15, 0, 1),
      withCost(15, MAX_PIN_SCRYPT_R + 1, 1),
      withCost(15, 8, 0),
      withCost(15, 8, MAX_PIN_SCRYPT_P + 1),
    ]) {
      expect(parsePinHash(pinHash), pinHash).toBeUndefined();
      expect(issuesOf({ ...minimal, owner: { ...minimal.owner, pinHash } }), pinHash).toEqual([
        expect.stringMatching(/^owner\.pinHash: .*log2 N <= 20, 1 <= r <= 16 and 1 <= p <= 4/),
      ]);
    }
  });

  it("states the maxmem Node's scrypt needs for a PIN hash's cost", () => {
    const params = { logN: MIN_PIN_SCRYPT_LOG_N, r: 8, p: 1 };
    const maxmem = pinScryptMaxmem(params);
    expect(maxmem).toBe(128 * 8 * (2 ** 15 + 3));
    expect(pinScryptMaxmem({ logN: MAX_PIN_SCRYPT_LOG_N, r: MAX_PIN_SCRYPT_R, p: MAX_PIN_SCRYPT_P })).toBe(
      128 * 16 * (2 ** 20 + 6),
    );
    // Exactly enough succeeds and one byte less fails, so the formula matches Node's check.
    const options = { N: 2 ** params.logN, r: params.r, p: params.p };
    expect(scryptSync("000000", "fake-salt-0123456", 32, { ...options, maxmem }).length).toBe(32);
    expect(() => scryptSync("000000", "fake-salt-0123456", 32, { ...options, maxmem: maxmem - 1 })).toThrow(
      /memory/i,
    );
  });
});
