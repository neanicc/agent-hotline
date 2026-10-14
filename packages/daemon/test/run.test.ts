import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type HttpFetch, postCallSignatureHeader, twilioSignature } from "@hotline/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Daemon,
  daemonPorts,
  FileSecretStore,
  hashPin,
  hotlinePaths,
  nextShutdownSignal,
  type RunDaemonOptions,
  runDaemon,
  SHUTDOWN_SIGNALS,
  writePrivateFile,
} from "../src/index.js";
import { send } from "./http.js";

const OWNER = "+15555550100";
const PIN_HASH = `scrypt$15$8$1$${"s".repeat(22)}$${"h".repeat(43)}`;
const CONFIG = {
  version: 1,
  owner: { phoneNumber: OWNER, pinHash: PIN_HASH },
  quietHours: { timeZone: "America/Toronto" },
  // Never the real Keychain in tests.
  secrets: { store: "file" },
};
const NOW = new Date("2026-10-13T21:58:00.000Z");

let dir: string;
let lines: string[];
let signals: EventEmitter;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hotline-run-"));
  lines = [];
  signals = new EventEmitter();
});

afterEach(async () => {
  // Stop any daemon a failing test left running.
  signals.emit("SIGTERM");
  await rm(dir, { recursive: true, force: true });
});

function paths(home = "home") {
  return hotlinePaths({ env: { HOTLINE_HOME: join(dir, home) }, homeDir: "/nonexistent" });
}

async function writeConfig(config: unknown = CONFIG, home = "home"): Promise<void> {
  await writePrivateFile(paths(home).config, JSON.stringify(config));
}

/**
 * A fake Twilio and ElevenLabs REST API for the real providers' pulls (HL-13a):
 * a GET for a path in `records` gets that record, any other GET a 404, and
 * anything else (a send or a call) is refused as a network request.
 */
function fakeApi(records: Record<string, unknown>): HttpFetch {
  return async (url, init) => {
    if (init.method !== "GET") throw new Error("unexpected network request");
    const record = records[new URL(url).pathname];
    return record === undefined
      ? { status: 404, json: async () => ({ code: 20404 }) }
      : { status: 200, json: async () => structuredClone(record) };
  };
}

/** Starts runDaemon and resolves once it is listening. */
async function launch(overrides: Partial<RunDaemonOptions> = {}) {
  let ready!: (daemon: Daemon) => void;
  const listening = new Promise<Daemon>((resolve) => {
    ready = resolve;
  });
  const exit = runDaemon({
    env: { HOTLINE_HOME: paths().home },
    homeDir: "/nonexistent",
    platform: process.platform,
    signals,
    logDestination: { write: (line) => lines.push(line) },
    version: "0.0.0-test",
    port: 0,
    clock: () => NOW,
    // Providers built from the config must never reach Twilio or ElevenLabs.
    fetch: async () => {
      throw new Error("unexpected network request");
    },
    onReady: ready,
    ...overrides,
  });
  // Surface a startup failure instead of waiting forever for readiness.
  const daemon = await Promise.race([
    listening,
    exit.then((code) => {
      throw new Error(`daemon exited with ${code} before it was ready`);
    }),
  ]);
  return { daemon, exit };
}

describe("runDaemon", () => {
  it.each(SHUTDOWN_SIGNALS)("serves the agent API, then shuts down cleanly on %s", async (signal) => {
    await writeConfig();
    const { daemon, exit } = await launch();
    const token = await new FileSecretStore(paths().secrets).get("daemon.apiToken");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const ok = await send({
      port: daemon.apiPort,
      path: "/v1/health",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
    expect((await send({ port: daemon.apiPort, path: "/v1/health" })).status).toBe(401);
    expect((await send({ port: daemon.hooksPort, method: "POST", path: "/hooks/twilio/sms" })).status).toBe(
      403,
    );

    signals.emit(signal);
    expect(await exit).toBe(0);

    // Listeners and database are closed, and the signal handlers removed.
    expect(daemon.store.isOpen).toBe(false);
    await expect(send({ port: daemon.apiPort, path: "/v1/health" })).rejects.toThrow(/ECONNREFUSED/);
    await expect(send({ port: daemon.hooksPort, path: "/hooks/x" })).rejects.toThrow(/ECONNREFUSED/);
    for (const name of SHUTDOWN_SIGNALS) expect(signals.listenerCount(name)).toBe(0);

    // The audit log recorded the start and the stop.
    const db = new DatabaseSync(paths().database, { readOnly: true });
    const audit = db.prepare("SELECT at, event, detail FROM audit ORDER BY seq").all();
    db.close();
    expect(audit).toEqual([
      {
        at: NOW.toISOString(),
        event: "daemon.started",
        detail: JSON.stringify({
          version: "0.0.0-test",
          apiPort: daemon.apiPort,
          hooksPort: daemon.hooksPort,
          // Test mode: the default judge host finds no agent CLI, and no key is stored.
          judge: "none",
        }),
      },
      { at: NOW.toISOString(), event: "daemon.stopping", detail: JSON.stringify({ signal }) },
    ]);

    // Logs say what happened and never contain the token or the owner's number.
    const text = lines.join("");
    expect(text).toContain("hotline daemon listening");
    expect(text).toContain("hotline daemon stopped");
    expect(text).not.toContain(token);
    expect(text).not.toContain("5555550100");
  });

  it("leaves the SMS webhook off until Twilio is configured", async () => {
    await writeConfig();
    const { exit } = await launch();
    signals.emit("SIGTERM");
    expect(await exit).toBe(0);
    const off = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((e) => e.msg === "sms webhook off");
    expect(off).toMatchObject({ reason: "sms.fromNumber is not set" });
  });

  it("serves the Twilio SMS webhook when the config and secrets are in place", async () => {
    const publicUrl = "https://hotline.example.test";
    const accountSid = `AC${"0123456789abcdef".repeat(2)}`;
    const authToken = "fake-twilio-auth-token-for-run-tests";
    await writeConfig({ ...CONFIG, sms: { fromNumber: "+15555550101" }, tunnel: { publicUrl } });
    const secrets = new FileSecretStore(paths().secrets);
    await secrets.set("twilio.accountSid", accountSid);
    await secrets.set("twilio.authToken", authToken);
    const ownerSid = `SM${"1".repeat(32)}`;
    const otherSid = `SM${"2".repeat(32)}`;
    const forgedSid = `SM${"3".repeat(32)}`;
    // Twilio holds the owner's message; the forged one was never sent.
    const { daemon, exit } = await launch({
      fetch: fakeApi({
        [`/2010-04-01/Accounts/${accountSid}/Messages/${ownerSid}.json`]: {
          sid: ownerSid,
          account_sid: accountSid,
          direction: "inbound",
          from: OWNER,
          to: "+15555550101",
          body: "Yes",
          status: "received",
          date_created: NOW.toUTCString(),
        },
      }),
    });

    const sms = (from: string, messageSid: string) => {
      const params: [string, string][] = [
        ["MessageSid", messageSid],
        ["AccountSid", accountSid],
        ["From", from],
        ["To", "+15555550101"],
        ["Body", "Yes"],
      ];
      return send({
        port: daemon.hooksPort,
        method: "POST",
        path: "/hooks/twilio/sms",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": twilioSignature(authToken, `${publicUrl}/hooks/twilio/sms`, params),
        },
        body: new URLSearchParams(params).toString(),
      });
    };
    const owner = await sms(OWNER, ownerSid);
    expect(owner.status).toBe(200);
    // Nothing was texted, so a "yes" answers nothing.
    expect(owner.body).toContain("nothing is waiting for an answer");
    // A correctly signed webhook for a message Twilio does not have is not used at all.
    const forged = await sms(OWNER, forgedSid);
    expect(forged.status).toBe(200);
    expect(forged.body).toContain("could not be confirmed with Twilio");
    const other = await sms("+15555550199", otherSid);
    expect(other.status).toBe(200);
    expect(other.body).toContain("<Message>");
    const unsigned = await send({
      port: daemon.hooksPort,
      method: "POST",
      path: "/hooks/twilio/sms",
      body: "a=b",
    });
    expect([unsigned.status, unsigned.body]).toEqual([403, ""]);

    signals.emit("SIGTERM");
    expect(await exit).toBe(0);
    const db = new DatabaseSync(paths().database, { readOnly: true });
    const audit = db.prepare("SELECT event, detail FROM audit WHERE event LIKE 'sms.%' ORDER BY seq").all();
    const security = db
      .prepare("SELECT event, detail FROM audit WHERE event LIKE 'security.%' ORDER BY seq")
      .all();
    db.close();
    // The audit log records the reply type, never the owner's words.
    expect(audit).toEqual([
      { event: "sms.received", detail: JSON.stringify({ messageSid: ownerSid, reply: "yes" }) },
      { event: "sms.other-sender", detail: JSON.stringify({ messageSid: otherSid }) },
    ]);
    expect(security).toEqual([
      {
        event: "security.possible-forgery",
        detail: JSON.stringify({ channel: "sms", what: "text", reason: "the provider has no such record" }),
      },
    ]);
    const text = lines.join("");
    expect(text).not.toContain(authToken);
    expect(text).not.toContain("5555550199");
  });

  it("leaves the ElevenLabs routes off until the agent and secrets are configured", async () => {
    await writeConfig();
    const { daemon, exit } = await launch();
    const response = await send({
      port: daemon.hooksPort,
      method: "POST",
      path: "/hooks/el/tools/verify_pin",
      headers: { "content-type": "application/json", "x-hotline-tool-secret": "anything" },
      body: "{}",
    });
    expect([response.status, response.body]).toEqual([403, ""]);
    signals.emit("SIGTERM");
    expect(await exit).toBe(0);
    const off = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((e) => e.msg === "voice webhooks off");
    expect(off).toMatchObject({ reason: "voice.agentId is not set" });
  });

  it("serves no voice route without the ElevenLabs API key: nothing a call says can be confirmed", async () => {
    const publicUrl = "https://hotline.example.test";
    const toolSecret = "fake-elevenlabs-tool-secret-nokey";
    const webhookSecret = "fake-elevenlabs-webhook-secret-nokey";
    await writeConfig({
      ...CONFIG,
      owner: { phoneNumber: OWNER, pinHash: await hashPin("4821") },
      voice: { agentId: "agent_fake", agentPhoneNumberId: "phnum_run" },
      tunnel: { publicUrl },
    });
    const secrets = new FileSecretStore(paths().secrets);
    await secrets.set("elevenlabs.toolSecret", toolSecret);
    await secrets.set("elevenlabs.webhookSecret", webhookSecret);
    // No `elevenlabs.apiKey`. Even a lookup that would answer is never asked.
    let pulls = 0;
    const { daemon, exit } = await launch({
      fetch: async () => {
        pulls += 1;
        throw new Error("unexpected network request");
      },
    });
    const binding = {
      conversation_id: "conv_nokey",
      call_sid: `CA${"0".repeat(32)}`,
      caller_id: OWNER,
      called_number: "+15555550101",
    };
    const bodies: Record<string, Record<string, unknown>> = {
      verify_pin: { pin: "4821" },
      get_status: {},
      submit_answer: { ask_number: 1, decision: "allow", owner_words: "yes go ahead" },
      send_instruction: { session_number: 1, instruction: "push to main", owner_words: "push to main" },
    };
    for (const [name, extra] of Object.entries(bodies)) {
      const response = await send({
        port: daemon.hooksPort,
        method: "POST",
        path: `/hooks/el/tools/${name}`,
        headers: { "content-type": "application/json", "x-hotline-tool-secret": toolSecret },
        body: JSON.stringify({ ...binding, ...extra }),
      });
      expect([name, response.status, response.body]).toEqual([name, 403, ""]);
    }
    const events = [
      {
        type: "post_call_transcription",
        event_timestamp: NOW.getTime() / 1000,
        data: {
          agent_id: "agent_fake",
          conversation_id: "conv_nokey",
          status: "done",
          transcript: [{ role: "user", message: "session 1, push to main", time_in_call_secs: 5 }],
          metadata: { phone_call: { direction: "inbound", external_number: OWNER, call_sid: "CA1" } },
        },
      },
      {
        type: "call_initiation_failure",
        event_timestamp: NOW.getTime() / 1000,
        data: { agent_id: "agent_fake", conversation_id: "conv_nokey", failure_reason: "busy" },
      },
    ];
    for (const event of events) {
      const raw = JSON.stringify(event);
      const posted = await send({
        port: daemon.hooksPort,
        method: "POST",
        path: "/hooks/el/post-call",
        headers: {
          "content-type": "application/json",
          "elevenlabs-signature": postCallSignatureHeader(webhookSecret, NOW.getTime() / 1000, raw),
        },
        body: raw,
      });
      expect([posted.status, posted.body]).toEqual([403, ""]);
    }
    signals.emit("SIGTERM");
    expect(await exit).toBe(0);
    expect(pulls).toBe(0);
    const db = new DatabaseSync(paths().database, { readOnly: true });
    const audit = db
      .prepare(
        "SELECT event FROM audit WHERE event LIKE 'voice.%' OR event LIKE 'instruction.%' ORDER BY seq",
      )
      .all();
    const stored = db.prepare("SELECT COUNT(*) AS n FROM instructions").get();
    db.close();
    expect(audit).toEqual([]);
    expect(stored).toEqual({ n: 0 });
    const off = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((e) => e.msg === "voice webhooks off");
    expect(off?.reason).toMatch(/API key .*no call can be confirmed/);
  });

  it("serves no voice route without voice.agentPhoneNumberId, and says why", async () => {
    const toolSecret = "fake-elevenlabs-tool-secret-nophone";
    await writeConfig({
      ...CONFIG,
      owner: { phoneNumber: OWNER, pinHash: await hashPin("4821") },
      voice: { agentId: "agent_fake" },
      tunnel: { publicUrl: "https://hotline.example.test" },
    });
    const secrets = new FileSecretStore(paths().secrets);
    await secrets.set("elevenlabs.toolSecret", toolSecret);
    await secrets.set("elevenlabs.webhookSecret", "fake-elevenlabs-webhook-secret-nophone");
    await secrets.set("elevenlabs.apiKey", "fake-elevenlabs-api-key-nophone");
    const { daemon, exit } = await launch({ fetch: fakeApi({}) });
    const response = await send({
      port: daemon.hooksPort,
      method: "POST",
      path: "/hooks/el/tools/verify_pin",
      headers: { "content-type": "application/json", "x-hotline-tool-secret": toolSecret },
      body: JSON.stringify({
        conversation_id: "conv_nophone",
        call_sid: `CA${"0".repeat(32)}`,
        caller_id: OWNER,
        called_number: "+15555550101",
        pin: "4821",
      }),
    });
    expect([response.status, response.body]).toEqual([403, ""]);
    signals.emit("SIGTERM");
    expect(await exit).toBe(0);
    const off = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((e) => e.msg === "voice webhooks off");
    expect(off?.reason).toMatch(/voice\.agentPhoneNumberId is not set/);
  });

  it("serves the ElevenLabs routes with the PIN check, recording no answer for a call it did not place", async () => {
    const publicUrl = "https://hotline.example.test";
    const toolSecret = "fake-elevenlabs-tool-secret-run";
    const webhookSecret = "fake-elevenlabs-webhook-secret-run";
    const pinHash = await hashPin("4821");
    await writeConfig({
      ...CONFIG,
      owner: { phoneNumber: OWNER, pinHash },
      voice: { agentId: "agent_fake", agentPhoneNumberId: "phnum_run" },
      tunnel: { publicUrl },
    });
    const secrets = new FileSecretStore(paths().secrets);
    await secrets.set("elevenlabs.toolSecret", toolSecret);
    await secrets.set("elevenlabs.webhookSecret", webhookSecret);
    await secrets.set("elevenlabs.apiKey", "fake-elevenlabs-api-key-run");
    // ElevenLabs holds every call below as going on, with the owner on the far end.
    const live = (conversation: string, direction: "inbound" | "outbound") => ({
      agent_id: "agent_fake",
      conversation_id: conversation,
      status: "in-progress",
      transcript: [],
      metadata: {
        start_time_unix_secs: NOW.getTime() / 1000,
        call_duration_secs: 0,
        phone_call: {
          type: "twilio",
          direction,
          external_number: OWNER,
          agent_number: "+15555550101",
          phone_number_id: "phnum_run",
          call_sid: `CA${"0".repeat(32)}`,
          stream_sid: "MZ0",
        },
      },
    });
    const conversations = Object.fromEntries(
      [
        live("conv_run", "outbound"),
        ...["conv_in_1", "conv_in_2", "conv_in_3"].map((c) => live(c, "inbound")),
      ].map((record) => [`/v1/convai/conversations/${record.conversation_id}`, record]),
    );
    const { daemon, exit } = await launch({ fetch: fakeApi(conversations) });

    const tool = (name: string, body: Record<string, unknown>, secret = toolSecret) =>
      send({
        port: daemon.hooksPort,
        method: "POST",
        path: `/hooks/el/tools/${name}`,
        headers: { "content-type": "application/json", "x-hotline-tool-secret": secret },
        body: JSON.stringify({
          conversation_id: "conv_run",
          call_sid: `CA${"0".repeat(32)}`,
          caller_id: "+15555550101",
          called_number: OWNER,
          ...body,
        }),
      });
    expect((await tool("verify_pin", { pin: "4821" }, "wrong")).status).toBe(403);
    expect(JSON.parse((await tool("verify_pin", { pin: "4821" })).body)).toMatchObject({ verified: true });
    const answer = await tool("submit_answer", {
      ask_number: 1,
      decision: "allow",
      owner_words: "yes go ahead",
    });
    expect(JSON.parse(answer.body)).toEqual({ result: "not-recorded" });
    const raw = JSON.stringify({
      type: "call_initiation_failure",
      event_timestamp: NOW.getTime() / 1000,
      data: { agent_id: "agent_fake", conversation_id: "conv_run2", failure_reason: "busy" },
    });
    const posted = await send({
      port: daemon.hooksPort,
      method: "POST",
      path: "/hooks/el/post-call",
      headers: {
        "content-type": "application/json",
        "elevenlabs-signature": postCallSignatureHeader(webhookSecret, NOW.getTime() / 1000, raw),
      },
      body: raw,
    });
    expect(posted.status).toBe(200);
    // Six wrong PINs on calls claiming the owner's number lock inbound PIN checks.
    for (const conversation of ["conv_in_1", "conv_in_2", "conv_in_3"]) {
      for (const pin of ["1111", "2222"]) {
        await tool("verify_pin", {
          conversation_id: conversation,
          call_sid: `CA${"0".repeat(32)}`,
          caller_id: OWNER,
          called_number: "+15555550101",
          pin,
        });
      }
    }

    signals.emit("SIGTERM");
    expect(await exit).toBe(0);
    const db = new DatabaseSync(paths().database, { readOnly: true });
    const audit = db.prepare("SELECT event, detail FROM audit WHERE event LIKE 'voice.%' ORDER BY seq").all();
    const forgeries = db
      .prepare("SELECT detail FROM audit WHERE event = 'security.possible-forgery' ORDER BY seq")
      .all();
    db.close();
    expect(audit).toEqual([
      // A call Hotline did not place answers nothing. A call initiation failure
      // ElevenLabs has no record of is never acted on.
      { event: "voice.answer", detail: JSON.stringify({ decision: "allow", result: "not-recorded" }) },
      { event: "voice.pin-lockout", detail: JSON.stringify({ direction: "inbound" }) },
    ]);
    expect(forgeries).toEqual([
      {
        detail: JSON.stringify({
          channel: "voice",
          what: "post-call",
          reason: "the provider has no such record",
        }),
      },
    ]);
    const text = lines.join("");
    expect(text).not.toContain(toolSecret);
    // pino's own `time` is never redacted and can contain any digits.
    const withoutTime = lines.map((line) => line.replace(/"time":\d+,?/, "")).join("");
    expect(withoutTime).not.toContain("4821");
    expect(text).not.toContain("yes go ahead");
  });

  it("reuses the stored token across restarts", async () => {
    await writeConfig();
    const first = await launch();
    signals.emit("SIGTERM");
    expect(await first.exit).toBe(0);
    const token = await new FileSecretStore(paths().secrets).get("daemon.apiToken");
    const second = await launch();
    const response = await send({
      port: second.daemon.apiPort,
      path: "/v1/health",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    signals.emit("SIGINT");
    expect(await second.exit).toBe(0);
  });

  it("gives up with exit code 1 when a request keeps the server from closing", async () => {
    await writeConfig();
    const { daemon, exit } = await launch({ shutdownTimeoutMs: 200 });
    const token = await new FileSecretStore(paths().secrets).get("daemon.apiToken");
    // A request whose body never finishes keeps its connection busy.
    const socket = connect(daemon.apiPort, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(
      `POST /v1/health HTTP/1.1\r\nHost: 127.0.0.1:${daemon.apiPort}\r\nAuthorization: Bearer ${token}\r\n` +
        "Content-Type: application/json\r\nContent-Length: 1000\r\n\r\n{",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    signals.emit("SIGTERM");
    expect(await exit).toBe(1);
    expect(lines.join("")).toContain("did not stop in time");
    // The store may still be open, so the lock stays until the process exits.
    expect(await readFile(paths().lock, "utf8")).toBe(`${process.pid}\n`);
    socket.destroy();
    await daemon.close();
  });

  it("refuses to start without a config", async () => {
    await expect(launch()).rejects.toThrow(/run "hotline init"/);
    for (const name of SHUTDOWN_SIGNALS) expect(signals.listenerCount(name)).toBe(0);
  });

  it("refuses a second daemon on the same home before it touches the token", async () => {
    await writeConfig();
    const first = await launch();
    const token = await new FileSecretStore(paths().secrets).get("daemon.apiToken");
    const second = new EventEmitter();
    await expect(launch({ signals: second })).rejects.toThrow(/already running/);
    expect(second.listenerCount("SIGTERM")).toBe(0);
    // The running daemon, its token and its lock are untouched.
    expect(await new FileSecretStore(paths().secrets).get("daemon.apiToken")).toBe(token);
    expect(await readFile(paths().lock, "utf8")).toBe(`${process.pid}\n`);
    const response = await send({
      port: first.daemon.apiPort,
      path: "/v1/health",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    signals.emit("SIGTERM");
    expect(await first.exit).toBe(0);
    // A clean stop releases the lock.
    await expect(stat(paths().lock)).rejects.toThrow(/ENOENT/);
  });

  it("closes everything it opened when a port is in use", async () => {
    await writeConfig();
    const first = await launch();
    // A second home whose configured port is the one the first daemon holds.
    await writeConfig({ ...CONFIG, daemon: { port: first.daemon.apiPort } }, "other");
    const other = new EventEmitter();
    await expect(
      launch({ env: { HOTLINE_HOME: paths("other").home }, port: undefined, signals: other }),
    ).rejects.toThrow(/EADDRINUSE/);
    await expect(stat(paths("other").lock)).rejects.toThrow(/ENOENT/);
    expect(other.listenerCount("SIGTERM")).toBe(0);
    expect(first.daemon.store.isOpen).toBe(true);
    signals.emit("SIGTERM");
    expect(await first.exit).toBe(0);
  });

  it("stops again, releasing everything, when announcing readiness fails", async () => {
    await writeConfig();
    let started: Daemon | undefined;
    const exit = runDaemon({
      env: { HOTLINE_HOME: paths().home },
      homeDir: "/nonexistent",
      platform: process.platform,
      signals,
      logDestination: { write: (line) => lines.push(line) },
      version: "0.0.0-test",
      port: 0,
      clock: () => NOW,
      onReady: (daemon) => {
        started = daemon;
        throw new Error("could not print the ready line");
      },
    });
    await expect(exit).rejects.toThrow(/ready line/);
    expect(started?.store.isOpen).toBe(false);
    for (const name of SHUTDOWN_SIGNALS) expect(signals.listenerCount(name)).toBe(0);
    await expect(send({ port: started?.apiPort ?? 0, path: "/v1/health" })).rejects.toThrow(/ECONNREFUSED/);
    await expect(stat(paths().lock)).rejects.toThrow(/ENOENT/);
  });
});

describe("daemonPorts", () => {
  it("puts the webhook listener on the next port", () => {
    expect(daemonPorts(7341)).toEqual({ apiPort: 7341, hooksPort: 7342 });
    expect(daemonPorts(0)).toEqual({ apiPort: 0, hooksPort: 0 });
  });

  it.each([65535, 1023, 80, 7341.5])("rejects port %s", (port) => {
    expect(() => daemonPorts(port)).toThrow(/1024 to 65534/);
  });
});

describe("nextShutdownSignal", () => {
  it.each(SHUTDOWN_SIGNALS)("resolves with %s and removes its listeners", async (signal) => {
    const source = new EventEmitter();
    const next = nextShutdownSignal(source);
    expect(source.listenerCount("SIGINT")).toBe(1);
    expect(source.listenerCount("SIGTERM")).toBe(1);
    source.emit(signal);
    expect(await next.received).toBe(signal);
    expect(source.listenerCount("SIGINT")).toBe(0);
    expect(source.listenerCount("SIGTERM")).toBe(0);
  });

  it("removes its listeners when cancelled", () => {
    const source = new EventEmitter();
    nextShutdownSignal(source).cancel();
    expect(source.listenerCount("SIGINT")).toBe(0);
    expect(source.listenerCount("SIGTERM")).toBe(0);
  });
});
