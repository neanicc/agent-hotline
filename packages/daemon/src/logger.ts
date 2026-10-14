// Daemon logging: Fastify's pino logger writing JSON lines through a stream
// that redacts each line just before it leaves the process. Redacting the final
// line, rather than individual fields, also covers messages, child bindings and
// whatever the request, response and error serializers produce.
import type { Redactor } from "./redact.js";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

/** Where log lines go, such as `process.stderr`. */
export interface LogDestination {
  write(line: string): unknown;
}

export interface LogOptions {
  level?: LogLevel;
  destination: LogDestination;
  redactor: Redactor;
}

/** A pino-compatible stream that redacts every line it is given. */
export function redactingStream(
  destination: LogDestination,
  redactor: Redactor,
): { write(line: string): void } {
  return {
    write(line: string) {
      let redacted: string;
      try {
        redacted = `${JSON.stringify(redactor.value(JSON.parse(line)))}\n`;
      } catch {
        redacted = redactor.text(line);
      }
      destination.write(redacted);
    },
  };
}

/** Path of a request URL without its query string or fragment, which may carry provider parameters. */
export function urlPath(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/**
 * Fastify logs every request it receives, before any auth or verification hook
 * runs. This replaces its request serializer so those lines carry the method and
 * path only: never the query string, headers or body of a request that may later
 * be rejected.
 */
export function requestSerializer(request: { method?: string; url?: string }): Record<string, string> {
  return { method: request.method ?? "", path: urlPath(request.url ?? "") };
}

/** The `logger` option for a Fastify instance; `name` labels its lines (`agent-api`, `webhooks`). */
export function fastifyLoggerOptions({ level = "info", destination, redactor }: LogOptions, name: string) {
  return {
    level,
    name,
    serializers: { req: requestSerializer },
    stream: redactingStream(destination, redactor),
  };
}
