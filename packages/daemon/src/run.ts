// `hotline daemon`: load the config, take the per-home lock, open the secret
// store and database, start both listeners, and shut down cleanly on SIGINT or
// SIGTERM.
import { type Config, parseSmsReply, type SecretStore } from "@hotline/core";
import { ensureApiToken } from "./api-token.js";
import { hotlinePaths, loadConfig } from "./config-file.js";
import { acquireDaemonLock } from "./lock.js";
import type { LogDestination, LogLevel } from "./logger.js";
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
  onReady?: (daemon: Daemon) => void;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

interface SmsWebhookSetup {
  routes: WebhookRoute[];
  /** Why the SMS webhook is off, when it is. */
  off?: string;
}

/**
 * The Twilio SMS webhook, when the config and secret store have everything it
 * needs. Otherwise no route is registered and `/hooks/twilio/sms` stays a 403.
 * Until call orchestration (HL-09) handles replies, an owner's text is only
 * recorded in the audit log by its SID and reply type, never its words.
 */
async function smsWebhook(
  config: Config,
  secrets: SecretStore,
  redactor: Redactor,
  store: HotlineStore,
  clock: () => Date,
): Promise<SmsWebhookSetup> {
  if (config.sms.provider !== "twilio") return { routes: [], off: "the SMS provider is fake" };
  const smsNumber = config.sms.fromNumber;
  const publicUrl = config.tunnel.publicUrl;
  if (smsNumber === undefined) return { routes: [], off: "sms.fromNumber is not set" };
  if (publicUrl === undefined) return { routes: [], off: "tunnel.publicUrl is not set" };
  const [accountSid, authToken] = await Promise.all([
    secrets.get("twilio.accountSid"),
    secrets.get("twilio.authToken"),
  ]);
  if (accountSid === undefined || authToken === undefined) {
    return { routes: [], off: "the Twilio account SID or auth token is not in the secret store" };
  }
  redactor.addSecret(authToken);
  const route = twilioSmsRoute({
    accountSid,
    authToken,
    publicUrl,
    ownerNumber: config.owner.phoneNumber,
    smsNumber,
    clock,
    redact: (text) => redactor.text(text),
    onOwnerMessage: ({ messageSid, body, receivedAt }) => {
      const reply = parseSmsReply(body);
      store.appendAudit(
        "sms.received",
        { messageSid, reply: reply.type === "command" ? reply.command : reply.type },
        receivedAt,
      );
      return undefined;
    },
    onOtherSender: (messageSid) => store.appendAudit("sms.other-sender", { messageSid }, clock()),
  });
  return { routes: [route] };
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
    const sms = await smsWebhook(config, secrets, redactor, store, clock);
    daemon = await startDaemon({
      apiToken,
      store,
      ...ports,
      log,
      version: options.version,
      webhookRoutes: sms.routes,
    });
    if (sms.off !== undefined) daemon.log.info({ reason: sms.off }, "sms webhook off");
    store.appendAudit(
      "daemon.started",
      { version: options.version, apiPort: daemon.apiPort, hooksPort: daemon.hooksPort },
      clock(),
    );
    // Listen for signals before announcing readiness, so a stop request is never missed.
    shutdown = nextShutdownSignal(options.signals);
    daemon.log.info({ apiUrl: daemon.apiUrl, hooksUrl: daemon.hooksUrl }, "hotline daemon listening");
    options.onReady?.(daemon);
  } catch (error) {
    shutdown?.cancel();
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
  const result = await Promise.race([daemon.close().then(() => false as const), timedOut]);
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
