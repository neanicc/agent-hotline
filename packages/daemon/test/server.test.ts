import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWebhookServer,
  createRedactor,
  type Daemon,
  generateApiToken,
  HOOKS_PREFIX,
  LOOPBACK_HOST,
  type LogOptions,
  openStore,
  type StartDaemonOptions,
  startDaemon,
  type WebhookRoute,
} from "../src/index.js";
import { send } from "./http.js";

const OWNER = "+15555550100";

let dir: string;
let lines: string[];
let log: LogOptions;
let token: string;
const running: Daemon[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hotline-server-"));
  lines = [];
  token = generateApiToken();
  log = {
    level: "info",
    destination: { write: (line) => lines.push(line) },
    redactor: createRedactor([token]),
  };
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.close()));
  await rm(dir, { recursive: true, force: true });
});

async function start(overrides: Partial<StartDaemonOptions> = {}): Promise<Daemon> {
  const store = await openStore(join(dir, `${running.length}.db`));
  try {
    const daemon = await startDaemon({
      apiToken: token,
      store,
      apiPort: 0,
      hooksPort: 0,
      log,
      version: "0.0.0-test",
      ...overrides,
    });
    running.push(daemon);
    return daemon;
  } catch (error) {
    store.close();
    throw error;
  }
}

const logText = () => lines.join("");
const logEntries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, LOOPBACK_HOST, () => probe.close(() => resolve(true)));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, LOOPBACK_HOST, () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe("listeners", () => {
  it("bind 127.0.0.1 only, on two different ports", async () => {
    const daemon = await start();
    expect(daemon.addresses.length).toBe(2);
    for (const address of daemon.addresses) {
      expect(address.address).toBe("127.0.0.1");
      expect(address.family).toBe("IPv4");
    }
    expect(daemon.apiPort).not.toBe(daemon.hooksPort);
    expect(daemon.apiUrl).toBe(`http://127.0.0.1:${daemon.apiPort}`);
    expect(daemon.hooksUrl).toBe(`http://127.0.0.1:${daemon.hooksPort}/hooks`);
  });

  it("leave nothing listening when one port is taken", async () => {
    const first = await start();
    const apiPort = await freePort();
    await expect(start({ apiPort, hooksPort: first.apiPort })).rejects.toThrow(/EADDRINUSE/);
    // The second daemon's agent API had started; it was closed again.
    expect(await portIsFree(apiPort)).toBe(true);
    expect(running).toHaveLength(1);
  });
});

describe("agent API", () => {
  const auth = () => ({ authorization: `Bearer ${token}` });

  it("answers health checks that carry the token", async () => {
    const daemon = await start();
    const response = await send({ port: daemon.apiPort, path: "/v1/health", headers: auth() });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, version: "0.0.0-test" });
  });

  it.each([
    ["no Authorization header", {}],
    ["a wrong token", { authorization: `Bearer ${generateApiToken()}` }],
    ["a truncated token", { authorization: "Bearer x" }],
    ["another scheme", { authorization: "Basic dXNlcjpwYXNz" }],
  ])("rejects a request with %s", async (_name, headers: Record<string, string>) => {
    const daemon = await start();
    const response = await send({ port: daemon.apiPort, path: "/v1/health", headers });
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toBe('Bearer realm="hotline"');
    expect(JSON.parse(response.body)).toEqual({ error: "unauthorized" });
  });

  it("does not reveal which paths exist without the token", async () => {
    const daemon = await start();
    expect((await send({ port: daemon.apiPort, path: "/v1/secret-admin" })).status).toBe(401);
    expect((await send({ port: daemon.apiPort, path: "/v1/secret-admin", headers: auth() })).status).toBe(
      404,
    );
  });

  it.each(["evil.example", "abc.ngrok.app", "127.0.0.1:1"])(
    "refuses Host %s even with the right token",
    async (host) => {
      const daemon = await start();
      const response = await send({ port: daemon.apiPort, path: "/v1/health", headers: { ...auth(), host } });
      expect(response.status).toBe(403);
    },
  );

  it("accepts localhost as the Host", async () => {
    const daemon = await start();
    const host = `localhost:${daemon.apiPort}`;
    const response = await send({ port: daemon.apiPort, path: "/v1/health", headers: { ...auth(), host } });
    expect(response.status).toBe(200);
  });

  it("is not reachable on the webhook port", async () => {
    const daemon = await start();
    const response = await send({ port: daemon.hooksPort, path: "/v1/health", headers: auth() });
    expect(response.status).toBe(404);
  });

  it("never logs the token, and logs rejected requests without their query", async () => {
    const daemon = await start();
    await send({ port: daemon.apiPort, path: "/v1/health", headers: auth() });
    await send({
      port: daemon.apiPort,
      path: `/v1/health?to=${encodeURIComponent(OWNER)}&note=query-marker`,
    });
    expect(logText()).not.toContain(token);
    expect(logText()).not.toContain("5555550100");
    // Not even Fastify's own "incoming request" line carries the query.
    expect(logText()).not.toContain("query-marker");
    const rejected = logEntries().find((entry) => entry.msg === "agent API: missing or wrong token");
    expect(rejected).toMatchObject({ method: "GET", path: "/v1/health" });
    const incoming = logEntries().filter((entry) => entry.msg === "incoming request");
    expect(incoming.map((entry) => entry.req)).toEqual([
      { method: "GET", path: "/v1/health" },
      { method: "GET", path: "/v1/health" },
    ]);
  });
});

describe("webhook listener", () => {
  it.each([
    ["POST", "/hooks/twilio/sms"],
    ["POST", "/hooks/el/submit_answer"],
    ["GET", "/hooks/twilio/voice"],
    ["GET", "/hooks"],
    ["PUT", "/hooks/"],
    ["DELETE", "/hooks/a/b/c"],
  ])("rejects %s %s with 403 until a verified route exists", async (method, path) => {
    const daemon = await start();
    const response = await send({ port: daemon.hooksPort, method, path });
    expect(response.status).toBe(403);
    // Bare: the same empty 403 as a failed signature or an unreadable body.
    expect(response.body).toBe("");
  });

  it("serves nothing outside /hooks", async () => {
    const daemon = await start();
    expect((await send({ port: daemon.hooksPort, path: "/" })).status).toBe(404);
    expect((await send({ port: daemon.hooksPort, path: "/hooksx" })).status).toBe(404);
  });

  it("logs a rejected webhook without its body, headers or query", async () => {
    const daemon = await start();
    const body = `From=${encodeURIComponent(OWNER)}&Body=approve+everything+body-marker`;
    const response = await send({
      port: daemon.hooksPort,
      method: "POST",
      path: "/hooks/twilio/sms?query-marker=1",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "signature-marker",
      },
      body,
    });
    expect(response.status).toBe(403);
    const text = logText();
    for (const marker of ["body-marker", "approve", "signature-marker", "query-marker", "5555550100"]) {
      expect(text).not.toContain(marker);
    }
    const rejected = logEntries().find((entry) => entry.msg === "rejected webhook");
    expect(rejected).toMatchObject({ method: "POST", path: "/hooks/twilio/sms", reason: "no verifier" });
  });
});

describe("verified webhook routes", () => {
  function server(verify: WebhookRoute["verify"]) {
    return buildWebhookServer({
      log,
      routes: [{ method: "POST", url: "/test", verify, handler: async () => ({ ok: true }) }],
    });
  }

  it("reach their handler only when the verifier returns true", async () => {
    const app = server(() => true);
    const response = await app.inject({ method: "POST", url: `${HOOKS_PREFIX}/test`, payload: { a: 1 } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });

  it.each([
    ["false", () => false],
    ["a truthy non-boolean", () => "yes" as unknown as boolean],
    ["a rejected promise", async () => Promise.reject(new Error("bad signature"))],
    [
      "a thrown error",
      () => {
        throw new Error("bad signature");
      },
    ],
  ])("reject with 403 when the verifier returns %s", async (_name, verify) => {
    const app = server(verify);
    const response = await app.inject({ method: "POST", url: `${HOOKS_PREFIX}/test`, payload: { a: 1 } });
    expect(response.statusCode).toBe(403);
    const rejected = logEntries().find((entry) => entry.msg === "rejected webhook");
    expect(rejected).toMatchObject({ reason: "verification failed", path: "/hooks/test" });
    await app.close();
  });

  it("let other paths and methods fall through to 403", async () => {
    const app = server(() => true);
    expect((await app.inject({ method: "GET", url: `${HOOKS_PREFIX}/test` })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `${HOOKS_PREFIX}/other` })).statusCode).toBe(403);
    await app.close();
  });
});

describe("close", () => {
  it("stops both listeners and closes the store, once", async () => {
    const daemon = await start();
    const { apiPort, hooksPort } = daemon;
    await Promise.all([daemon.close(), daemon.close()]);
    expect(daemon.store.isOpen).toBe(false);
    expect(await portIsFree(apiPort)).toBe(true);
    expect(await portIsFree(hooksPort)).toBe(true);
    await expect(send({ port: apiPort, path: "/v1/health" })).rejects.toThrow(/ECONNREFUSED/);
  });
});
