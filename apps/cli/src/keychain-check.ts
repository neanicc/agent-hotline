// `hotline doctor`'s Keychain self-test: exercises the real /usr/bin/security
// through the same KeychainSecretStore code the daemon uses, on a throwaway item.
// It checks the three things the store assumes about the binary (HL-02): `-i`
// accepts `add-generic-password ... -X <hex>`, `find-generic-password -w` prints
// the stored text, and a missing item exits 44. It never touches the real
// `agent-hotline` items, stores only a random dummy value, reports security's
// exit codes and never its output, and always deletes the item it added.
import { randomBytes } from "node:crypto";
import type { SecretName, SecretStoreChoice } from "@hotline/core";
import { type Exec, KeychainSecretStore, nodeExec } from "@hotline/daemon";
import type { CliContext } from "./cli.js";
import type { Check } from "./doctor.js";
import { isTestMode } from "./setup.js";

/** The throwaway Keychain service. Never `agent-hotline`, where the real secrets live. */
export const KEYCHAIN_CHECK_SERVICE = "agent-hotline-doctor-check";
/**
 * Not one of the real secret names, so even under the wrong service it could
 * never overwrite or delete a real secret. The store only passes it to `security`.
 */
export const KEYCHAIN_CHECK_ACCOUNT = "doctor.selfTest" as SecretName;
/** Each `security` call is killed after this long; the test stops at the first failure. */
export const KEYCHAIN_CHECK_TIMEOUT_MS = 1_500;

export interface KeychainSelfTestOptions {
  /** Per-call limit; a call that takes longer counts as failed. */
  timeoutMs?: number;
  /** The dummy value to store. Random by default. */
  value?: string;
}

class StepTimeout extends Error {}

/** Runs `exec`, rejecting after `timeoutMs` even if the injected exec never settles. */
function withTimeout(exec: Exec, timeoutMs: number): Exec {
  return (file, args, input) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new StepTimeout()), timeoutMs);
      exec(file, args, input).then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
}

type Step = "add" | "read back" | "delete" | "missing-item lookup";

/** Why `add` failed, from the exit codes of security's add and the store's read-back. */
function addProblem(codes: readonly number[]): string {
  if (codes[0] !== 0 || codes.length < 2) return "security failed";
  if (codes[1] === 0) return "the value read back did not match";
  if (codes[1] === 44) return "security reported success but the item was not stored";
  return "the read-back failed";
}

/**
 * Adds a throwaway item, reads it back, deletes it and looks it up again, which
 * must read as not set (exit 44). PASS, or FAIL naming the step and security's
 * exit codes only. Unless the run ended with the item confirmed gone, it is
 * deleted again.
 */
export async function keychainSelfTest(exec: Exec, options: KeychainSelfTestOptions = {}): Promise<Check> {
  const timed = withTimeout(exec, options.timeoutMs ?? KEYCHAIN_CHECK_TIMEOUT_MS);
  // Exit codes of the current step's calls; security's output is never kept.
  let codes: number[] = [];
  let timedOut = false;
  const recording: Exec = async (file, args, input) => {
    try {
      const result = await timed(file, args, input);
      codes.push(result.exitCode);
      return result;
    } catch (error) {
      // withTimeout's own limit, or nodeExec killing security at its timeout.
      if (error instanceof StepTimeout || /killed/.test((error as Error).message)) timedOut = true;
      throw error;
    }
  };
  const store = new KeychainSecretStore(recording, KEYCHAIN_CHECK_SERVICE);
  const value = options.value ?? randomBytes(18).toString("base64url");
  let step: Step = "add";
  const begin = (next: Step) => {
    step = next;
    codes = [];
    timedOut = false;
  };
  // Undefined while everything works; otherwise why the step failed.
  let problem: string | undefined;
  let gone = false;
  try {
    // set() adds through `security -i` with `-X <hex>`, then reads back and compares.
    begin("add");
    await store.set(KEYCHAIN_CHECK_ACCOUNT, value);
    begin("read back");
    if ((await store.get(KEYCHAIN_CHECK_ACCOUNT)) !== value) {
      problem = "the value read back did not match";
    } else {
      begin("delete");
      await store.delete(KEYCHAIN_CHECK_ACCOUNT);
      if (codes[0] !== 0) {
        problem = "the item was already gone";
      } else {
        begin("missing-item lookup");
        if ((await store.get(KEYCHAIN_CHECK_ACCOUNT)) === undefined) gone = true;
        else problem = "the deleted item could still be read";
      }
    }
  } catch {
    if (timedOut) problem = "security did not finish in time (is the login Keychain locked?)";
    else if (codes.length === 0) problem = "security could not run";
    else if (step === "add") problem = addProblem(codes);
    else problem = "security failed";
  }
  const exits = codes.length > 0 ? ` (security exit ${codes.join(" then ")})` : "";
  let cleanup = "";
  if (!gone) {
    // Remove the throwaway item whatever failed above; exit 44 (already gone) is fine.
    try {
      await store.delete(KEYCHAIN_CHECK_ACCOUNT);
    } catch {
      cleanup = `; could not remove the throwaway item, delete service ${KEYCHAIN_CHECK_SERVICE} in Keychain Access`;
    }
  }
  if (problem === undefined) {
    return {
      status: "pass",
      name: "keychain",
      detail: `self-test passed: security added, read back and deleted a throwaway item (service ${KEYCHAIN_CHECK_SERVICE}); a missing item reads as not set`,
    };
  }
  return {
    status: "fail",
    name: "keychain",
    detail: `self-test failed at ${step}${exits}: ${problem}${cleanup}`,
  };
}

/**
 * The `security` runner for the self-test: the injected one, else the real
 * binary with a short timeout. Under test mode the real binary is refused.
 */
export function keychainCheckExec(context: CliContext): Exec {
  if (context.exec !== undefined) return context.exec;
  if (isTestMode(context)) throw new Error("test mode: the Keychain self-test needs an injected exec");
  return nodeExec(KEYCHAIN_CHECK_TIMEOUT_MS);
}

/** True when the configured store resolves to the Keychain on this Mac. */
export function usesKeychain(context: CliContext, choice: SecretStoreChoice): boolean {
  if (context.platform !== "darwin") return false;
  return choice === "keychain" || choice === "auto";
}

/** The doctor check. FAIL, without running anything, when no runner is allowed. */
export async function keychainCheck(context: CliContext): Promise<Check> {
  let exec: Exec;
  try {
    exec = keychainCheckExec(context);
  } catch (error) {
    return { status: "fail", name: "keychain", detail: (error as Error).message };
  }
  return keychainSelfTest(exec);
}
