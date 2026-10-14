// The per-install token agents present to the local API. It lives in the secret
// store as `daemon.apiToken` (the Keychain on macOS, else the 0600 secrets file),
// where the MCP server and hook adapters read it too.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SecretStore } from "@hotline/core";

/** 32 random bytes, base64url: 43 characters. */
export const API_TOKEN_BYTES = 32;
/** A stored token shorter than this is replaced rather than trusted. */
export const MIN_API_TOKEN_LENGTH = 32;

export function generateApiToken(): string {
  return randomBytes(API_TOKEN_BYTES).toString("base64url");
}

/**
 * Returns the install's API token, creating and storing one on first use. A token
 * too short to be one Hotline generated is replaced.
 */
export async function ensureApiToken(store: SecretStore): Promise<string> {
  const existing = await store.get("daemon.apiToken");
  if (existing !== undefined && existing.length >= MIN_API_TOKEN_LENGTH) return existing;
  const token = generateApiToken();
  await store.set("daemon.apiToken", token);
  return token;
}

/**
 * Constant-time comparison. Both sides are hashed first, so neither the content
 * nor the length of the expected token leaks through timing.
 */
export function tokensMatch(presented: string, expected: string): boolean {
  if (expected.length === 0) return false;
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** The token from an `Authorization: Bearer <token>` header, or undefined. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer ([\x21-\x7e]+)$/i.exec(header);
  return match?.[1];
}
