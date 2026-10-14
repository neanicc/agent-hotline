// Test harness: the real daemon (`runDaemon`, real routes, real store, call
// orchestration) with a fake clock, FakeSmsProvider and the fake voice provider
// playing scripted humans against the daemon's own webhook routes over HTTP.
// Nothing leaves 127.0.0.1: the providers' `fetch` refuses every request.
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answer, Ask, AskOutcome } from "@hotline/core";
import {
  FakeSmsProvider,
  FakeVoiceProvider,
  type HttpFetch,
  httpVoiceToolClient,
  twilioSignature,
  type VoiceToolClient,
} from "@hotline/providers";
import {
  type CallOrchestrator,
  type Daemon,
  FileSecretStore,
  hashPin,
  hotlinePaths,
  type JudgeHost,
  runDaemon,
  writePrivateFile,
} from "../src/index.js";
import { send } from "./http.js";

export const OWNER = "+15555550100";
export const HOTLINE_NUMBER = "+15555550101";
export const STRANGER = "+15555550199";
export const PIN = "4821";
export const PUBLIC_URL = "https://hotline.example.test";
export const ACCOUNT_SID = `AC${"0123456789abcdef".repeat(2)}`;
const AUTH_TOKEN = "fake-twilio-auth-token-orchestration";
const TOOL_SECRET = "fake-elevenlabs-tool-secret-orch";
const WEBHOOK_SECRET = "fake-elevenlabs-webhook-secret-orch";
/** 17:58 in Toronto: outside the default quiet hours (22:00 to 08:00). */
export const START = new Date("2026-10-13T21:58:00.000Z");
/** How long the scripted owner takes to read a text before replying. */
export const READING_MS = 15_000;

let pinHash: Promise<string> | undefined;

/** Refuses every request: a provider that tried to reach Twilio or ElevenLabs fails the test. */
export const noNetwork: HttpFetch = async (url) => {
  throw new Error(`unexpected network request to ${new URL(url).host}`);
};

export interface HotlineOptions {
  /** Merged over the base config. */
  config?: Record<string, unknown>;
  /** Call orchestration's own timer; off by default so tests step time explicitly. */
  autoTick?: boolean;
  /** Replaces the HTTP client the fake voice provider uses to reach the daemon. */
  voiceClient?: (real: VoiceToolClient) => VoiceToolClient;
  start?: Date;
  /** Reuse a hotline home (restart tests). */
  dir?: string;
  /** A fake agent CLI host for the reply judge (HL-09d); without one the daemon has no judge. */
  judgeHost?: JudgeHost;
}

export interface Hotline {
  dir: string;
  daemon: Daemon;
  orchestrator: CallOrchestrator;
  voice: FakeVoiceProvider;
  /** Sends tool calls and signed post-call webhooks to this daemon's routes, as ElevenLabs would. */
  elevenLabs: VoiceToolClient;
  sms: FakeSmsProvider;
  clock: { now: Date };
  /** Moves the fake clock on and runs whatever is due. */
  advance(ms: number): Promise<void>;
  /** Waits for every orchestration step started so far. */
  settle(): Promise<void>;
  registerSession(agent?: "claude-code" | "codex", cwd?: string): Promise<string>;
  /** Creates a question or notification through the agent API. */
  ask(sessionId: string, body: Record<string, unknown>): Promise<Ask>;
  /** Stores an ask directly, as the hook adapters' permission and stop asks will arrive (HL-06). */
  addAsk(sessionId: string, fields: Partial<Ask> & Pick<Ask, "kind" | "text">): Ask;
  /** The agent API's outcome long poll. */
  outcome(askId: string, waitSeconds?: number): Promise<{ state: string; outcome?: AskOutcome }>;
  /**
   * A signed Twilio webhook for a text to the Hotline number; returns the reply text, if any.
   * The fake clock first moves on `READING_MS` (the owner reads before replying) unless `instantly`.
   */
  text(
    body: string,
    options?: { from?: string; messageSid?: string; instantly?: boolean },
  ): Promise<string | undefined>;
  stop(): Promise<number>;
}

const messageSid = () => `SM${randomBytes(16).toString("hex")}`;

export async function startHotline(options: HotlineOptions = {}): Promise<Hotline> {
  pinHash ??= hashPin(PIN);
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "hotline-orch-")));
  const paths = hotlinePaths({ env: { HOTLINE_HOME: join(dir, "home") }, homeDir: "/nonexistent" });
  const config = {
    version: 1,
    owner: { phoneNumber: OWNER, pinHash: await pinHash },
    quietHours: { timeZone: "America/Toronto" },
    secrets: { store: "file" },
    sms: { fromNumber: HOTLINE_NUMBER },
    voice: { agentId: "agent_fake" },
    tunnel: { publicUrl: PUBLIC_URL },
    ...options.config,
  };
  await writePrivateFile(paths.config, JSON.stringify(config));
  const secrets = new FileSecretStore(paths.secrets);
  await secrets.set("twilio.accountSid", ACCOUNT_SID);
  await secrets.set("twilio.authToken", AUTH_TOKEN);
  await secrets.set("elevenlabs.toolSecret", TOOL_SECRET);
  await secrets.set("elevenlabs.webhookSecret", WEBHOOK_SECRET);

  const clock = { now: options.start ?? START };
  let hooksUrl = "";
  const real: VoiceToolClient = {
    tool: (name, body) =>
      httpVoiceToolClient({
        hooksUrl,
        toolSecret: TOOL_SECRET,
        webhookSecret: WEBHOOK_SECRET,
        fetch: globalThis.fetch as unknown as HttpFetch,
        clock: () => clock.now,
      }).tool(name, body),
    postCall: (payload) =>
      httpVoiceToolClient({
        hooksUrl,
        toolSecret: TOOL_SECRET,
        webhookSecret: WEBHOOK_SECRET,
        fetch: globalThis.fetch as unknown as HttpFetch,
        clock: () => clock.now,
      }).postCall(payload),
  };
  const voice = new FakeVoiceProvider({
    ownerNumber: OWNER,
    agentNumber: HOTLINE_NUMBER,
    agentId: "agent_fake",
    client: options.voiceClient?.(real) ?? real,
    clock: () => clock.now,
  });
  const sms = new FakeSmsProvider({ ownerNumber: OWNER });
  const signals = new EventEmitter();
  let ready!: (value: { daemon: Daemon; orchestrator: CallOrchestrator }) => void;
  const listening = new Promise<{ daemon: Daemon; orchestrator: CallOrchestrator }>((resolve) => {
    ready = resolve;
  });
  const exit = runDaemon({
    env: { HOTLINE_HOME: paths.home },
    homeDir: "/nonexistent",
    platform: process.platform,
    signals,
    logDestination: { write: () => {} },
    version: "0.0.0-test",
    port: 0,
    clock: () => clock.now,
    fetch: noNetwork,
    providers: { voice, sms },
    ...(options.judgeHost === undefined ? {} : { judgeHost: options.judgeHost }),
    autoTick: options.autoTick ?? false,
    onReady: (daemon, orchestrator) => ready({ daemon, orchestrator }),
  });
  const { daemon, orchestrator } = await Promise.race([
    listening,
    exit.then((code) => {
      throw new Error(`daemon exited with ${code} before it was ready`);
    }),
  ]);
  hooksUrl = daemon.hooksUrl;
  const token = (await secrets.get("daemon.apiToken")) ?? "";
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await send({
      port: daemon.apiPort,
      method,
      path,
      headers: {
        host: `127.0.0.1:${daemon.apiPort}`,
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status >= 300) throw new Error(`${method} ${path} answered ${response.status}`);
    return JSON.parse(response.body) as Record<string, unknown>;
  };

  let ids = 0;
  const hotline: Hotline = {
    dir,
    daemon,
    orchestrator,
    voice,
    elevenLabs: real,
    sms,
    clock,
    async advance(ms) {
      // Steps already queued (say, a new ask) run at the time they happened.
      await orchestrator.idle();
      clock.now = new Date(clock.now.getTime() + ms);
      await orchestrator.tick();
      await orchestrator.idle();
    },
    settle: () => orchestrator.idle(),
    async registerSession(agent = "claude-code", cwd = "/work/demo-app") {
      const { session } = await api("POST", "/v1/sessions", { agent, cwd });
      return (session as { id: string }).id;
    },
    async ask(sessionId, body) {
      const { ask } = await api("POST", `/v1/sessions/${sessionId}/asks`, body);
      await orchestrator.idle();
      return ask as Ask;
    },
    addAsk(sessionId, fields) {
      ids += 1;
      const ask: Ask = {
        id: `ask-direct-${ids}`,
        sessionId,
        options: [],
        risk: "low",
        urgent: false,
        createdAt: clock.now.toISOString(),
        expiresAt: new Date(clock.now.getTime() + 30 * 60_000).toISOString(),
        status: "pending",
        ...fields,
      };
      daemon.store.addAsk(ask);
      return ask;
    },
    async outcome(askId, waitSeconds = 0) {
      return (await api("GET", `/v1/asks/${askId}/outcome?waitSeconds=${waitSeconds}`)) as {
        state: string;
        outcome?: AskOutcome;
      };
    },
    async text(body, { from = OWNER, messageSid: sid = messageSid(), instantly = false } = {}) {
      await orchestrator.idle();
      if (!instantly) clock.now = new Date(clock.now.getTime() + READING_MS);
      const params: [string, string][] = [
        ["MessageSid", sid],
        ["AccountSid", ACCOUNT_SID],
        ["From", from],
        ["To", HOTLINE_NUMBER],
        ["Body", body],
      ];
      const response = await send({
        port: daemon.hooksPort,
        method: "POST",
        path: "/hooks/twilio/sms",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": twilioSignature(AUTH_TOKEN, `${PUBLIC_URL}/hooks/twilio/sms`, params),
        },
        body: new URLSearchParams(params).toString(),
      });
      if (response.status !== 200) throw new Error(`sms webhook answered ${response.status}`);
      await orchestrator.idle();
      const match = /<Message>(.*)<\/Message>/s.exec(response.body);
      return match?.[1]?.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
    },
    async stop() {
      signals.emit("SIGTERM");
      const code = await exit;
      if (options.dir === undefined) await rm(dir, { recursive: true, force: true });
      return code;
    },
  };
  return hotline;
}

/** The recorded answer of an answered outcome, or a failure naming what came back. */
export function answerOf(result: { state: string; outcome?: AskOutcome }): Answer {
  if (result.outcome?.outcome !== "answered") throw new Error(`not answered: ${JSON.stringify(result)}`);
  return result.outcome.answer;
}
