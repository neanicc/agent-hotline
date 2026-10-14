// The doctor's Keychain self-test against a fake `security` that models the real
// binary: items keyed by service and account, exit 44 for a missing item, `-w`
// printing the value and a newline, `-i` reading one command from stdin. The real
// /usr/bin/security never runs here: spawn is replaced and must never be called.
import { join } from "node:path";
import { type Exec, type ExecResult, KEYCHAIN_SERVICE, nodeExec, writePrivateFile } from "@hotline/daemon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KEYCHAIN_CHECK_ACCOUNT,
  KEYCHAIN_CHECK_SERVICE,
  keychainCheckExec,
  keychainSelfTest,
} from "../src/keychain-check.js";
import { cli, type TempSetup, tempSetup, testContext } from "./setup-helpers.js";

const spawned = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: () => {
    spawned.count++;
    throw new Error("the real security binary must never run in tests");
  },
}));

const NOT_FOUND = "security: SecItemCopyMatching: The specified item could not be found in the keychain.\n";
const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

type Override = (
  args: readonly string[],
  input: string | undefined,
) => ExecResult | "hang" | "kill" | "enoent" | undefined;

/** A fake `/usr/bin/security`. `override` replaces one call's behaviour; undefined falls through. */
function fakeSecurity(override: Override = () => undefined) {
  const items = new Map<string, string>();
  const calls: { args: string[]; input: string | undefined }[] = [];
  const key = (service: string, account: string) => `${service}\u0000${account}`;
  const flag = (list: readonly string[], name: string) => list[list.indexOf(name) + 1] ?? "";
  const exec: Exec = async (_file, args, input) => {
    calls.push({ args: [...args], input });
    const forced = override(args, input);
    if (forced === "hang") return new Promise<ExecResult>(() => {});
    if (forced === "kill") throw new Error("/usr/bin/security was killed by SIGTERM");
    if (forced === "enoent")
      throw Object.assign(new Error("spawn /usr/bin/security ENOENT"), { code: "ENOENT" });
    if (forced !== undefined) return forced;
    if (args[0] === "find-generic-password") {
      const value = items.get(key(flag(args, "-s"), flag(args, "-a")));
      return value === undefined ? { exitCode: 44, stdout: "", stderr: NOT_FOUND } : ok(`${value}\n`);
    }
    if (args[0] === "delete-generic-password") {
      const k = key(flag(args, "-s"), flag(args, "-a"));
      if (!items.has(k)) return { exitCode: 44, stdout: "", stderr: NOT_FOUND };
      items.delete(k);
      return ok('keychain: "/Users/fake/Library/Keychains/login.keychain-db"\npassword has been deleted.\n');
    }
    if (args[0] === "-i") {
      const words = (input ?? "").trim().split(/\s+/);
      if (words[0] !== "add-generic-password") return { exitCode: 1, stdout: "", stderr: "unknown command" };
      items.set(
        key(flag(words, "-s"), flag(words, "-a")),
        Buffer.from(flag(words, "-X"), "hex").toString("utf8"),
      );
      return ok();
    }
    return { exitCode: 1, stdout: "", stderr: "unexpected" };
  };
  return Object.assign(exec, { items, calls });
}

const VALUE = "dummy-value-for-the-self-test";
const HEX = Buffer.from(VALUE, "utf8").toString("hex");
const verb = (call: { args: string[] }) => call.args[0];

/** Every call targeted the throwaway service and account, never the real items. */
function expectOnlyThrowaway(fake: { calls: { args: string[]; input: string | undefined }[] }) {
  for (const { args, input } of fake.calls) {
    const words = args[0] === "-i" ? (input ?? "").trim().split(/\s+/) : args;
    expect(words[words.indexOf("-s") + 1]).toBe(KEYCHAIN_CHECK_SERVICE);
    expect(words[words.indexOf("-a") + 1]).toBe(KEYCHAIN_CHECK_ACCOUNT);
  }
}

/** The last call was a delete of the throwaway item (cleanup ran). */
function expectCleanup(fake: ReturnType<typeof fakeSecurity>) {
  expect(verb(fake.calls.at(-1) ?? { args: [] })).toBe("delete-generic-password");
  expect([...fake.items.keys()].filter((k) => k.startsWith(`${KEYCHAIN_CHECK_SERVICE}\u0000`))).toEqual([]);
}

afterEach(() => {
  expect(spawned.count).toBe(0);
});

describe("keychainSelfTest", () => {
  it("runs under a spawn that refuses, so a real security run would fail loudly", async () => {
    // Proves the mock reaches the daemon's nodeExec; the binary named here never starts.
    await expect(nodeExec(100)("/usr/bin/false", [])).rejects.toThrow("must never run");
    expect(spawned.count).toBe(1);
    spawned.count = 0;
  });

  it("uses a throwaway service and account, never the real ones", () => {
    expect(KEYCHAIN_CHECK_SERVICE).not.toBe(KEYCHAIN_SERVICE);
    expect(KEYCHAIN_CHECK_SERVICE).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(["daemon.apiToken", "elevenlabs.apiKey", "twilio.authToken"]).not.toContain(
      KEYCHAIN_CHECK_ACCOUNT,
    );
  });

  it("passes: adds through -i with -X hex, reads back, deletes, and a missing item reads as unset", async () => {
    const fake = fakeSecurity();
    // A real secret under the real service must survive untouched.
    fake.items.set(`${KEYCHAIN_SERVICE}\u0000daemon.apiToken`, "real-token-stays");
    const check = await keychainSelfTest(fake, { value: VALUE });
    expect(check).toMatchObject({ status: "pass", name: "keychain" });
    expect(check.detail).toContain(KEYCHAIN_CHECK_SERVICE);
    expect(fake.calls.map(verb)).toEqual([
      "-i",
      "find-generic-password",
      "find-generic-password",
      "delete-generic-password",
      "find-generic-password",
    ]);
    // The value goes in on stdin as hex, never in an argument.
    expect(fake.calls[0]?.input).toBe(
      `add-generic-password -U -s ${KEYCHAIN_CHECK_SERVICE} -a ${KEYCHAIN_CHECK_ACCOUNT} -X ${HEX}\n`,
    );
    for (const { args } of fake.calls) expect(args.join(" ")).not.toContain(HEX);
    expectOnlyThrowaway(fake);
    expect([...fake.items]).toEqual([[`${KEYCHAIN_SERVICE}\u0000daemon.apiToken`, "real-token-stays"]]);
  });

  it("stores a fresh random value each run and never prints it", async () => {
    const fake = fakeSecurity();
    const first = await keychainSelfTest(fake);
    const second = await keychainSelfTest(fake);
    expect([first.status, second.status]).toEqual(["pass", "pass"]);
    const added = fake.calls.filter((call) => verb(call) === "-i").map((call) => call.input);
    expect(new Set(added).size).toBe(2);
    for (const input of added) {
      const hex = (input ?? "").trim().split(" ").at(-1) ?? "";
      const value = Buffer.from(hex, "hex").toString("utf8");
      expect(value.length).toBeGreaterThanOrEqual(20);
      expect(first.detail + second.detail).not.toContain(value);
      expect(first.detail + second.detail).not.toContain(hex);
    }
  });

  it("fails a refused add with the exit code only, not security's echo of the hex", async () => {
    const fake = fakeSecurity((args, input) =>
      args[0] === "-i" ? { exitCode: 1, stdout: input ?? "", stderr: `security: ${input}` } : undefined,
    );
    const check = await keychainSelfTest(fake, { value: VALUE });
    expect(check).toEqual({
      status: "fail",
      name: "keychain",
      detail: "self-test failed at add (security exit 1): security failed",
    });
    expectCleanup(fake);
    expectOnlyThrowaway(fake);
  });

  it("fails an add that exits 0 but stores nothing (interactive mode)", async () => {
    const fake = fakeSecurity((args) => (args[0] === "-i" ? ok() : undefined));
    const check = await keychainSelfTest(fake, { value: VALUE });
    expect(check.status).toBe("fail");
    expect(check.detail).toBe(
      "self-test failed at add (security exit 0 then 44): security reported success but the item was not stored",
    );
    expectCleanup(fake);
  });

  it("fails when -w prints something other than the stored text, and still deletes the item", async () => {
    const fake = fakeSecurity((args) => (args[0] === "find-generic-password" ? ok(`${HEX}\n`) : undefined));
    const check = await keychainSelfTest(fake, { value: VALUE });
    expect(check.detail).toBe(
      "self-test failed at add (security exit 0 then 0): the value read back did not match",
    );
    expect(check.detail).not.toContain(HEX);
    expectCleanup(fake);
  });

  it("fails when the delete fails, and retries the delete as cleanup", async () => {
    let deletes = 0;
    const fake = fakeSecurity((args) =>
      args[0] === "delete-generic-password" && deletes++ === 0
        ? { exitCode: 1, stdout: "", stderr: "security: some failure" }
        : undefined,
    );
    const check = await keychainSelfTest(fake, { value: VALUE });
    expect(check.detail).toBe("self-test failed at delete (security exit 1): security failed");
    expect(deletes).toBe(2);
    expectCleanup(fake);
  });

  it("fails when a deleted item still reads back, or the missing lookup is not exit 44", async () => {
    let finds = 0;
    const lingering = fakeSecurity((args) =>
      args[0] === "find-generic-password" && ++finds === 3 ? ok(`${VALUE}\n`) : undefined,
    );
    const still = await keychainSelfTest(lingering, { value: VALUE });
    expect(still.detail).toBe(
      "self-test failed at missing-item lookup (security exit 0): the deleted item could still be read",
    );
    expect(verb(lingering.calls.at(-1) ?? { args: [] })).toBe("delete-generic-password");

    let lookups = 0;
    const odd = fakeSecurity((args) =>
      args[0] === "find-generic-password" && ++lookups === 3
        ? { exitCode: 36, stdout: "", stderr: "x" }
        : undefined,
    );
    const check = await keychainSelfTest(odd, { value: VALUE });
    expect(check.detail).toBe("self-test failed at missing-item lookup (security exit 36): security failed");
    expectCleanup(odd);
  });

  it("fails a call that hangs past the timeout, cleans up, and finishes quickly", async () => {
    const fake = fakeSecurity((args) => (args[0] === "-i" ? "hang" : undefined));
    const started = Date.now();
    const check = await keychainSelfTest(fake, { value: VALUE, timeoutMs: 20 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(check.detail).toBe(
      "self-test failed at add: security did not finish in time (is the login Keychain locked?)",
    );
    expectCleanup(fake);
  });

  it("treats security killed at its timeout as a timeout too", async () => {
    let finds = 0;
    const fake = fakeSecurity((args) =>
      args[0] === "find-generic-password" && ++finds === 2 ? "kill" : undefined,
    );
    const check = await keychainSelfTest(fake, { value: VALUE });
    expect(check.detail).toBe(
      "self-test failed at read back: security did not finish in time (is the login Keychain locked?)",
    );
    expectCleanup(fake);
  });

  it("reports a cleanup that fails too, and still ends within two timeouts", async () => {
    const fake = fakeSecurity(() => "hang");
    const started = Date.now();
    const check = await keychainSelfTest(fake, { value: VALUE, timeoutMs: 20 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fake.calls.map(verb)).toEqual(["-i", "delete-generic-password"]);
    expect(check.detail).toBe(
      `self-test failed at add: security did not finish in time (is the login Keychain locked?); could not remove the throwaway item, delete service ${KEYCHAIN_CHECK_SERVICE} in Keychain Access`,
    );
  });

  it("fails when security cannot start, and still tries the cleanup", async () => {
    const fake = fakeSecurity(() => "enoent");
    const check = await keychainSelfTest(fake, { value: VALUE });
    expect(check.detail).toMatch(/^self-test failed at add: security could not run; could not remove/);
    expect(fake.calls.map(verb)).toEqual(["-i", "delete-generic-password"]);
  });
});

describe("hotline doctor Keychain self-test", () => {
  let setup: TempSetup;
  beforeEach(async () => {
    setup = await tempSetup();
  });
  afterEach(() => setup.cleanup());

  async function writeConfig(store: "auto" | "keychain" | "file") {
    const config = {
      version: 1,
      owner: { phoneNumber: "+15555550100", pinHash: `scrypt$15$8$1$${"s".repeat(22)}$${"h".repeat(43)}` },
      quietHours: { timeZone: "America/Toronto" },
      voice: { provider: "fake" },
      sms: { provider: "fake" },
      secrets: { store },
    };
    await writePrivateFile(join(setup.hotlineHome, "config.json"), JSON.stringify(config));
  }

  const offline = Object.assign(
    async () => {
      throw new TypeError("fetch failed");
    },
    { requests: [] },
  );
  const doctor = (extra: Parameters<typeof testContext>[1]) =>
    cli(["doctor", "--home", setup.home], testContext(setup, { fetch: offline, ...extra }));
  const keychainLines = (stdout: string) =>
    stdout.split("\n").filter((line) => /^\w+\s+keychain\s/.test(line));

  it("runs on macOS with the Keychain store (keychain or auto) and passes", async () => {
    for (const store of ["keychain", "auto"] as const) {
      await writeConfig(store);
      const fake = fakeSecurity();
      const result = await doctor({ platform: "darwin", exec: fake });
      expect(keychainLines(result.stdout)).toEqual([
        expect.stringMatching(/^PASS\s+keychain\s+self-test passed: security added, read back and deleted/),
      ]);
      // The secrets check only reads the real service; every write is the throwaway item.
      expectOnlyThrowaway({ calls: fake.calls.filter((call) => verb(call) !== "find-generic-password") });
      expect(fake.calls.filter((call) => verb(call) !== "find-generic-password")).toHaveLength(2);
      expect(fake.items.size).toBe(0);
    }
  });

  it("fails doctor (exit 1) when the self-test fails, with the exit code only", async () => {
    await writeConfig("keychain");
    const fake = fakeSecurity((args, input) =>
      args[0] === "-i" ? { exitCode: 1, stdout: input ?? "", stderr: `echo ${input}` } : undefined,
    );
    const result = await doctor({ platform: "darwin", exec: fake });
    expect(result.code).toBe(1);
    expect(keychainLines(result.stdout)).toEqual([
      expect.stringMatching(
        /^FAIL\s+keychain\s+self-test failed at add \(security exit 1\): security failed$/,
      ),
    ]);
    expect(result.stdout + result.stderr).not.toContain("add-generic-password");
  });

  it("does not run with the file store, or off macOS", async () => {
    await writeConfig("file");
    const fake = fakeSecurity();
    const fileStore = await doctor({ platform: "darwin", exec: fake });
    expect(keychainLines(fileStore.stdout)).toEqual([]);
    await writeConfig("auto");
    const linux = await doctor({ platform: "linux", exec: fake });
    expect(keychainLines(linux.stdout)).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("never falls back to the real security binary under test mode", async () => {
    await writeConfig("keychain");
    const result = await doctor({ platform: "darwin" });
    expect(keychainLines(result.stdout)).toEqual([
      expect.stringMatching(/^FAIL\s+keychain\s+test mode: the Keychain self-test needs an injected exec$/),
    ]);
    expect(() =>
      keychainCheckExec(testContext(setup, { platform: "darwin", env: { HOTLINE_TEST_MODE: "1" } })),
    ).toThrow("test mode");
    expect(spawned.count).toBe(0);
  });
});
