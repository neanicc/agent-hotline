// Secret names, values and the store interface. Secrets never live in the config
// file; the daemon package implements this interface with the macOS Keychain
// (through `security`) and with a user-only 0600 file.
import { z } from "zod";

export const SecretName = z.enum([
  /**
   * Optional Anthropic API key for the reply judge (HL-09d), used only when
   * neither the Claude Code nor the Codex CLI is installed.
   */
  "anthropic.apiKey",
  /** Per-install token agents present to the local API on 127.0.0.1. */
  "daemon.apiToken",
  "elevenlabs.apiKey",
  /** Shared secret ElevenLabs server tools send to `/hooks/el/*`. */
  "elevenlabs.toolSecret",
  /** HMAC key for ElevenLabs post-call webhooks. */
  "elevenlabs.webhookSecret",
  "twilio.accountSid",
  "twilio.authToken",
]);
export type SecretName = z.infer<typeof SecretName>;

/**
 * A secret is printable ASCII on one line. API keys, tokens and SIDs all are, and
 * the restriction keeps every store's encoding unambiguous.
 */
export const SecretValue = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/, "must be printable ASCII without spaces or line breaks");

export const SecretStoreKind = z.enum(["keychain", "file"]);
export type SecretStoreKind = z.infer<typeof SecretStoreKind>;

export interface SecretStore {
  readonly kind: SecretStoreKind;
  /** The stored value, or undefined when the secret was never set. */
  get(name: SecretName): Promise<string | undefined>;
  /** Stores `value`, replacing any earlier one. Rejects a value `SecretValue` refuses. */
  set(name: SecretName, value: string): Promise<void>;
  /** Removes the secret. Deleting a missing secret is not an error. */
  delete(name: SecretName): Promise<void>;
}

/** On-disk shape of the 0600 fallback file. */
export const SecretFile = z.strictObject({
  version: z.literal(1),
  secrets: z.partialRecord(SecretName, SecretValue),
});
export type SecretFile = z.infer<typeof SecretFile>;

export class SecretStoreError extends Error {
  override readonly name = "SecretStoreError";
}
