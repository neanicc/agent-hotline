import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { twilioSignature } from "@hotline/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Daemon,
  daemonPorts,
  FileSecretStore,
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
    const { daemon, exit } = await launch();

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
    const ownerSid = `SM${"1".repeat(32)}`;
    const otherSid = `SM${"2".repeat(32)}`;
    expect((await sms(OWNER, ownerSid)).status).toBe(200);
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
    db.close();
    // The owner's words are not stored until orchestration (HL-09) records an answer.
    expect(audit).toEqual([
      { event: "sms.received", detail: JSON.stringify({ messageSid: ownerSid, reply: "yes" }) },
      { event: "sms.other-sender", detail: JSON.stringify({ messageSid: otherSid }) },
    ]);
    const text = lines.join("");
    expect(text).not.toContain(authToken);
    expect(text).not.toContain("5555550199");
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
