// Finds the daemon a client command talks to: the config in the hotline home and
// the per-install API token in the configured secret store. Never creates either.
// Also the shared pieces the setup commands (init, install, doctor, voice,
// test-call) use: the secret store, test-mode guards and config edits.
import { readFile } from "node:fs/promises";
import {
  type Config,
  ConfigError,
  parseConfig,
  type SecretStore,
  type SecretStoreChoice,
} from "@hotline/core";
import type { HotlinePaths } from "@hotline/daemon";
import type { CliContext } from "./cli.js";

export interface DaemonSetup {
  config: Config;
  token: string;
}

/**
 * The HTTP client the setup commands use for the daemon's health check and the
 * ElevenLabs API. `main` passes the global `fetch`; tests pass a fake.
 */
export type CliFetch = (
  url: string,
  init: {
    method: "GET" | "POST" | "PATCH";
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    redirect?: "error";
  },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/**
 * True under the test runner, or when `HOTLINE_TEST_MODE=1`. In test mode the
 * commands refuse anything that could reach the developer's real Keychain,
 * agent configs or network.
 */
export function isTestMode(context: CliContext): boolean {
  return process.env.VITEST !== undefined || context.env.HOTLINE_TEST_MODE === "1";
}

/** The configured secret store. In test mode the Keychain needs an injected `exec`. */
export async function secretStoreFor(
  context: CliContext,
  choice: SecretStoreChoice,
  paths: HotlinePaths,
): Promise<SecretStore> {
  const { openSecretStore } = await import("@hotline/daemon");
  const keychain = choice === "keychain" || (choice === "auto" && context.platform === "darwin");
  if (keychain && context.exec === undefined && isTestMode(context)) {
    throw new Error("test mode: the Keychain secret store needs an injected exec");
  }
  return openSecretStore({
    choice,
    platform: context.platform,
    filePath: paths.secrets,
    ...(context.exec === undefined ? {} : { exec: context.exec }),
  });
}

/** The HTTP client for setup commands. In test mode one must be injected. */
export function fetchFor(context: CliContext): CliFetch {
  if (context.fetch !== undefined) return context.fetch;
  if (isTestMode(context)) throw new Error("test mode: no network; inject a fake fetch");
  return globalThis.fetch as unknown as CliFetch;
}

/** Throws with a message for the owner (never a secret) when Hotline is not set up. */
export async function loadDaemonSetup(context: CliContext): Promise<DaemonSetup> {
  const { hotlinePaths, loadConfig } = await import("@hotline/daemon");
  const paths = hotlinePaths({ env: context.env, homeDir: context.homeDir });
  const config = await loadConfig(paths.config);
  const secrets = await secretStoreFor(context, config.secrets.store, paths);
  const token = await secrets.get("daemon.apiToken");
  if (token === undefined) throw new Error('no API token yet; start "hotline daemon" first');
  return { config, token };
}

/**
 * Changes some settings in the config file and writes it back (0600), keeping
 * everything else as the owner wrote it. The result must still be a valid
 * config. Returns the parsed result.
 */
export async function updateConfigFile(
  path: string,
  change: (raw: Record<string, unknown>) => void,
): Promise<Config> {
  const { loadConfig, writePrivateFile } = await import("@hotline/daemon");
  // loadConfig checks the file is private and valid before anything is changed.
  await loadConfig(path);
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  change(raw);
  const config = parseConfig(raw);
  await writePrivateFile(path, `${JSON.stringify(raw, null, 2)}\n`);
  return config;
}

/** `raw[key]` as an object, created when missing. For `updateConfigFile` callbacks. */
export function section(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = raw[key];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (value !== undefined) throw new ConfigError("Invalid hotline config", [`${key}: must be an object`]);
  const created: Record<string, unknown> = {};
  raw[key] = created;
  return created;
}

/** The last four digits of a phone number, the only part output ever shows. */
export function lastFour(number: string): string {
  return `…${number.slice(-4)}`;
}
