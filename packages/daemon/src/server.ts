// The daemon's two HTTP listeners, both bound to 127.0.0.1 only:
//
// - the agent API, for the MCP server and hook adapters on this Mac. Every
//   request, including one for a path that does not exist, needs the
//   per-install token and a loopback Host header;
// - the webhook listener, which serves only `/hooks/*` and is the one port the
//   tunnel forwards. Each webhook route must declare how it verifies its caller;
//   a route without a verifier, a failed verification and every path not yet
//   implemented get 403. Bodies of rejected requests are never logged.
//
// Keeping them on separate ports means a tunnel pointed at the webhook port
// cannot reach the agent API, whatever the tunnel's own path rules say.
import type { AddressInfo } from "node:net";
import type { FormParams } from "@hotline/providers";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { bearerToken, tokensMatch } from "./api-token.js";
import { fastifyLoggerOptions, type LogOptions, urlPath } from "./logger.js";
import type { HotlineStore } from "./store.js";

/** The only address the daemon listens on. Not configurable. */
export const LOOPBACK_HOST = "127.0.0.1";
/** Path prefix of every public webhook route; the only paths the tunnel exposes. */
export const HOOKS_PREFIX = "/hooks";

const AGENT_API_BODY_LIMIT = 1024 * 1024;
const WEBHOOK_BODY_LIMIT = 256 * 1024;

/** Proves a webhook came from its provider. Only a literal `true` lets the request through. */
export type WebhookVerifier = (request: FastifyRequest) => boolean | Promise<boolean>;

/**
 * A cheap check that runs before the body is read, such as "the signature header
 * is present". Only a literal `true` lets the request on to parsing.
 */
export type WebhookPrecheck = (request: FastifyRequest) => boolean;

declare module "fastify" {
  interface FastifyContextConfig {
    verifyWebhook?: WebhookVerifier;
    precheckWebhook?: WebhookPrecheck;
  }
}

export interface WebhookRoute {
  method: "GET" | "POST";
  /** Path below `/hooks`, such as `/twilio/sms`. */
  url: string;
  precheck?: WebhookPrecheck;
  verify: WebhookVerifier;
  handler: (request: FastifyRequest, reply: FastifyReply) => unknown;
}

function decodeFormComponent(text: string): string {
  return decodeURIComponent(text.replace(/\+/g, " "));
}

/**
 * Strictly parses an `application/x-www-form-urlencoded` webhook body into its
 * parameters, in the order they arrived, with repeats kept so a verifier can
 * refuse them. Unlike `URLSearchParams`, a malformed escape, invalid UTF-8 or an
 * empty `&&` segment is an error, never a guess.
 */
export function parseFormBody(text: string): FormParams {
  if (text.length === 0) return [];
  return text.split("&").map((part): [string, string] => {
    if (part.length === 0) throw new Error("empty form parameter");
    const equals = part.indexOf("=");
    const name = equals === -1 ? part : part.slice(0, equals);
    const value = equals === -1 ? "" : part.slice(equals + 1);
    return [decodeFormComponent(name), decodeFormComponent(value)];
  });
}

function boundPort(app: FastifyInstance): number | undefined {
  const address = app.server.address() as AddressInfo | string | null;
  return typeof address === "object" && address !== null ? address.port : undefined;
}

function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  const status =
    error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 500;
  if (status === 500) request.log.error({ err: error }, "request failed");
  // Never echo internal error messages to the caller.
  void reply.code(status).send({ error: status === 500 ? "internal error" : "request rejected" });
}

/** A webhook rejection: the same bare 403 for every reason, so a scanner learns nothing. */
function rejectWebhook(request: FastifyRequest, reply: FastifyReply, reason: string) {
  // Method and path only: never the body, headers or query of an unverified request.
  request.log.warn({ method: request.method, path: urlPath(request.url), reason }, "rejected webhook");
  return reply.code(403).send();
}

/**
 * On the webhook listener, a request the server could not read (malformed body,
 * unsupported content type, too large) gets the same bare 403 as a failed
 * verification, never a 4xx that shows the route exists.
 */
function webhookErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  const status = error.statusCode;
  if (status !== undefined && status >= 400 && status < 500) {
    void rejectWebhook(request, reply, "unreadable request");
    return;
  }
  errorHandler(error, request, reply);
}

function notFound(_request: FastifyRequest, reply: FastifyReply): void {
  void reply.code(404).send({ error: "not found" });
}

export interface AgentApiOptions {
  apiToken: string;
  log: LogOptions;
  version: string;
}

/** The token-protected local API agents talk to. Call `listen` on 127.0.0.1 only. */
export function buildAgentApi({ apiToken, log, version }: AgentApiOptions): FastifyInstance {
  const app = Fastify({
    logger: fastifyLoggerOptions(log, "agent-api"),
    bodyLimit: AGENT_API_BODY_LIMIT,
    return503OnClosing: true,
  });
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFound);

  app.addHook("onRequest", async (request, reply) => {
    // A Host other than this listener's loopback address means a browser page
    // (DNS rebinding) or a tunnel pointed at the wrong port.
    const port = boundPort(app);
    const host = request.headers.host?.toLowerCase();
    if (port === undefined || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
      request.log.warn(
        { method: request.method, path: urlPath(request.url) },
        "agent API: wrong Host header",
      );
      return reply.code(403).send({ error: "forbidden" });
    }
    const presented = bearerToken(request.headers.authorization);
    if (presented === undefined || !tokensMatch(presented, apiToken)) {
      request.log.warn(
        { method: request.method, path: urlPath(request.url) },
        "agent API: missing or wrong token",
      );
      return reply
        .code(401)
        .header("www-authenticate", 'Bearer realm="hotline"')
        .send({ error: "unauthorized" });
    }
    return undefined;
  });

  app.get("/v1/health", async () => ({ ok: true, version }));
  return app;
}

export interface WebhookServerOptions {
  log: LogOptions;
  /** Verified webhook routes; later tickets add Twilio and ElevenLabs here. */
  routes?: readonly WebhookRoute[];
}

/** The public listener: `/hooks/*` only, and every route verifies its caller. */
export function buildWebhookServer({ log, routes = [] }: WebhookServerOptions): FastifyInstance {
  const app = Fastify({
    logger: fastifyLoggerOptions(log, "webhooks"),
    bodyLimit: WEBHOOK_BODY_LIMIT,
    return503OnClosing: true,
  });
  app.setErrorHandler(webhookErrorHandler);
  app.setNotFoundHandler(notFound);
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        done(null, parseFormBody(body as string));
      } catch {
        // The webhook error handler turns any 4xx into the uniform 403.
        done(Object.assign(new Error("malformed form body"), { statusCode: 400 }), undefined);
      }
    },
  );

  void app.register(
    async (hooks) => {
      // Before the body is read: a route that cannot verify its caller is refused
      // outright, and a route's precheck (such as "the signature header is there")
      // runs before any parsing.
      hooks.addHook("onRequest", async (request, reply) => {
        const config = request.routeOptions.config;
        if (config.verifyWebhook === undefined) return rejectWebhook(request, reply, "no verifier");
        let passed = true;
        try {
          passed = config.precheckWebhook === undefined || config.precheckWebhook(request) === true;
        } catch {
          passed = false;
        }
        return passed ? undefined : rejectWebhook(request, reply, "precheck failed");
      });
      // After parsing, so verifiers can check signatures over the parameters or body.
      hooks.addHook("preHandler", async (request, reply) => {
        const verify = request.routeOptions.config.verifyWebhook;
        let verified = false;
        try {
          verified = verify !== undefined && (await verify(request)) === true;
        } catch {
          verified = false;
        }
        return verified ? undefined : rejectWebhook(request, reply, "verification failed");
      });

      for (const route of routes) {
        hooks.route({
          method: route.method,
          url: route.url,
          config: { verifyWebhook: route.verify, precheckWebhook: route.precheck },
          handler: route.handler,
        });
      }
      // Everything else under /hooks: no verifier, so the onRequest hook answers 403.
      const unreachable = async () => {
        throw new Error("unverified webhook reached a handler");
      };
      hooks.all("/", unreachable);
      hooks.all("/*", unreachable);
    },
    { prefix: HOOKS_PREFIX },
  );
  return app;
}

export interface StartDaemonOptions {
  apiToken: string;
  /** Owned by the daemon from here on: `close()` closes it after the listeners. */
  store: HotlineStore;
  /** 0 picks a free port (tests). */
  apiPort: number;
  /** 0 picks a free port (tests). */
  hooksPort: number;
  log: LogOptions;
  version: string;
  webhookRoutes?: readonly WebhookRoute[];
}

export interface Daemon {
  readonly apiUrl: string;
  readonly hooksUrl: string;
  readonly apiPort: number;
  readonly hooksPort: number;
  /** Every address either listener is bound to; always 127.0.0.1. */
  readonly addresses: readonly AddressInfo[];
  readonly store: HotlineStore;
  readonly log: FastifyBaseLogger;
  /** Stops accepting requests, lets in-flight ones finish, then closes the store. Idempotent. */
  close(): Promise<void>;
}

/** Starts both listeners on 127.0.0.1. On failure nothing is left listening; the caller keeps the store. */
export async function startDaemon(options: StartDaemonOptions): Promise<Daemon> {
  const api = buildAgentApi({ apiToken: options.apiToken, log: options.log, version: options.version });
  const hooks = buildWebhookServer({ log: options.log, routes: options.webhookRoutes });
  try {
    await api.listen({ host: LOOPBACK_HOST, port: options.apiPort });
    await hooks.listen({ host: LOOPBACK_HOST, port: options.hooksPort });
  } catch (error) {
    await Promise.allSettled([api.close(), hooks.close()]);
    throw error;
  }
  const apiPort = boundPort(api) ?? options.apiPort;
  const hooksPort = boundPort(hooks) ?? options.hooksPort;

  let closing: Promise<void> | undefined;
  return {
    apiUrl: `http://${LOOPBACK_HOST}:${apiPort}`,
    hooksUrl: `http://${LOOPBACK_HOST}:${hooksPort}${HOOKS_PREFIX}`,
    apiPort,
    hooksPort,
    addresses: [...api.addresses(), ...hooks.addresses()],
    store: options.store,
    log: api.log,
    close() {
      closing ??= (async () => {
        await Promise.allSettled([api.close(), hooks.close()]);
        options.store.close();
      })();
      return closing;
    },
  };
}
