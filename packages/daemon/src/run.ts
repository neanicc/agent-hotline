// `hotline daemon`: load the config, take the per-home lock, open the secret
// store and database, start call orchestration and both listeners, and shut
// down cleanly on SIGINT or SIGTERM.
import { type Config, policySettings, type SecretStore } from "@hotline/core";
import {
  ElevenLabsVoiceProvider,
  type HttpFetch,
  type SmsProvider,
  TwilioSmsProvider,
  type VoiceProvider,
} from "@hotline/providers";
import { ensureApiToken } from "./api-token.js";
import { hotlinePaths, loadConfig } from "./config-file.js";
import { elevenLabsRoutes } from "./elevenlabs-webhook.js";
import { acquireDaemonLock } from "./lock.js";
import type { LogDestination, LogLevel } from "./logger.js";
import { CallOrchestrator } from "./orchestrator.js";
import { PinGate, verifyPin } from "./pin.js";
import { createRedactor, type Redactor } from "./redact.js";
import { type Exec, openSecretStore } from "./secret-store.js";
import { type Daemon, startDaemon, type WebhookRoute } from "./server.js";
import { twilioSmsRoute } from "./sms-webhook.js";
import { type HotlineStore, openStore } from "./store.js";

export type ShutdownSignal = "SIGINT" | "SIGTERM";
export const SHUTDOWN_SIGNALS: readonly ShutdownSignal[] = ["SIGINT", "SIGTERM"];

/** `process`, or a fake in tests. */
export interface SignalSource {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

export interface ShutdownWait {
  /** The first SIGINT or SIGTERM. */
  received: Promise<ShutdownSignal>;
  /** Removes the listeners without waiting; `received` then never settles. */
  cancel(): void;
}

/**
 * Listens for the first SIGINT or SIGTERM. The listeners are removed when it
 * arrives, so a second signal during shutdown gets Node's default handling and
 * ends the process at once.
 */
export function nextShutdownSignal(signals: SignalSource): ShutdownWait {
  let cancel = () => {};
  const received = new Promise<ShutdownSignal>((resolve) => {
    const listeners = SHUTDOWN_SIGNALS.map((signal) => {
      const listener = () => {
        cancel();
        resolve(signal);
      };
      signals.on(signal, listener);
      return [signal, listener] as const;
    });
    cancel = () => {
      for (const [name, registered] of listeners) signals.off(name, registered);
    };
  });
  return { received, cancel };
}

/** Ports for the agent API and the webhook listener: the configured port and the next one. */
export function daemonPorts(apiPort: number): { apiPort: number; hooksPort: number } {
  if (apiPort === 0) return { apiPort: 0, hooksPort: 0 };
  if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65534) {
    throw new Error(
      `Daemon port ${apiPort} is out of range: use 1024 to 65534 (the webhook listener takes the next port)`,
    );
  }
  return { apiPort, hooksPort: apiPort + 1 };
}

export interface RunDaemonOptions {
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  platform: NodeJS.Platform;
  signals: SignalSource;
  logDestination: LogDestination;
  logLevel?: LogLevel;
  version: string;
  /** Overrides `config.daemon.port`; 0 picks free ports for both listeners. */
  port?: number;
  /** Runs `security` for the Keychain store; tests inject a fake. */
  exec?: Exec;
  clock?: () => Date;
  /** How long to wait for in-flight requests before giving up on a clean stop. */
  shutdownTimeoutMs?: number;
  /** Called once both listeners are up. If it throws, the daemon stops again. */
  onReady?: (daemon: Daemon, orchestrator: CallOrchestrator) => void;
  /**
   * The HTTP client the Twilio and ElevenLabs providers use. Defaults to
   * `globalThis.fetch`; tests pass one that never reaches the network.
   */
  fetch?: HttpFetch;
  /** For tests and the scenario suite: providers to use instead of the configured ones. */
  providers?: { voice?: VoiceProvider; sms?: SmsProvider };
  /** Whether call orchestration ticks on its own timer (default true). */
  autoTick?: boolean;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

interface WebhookSetup {
  routes: WebhookRoute[];
  /** Why the SMS webhook is off, when it is. */
  off?: string;
}

interface TwilioSetup {
  accountSid: string;
  authToken: string;
  smsNumber: string;
}

/** The Twilio number and credentials, or why texting is off. */
async function twilioSetup(config: Config, secrets: SecretStore): Promise<TwilioSetup | string> {
  if (config.sms.provider !== "twilio") return "the SMS provider is fake";
  const smsNumber = config.sms.fromNumber;
  if (smsNumber === undefined) return "sms.fromNumber is not set";
  const [accountSid, authToken] = await Promise.all([
    secrets.get("twilio.accountSid"),
    secrets.get("twilio.authToken"),
  ]);
  if (accountSid === undefined || authToken === undefined) {
    return "the Twilio account SID or auth token is not in the secret store";
  }
  return { accountSid, authToken, smsNumber };
}

/**
 * The Twilio SMS webhook, when the config and secret store have everything it
 * needs. Otherwise no route is registered and `/hooks/twilio/sms` stays a 403.
 * The owner's texts go to call orchestration, once per message SID.
 */
function smsWebhook(
  config: Config,
  twilio: TwilioSetup | string,
  redactor: Redactor,
  store: HotlineStore,
  orchestrator: CallOrchestrator,
  clock: () => Date,
): WebhookSetup {
  if (typeof twilio === "string") return { routes: [], off: twilio };
  const publicUrl = config.tunnel.publicUrl;
  if (publicUrl === undefined) return { routes: [], off: "tunnel.publicUrl is not set" };
  const route = twilioSmsRoute({
    accountSid: twilio.accountSid,
    authToken: twilio.authToken,
    publicUrl,
    ownerNumber: config.owner.phoneNumber,
    smsNumber: twilio.smsNumber,
    clock,
    redact: (text) => redactor.text(text),
    onOwnerMessage: (message) => orchestrator.ownerText(message),
    onOtherSender: (messageSid) => store.appendAudit("sms.other-sender", { messageSid }, clock()),
  });
  return { routes: [route] };
}

/** The configured SMS provider, built with the real `fetch` and the daemon's redactor, or none. */
function smsProvider(
  config: Config,
  twilio: TwilioSetup | string,
  redactor: Redactor,
  fetch: HttpFetch,
): SmsProvider | undefined {
  if (typeof twilio === "string") return undefined;
  return new TwilioSmsProvider({
    accountSid: twilio.accountSid,
    authToken: twilio.authToken,
    fromNumber: twilio.smsNumber,
    ownerNumber: config.owner.phoneNumber,
    redact: (text) => redactor.text(text),
    fetch,
  });
}

/** The configured voice provider (ElevenLabs Agents), or why calling is off. */
async function voiceProvider(
  config: Config,
  secrets: SecretStore,
  redactor: Redactor,
  fetch: HttpFetch,
): Promise<VoiceProvider | string> {
  if (config.voice.provider !== "elevenlabs") return "the voice provider is fake";
  const { agentId, agentPhoneNumberId } = config.voice;
  if (agentId === undefined || agentPhoneNumberId === undefined) {
    return "voice.agentId or voice.agentPhoneNumberId is not set";
  }
  const apiKey = await secrets.get("elevenlabs.apiKey");
  if (apiKey === undefined) return "the ElevenLabs API key is not in the secret store";
  redactor.addSecret(apiKey);
  return new ElevenLabsVoiceProvider({
    apiKey,
    agentId,
    agentPhoneNumberId,
    ownerNumber: config.owner.phoneNumber,
    redact: (text) => redactor.text(text),
    fetch,
  });
}

/**
 * The ElevenLabs server-tool and post-call routes, when the config and secret
 * store have everything they need. Otherwise none is registered and
 * `/hooks/el/*` stays a 403. Answers and post-call events go to call
 * orchestration; until the inbound line (HL-10) takes over, instructions are
 * recorded in the audit log by kind only and the status is not read out.
 */
async function voiceWebhook(
  config: Config,
  secrets: SecretStore,
  redactor: Redactor,
  store: HotlineStore,
  orchestrator: CallOrchestrator,
  clock: () => Date,
): Promise<WebhookSetup> {
  if (config.voice.provider !== "elevenlabs") return { routes: [], off: "the voice provider is fake" };
  const agentId = config.voice.agentId;
  if (agentId === undefined) return { routes: [], off: "voice.agentId is not set" };
  if (config.tunnel.publicUrl === undefined) return { routes: [], off: "tunnel.publicUrl is not set" };
  const [toolSecret, webhookSecret] = await Promise.all([
    secrets.get("elevenlabs.toolSecret"),
    secrets.get("elevenlabs.webhookSecret"),
  ]);
  if (toolSecret === undefined || webhookSecret === undefined) {
    return { routes: [], off: "the ElevenLabs tool or webhook secret is not in the secret store" };
  }
  redactor.addSecret(toolSecret);
  redactor.addSecret(webhookSecret);
  const pinHash = config.owner.pinHash;
  const pins = new PinGate({
    check: (pin) => verifyPin(pin, pinHash),
    clock,
    onVerified: (pin) => redactor.addShortSecret(pin),
    // Recorded now; the inbound line (HL-10) also texts the owner about it.
    onLockout: (direction) => store.appendAudit("voice.pin-lockout", { direction }, clock()),
  });
  const routes = elevenLabsRoutes({
    toolSecret,
    webhookSecret,
    agentId,
    ownerNumber: config.owner.phoneNumber,
    // Only a call orchestration placed and still waits on is outbound; any
    // other conversation is treated as inbound and needs the PIN.
    placedCall: (conversationId) => orchestrator.placedCall(conversationId),
    pins,
    clock,
    redact: (text) => redactor.text(text),
    handlers: {
      submitAnswer: (answer) => orchestrator.submitAnswer(answer),
      getStatus: () => "Status is not available yet.",
      sendInstruction: ({ receivedAt }) => {
        store.appendAudit("voice.instruction", { queued: false }, receivedAt);
        return "unknown-session";
      },
      postCall: async (event, receivedAt) => {
        const detail = event.type === "transcription" ? { status: event.status } : { reason: event.reason };
        store.appendAudit(`voice.${event.type}`, detail, receivedAt);
        await orchestrator.postCall(event, receivedAt);
      },
    },
  });
  return { routes };
}

/**
 * Runs the daemon until SIGINT or SIGTERM. Resolves with the process exit code:
 * 0 after a clean stop, 1 if closing timed out. Startup problems (missing or
 * unsafe config, another daemon on the same home, secret store, database, port
 * in use) reject, after closing whatever had been opened.
 */
export async function runDaemon(options: RunDaemonOptions): Promise<number> {
  const clock = options.clock ?? (() => new Date());
  const paths = hotlinePaths({ env: options.env, homeDir: options.homeDir });
  const config = await loadConfig(paths.config);
  const ports = daemonPorts(options.port ?? config.daemon.port);
  // Before the token or database: a second daemon on this home stops here.
  const lock = await acquireDaemonLock(paths.lock);

  let store: HotlineStore | undefined;
  let daemon: Daemon | undefined;
  let orchestrator: CallOrchestrator | undefined;
  let shutdown: ShutdownWait | undefined;
  try {
    const secrets = openSecretStore({
      choice: config.secrets.store,
      platform: options.platform,
      filePath: paths.secrets,
      exec: options.exec,
    });
    const apiToken = await ensureApiToken(secrets);
    const redactor = createRedactor([apiToken]);
    const log = { level: options.logLevel ?? "info", destination: options.logDestination, redactor };
    store = await openStore(paths.database, { redactor });
    const fetch = options.fetch ?? (globalThis.fetch as unknown as HttpFetch);
    const twilio = await twilioSetup(config, secrets);
    if (typeof twilio !== "string") redactor.addSecret(twilio.authToken);
    const caller = options.providers?.voice ?? (await voiceProvider(config, secrets, redactor, fetch));
    const texter = options.providers?.sms ?? smsProvider(config, twilio, redactor, fetch);
    const calls = new CallOrchestrator({
      store,
      settings: policySettings(config),
      clock,
      ...(typeof caller === "string" ? {} : { voice: caller }),
      ...(texter === undefined ? {} : { sms: texter }),
      redact: (text) => redactor.text(text),
      ...(options.autoTick === undefined ? {} : { autoTick: options.autoTick }),
    });
    orchestrator = calls;
    const sms = smsWebhook(config, twilio, redactor, store, orchestrator, clock);
    const voice = await voiceWebhook(config, secrets, redactor, store, orchestrator, clock);
    daemon = await startDaemon({
      apiToken,
      store,
      ...ports,
      log,
      version: options.version,
      webhookRoutes: [...sms.routes, ...voice.routes],
      clock,
      askTimeoutMinutes: config.policy.askTimeoutMinutes,
      nicknames: config.nicknames,
      settle: () => calls.tick(),
    });
    if (sms.off !== undefined) daemon.log.info({ reason: sms.off }, "sms webhook off");
    if (voice.off !== undefined) daemon.log.info({ reason: voice.off }, "voice webhooks off");
    if (typeof caller === "string") daemon.log.info({ reason: caller }, "outbound calls off");
    if (texter === undefined) daemon.log.info({ reason: twilio }, "outbound texts off");
    orchestrator.attachLog(daemon.log);
    await orchestrator.start();
    store.appendAudit(
      "daemon.started",
      { version: options.version, apiPort: daemon.apiPort, hooksPort: daemon.hooksPort },
      clock(),
    );
    // Listen for signals before announcing readiness, so a stop request is never missed.
    shutdown = nextShutdownSignal(options.signals);
    daemon.log.info({ apiUrl: daemon.apiUrl, hooksUrl: daemon.hooksUrl }, "hotline daemon listening");
    options.onReady?.(daemon, orchestrator);
  } catch (error) {
    shutdown?.cancel();
    await orchestrator?.stop();
    if (daemon !== undefined) await daemon.close();
    else store?.close();
    await lock.release();
    throw error;
  }

  const received = await shutdown.received;
  daemon.log.info({ signal: received }, "hotline daemon shutting down");
  try {
    store.appendAudit("daemon.stopping", { signal: received }, clock());
  } catch (error) {
    // Never let a failed audit write keep the daemon from stopping.
    daemon.log.error({ err: error }, "could not record the shutdown in the audit log");
  }

  const timeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs);
  });
  const [orchestration, listeners] = [orchestrator, daemon];
  const closed = (async () => {
    // No new steps (timer, store listeners) once shutdown starts; the one in progress finishes.
    await orchestration.stop();
    await listeners.close();
    return false as const;
  })();
  const result = await Promise.race([closed, timedOut]);
  clearTimeout(timer);
  if (result === true) {
    // The store may still be open, so keep the lock: a new daemon must not open
    // the same database yet. Once this process exits, the stale-pid check frees it.
    daemon.log.error({ timeoutMs }, "hotline daemon did not stop in time");
    return 1;
  }
  await lock.release();
  daemon.log.info("hotline daemon stopped");
  return 0;
}
