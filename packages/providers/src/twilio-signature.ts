// Twilio webhook signatures (`X-Twilio-Signature`), following Twilio's documented
// algorithm (https://www.twilio.com/docs/usage/security#validating-requests):
//
// 1. Take the full URL Twilio requested, from the scheme through the query string.
// 2. For a form-encoded POST, sort the parameters by name (case-sensitive, by
//    code unit) and append each name and value to the URL, with no delimiters.
// 3. HMAC-SHA1 that string with the account's auth token as the key.
// 4. Base64-encode the hash and compare it with the header.
//
// Written by hand instead of pulling in the `twilio` package for one HMAC.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Form parameters in the order they arrived. Names may repeat; see `validTwilioSignature`. */
export type FormParams = readonly (readonly [string, string])[];

/** The string Twilio signs: the URL followed by every parameter name and value, sorted by name. */
export function twilioSignaturePayload(url: string, params: FormParams): string {
  const sorted = [...params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted.reduce((payload, [name, value]) => payload + name + value, url);
}

/** The `X-Twilio-Signature` value Twilio would send for this URL and these parameters. */
export function twilioSignature(authToken: string, url: string, params: FormParams): string {
  return createHmac("sha1", authToken).update(twilioSignaturePayload(url, params), "utf8").digest("base64");
}

/**
 * True only when `header` is Twilio's signature for `url` and `params` under
 * `authToken`, compared in constant time. Fails closed: an empty token, a missing
 * header, or a parameter name that appears twice (Twilio's SMS webhooks never
 * repeat one, and the sort order of repeats is ambiguous) is never valid.
 */
export function validTwilioSignature(
  authToken: string,
  url: string,
  params: FormParams,
  header: string | undefined,
): boolean {
  if (authToken.length === 0 || header === undefined || header.length === 0) return false;
  const names = new Set(params.map(([name]) => name));
  if (names.size !== params.length) return false;
  const expected = twilioSignature(authToken, url, params);
  // Hash both sides so neither the content nor the length leaks through timing.
  const a = createHash("sha256").update(header, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
