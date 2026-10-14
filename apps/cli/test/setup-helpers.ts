// Shared fakes for the setup command tests: a temporary HOTLINE_HOME and agent
// home, a fake HTTP layer that records every request and never reaches the
// network, a fake `security` for the Keychain store, and a scripted prompter.
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "@hotline/daemon";
import { type CliContext, run } from "../src/cli.js";
import type { Prompter } from "../src/prompt.js";
import type { CliFetch } from "../src/setup.js";

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Route = (request: Recorded) => { status: number; body?: unknown } | undefined;

/** A fetch that answers from `routes` (first match wins) and records every request. Unmatched: 404. */
export function fakeFetch(...routes: Route[]): CliFetch & { requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetch = async (url: string, init: Parameters<CliFetch>[1]) => {
    const request: Recorded = {
      method: init.method,
      url,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    requests.push(request);
    for (const route of routes) {
      const answer = route(request);
      if (answer !== undefined) return { status: answer.status, json: async () => answer.body ?? {} };
    }
    return { status: 404, json: async () => ({}) };
  };
  return Object.assign(fetch, { requests });
}

export const route =
  (
    method: string,
    path: string | RegExp,
    status: number,
    body?: unknown | ((request: Recorded) => unknown),
  ): Route =>
  (request) => {
    if (request.method !== method) return undefined;
    const { pathname, search } = new URL(request.url);
    const target = pathname + search;
    if (typeof path === "string" ? target !== path : !path.test(target)) return undefined;
    return { status, body: typeof body === "function" ? (body as (r: Recorded) => unknown)(request) : body };
  };

/** A fake `/usr/bin/security` backed by a Map: enough for KeychainSecretStore's get, set and delete. */
export function fakeSecurity(): Exec & { items: Map<string, string>; calls: string[][] } {
  const items = new Map<string, string>();
  const calls: string[][] = [];
  const exec: Exec = async (_file, args, input) => {
    calls.push([...args]);
    const account = (list: readonly string[]) => list[list.indexOf("-a") + 1] ?? "";
    if (args[0] === "find-generic-password") {
      const value = items.get(account(args));
      return value === undefined
        ? { exitCode: 44, stdout: "", stderr: "not found" }
        : { exitCode: 0, stdout: `${value}\n`, stderr: "" };
    }
    if (args[0] === "-i") {
      const words = (input ?? "").trim().split(/\s+/);
      items.set(account(words), Buffer.from(words[words.indexOf("-X") + 1] ?? "", "hex").toString("utf8"));
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "delete-generic-password") {
      items.delete(account(args));
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "unexpected" };
  };
  return Object.assign(exec, { items, calls });
}

/** A prompter that answers from a list and records the questions. */
export function scriptedPrompter(...answers: string[]): Prompter & { questions: string[] } {
  const questions: string[] = [];
  return {
    questions,
    async ask(question) {
      questions.push(question);
      return answers.shift() ?? "";
    },
  };
}

export interface TempSetup {
  dir: string;
  /** HOTLINE_HOME. */
  hotlineHome: string;
  /** Stands in for the user's home folder (agent configs). */
  home: string;
  cleanup(): Promise<void>;
}

export async function tempSetup(): Promise<TempSetup> {
  const dir = await mkdtemp(join(tmpdir(), "hl11-setup-"));
  return {
    dir,
    hotlineHome: join(dir, "hotline"),
    home: join(dir, "home"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export function testContext(setup: TempSetup, extra: Partial<CliContext> = {}): CliContext {
  return {
    // Never the real ~/.hotline, ~/.claude or ~/.codex.
    env: { HOTLINE_HOME: setup.hotlineHome },
    homeDir: setup.home,
    cwd: join(setup.home, "project"),
    platform: "linux",
    signals: new EventEmitter(),
    logDestination: { write: () => {} },
    now: () => new Date("2026-10-14T12:00:00.000Z"),
    ...extra,
  };
}

export async function cli(argv: string[], context: CliContext) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(argv, { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) }, context);
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}
