// DaemonClient against plain HTTP servers on 127.0.0.1 that are not the daemon.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient, DaemonError } from "../src/index.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function failure(promise: Promise<unknown>): Promise<DaemonError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof DaemonError)) throw new Error(`expected a DaemonError, got ${String(error)}`);
  return error;
}

describe("DaemonClient", () => {
  it("talks to 127.0.0.1 with the bearer token", async () => {
    const seen: Array<{ host?: string; authorization?: string }> = [];
    const port = await serve((request, response) => {
      seen.push({ host: request.headers.host, authorization: request.headers.authorization });
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ cancelled: true }));
    });
    const client = new DaemonClient({ connection: async () => ({ port, token: "test-token-1" }) });
    expect(await client.cancelAsk("ask-1")).toBe(true);
    expect(seen).toEqual([{ host: `127.0.0.1:${port}`, authorization: "Bearer test-token-1" }]);
  });

  it("never follows a redirect, so neither the token nor the text reaches another server", async () => {
    let elsewhere = 0;
    const target = await serve((_request, response) => {
      elsewhere += 1;
      response.writeHead(200).end("{}");
    });
    const port = await serve((_request, response) => {
      response.writeHead(307, { location: `http://127.0.0.1:${target}/collect` }).end();
    });
    const client = new DaemonClient({ connection: async () => ({ port, token: "test-token-1" }) });
    const error = await failure(client.createAsk("session-1", { kind: "question", text: "Ship it?" }));
    expect(error.kind).toBe("unreachable");
    expect(elsewhere).toBe(0);
  });

  it("looks the port up again after a response that is not the daemon's", async () => {
    let lookups = 0;
    const port = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" }).end("<html>not hotline</html>");
    });
    const client = new DaemonClient({
      connection: async () => {
        lookups += 1;
        return { port, token: "test-token-1" };
      },
    });
    expect((await failure(client.cancelAsk("ask-1"))).kind).toBe("bad-response");
    expect((await failure(client.cancelAsk("ask-1"))).kind).toBe("bad-response");
    expect(lookups).toBe(2);
  });

  it("reports a missing setup as not-configured and retries the lookup next time", async () => {
    let lookups = 0;
    const client = new DaemonClient({
      connection: async () => {
        lookups += 1;
        throw new Error("no config");
      },
    });
    expect((await failure(client.cancelAsk("ask-1"))).kind).toBe("not-configured");
    expect((await failure(client.cancelAsk("ask-1"))).kind).toBe("not-configured");
    expect(lookups).toBe(2);
  });
});
