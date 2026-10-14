// Exposure audit (HL-13): with Twilio and ElevenLabs fully configured, the
// public (webhook) listener serves only `/hooks/*` and verifies every route;
// the agent API binds 127.0.0.1 only and needs the token, and a loopback Host,
// on every route it serves. The route lists come from the listeners
// themselves (`Daemon.routes`), so a route added later is audited too.
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Daemon,
  FileSecretStore,
  HOOKS_PREFIX,
  hashPin,
  hotlinePaths,
  LOOPBACK_HOST,
  runDaemon,
  writePrivateFile,
} from "../src/index.js";
import { send } from "./http.js";

const OWNER = "+15555550100";
const PUBLIC_URL = "https://hotline.example.test";

let dir: string;
let signals: EventEmitter;
let daemon: Daemon;
let exit: Promise<number>;
let apiToken: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hotline-hl13-exposure-"));
  signals = new EventEmitter();
  const paths = hotlinePaths({ env: { HOTLINE_HOME: join(dir, "home") }, homeDir: "/nonexistent" });
  await writePrivateFile(
    paths.config,
    JSON.stringify({
      version: 1,
      owner: { phoneNumber: OWNER, pinHash: await hashPin("4821") },
      quietHours: { timeZone: "America/Toronto" },
      secrets: { store: "file" },
      sms: { provider: "twilio", fromNumber: "+15555550101" },
      voice: { provider: "elevenlabs", agentId: "agent_fake", agentPhoneNumberId: "phnum_fake" },
      tunnel: { publicUrl: PUBLIC_URL },
    }),
  );
  const secrets = new FileSecretStore(paths.secrets);
  await secrets.set("twilio.accountSid", `AC${"0123456789abcdef".repeat(2)}`);
  await secrets.set("twilio.authToken", "fake-twilio-auth-token-exposure");
  await secrets.set("elevenlabs.apiKey", "fake-elevenlabs-api-key-exposure");
  await secrets.set("elevenlabs.toolSecret", "fake-elevenlabs-tool-secret-exposure");
  await secrets.set("elevenlabs.webhookSecret", "fake-elevenlabs-webhook-secret-exposure");
  let ready!: (daemon: Daemon) => void;
  const listening = new Promise<Daemon>((resolve) => {
    ready = resolve;
  });
  exit = runDaemon({
    env: { HOTLINE_HOME: paths.home },
    homeDir: "/nonexistent",
    platform: process.platform,
    signals,
    logDestination: { write: () => {} },
    version: "0.0.0-test",
    port: 0,
    clock: () => new Date("2026-10-13T21:58:00.000Z"),
    // Providers built from the config must never reach Twilio or ElevenLabs.
    fetch: async () => {
      throw new Error("unexpected network request");
    },
    autoTick: false,
    onReady: ready,
  });
  daemon = await Promise.race([
    listening,
    exit.then((code) => {
      throw new Error(`daemon exited with ${code} before it was ready`);
    }),
  ]);
  apiToken = (await secrets.get("daemon.apiToken")) ?? "";
});

afterAll(async () => {
  signals.emit("SIGTERM");
  await exit;
  await rm(dir, { recursive: true, force: true });
});

/** A concrete path for a route pattern: every `:param` and `*` filled in. */
const concrete = (url: string) => url.replace(/:[A-Za-z]+/g, "x-1").replace(/\*$/, "probe");

describe("exposure audit", () => {
  it("binds both listeners to 127.0.0.1 only", () => {
    expect(daemon.addresses.length).toBeGreaterThanOrEqual(2);
    for (const address of daemon.addresses) expect(address.address).toBe(LOOPBACK_HOST);
  });

  it("serves only /hooks/* on the public listener, including every configured webhook", () => {
    const urls = daemon.routes.hooks.map((route) => route.url);
    for (const url of urls)
      expect(url === HOOKS_PREFIX || url.startsWith(`${HOOKS_PREFIX}/`), url).toBe(true);
    // The audit only means something if the configured routes are really there.
    expect(urls).toEqual(
      expect.arrayContaining([
        "/hooks/twilio/sms",
        "/hooks/el/post-call",
        "/hooks/el/tools/submit_answer",
        "/hooks/el/tools/verify_pin",
        "/hooks/el/tools/get_status",
        "/hooks/el/tools/send_instruction",
      ]),
    );
  });

  it("refuses every public route without its provider's proof, with the same bare 403", async () => {
    // The catch-all under /hooks registers every method Node knows; probe the
    // ones a client can send plainly (CONNECT and friends change the protocol).
    const probed = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
    for (const { method, url } of daemon.routes.hooks.filter((route) => probed.has(route.method))) {
      for (const contentType of ["application/json", "application/x-www-form-urlencoded"]) {
        const bodyless = !["POST", "PUT", "PATCH"].includes(method);
        const response = await send({
          port: daemon.hooksPort,
          method,
          path: concrete(url),
          headers: { "content-type": contentType },
          body: bodyless ? undefined : contentType === "application/json" ? "{}" : "a=b",
        });
        expect([`${method} ${url}`, response.status, response.body]).toEqual([`${method} ${url}`, 403, ""]);
      }
    }
  });

  it("keeps the agent API under /v1 and off the public listener", async () => {
    expect(daemon.routes.api.length).toBeGreaterThan(5);
    for (const { method, url } of daemon.routes.api) {
      expect(url.startsWith("/v1/"), url).toBe(true);
      const response = await send({
        port: daemon.hooksPort,
        method,
        path: concrete(url),
        headers: { authorization: `Bearer ${apiToken}` },
      });
      expect([`${method} ${url}`, response.status]).toEqual([`${method} ${url}`, 404]);
    }
  });

  it("needs the token on every agent API route", async () => {
    const host = `127.0.0.1:${daemon.apiPort}`;
    for (const { method, url } of daemon.routes.api) {
      for (const authorization of [undefined, "Bearer wrong-token", `Basic ${apiToken}`, apiToken]) {
        const response = await send({
          port: daemon.apiPort,
          method,
          path: concrete(url),
          headers: { host, ...(authorization === undefined ? {} : { authorization }) },
        });
        expect([`${method} ${url} ${authorization === undefined ? "none" : "bad"}`, response.status]).toEqual(
          [`${method} ${url} ${authorization === undefined ? "none" : "bad"}`, 401],
        );
      }
    }
  });

  it("needs a loopback Host on every agent API route, even with the token", async () => {
    for (const { method, url } of daemon.routes.api) {
      const response = await send({
        port: daemon.apiPort,
        method,
        path: concrete(url),
        headers: { host: "hotline.example.test", authorization: `Bearer ${apiToken}` },
      });
      expect([`${method} ${url}`, response.status]).toEqual([`${method} ${url}`, 403]);
    }
  });

  it("answers paths outside /hooks on the public listener with 404 or 403, never content", async () => {
    for (const path of [
      "/",
      "/v1/health",
      "/HOOKS/twilio/sms",
      "/hooks/../v1/health",
      "/hooks",
      "/%2Fv1/health",
    ]) {
      const response = await send({
        port: daemon.hooksPort,
        path,
        headers: { authorization: `Bearer ${apiToken}` },
      });
      expect([403, 404], path).toContain(response.status);
      expect(response.body).not.toContain("version");
    }
  });
});
