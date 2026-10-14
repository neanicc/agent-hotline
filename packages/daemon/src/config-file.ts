// Locates and reads the hotline config. Parsing and validation live in @hotline/core.
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type Config, ConfigError, parseConfigText } from "@hotline/core";
import { privatePathProblem } from "./private-file.js";

export interface HotlinePaths {
  /** Directory holding Hotline's local state. */
  home: string;
  /** `config.json`: owner settings, no secrets. */
  config: string;
  /** `secrets.json`: the 0600 fallback secret store, used when the Keychain is not. */
  secrets: string;
}

export interface PathOptions {
  /** Environment to read `HOTLINE_HOME` from. */
  env: Readonly<Record<string, string | undefined>>;
  /** The user's home directory; `~/.hotline` is the default home. */
  homeDir: string;
}

/** Where Hotline keeps its files: `$HOTLINE_HOME`, else `~/.hotline`. */
export function hotlinePaths({ env, homeDir }: PathOptions): HotlinePaths {
  const override = env.HOTLINE_HOME;
  if (override !== undefined && override !== "" && !isAbsolute(override)) {
    throw new ConfigError("HOTLINE_HOME must be an absolute path", []);
  }
  const home = override || join(homeDir, ".hotline");
  return { home, config: join(home, "config.json"), secrets: join(home, "secrets.json") };
}

/**
 * Reads and validates the config at `path`. Throws ConfigError when it is
 * missing, readable by other users, or invalid; the message never quotes the file.
 */
export async function loadConfig(path: string): Promise<Config> {
  const problem = await privatePathProblem(path);
  if (problem === "missing") throw new ConfigError(`No hotline config at ${path}; run "hotline init"`, []);
  if (problem !== undefined) throw new ConfigError(`Hotline config ${path} ${problem}`, []);
  return parseConfigText(await readFile(path, "utf8"));
}
