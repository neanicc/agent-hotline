// The scenario harness: the real daemon (`runDaemon` on 127.0.0.1 with ephemeral
// ports and a temporary HOTLINE_HOME) with a fake clock, the fake voice provider
// playing scripted humans against the daemon's own `/hooks/el/*` routes,
// FakeSmsProvider, and the real `hotline` CLI (apps/cli/dist/main.js) run as
// child processes for `hotline away`, `hotline hook` and `hotline mcp`, exactly
// as Claude Code and Codex run them. Nothing leaves 127.0.0.1: the providers'
// `fetch` refuses every request, and the child processes get a scrubbed
// environment whose HOME and HOTLINE_HOME are temporary folders.
//
// Clocks: the daemon, the fake providers and the scripted humans share the fake
// clock, which only the scenario moves. The CLI children run on the real clock,
// so the fake one starts years ahead of it: the hooks' and the MCP server's own
// deadlines (`--wait-seconds`, an ask's expiry plus a grace period) then never
// cut a wait short, and every outcome comes from the daemon.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentKind, Ask } from "@hotline/core";
import {
  type CallOrchestrator,
  type Daemon,
  FileSecretStore,
  hashPin,
  hotlinePaths,
  runDaemon,
  writePrivateFile,
} from "@hotline/daemon";
import {
  FakeSmsProvider,
  FakeVoiceProvider,
  type HttpFetch,
  httpVoiceToolClient,
  twilioSignature,
  type VoiceToolClient,
} from "@hotline/providers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { check, ScenarioFailure, waitFor } from "./check.js";
import { alwaysApproveProxy, type Fault, type FaultProxy } from "./fault.js";

/** Obviously fake numbers only (AGENTS.md). */
export const OWNER = "+15555550100";
export const HOTLINE_NUMBER = "+15555550101";
export const STRANGER = "+15555550199";
export const PIN = "4821";
export const PUBLIC_URL = "https://hotline.example.test";
export const ACCOUNT_SID = `AC${"0123456789abcdef".repeat(2)}`;
const AUTH_TOKEN = "fake-twilio-auth-token-scenarios";
const TOOL_SECRET = "fake-elevenlabs-tool-secret-scen";
const WEBHOOK_SECRET = "fake-elevenlabs-webhook-secret-sc";

/**
 * 17:58 in Toronto on a Tuesday, outside the default quiet hours (22:00 to
 * 08:00), and years after any real clock the CLI children read (see above).
 */
export const START = new Date("2031-06-10T21:58:00.000Z");
/** `policy.batchWindowSeconds` (default 20): asks within it share one call. */
export const BATCH_MS = 20_000;
/** The queue's wait before it retries an unanswered call. */
export const RETRY_MS = 120_000;
export const MINUTE = 60_000;
/** `policy.askTimeoutMinutes` (default 30). */
export const ASK_TIMEOUT_MS = 30 * MINUTE;
/** How long the scripted owner takes to read a text before replying (past the daemon's 10 s floor). */
export const READING_MS = 15_000;
/** Quiet hours around START (17:58 in Toronto). */
export const QUIET = { quietHours: { timeZone: "America/Toronto", start: "17:00", end: "23:00" } };
/** The hooks' `--wait-seconds`, real time: far longer than any scenario takes. */
const HOOK_WAIT_SECONDS = 120;
/** Real-time cap on one CLI child, so a hung child fails its scenario instead of the run. */
const CHILD_TIMEOUT_MS = 150_000;

/** The built CLI, from both eval/src (tests) and eval/dist (the runner). */
export const CLI_PATH = fileURLToPath(new URL("../../apps/cli/dist/main.js", import.meta.url));

/** Refuses every request: a provider that tried to reach Twilio or ElevenLabs fails the scenario. */
const noNetwork: HttpFetch = async (url) => {
  throw new Error(`unexpected network request to ${new URL(url).host}`);
};

let pinHash: Promise<string> | undefined;

export interface HotlineOptions {
  /** Merged over the base config. */
  config?: Record<string, unknown>;
  /**
   * Moves the fake clock on this much after each server-tool call, so transcript
   * turns run on as on a real call (an inbound call's turns count as the owner's
   * only after the moment the PIN was verified).
   */
  toolStepMs?: number;
  /** Keeps every post-call webhook payload the fake provider sends, for replay scenarios. */
  capturePostCalls?: boolean;
  /** The self-test fault, if any. Never set in a normal run. */
  fault?: Fault;
}

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface McpSession {
  /** The server's working directory (real path): its session's `cwd`. */
  folder: string;
  /** Calls a tool and returns its JSON result. Rejects when the result is not JSON text. */
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface RawResponse {
  status: number;
  body: string;
}

export interface Hotline {
  dir: string;
  daemon: Daemon;
  orchestrator: CallOrchestrator;
  voice: FakeVoiceProvider;
  sms: FakeSmsProvider;
  /** Sends tool calls and signed post-call webhooks to the daemon's routes, as ElevenLabs would. */
  elevenLabs: VoiceToolClient;
  /** Post-call payloads the fake provider sent, when `capturePostCalls` is set. */
  postCalls: Record<string, unknown>[];
  clock: { now: Date };
  /** Moves the fake clock on and runs whatever is due. */
  advance(ms: number): Promise<void>;
  /** Waits for every orchestration step started so far. */
  settle(): Promise<void>;
  /** The first ask in the store that matches, waiting for an agent's request to arrive. */
  waitForAsk(match: (ask: Ask) => boolean, what: string): Promise<Ask>;
  /** Runs the real `hotline` CLI with this hotline home. */
  cli(args: readonly string[], stdin?: string): Promise<CliRun>;
  /** `hotline away on|off`. */
  away(on: boolean): Promise<void>;
  /** `hotline hook <claude|codex> <permission|stop>` with `payload` on stdin. Resolves when it exits. */
  hook(agent: AgentKind, event: "permission" | "stop", payload: Record<string, unknown>): Promise<CliRun>;
  /** `hotline mcp --agent <claude|codex>` in `<dir>/src/<folder>`, with an MCP client connected. */
  mcp(agent: AgentKind, folder: string): Promise<McpSession>;
  /** Registers a session through the agent API, as the hook adapters do. */
  register(agent: AgentKind, cwd: string, agentSessionId?: string): Promise<string>;
  /**
   * A signed Twilio webhook for a text to the Hotline number; returns the reply text, if any.
   * The fake clock first moves on `READING_MS` (the owner reads before replying) unless `instantly`.
   */
  text(
    body: string,
    options?: { from?: string; messageSid?: string; instantly?: boolean },
  ): Promise<string | undefined>;
  /** A raw request to the webhook listener. */
  hooks(path: string, headers: Record<string, string>, body: string): Promise<RawResponse>;
  /** Twilio form parameters for a text, and their valid signature. */
  smsRequest(
    body: string,
    options?: { from?: string; messageSid?: string },
  ): { form: string; signature: string };
  stop(): Promise<void>;
}

const messageSid = () => `SM${randomBytes(16).toString("hex")}`;

function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers: { connection: "close", ...headers }, agent: false },
      (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function toolJson(result: unknown): Record<string, unknown> {
  const first = (result as CallToolResult).content?.[0];
  if (first?.type !== "text") throw new ScenarioFailure("the MCP tool result has no text content");
  return JSON.parse(first.text) as Record<string, unknown>;
}

export async function startHotline(options: HotlineOptions = {}): Promise<Hotline> {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`the hotline CLI is not built (${CLI_PATH}); run "pnpm run build" first`);
  }
  pinHash ??= hashPin(PIN);
  const dir = await realpath(await mkdtemp(join(tmpdir(), "hotline-scenario-")));
  const home = join(dir, "home");
  const paths = hotlinePaths({ env: { HOTLINE_HOME: home }, homeDir: "/nonexistent" });
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

  const clock = { now: START };
  let hooksUrl = "";
  const client = () =>
    httpVoiceToolClient({
      hooksUrl,
      toolSecret: TOOL_SECRET,
      webhookSecret: WEBHOOK_SECRET,
      fetch: globalThis.fetch as unknown as HttpFetch,
      clock: () => clock.now,
    });
  const postCalls: Record<string, unknown>[] = [];
  const elevenLabs: VoiceToolClient = {
    tool: async (name, body) => {
      const response = await client().tool(name, body);
      if (options.toolStepMs !== undefined) clock.now = new Date(clock.now.getTime() + options.toolStepMs);
      return response;
    },
    postCall: async (payload) => {
      if (options.capturePostCalls) postCalls.push(payload);
      await client().postCall(payload);
    },
  };
  const voice = new FakeVoiceProvider({
    ownerNumber: OWNER,
    agentNumber: HOTLINE_NUMBER,
    agentId: "agent_fake",
    client: elevenLabs,
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
    version: "0.0.0-scenarios",
    port: 0,
    clock: () => clock.now,
    fetch: noNetwork,
    providers: { voice, sms },
    // The scenario steps time itself; nothing fires behind its back.
    autoTick: false,
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
  const proxy: FaultProxy | undefined =
    options.fault === "always-approve" ? await alwaysApproveProxy(daemon.apiPort) : undefined;
  /** Where the hooks and MCP servers find the daemon: the proxy when a fault is injected. */
  const agentPort = proxy?.port ?? daemon.apiPort;

  // The CLI children see only this: no real HOME, no real credentials, test mode on.
  const nohome = join(dir, "nohome");
  await mkdir(nohome, { recursive: true, mode: 0o700 });
  const cliEnv: Record<string, string> = {
    HOTLINE_HOME: home,
    HOME: nohome,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOTLINE_TEST_MODE: "1",
    // node:sqlite's ExperimentalWarning on Node 22 and 24.
    NODE_NO_WARNINGS: "1",
  };
  const children = new Set<ChildProcess>();
  const sessions = new Set<McpSession>();

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await rawRequest(
      daemon.apiPort,
      method,
      path,
      {
        host: `127.0.0.1:${daemon.apiPort}`,
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body === undefined ? undefined : JSON.stringify(body),
    );
    if (response.status >= 300) throw new ScenarioFailure(`${method} ${path} answered ${response.status}`);
    return JSON.parse(response.body) as Record<string, unknown>;
  };

  const cli = (args: readonly string[], stdin = ""): Promise<CliRun> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI_PATH, ...args], {
        cwd: dir,
        env: cliEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
      child.on("error", (error) => {
        stderr += String(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        children.delete(child);
        resolve({ code, stdout, stderr });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    });

  const smsRequest = (body: string, { from = OWNER, messageSid: sid = messageSid() } = {}) => {
    const params: [string, string][] = [
      ["MessageSid", sid],
      ["AccountSid", ACCOUNT_SID],
      ["From", from],
      ["To", HOTLINE_NUMBER],
      ["Body", body],
    ];
    return {
      form: new URLSearchParams(params).toString(),
      signature: twilioSignature(AUTH_TOKEN, `${PUBLIC_URL}/hooks/twilio/sms`, params),
    };
  };
  const hooks = (path: string, headers: Record<string, string>, body: string) =>
    rawRequest(daemon.hooksPort, "POST", path, headers, body);

  const hotline: Hotline = {
    dir,
    daemon,
    orchestrator,
    voice,
    sms,
    elevenLabs,
    postCalls,
    clock,
    async advance(ms) {
      // Steps already queued (say, a new ask) run at the time they happened.
      await orchestrator.idle();
      clock.now = new Date(clock.now.getTime() + ms);
      await orchestrator.tick();
      await orchestrator.idle();
    },
    settle: () => orchestrator.idle(),
    async waitForAsk(match, what) {
      const ask = await waitFor(() => daemon.store.listAsks().find(match), what);
      // Its queue step (`onAskAdded`) runs before anything else the scenario does.
      await orchestrator.idle();
      return ask;
    },
    cli,
    async away(on) {
      const run = await cli(["away", on ? "on" : "off"]);
      check(run.code === 0, `hotline away ${on ? "on" : "off"} exited with ${run.code}: ${run.stderr}`);
    },
    hook(agent, event, payload) {
      return cli(
        [
          "hook",
          agent === "codex" ? "codex" : "claude",
          event,
          "--port",
          String(agentPort),
          "--wait-seconds",
          String(HOOK_WAIT_SECONDS),
        ],
        JSON.stringify(payload),
      );
    },
    async mcp(agent, folderName) {
      const folder = join(dir, "src", folderName);
      await mkdir(folder, { recursive: true });
      const cwd = await realpath(folder);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          CLI_PATH,
          "mcp",
          "--agent",
          agent === "codex" ? "codex" : "claude",
          "--port",
          String(agentPort),
        ],
        env: cliEnv,
        cwd,
        stderr: "pipe",
      });
      transport.stderr?.on("data", () => {});
      const mcp = new Client({
        name: agent === "codex" ? "codex-mcp-client" : "claude-code",
        version: "1.0.0",
      });
      await mcp.connect(transport);
      // The server registers its session once the client has initialized.
      await waitFor(
        () =>
          daemon.store.listSessions().find((s) => s.agent === agent && s.cwd === cwd && s.state !== "ended"),
        `the ${agent} MCP server's session`,
      );
      let closed = false;
      const session: McpSession = {
        folder: cwd,
        async call(name, args) {
          const result = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 140_000 });
          return toolJson(result);
        },
        async close() {
          if (closed) return;
          closed = true;
          sessions.delete(session);
          await mcp.close().catch(() => {});
        },
      };
      sessions.add(session);
      return session;
    },
    async register(agent, cwd, agentSessionId) {
      const { session } = await api("POST", "/v1/sessions", {
        agent,
        cwd,
        ...(agentSessionId === undefined ? {} : { agentSessionId }),
      });
      return (session as { id: string }).id;
    },
    async text(body, { from = OWNER, messageSid: sid, instantly = false } = {}) {
      await orchestrator.idle();
      if (!instantly) clock.now = new Date(clock.now.getTime() + READING_MS);
      const { form, signature } = smsRequest(body, {
        from,
        ...(sid === undefined ? {} : { messageSid: sid }),
      });
      const response = await hooks(
        "/hooks/twilio/sms",
        { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
        form,
      );
      if (response.status !== 200) throw new ScenarioFailure(`the SMS webhook answered ${response.status}`);
      await orchestrator.idle();
      const match = /<Message>(.*)<\/Message>/s.exec(response.body);
      return match?.[1]?.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
    },
    hooks,
    smsRequest,
    async stop() {
      for (const session of [...sessions]) await session.close();
      for (const child of children) child.kill("SIGKILL");
      await proxy?.close();
      signals.emit("SIGTERM");
      await exit;
      await rm(dir, { recursive: true, force: true });
    },
  };
  return hotline;
}
