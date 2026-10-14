// `hotline init`: creates the hotline home (0700) and config (0600) and puts the
// provider credentials in the secret store. Settings come from flags or prompts;
// the PIN and credentials come from prompts (no echo) or environment variables,
// never from flags, because a process's arguments are visible to other users.
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { parseConfig, type SecretName, SecretStoreChoice } from "@hotline/core";
import type { CliContext, Output } from "./cli.js";
import { lastFour, secretStoreFor, section } from "./setup.js";

/** Environment variables `init` reads secrets from, for scripted setup. */
export const SECRET_ENV: ReadonlyArray<readonly [SecretName, string, string]> = [
  ["elevenlabs.apiKey", "HOTLINE_ELEVENLABS_API_KEY", "ElevenLabs API key"],
  ["elevenlabs.webhookSecret", "HOTLINE_ELEVENLABS_WEBHOOK_SECRET", "ElevenLabs post-call webhook secret"],
  ["twilio.accountSid", "HOTLINE_TWILIO_ACCOUNT_SID", "Twilio account SID"],
  ["twilio.authToken", "HOTLINE_TWILIO_AUTH_TOKEN", "Twilio auth token"],
];
export const PIN_ENV = "HOTLINE_PIN";
/** Shortest PIN `init` accepts without a warning. */
export const RECOMMENDED_PIN_DIGITS = 6;

export function initUsage(): string {
  return [
    "Usage: hotline init [options]",
    "",
    "Creates the hotline home ($HOTLINE_HOME, else ~/.hotline; mode 0700) with",
    "config.json (0600), and stores credentials in the secret store (the macOS",
    "Keychain, else a 0600 secrets file). Asks for anything not given.",
    "",
    "Options:",
    "  --owner <+15555550100>        Your phone number: the only one Hotline calls, texts or answers",
    "  --time-zone <zone>            IANA time zone for quiet hours (default: this Mac's)",
    "  --public-url <https://...>    The tunnel's public origin (for webhooks)",
    "  --sms-from <+1...>            The Twilio number texts come from",
    "  --agent-phone-number-id <id>  The Twilio number's id in ElevenLabs (Phone Numbers)",
    "  --voice-provider <elevenlabs|fake>   --sms-provider <twilio|fake>",
    "  --secret-store <auto|keychain|file>",
    "  --force                       Replace the settings of an existing config",
    "  --non-interactive             Never ask; fail if something required is missing",
    "",
    `The PIN (4 to 8 digits; ${RECOMMENDED_PIN_DIGITS} or more recommended) and credentials are asked`,
    `without echo, or read from ${PIN_ENV}, ${SECRET_ENV.map(([, env]) => env).join(", ")}.`,
    "Never pass them as arguments. Next: hotline voice apply, hotline install, hotline doctor.",
  ].join("\n");
}

const FLAGS = {
  "--owner": "owner",
  "--time-zone": "timeZone",
  "--public-url": "publicUrl",
  "--sms-from": "smsFrom",
  "--agent-phone-number-id": "agentPhoneNumberId",
  "--voice-provider": "voiceProvider",
  "--sms-provider": "smsProvider",
  "--secret-store": "secretStore",
} as const;
type Flag = (typeof FLAGS)[keyof typeof FLAGS];

class InitError extends Error {}

/** `secrets.store` of a config's text as written, defaulting to auto. */
function storeChoiceOf(text: string): string {
  try {
    const store = (JSON.parse(text) as { secrets?: { store?: unknown } }).secrets?.store;
    return typeof store === "string" ? store : "auto";
  } catch {
    return "auto";
  }
}

export async function initCommand(
  args: readonly string[],
  out: Output,
  context: CliContext,
): Promise<number> {
  const flags: Partial<Record<Flag, string>> = {};
  let force = false;
  let interactive = context.prompt !== undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--help" || arg === "-h") {
      out.stdout(initUsage());
      return 0;
    }
    if (arg === "--force") force = true;
    else if (arg === "--non-interactive") interactive = false;
    else if (arg in FLAGS) {
      const value = args[++index];
      if (value === undefined || value === "") {
        out.stderr(`hotline init: ${arg} needs a value\n\n${initUsage()}`);
        return 2;
      }
      flags[FLAGS[arg as keyof typeof FLAGS]] = value;
    } else {
      out.stderr(`hotline init: unknown option "${arg}"\n\n${initUsage()}`);
      return 2;
    }
  }
  const prompt = interactive ? context.prompt : undefined;
  const ask = async (question: string, secret = false): Promise<string | undefined> =>
    prompt === undefined ? undefined : (await prompt.ask(question, { secret })) || undefined;

  const { hashPin, hotlinePaths, PIN_PATTERN, privateDirectoryProblem, writePrivateFile } = await import(
    "@hotline/daemon"
  );
  try {
    const paths = hotlinePaths({ env: context.env, homeDir: context.homeDir });

    // Start from the existing config with --force, so settings init does not ask about survive.
    let raw: Record<string, unknown> = {};
    const existing = await readFile(paths.config, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing !== undefined) {
      if (!force) throw new InitError(`${paths.config} already exists; pass --force to replace its settings`);
      // Never drop a config silently: it holds the ElevenLabs ids, and losing them
      // would orphan the deployed agent and tools.
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing);
      } catch {
        parsed = undefined;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new InitError(
          `${paths.config} is not a JSON object; fix it, or move it aside to start over (note its voice ids first)`,
        );
      }
      raw = parsed as Record<string, unknown>;
    }
    const owner = section(raw, "owner");
    const quietHours = section(raw, "quietHours");

    const phone =
      flags.owner ??
      (await ask("Your phone number, with country code (+15555550100): ")) ??
      owner.phoneNumber;
    if (typeof phone !== "string") throw new InitError("the owner's phone number is required (--owner)");
    owner.phoneNumber = phone;

    const zone = flags.timeZone ?? quietHours.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    quietHours.timeZone = zone;

    const pin = (context.env[PIN_ENV] || undefined) ?? (await ask("Choose a PIN (4 to 8 digits): ", true));
    if (pin === undefined) {
      if (typeof owner.pinHash !== "string") throw new InitError(`a PIN is required (prompt or ${PIN_ENV})`);
    } else {
      if (!PIN_PATTERN.test(pin)) throw new InitError("the PIN must be 4 to 8 digits");
      if (!context.env[PIN_ENV] && (await ask("Type the PIN again: ", true)) !== pin) {
        throw new InitError("the two PINs differ; nothing was changed");
      }
      if (pin.length < RECOMMENDED_PIN_DIGITS) {
        out.stderr(
          `hotline init: warning: a ${RECOMMENDED_PIN_DIGITS}-digit or longer PIN is recommended; caller ID can be spoofed and the PIN is what stops it`,
        );
      }
      owner.pinHash = await hashPin(pin);
    }

    const voice = section(raw, "voice");
    const sms = section(raw, "sms");
    if (flags.voiceProvider !== undefined) voice.provider = flags.voiceProvider;
    if (flags.smsProvider !== undefined) sms.provider = flags.smsProvider;
    if (flags.agentPhoneNumberId !== undefined) voice.agentPhoneNumberId = flags.agentPhoneNumberId;
    if (flags.smsFrom !== undefined) sms.fromNumber = flags.smsFrom;
    if (flags.publicUrl !== undefined) section(raw, "tunnel").publicUrl = flags.publicUrl;
    if (flags.secretStore !== undefined) {
      if (!SecretStoreChoice.safeParse(flags.secretStore).success) {
        throw new InitError("--secret-store must be auto, keychain or file");
      }
      section(raw, "secrets").store = flags.secretStore;
    }
    raw.version = 1;
    // Validate everything before touching the disk.
    const config = parseConfig(raw);
    const previousStore = existing === undefined ? undefined : storeChoiceOf(existing);

    await mkdir(paths.home, { recursive: true, mode: 0o700 });
    const homeInfo = await lstat(paths.home);
    if (homeInfo.isSymbolicLink() || !homeInfo.isDirectory()) {
      throw new InitError(`${paths.home} is not a real directory`);
    }
    if (privateDirectoryProblem(homeInfo) !== undefined) {
      await chmod(paths.home, 0o700);
      const problem = privateDirectoryProblem(await lstat(paths.home));
      if (problem !== undefined) throw new InitError(`${paths.home} ${problem}`);
      out.stdout(`made ${paths.home} private (mode 700)`);
    }

    // Secrets before the config: if the store fails, nothing points at a half setup.
    const secrets = await secretStoreFor(context, config.secrets.store, paths);
    const stored: string[] = [];
    const missing: string[] = [];
    for (const [name, env, label] of SECRET_ENV) {
      const value = (context.env[env] || undefined) ?? (await ask(`${label} (Enter to skip): `, true));
      if (value !== undefined) {
        await secrets.set(name, value);
        stored.push(label);
      } else if ((await secrets.get(name)) === undefined) {
        missing.push(label);
      }
    }
    if ((await secrets.get("elevenlabs.toolSecret")) === undefined) {
      // Shared by the ElevenLabs tools and the daemon; `hotline voice apply` uploads it.
      await secrets.set("elevenlabs.toolSecret", randomBytes(32).toString("base64url"));
      stored.push("ElevenLabs tool secret (generated)");
      // The deployed tools still send the old one: every answer would fail closed.
      if (config.voice.toolSecretId !== undefined) {
        out.stdout("A new tool secret was generated: run hotline voice apply so ElevenLabs sends it.");
      }
    }
    await writePrivateFile(paths.config, `${JSON.stringify(raw, null, 2)}\n`);

    out.stdout(`wrote ${paths.config} (owner ${lastFour(config.owner.phoneNumber)}, quiet hours in ${zone})`);
    out.stdout(`secret store: ${secrets.kind}`);
    if (previousStore !== undefined && previousStore !== config.secrets.store) {
      out.stdout(
        `note: the old ${previousStore} store still holds Hotline's earlier secrets; remove them there if you no longer use it`,
      );
    }
    for (const label of stored) out.stdout(`stored: ${label}`);
    for (const label of missing) out.stdout(`not set: ${label} (run hotline init --force again to add it)`);
    out.stdout(
      [
        "Next:",
        "  hotline voice apply            create the ElevenLabs agent and tools",
        "  hotline install claude|codex   add the MCP server and hooks",
        "  hotline daemon                 start the daemon",
        "  hotline doctor                 check everything",
      ].join("\n"),
    );
    return 0;
  } catch (error) {
    // Config errors list setting paths, never values; nothing else here quotes a secret.
    out.stderr(`hotline init: ${(error as Error).message}`);
    return 1;
  }
}
