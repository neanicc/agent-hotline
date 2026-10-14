// Pulling a record back from a provider's REST API (HL-13a). A webhook is only a
// trigger: before a text or a call can decide anything, the daemon fetches the
// message or the conversation from Twilio or ElevenLabs and uses that record.
// A same-user process that can read Hotline's webhook secrets can sign a
// webhook, but it cannot make the owner's message or the owner's speech exist
// at the provider.
import type { HttpFetch } from "./twilio-sms.js";

/**
 * Why a pull gave no record:
 * - `not-found`: the provider has no such message or conversation (HTTP 404),
 *   the mark of a forged webhook;
 * - `unreachable`: the request did not complete;
 * - `refused`: any other non-2xx answer (bad credentials, rate limit, outage);
 * - `malformed`: the provider answered with something that is not the record asked for;
 * - `unsupported`: the provider cannot pull at all.
 */
export type PullFailure = "not-found" | "unreachable" | "refused" | "malformed" | "unsupported";

/** A failed pull. The message never quotes the provider's response, which can echo numbers or words. */
export class PullError extends Error {
  override readonly name = "PullError";
  constructor(
    message: string,
    readonly reason: PullFailure,
    /** HTTP status of the provider's response, when there was one. */
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * GETs `url` and returns its parsed JSON body, or throws `PullError`. Only a
 * system error code (such as ECONNREFUSED) is kept from a network failure: the
 * original error can name the request URL, which holds account ids.
 */
export async function pullJson(
  fetch: HttpFetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  provider: string,
): Promise<unknown> {
  let response: Awaited<ReturnType<HttpFetch>>;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
    const reason =
      typeof cause?.code === "string" && /^[A-Z_]{1,40}$/.test(cause.code) ? ` (${cause.code})` : "";
    throw new PullError(`Could not reach ${provider}${reason}`, "unreachable");
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  if (response.status === 404) {
    throw new PullError(`${provider} has no such record (HTTP 404)`, "not-found", 404);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new PullError(
      `${provider} refused the lookup (HTTP ${response.status})`,
      "refused",
      response.status,
    );
  }
  if (parsed === undefined) throw new PullError(`${provider} answered without a record`, "malformed");
  return parsed;
}
