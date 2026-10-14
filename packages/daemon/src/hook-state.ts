// Local state the hook adapters keep between runs, under the private-file rules
// (0600 files in 0700 directories, no symlinks, owned by the current user):
//
//   away.json            whether away mode is on (`hotline away on|off`)
//   hook-state/<agent>-<hash>.json
//                        consecutive Stop-hook continuations for one agent session
//
// Every reader fails safe. Away mode that cannot be read is off, so the agent
// shows its own terminal prompt. A continuation count that cannot be read is
// reported as an error, and the Stop hook then lets the agent stop.
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { type AgentKind, Timestamp } from "@hotline/core";
import { z } from "zod";
import { privatePathProblem, writePrivateFile } from "./private-file.js";

const AwayFile = z.strictObject({ version: z.literal(1), away: z.boolean(), changedAt: Timestamp });
export type AwayFile = z.infer<typeof AwayFile>;

const ContinuationFile = z.strictObject({
  version: z.literal(1),
  continuations: z.int().min(0).max(1000),
  updatedAt: Timestamp,
});

export interface AwayState {
  away: boolean;
  /** When it last changed, if known. */
  changedAt?: string;
  /** Why the file could not be used; away mode is then off. */
  problem?: string;
}

async function readPrivateJson<T>(path: string, schema: z.ZodType<T>): Promise<T | "missing"> {
  const problem = await privatePathProblem(path);
  if (problem === "missing") return "missing";
  if (problem !== undefined) throw new Error(`${path} ${problem}`);
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(`${path} has an unexpected shape`);
  return parsed.data;
}

/** Whether away mode is on. Never throws: a missing, unsafe or broken file means off. */
export async function readAwayState(path: string): Promise<AwayState> {
  try {
    const file = await readPrivateJson(path, AwayFile);
    if (file === "missing") return { away: false };
    return { away: file.away, changedAt: file.changedAt };
  } catch (error) {
    return { away: false, problem: (error as Error).message };
  }
}

export async function writeAwayState(path: string, away: boolean, at: Date): Promise<void> {
  const file: AwayFile = { version: 1, away, changedAt: at.toISOString() };
  await writePrivateFile(path, `${JSON.stringify(file, null, 2)}\n`);
}

/** Consecutive away-mode continuations per agent session, one small private file each. */
export class FileContinuationStore {
  constructor(private readonly directory: string) {}

  /** The file for a session. Hashed, so an agent's session id never becomes a path. */
  private path(agent: AgentKind, agentSessionId: string): string {
    const hash = createHash("sha256").update(`${agent}\n${agentSessionId}`).digest("hex").slice(0, 32);
    return join(this.directory, `${agent}-${hash}.json`);
  }

  /** The count, 0 when none is stored. Throws when the file exists but cannot be trusted. */
  async get(agent: AgentKind, agentSessionId: string): Promise<number> {
    const file = await readPrivateJson(this.path(agent, agentSessionId), ContinuationFile);
    return file === "missing" ? 0 : file.continuations;
  }

  async set(agent: AgentKind, agentSessionId: string, continuations: number, at: Date): Promise<void> {
    const path = this.path(agent, agentSessionId);
    if (continuations === 0 && (await privatePathProblem(path)) === "missing") return;
    const file = { version: 1, continuations, updatedAt: at.toISOString() };
    await writePrivateFile(path, `${JSON.stringify(ContinuationFile.parse(file))}\n`);
  }

  /** Forgets every count, for example when away mode is switched off. */
  async clear(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }
}
