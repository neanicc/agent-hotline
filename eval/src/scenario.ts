// What a scenario is, and small helpers every scenario file shares.
import type { Answer, Ask } from "@hotline/core";
import type { Hotline, HotlineOptions } from "./hotline.js";

export interface ScenarioContext {
  /** Starts a fresh hotline (daemon, fakes, temporary home). Stopped when the scenario ends. */
  start(options?: Omit<HotlineOptions, "fault">): Promise<Hotline>;
}

export interface Scenario {
  /** The name in docs/eval.md and eval/thresholds.toml. */
  name: string;
  run(context: ScenarioContext): Promise<void>;
}

/**
 * Marks a promise the scenario awaits later (a hook or `ask_human` still
 * waiting on the owner) as handled, so a failure before it is awaited is never
 * an unhandled rejection. Awaiting the result still sees the rejection.
 */
export function later<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

/** The six-digit confirmation code in a texted permission request. */
export function codeIn(text: string | undefined): string | undefined {
  return /YES (\d{6})/.exec(text ?? "")?.[1];
}

export const isKind =
  (kind: Ask["kind"], except: readonly string[] = []) =>
  (ask: Ask) =>
    ask.kind === kind && !except.includes(ask.id);

export function answer(h: Hotline, ask: Ask): Answer | undefined {
  return h.daemon.store.getAnswer(ask.id);
}

export function auditCount(h: Hotline, event: string): number {
  return h.daemon.store.listAudit().filter((entry) => entry.event === event).length;
}
