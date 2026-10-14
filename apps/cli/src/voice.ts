// `hotline voice list|set|apply` and `hotline test-call`. Every ElevenLabs request
// goes through the injected `fetch`; tests pass a fake and never reach the network.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "@hotline/core";
import type { VoiceProvider } from "@hotline/providers";
import type { CliContext, Output } from "./cli.js";
import { deployAgent, ElevenLabsAdmin } from "./elevenlabs-admin.js";
import { fetchFor, lastFour, secretStoreFor, section, updateConfigFile } from "./setup.js";

export function voiceUsage(): string {
  return [
    "Usage: hotline voice <list|set|apply>",
    "",
    "  list             Voices in your ElevenLabs account (library voices you saved and clones)",
    "  set <voice id>   Use this voice: saves voice.voiceId and re-applies the agent",
    "  apply            Create or update the ElevenLabs agent, its four server tools and",
    "                   the tool secret from this version's definition",
    "",
    "See docs/voice.md for choosing or cloning a voice.",
  ].join("\n");
}

export function testCallUsage(): string {
  return [
    "Usage: hotline test-call [--yes]",
    "",
    "Rings the owner's phone once through the configured voice provider, with a short",
    "test message that needs no answer. It asks before ringing unless --yes is given.",
    "With voice.provider set to fake, nothing rings: the fake provider records the call.",
  ].join("\n");
}

class SetupError extends Error {}

async function loadSetup(context: CliContext) {
  const { hotlinePaths, loadConfig } = await import("@hotline/daemon");
  const paths = hotlinePaths({ env: context.env, homeDir: context.homeDir });
  const config = await loadConfig(paths.config);
  const secrets = await secretStoreFor(context, config.secrets.store, paths);
  return { paths, config, secrets };
}

async function admin(context: CliContext, apiKey: string | undefined): Promise<ElevenLabsAdmin> {
  if (apiKey === undefined) {
    throw new SetupError("the ElevenLabs API key is not in the secret store; run hotline init --force");
  }
  return new ElevenLabsAdmin(apiKey, fetchFor(context));
}

/** Creates or updates the ElevenLabs agent and records its ids in the config. */
async function apply(context: CliContext, out: Output, configPath: string, config: Config, apiKey?: string) {
  if (config.voice.provider !== "elevenlabs") {
    throw new SetupError("voice.provider is fake; there is no ElevenLabs agent to apply");
  }
  const publicUrl = config.tunnel.publicUrl;
  if (publicUrl === undefined) {
    throw new SetupError(
      "tunnel.publicUrl is not set; the tools need it (hotline init --force --public-url)",
    );
  }
  const { secrets } = await loadSetup(context);
  const toolSecret = await secrets.get("elevenlabs.toolSecret");
  if (toolSecret === undefined) throw new SetupError("the tool secret is missing; run hotline init --force");
  const client = await admin(context, apiKey ?? (await secrets.get("elevenlabs.apiKey")));
  const agentId = await deployAgent({
    admin: client,
    publicUrl,
    toolSecret,
    ...(config.voice.voiceId === undefined ? {} : { voiceId: config.voice.voiceId }),
    ...(config.voice.llm === undefined ? {} : { llm: config.voice.llm }),
    ...(config.voice.agentId === undefined ? {} : { agentId: config.voice.agentId }),
    ...(config.voice.toolSecretId === undefined ? {} : { toolSecretId: config.voice.toolSecretId }),
    ...(config.voice.toolIds === undefined ? {} : { toolIds: config.voice.toolIds }),
    save: async (ids) => {
      await updateConfigFile(configPath, (raw) => Object.assign(section(raw, "voice"), ids));
    },
    log: (line) => out.stdout(line),
  });
  out.stdout(`ElevenLabs agent ${agentId} is up to date; hotline doctor checks it`);
}

export async function voiceCommand(
  args: readonly string[],
  out: Output,
  context: CliContext,
): Promise<number> {
  const [action, ...rest] = args;
  if (action === undefined) {
    out.stderr(voiceUsage());
    return 2;
  }
  if (action === "--help" || action === "-h") {
    out.stdout(voiceUsage());
    return 0;
  }
  const { isVoiceId } = await import("@hotline/providers");
  try {
    if (action === "set") {
      const [voiceId, ...extra] = rest;
      if (voiceId === undefined || extra.length > 0) {
        out.stderr(`hotline voice set: give one voice id\n\n${voiceUsage()}`);
        return 2;
      }
      // Checked before anything is saved or sent.
      if (!isVoiceId(voiceId)) {
        out.stderr("hotline voice set: that is not a voice id; copy it with Copy voice ID in My Voices");
        return 2;
      }
      const { paths } = await loadSetup(context);
      const config = await updateConfigFile(paths.config, (raw) => {
        section(raw, "voice").voiceId = voiceId;
      });
      out.stdout(`voice.voiceId is now ${voiceId}`);
      if (config.voice.provider !== "elevenlabs") return 0;
      if (config.tunnel.publicUrl === undefined) {
        out.stdout("Not applied yet: set tunnel.publicUrl, then run hotline voice apply");
        return 0;
      }
      try {
        await apply(context, out, paths.config, config);
      } catch (error) {
        // Say plainly that the phone still uses the old voice.
        out.stderr(
          `hotline voice set: saved, but not applied: ${(error as Error).message}. The agent keeps its old voice until hotline voice apply succeeds.`,
        );
        return 1;
      }
      return 0;
    }
    if (rest.length > 0) {
      out.stderr(`hotline voice ${action}: unexpected "${rest[0]}"\n\n${voiceUsage()}`);
      return 2;
    }
    if (action === "apply") {
      const { paths, config } = await loadSetup(context);
      await apply(context, out, paths.config, config);
      return 0;
    }
    if (action === "list") {
      const { config, secrets } = await loadSetup(context);
      const client = await admin(context, await secrets.get("elevenlabs.apiKey"));
      const { voices, complete } = await client.listVoices();
      if (voices.length === 0) out.stdout("No voices found in your ElevenLabs account.");
      for (const voice of voices) {
        const current = voice.voiceId === config.voice.voiceId ? "  (current)" : "";
        out.stdout(
          `${voice.voiceId}  ${voice.name}${voice.category ? ` [${voice.category}]` : ""}${current}`,
        );
      }
      if (!complete) out.stdout("(more voices not shown; find the rest in My Voices in the ElevenLabs app)");
      return 0;
    }
    out.stderr(`hotline voice: unknown action "${action}"\n\n${voiceUsage()}`);
    return 2;
  } catch (error) {
    out.stderr(`hotline voice ${action}: ${(error as Error).message}`);
    return 1;
  }
}

/** Shortest time between two real test calls. */
export const TEST_CALL_COOLDOWN_MS = 2 * 60 * 1000;

/**
 * When the last real test call was placed (ms), or undefined when none was. A
 * stamp that exists but cannot be trusted or read refuses the call (fails closed).
 */
async function lastTestCall(path: string): Promise<number | undefined> {
  const { privatePathProblem } = await import("@hotline/daemon");
  const problem = await privatePathProblem(path);
  if (problem === "missing") return undefined;
  const unusable = new SetupError(`${path} cannot be trusted or read; remove it to place a test call`);
  if (problem !== undefined) throw unusable;
  let at: unknown;
  try {
    at = (JSON.parse(await readFile(path, "utf8")) as { at?: unknown }).at;
  } catch {
    throw unusable;
  }
  const time = typeof at === "string" ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(time)) throw unusable;
  return time;
}

/** The one ask a test call reads out. Fixed words only. */
const TEST_ASK = {
  askId: "test-call",
  kind: "notify" as const,
  nickname: "Agent Hotline",
  text: "This is a test call from Agent Hotline. Nothing needs an answer; you can hang up.",
  options: [],
  risk: "low" as const,
};

export async function testCallCommand(
  args: readonly string[],
  out: Output,
  context: CliContext,
): Promise<number> {
  let yes = false;
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      out.stdout(testCallUsage());
      return 0;
    }
    if (arg === "--yes") yes = true;
    else {
      out.stderr(`hotline test-call: unknown option "${arg}"\n\n${testCallUsage()}`);
      return 2;
    }
  }
  const { createRedactor } = await import("@hotline/daemon");
  const { ElevenLabsVoiceProvider, FakeVoiceProvider } = await import("@hotline/providers");
  try {
    const { paths, config, secrets } = await loadSetup(context);
    const owner = config.owner.phoneNumber;
    // test-call goes around the daemon's call policy (rate limits, quiet hours), so
    // it keeps its own cooldown: a loop of `test-call --yes` cannot ring on and on.
    const now = (context.now ?? (() => new Date()))();
    const stampPath = join(paths.home, "test-call.json");
    const last = await lastTestCall(stampPath);
    if (
      config.voice.provider !== "fake" &&
      last !== undefined &&
      now.getTime() - last < TEST_CALL_COOLDOWN_MS
    ) {
      const wait = Math.ceil((TEST_CALL_COOLDOWN_MS - (now.getTime() - last)) / 1000);
      throw new SetupError(`a test call was placed less than 2 minutes ago; try again in ${wait}s`);
    }
    let provider: VoiceProvider;
    if (config.voice.provider === "fake") {
      provider = new FakeVoiceProvider({
        ownerNumber: owner,
        // A test call is never played, so the fake never sends a tool call.
        client: {
          tool: async () => {
            throw new Error("the fake test call plays no tools");
          },
          postCall: async () => {},
        },
      });
    } else {
      const { agentId, agentPhoneNumberId } = config.voice;
      if (agentId === undefined)
        throw new SetupError("voice.agentId is not set; run hotline voice apply first");
      if (agentPhoneNumberId === undefined) {
        throw new SetupError(
          "voice.agentPhoneNumberId is not set; run hotline init --force --agent-phone-number-id",
        );
      }
      const apiKey = await secrets.get("elevenlabs.apiKey");
      if (apiKey === undefined) throw new SetupError("the ElevenLabs API key is not in the secret store");
      const redactor = createRedactor([apiKey]);
      provider = new ElevenLabsVoiceProvider({
        apiKey,
        agentId,
        agentPhoneNumberId,
        ownerNumber: owner,
        redact: (text) => redactor.text(text),
        fetch: fetchFor(context),
      });
    }
    out.stdout(
      config.voice.provider === "fake"
        ? `voice.provider is fake: no phone will ring; the fake provider records a call to ${lastFour(owner)}.`
        : `This will ring the owner's phone (${lastFour(owner)}) now, through ElevenLabs.`,
    );
    if (!yes && config.voice.provider !== "fake") {
      const answer = await context.prompt?.ask("Type yes to ring it: ");
      if (answer === undefined) throw new SetupError("pass --yes to ring without asking");
      if (answer.toLowerCase() !== "yes") {
        out.stdout("Not ringing.");
        return 1;
      }
    }
    if (config.voice.provider !== "fake") {
      // Recorded before the request: a call that fails after ringing still counts.
      const { writePrivateFile } = await import("@hotline/daemon");
      await writePrivateFile(stampPath, `${JSON.stringify({ version: 1, at: now.toISOString() })}\n`);
    }
    const placed = await provider.callOwner({
      callId: `test-${randomBytes(6).toString("hex")}`,
      asks: [TEST_ASK],
    });
    out.stdout(
      config.voice.provider === "fake"
        ? `Fake call recorded (conversation ${placed.conversationId}).`
        : `Call placed (conversation ${placed.conversationId}). Hang up whenever you like.`,
    );
    return 0;
  } catch (error) {
    out.stderr(`hotline test-call: ${(error as Error).message}`);
    return 1;
  }
}
