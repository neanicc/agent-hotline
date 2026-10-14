// `hotline init` with a temporary HOTLINE_HOME, the file secret store or a fake
// `security` for the Keychain. Never the real ~/.hotline or Keychain.
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfigText } from "@hotline/core";
import { FileSecretStore, verifyPin } from "@hotline/daemon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cli,
  fakeSecurity,
  scriptedPrompter,
  type TempSetup,
  tempSetup,
  testContext,
} from "./setup-helpers.js";

let setup: TempSetup;
beforeEach(async () => {
  setup = await tempSetup();
});
afterEach(() => setup.cleanup());

const SECRETS = {
  HOTLINE_PIN: "482913",
  HOTLINE_ELEVENLABS_API_KEY: "sk_fake_elevenlabs_key_0001",
  HOTLINE_ELEVENLABS_WEBHOOK_SECRET: "wsec_fake_0001",
  HOTLINE_TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`,
  HOTLINE_TWILIO_AUTH_TOKEN: "fake_twilio_token_0001",
};
const FLAGS = [
  "--non-interactive",
  "--owner",
  "+15555550100",
  "--time-zone",
  "America/Toronto",
  "--public-url",
  "https://hotline-fake.example.com",
  "--sms-from",
  "+15555550101",
  "--agent-phone-number-id",
  "phnum_fake_1",
  "--secret-store",
  "file",
];

function env(extra: Record<string, string> = {}) {
  return { HOTLINE_HOME: setup.hotlineHome, ...extra };
}

const mode = async (path: string) => (await lstat(path)).mode & 0o777;

describe("hotline init", () => {
  it("creates a 0700 home and 0600 config, hashes the PIN and stores credentials", async () => {
    const result = await cli(["init", ...FLAGS], testContext(setup, { env: env(SECRETS) }));
    expect(result.code).toBe(0);
    expect(await mode(setup.hotlineHome)).toBe(0o700);
    const configPath = join(setup.hotlineHome, "config.json");
    expect(await mode(configPath)).toBe(0o600);
    const text = await readFile(configPath, "utf8");
    const config = parseConfigText(text);
    expect(config.owner.phoneNumber).toBe("+15555550100");
    expect(config.quietHours.timeZone).toBe("America/Toronto");
    expect(config.tunnel.publicUrl).toBe("https://hotline-fake.example.com");
    expect(config.voice.agentPhoneNumberId).toBe("phnum_fake_1");
    expect(text).not.toContain("482913");
    expect(await verifyPin("482913", config.owner.pinHash)).toBe(true);

    const store = new FileSecretStore(join(setup.hotlineHome, "secrets.json"));
    expect(await mode(join(setup.hotlineHome, "secrets.json"))).toBe(0o600);
    expect(await store.get("elevenlabs.apiKey")).toBe(SECRETS.HOTLINE_ELEVENLABS_API_KEY);
    expect(await store.get("twilio.authToken")).toBe(SECRETS.HOTLINE_TWILIO_AUTH_TOKEN);
    expect((await store.get("elevenlabs.toolSecret"))?.length).toBeGreaterThanOrEqual(43);
    // Output names what was stored, never a value, and shows the number's last four only.
    for (const value of Object.values(SECRETS)) expect(result.stdout + result.stderr).not.toContain(value);
    expect(result.stdout).not.toContain("+15555550100");
    expect(result.stdout).toContain("…0100");
  });

  it("explains the reply judge, and stores an Anthropic API key only from its variable (HL-09d)", async () => {
    const plain = await cli(["init", ...FLAGS], testContext(setup, { env: env(SECRETS) }));
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain("Reply judge:");
    expect(plain.stdout).toContain("your own Claude Code login");
    expect(plain.stdout).toContain("Only your short spoken reply is sent");
    expect(plain.stdout).toContain('"yes if the tests pass"');
    const store = new FileSecretStore(join(setup.hotlineHome, "secrets.json"));
    expect(await store.get("anthropic.apiKey")).toBeUndefined();

    const key = "sk-ant-fake-judge-key-0001";
    const prompter = scriptedPrompter();
    const withKey = await cli(
      ["init", ...FLAGS, "--force"],
      testContext(setup, { env: env({ ...SECRETS, HOTLINE_ANTHROPIC_API_KEY: key }), prompt: prompter }),
    );
    expect(withKey.code).toBe(0);
    expect(await store.get("anthropic.apiKey")).toBe(key);
    expect(withKey.stdout).toContain("stored: Anthropic API key (reply judge)");
    expect(withKey.stdout + withKey.stderr).not.toContain(key);
    // Never asked for: the owner's agent login comes first.
    expect(prompter.questions.join("\n")).not.toMatch(/anthropic/i);
  });

  describe("the reply judge choice (HL-09d)", () => {
    const interactiveFlags = FLAGS.filter((flag) => flag !== "--non-interactive");
    const configPath = () => join(setup.hotlineHome, "config.json");
    const recorded = async () => parseConfigText(await readFile(configPath(), "utf8")).judge.backend;

    it("records no choice without --judge when it cannot ask, so nothing is sent", async () => {
      const result = await cli(["init", ...FLAGS], testContext(setup, { env: env(SECRETS) }));
      expect(result.code).toBe(0);
      expect(await recorded()).toBeUndefined();
      expect(result.stdout).toContain("reply judge: not chosen, so nothing is sent");
    });

    it("takes --judge, and refuses a value that is not a backend", async () => {
      const chosen = await cli(
        ["init", ...FLAGS, "--judge", "codex"],
        testContext(setup, { env: env(SECRETS) }),
      );
      expect(chosen.code).toBe(0);
      expect(await recorded()).toBe("codex");
      expect(chosen.stdout).toContain("reply judge: codex");
      const bad = await cli(
        ["init", ...FLAGS, "--force", "--judge", "always"],
        testContext(setup, { env: env(SECRETS) }),
      );
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain("--judge must be one of auto, claude-code, codex, anthropic-api, off");
      expect(await recorded()).toBe("codex");
    });

    it("asks once, after explaining what is sent: Enter or yes is auto, no is off", async () => {
      for (const [answer, choice] of [
        ["", "auto"],
        ["Yes", "auto"],
        ["n", "off"],
      ] as const) {
        const prompt = scriptedPrompter(answer);
        const result = await cli(
          ["init", ...interactiveFlags, "--force"],
          testContext(setup, { env: env(SECRETS), prompt }),
        );
        expect(result.code).toBe(0);
        expect(prompt.questions).toEqual([expect.stringContaining("Use the reply judge")]);
        expect(prompt.questions[0]).toContain("only your short spoken reply");
        expect(result.stdout.indexOf("Reply judge:")).toBeGreaterThanOrEqual(0);
        expect(await recorded()).toBe(choice);
      }
    });

    it("keeps an earlier off on Enter, showing [y/N]: a refusal never turns into sending", async () => {
      expect(
        (await cli(["init", ...FLAGS, "--judge", "off"], testContext(setup, { env: env(SECRETS) }))).code,
      ).toBe(0);
      const prompt = scriptedPrompter("");
      const kept = await cli(
        ["init", ...interactiveFlags, "--force"],
        testContext(setup, { env: env(SECRETS), prompt }),
      );
      expect(kept.code).toBe(0);
      expect(prompt.questions).toEqual([expect.stringMatching(/\[y\/N\]: $/)]);
      expect(await recorded()).toBe("off");
      // Only an explicit yes turns it back on.
      const yes = scriptedPrompter("y");
      expect(
        (
          await cli(
            ["init", ...interactiveFlags, "--force"],
            testContext(setup, { env: env(SECRETS), prompt: yes }),
          )
        ).code,
      ).toBe(0);
      expect(await recorded()).toBe("auto");
      const again = scriptedPrompter("");
      await cli(
        ["init", ...interactiveFlags, "--force"],
        testContext(setup, { env: env(SECRETS), prompt: again }),
      );
      expect(again.questions).toEqual([expect.stringMatching(/\[Y\/n\]: $/)]);
      expect(await recorded()).toBe("auto");
    });

    it("keeps a backend chosen earlier on Enter, and gives up on an answer that is neither", async () => {
      expect(
        (await cli(["init", ...FLAGS, "--judge", "codex"], testContext(setup, { env: env(SECRETS) }))).code,
      ).toBe(0);
      const kept = await cli(
        ["init", ...interactiveFlags, "--force"],
        testContext(setup, { env: env(SECRETS), prompt: scriptedPrompter("") }),
      );
      expect(kept.code).toBe(0);
      expect(await recorded()).toBe("codex");

      const before = await readFile(configPath(), "utf8");
      const prompt = scriptedPrompter("maybe", "sure thing", "hmm");
      const unclear = await cli(
        ["init", ...interactiveFlags, "--force"],
        testContext(setup, { env: env(SECRETS), prompt }),
      );
      expect(unclear.code).toBe(1);
      expect(prompt.questions).toHaveLength(3);
      expect(unclear.stderr).toContain("answer y or n for the reply judge; nothing was changed");
      expect(await readFile(configPath(), "utf8")).toBe(before);
    });
  });

  it("uses the Keychain through an injected security, never the real one", async () => {
    const security = fakeSecurity();
    const flags = FLAGS.filter((flag) => flag !== "file" && flag !== "--secret-store");
    const result = await cli(
      ["init", ...flags],
      testContext(setup, { env: env(SECRETS), platform: "darwin", exec: security }),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("secret store: keychain");
    expect(security.items.get("elevenlabs.apiKey")).toBe(SECRETS.HOTLINE_ELEVENLABS_API_KEY);
    // Values travel on stdin as hex, never in the arguments.
    for (const call of security.calls)
      expect(call.join(" ")).not.toContain(SECRETS.HOTLINE_TWILIO_AUTH_TOKEN);
  });

  it("refuses the Keychain in test mode without an injected exec", async () => {
    const flags = FLAGS.filter((flag) => flag !== "file" && flag !== "--secret-store");
    const result = await cli(
      ["init", ...flags],
      testContext(setup, { env: env(SECRETS), platform: "darwin" }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("needs an injected exec");
    await expect(lstat(join(setup.hotlineHome, "config.json"))).rejects.toThrow();
  });

  it("asks for what is missing, with hidden input for the PIN and secrets", async () => {
    const prompt = scriptedPrompter("+15555550100", "123456", "123456", "", "", "", "");
    const result = await cli(
      ["init", "--secret-store", "file", "--voice-provider", "fake", "--sms-provider", "fake"],
      testContext(setup, { env: env(), prompt }),
    );
    expect(result.code).toBe(0);
    expect(prompt.questions[0]).toContain("phone number");
    expect(prompt.questions[1]).toContain("PIN");
    expect(result.stdout).toContain("not set: ElevenLabs API key");
  });

  it("warns about a PIN shorter than 6 digits and refuses a malformed or mismatched one", async () => {
    const short = await cli(
      ["init", ...FLAGS],
      testContext(setup, { env: env({ ...SECRETS, HOTLINE_PIN: "4829" }) }),
    );
    expect(short.code).toBe(0);
    expect(short.stderr).toContain("6-digit or longer PIN is recommended");

    const bad = await cli(
      ["init", ...FLAGS, "--force"],
      testContext(setup, { env: env({ ...SECRETS, HOTLINE_PIN: "12ab" }) }),
    );
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("4 to 8 digits");

    const mismatch = await cli(
      ["init", "--force", "--secret-store", "file"],
      testContext(setup, { env: env(), prompt: scriptedPrompter("", "111111", "222222") }),
    );
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain("the two PINs differ");
  });

  it("fails without a PIN or owner when it cannot ask", async () => {
    const noPin = await cli(["init", ...FLAGS], testContext(setup, { env: env() }));
    expect(noPin.code).toBe(1);
    expect(noPin.stderr).toContain("a PIN is required");
    const noOwner = await cli(["init", "--non-interactive"], testContext(setup, { env: env(SECRETS) }));
    expect(noOwner.stderr).toContain("phone number is required");
  });

  it("keeps an existing config unless --force, and --force keeps settings it does not ask about", async () => {
    expect((await cli(["init", ...FLAGS], testContext(setup, { env: env(SECRETS) }))).code).toBe(0);
    const configPath = join(setup.hotlineHome, "config.json");
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    raw.nicknames = { "demo-app": "the demo" };
    await writeFile(configPath, JSON.stringify(raw));

    const again = await cli(["init", ...FLAGS], testContext(setup, { env: env(SECRETS) }));
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("pass --force");

    const forced = await cli(
      ["init", "--non-interactive", "--force", "--owner", "+15555550102"],
      testContext(setup, { env: env() }),
    );
    expect(forced.code).toBe(0);
    const config = parseConfigText(await readFile(configPath, "utf8"));
    expect(config.owner.phoneNumber).toBe("+15555550102");
    expect(config.nicknames).toEqual({ "demo-app": "the demo" });
    // The earlier PIN hash is kept when no new PIN is given.
    expect(await verifyPin("482913", config.owner.pinHash)).toBe(true);
  });

  it("refuses --force over a config it cannot read, rather than dropping its ids", async () => {
    await mkdir(setup.hotlineHome, { mode: 0o700 });
    const configPath = join(setup.hotlineHome, "config.json");
    await writeFile(configPath, '{"voice": {"agentId": "agent_fake_1"', { mode: 0o600 });
    const result = await cli(["init", ...FLAGS, "--force"], testContext(setup, { env: env(SECRETS) }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is not a JSON object; fix it, or move it aside");
    expect(await readFile(configPath, "utf8")).toBe('{"voice": {"agentId": "agent_fake_1"');
  });

  it("names the old store when --force switches secret stores", async () => {
    const flags = FLAGS.filter((flag) => flag !== "file" && flag !== "--secret-store");
    const security = fakeSecurity();
    const first = await cli(
      ["init", ...flags, "--secret-store", "keychain"],
      testContext(setup, { env: env(SECRETS), platform: "darwin", exec: security }),
    );
    expect(first.code).toBe(0);
    const switched = await cli(
      ["init", "--non-interactive", "--force", "--secret-store", "file"],
      testContext(setup, { env: env(SECRETS) }),
    );
    expect(switched.code).toBe(0);
    expect(switched.stdout).toContain("the old keychain store still holds Hotline's earlier secrets");
  });

  it("asks for hotline voice apply when it generates a tool secret for a deployed agent", async () => {
    expect((await cli(["init", ...FLAGS], testContext(setup, { env: env(SECRETS) }))).code).toBe(0);
    const configPath = join(setup.hotlineHome, "config.json");
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    raw.voice.toolSecretId = "sec_fake_1";
    await writeFile(configPath, JSON.stringify(raw));
    await new FileSecretStore(join(setup.hotlineHome, "secrets.json")).delete("elevenlabs.toolSecret");
    const again = await cli(["init", "--non-interactive", "--force"], testContext(setup, { env: env() }));
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("A new tool secret was generated: run hotline voice apply");
  });

  it("validates settings before writing anything", async () => {
    const result = await cli(
      ["init", ...FLAGS.map((flag) => (flag === "+15555550100" ? "5555550100" : flag))],
      testContext(setup, { env: env(SECRETS) }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("owner.phoneNumber");
    await expect(lstat(setup.hotlineHome)).rejects.toThrow();
  });

  it("makes an existing home private", async () => {
    await mkdir(setup.hotlineHome, { mode: 0o755 });
    const result = await cli(["init", ...FLAGS], testContext(setup, { env: env(SECRETS) }));
    expect(result.code).toBe(0);
    expect(await mode(setup.hotlineHome)).toBe(0o700);
  });
});
