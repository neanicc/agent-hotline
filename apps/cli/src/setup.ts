// Finds the daemon a client command talks to: the config in the hotline home and
// the per-install API token in the configured secret store. Never creates either.
import type { Config } from "@hotline/core";
import type { CliContext } from "./cli.js";

export interface DaemonSetup {
  config: Config;
  token: string;
}

/** Throws with a message for the owner (never a secret) when Hotline is not set up. */
export async function loadDaemonSetup(context: CliContext): Promise<DaemonSetup> {
  const { hotlinePaths, loadConfig, openSecretStore } = await import("@hotline/daemon");
  const paths = hotlinePaths({ env: context.env, homeDir: context.homeDir });
  const config = await loadConfig(paths.config);
  const secrets = openSecretStore({
    choice: config.secrets.store,
    platform: context.platform,
    filePath: paths.secrets,
  });
  const token = await secrets.get("daemon.apiToken");
  if (token === undefined) throw new Error('no API token yet; start "hotline daemon" first');
  return { config, token };
}
