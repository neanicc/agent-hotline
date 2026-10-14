import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStoreError } from "@hotline/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Exec,
  type ExecResult,
  FileSecretStore,
  KEYCHAIN_SERVICE,
  KeychainSecretStore,
  nodeExec,
  openSecretStore,
  SECURITY_PATH,
} from "../src/index.js";

const SECRET = "sk_fake_0123456789abcdef";

interface Call {
  file: string;
  args: readonly string[];
  input: string | undefined;
}

/**
 * Stands in for /usr/bin/security with an in-memory keychain, following the
 * documented commands: find-generic-password -w prints the password, a missing
 * item exits 44, and `-i` reads commands from stdin.
 */
function fakeSecurity(options: { failAdd?: boolean; addExit?: number; echoCommand?: boolean } = {}) {
  const items = new Map<string, string>();
  const calls: Call[] = [];
  const result = (exitCode: number, stdout = "", stderr = ""): ExecResult => ({ exitCode, stdout, stderr });
  const flag = (args: readonly string[], name: string) => args[args.indexOf(name) + 1] ?? "";

  const exec: Exec = async (file, args, input) => {
    calls.push({ file, args, input });
    const key = (a: readonly string[]) => `${flag(a, "-s")}/${flag(a, "-a")}`;
    switch (args[0]) {
      case "find-generic-password": {
        const value = items.get(key(args));
        return value === undefined
          ? result(
              44,
              "",
              "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n",
            )
          : result(0, `${value}\n`);
      }
      case "delete-generic-password":
        return items.delete(key(args)) ? result(0) : result(44, "", "security: item not found\n");
      case "-i": {
        const line = (input ?? "").trim().split(/\s+/);
        if (line[0] !== "add-generic-password" || !line.includes("-U"))
          return result(0, "", "unknown command\n");
        if (!options.failAdd) items.set(key(line), Buffer.from(flag(line, "-X"), "hex").toString("utf8"));
        // Interactive mode may echo the failing command, hex secret included.
        const stderr = options.echoCommand ? `security> ${input ?? ""}add-generic-password: failed\n` : "";
        return result(options.addExit ?? 0, options.echoCommand ? `security> ${input ?? ""}` : "", stderr);
      }
      default:
        return result(1, "", "unexpected\n");
    }
  };
  return { exec, calls, items };
}

describe("KeychainSecretStore", () => {
  it("stores, reads and deletes a generic password under the agent-hotline service", async () => {
    const security = fakeSecurity();
    const store = new KeychainSecretStore(security.exec);
    expect(store.kind).toBe("keychain");
    expect(await store.get("twilio.authToken")).toBeUndefined();

    await store.set("twilio.authToken", SECRET);
    expect(security.items.get(`${KEYCHAIN_SERVICE}/twilio.authToken`)).toBe(SECRET);
    expect(await store.get("twilio.authToken")).toBe(SECRET);

    await store.delete("twilio.authToken");
    await store.delete("twilio.authToken");
    expect(await store.get("twilio.authToken")).toBeUndefined();
    expect(security.calls.every((call) => call.file === SECURITY_PATH)).toBe(true);
  });

  it("never puts a secret in a process argument list", async () => {
    const security = fakeSecurity();
    const store = new KeychainSecretStore(security.exec);
    await store.set("elevenlabs.apiKey", SECRET);
    const hex = Buffer.from(SECRET).toString("hex");
    for (const call of security.calls) {
      expect(call.args.join(" ")).not.toContain(SECRET);
      expect(call.args.join(" ")).not.toContain(hex);
    }
    expect(security.calls[0]).toEqual({
      file: SECURITY_PATH,
      args: ["-i"],
      input: `add-generic-password -U -s agent-hotline -a elevenlabs.apiKey -X ${hex}\n`,
    });
  });

  it("fails when the write did not take, without echoing the secret", async () => {
    for (const options of [{ failAdd: true }, { addExit: 1 }]) {
      const store = new KeychainSecretStore(fakeSecurity(options).exec);
      const error = await store.set("twilio.authToken", SECRET).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SecretStoreError);
      expect((error as Error).message).toMatch(/Could not store twilio.authToken/);
      expect((error as Error).message).not.toContain(SECRET);
    }
  });

  it("never passes security's output on when a store fails, even if it echoes the command", async () => {
    const hex = Buffer.from(SECRET).toString("hex");
    const cases = [
      { echoCommand: true, addExit: 1 },
      { echoCommand: true, failAdd: true },
      { echoCommand: true, failAdd: true, addExit: 1 },
    ];
    for (const options of cases) {
      const error = await new KeychainSecretStore(fakeSecurity(options).exec)
        .set("twilio.authToken", SECRET)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SecretStoreError);
      const message = (error as Error).message;
      expect(message).toMatch(/^Could not store twilio\.authToken in the Keychain \(security exit \d+\)$/);
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(hex);
      expect(message).not.toContain(hex.slice(0, 8));
    }
  });

  it("hides security's output when the read-back itself fails", async () => {
    const hex = Buffer.from(SECRET).toString("hex");
    const exec: Exec = async (_file, args, input) =>
      args[0] === "-i"
        ? { exitCode: 0, stdout: "", stderr: "" }
        : { exitCode: 51, stdout: SECRET, stderr: `security: failed after ${input ?? ""}${hex}\n` };
    const error = await new KeychainSecretStore(exec)
      .set("twilio.authToken", SECRET)
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      "Could not store twilio.authToken in the Keychain (security exit 0)",
    );
  });

  it("masks long hex runs in read and delete errors and never includes stdout", async () => {
    const hex = Buffer.from(SECRET).toString("hex");
    const exec: Exec = async () => ({ exitCode: 51, stdout: SECRET, stderr: `security: bad item ${hex}\n` });
    for (const attempt of [
      new KeychainSecretStore(exec).get("daemon.apiToken"),
      new KeychainSecretStore(exec).delete("daemon.apiToken"),
    ]) {
      const message = ((await attempt.catch((e: unknown) => e)) as Error).message;
      expect(message).toMatch(/security exit 51: security: bad item \[redacted\]/);
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(hex.slice(0, 8));
    }
  });

  it("surfaces other security errors", async () => {
    const exec: Exec = async () => ({
      exitCode: 51,
      stdout: "",
      stderr: "security: user interaction is not allowed\n",
    });
    await expect(new KeychainSecretStore(exec).get("daemon.apiToken")).rejects.toThrow(
      /security exit 51: security: user interaction is not allowed/,
    );
    await expect(new KeychainSecretStore(exec).delete("daemon.apiToken")).rejects.toThrow(SecretStoreError);
  });

  it("rejects values that are not one line of printable ASCII before running anything", async () => {
    const security = fakeSecurity();
    const store = new KeychainSecretStore(security.exec);
    await expect(store.set("twilio.authToken", "has space")).rejects.toThrow(SecretStoreError);
    await expect(store.set("twilio.authToken", "line\nbreak")).rejects.toThrow(SecretStoreError);
    expect(security.calls).toEqual([]);
  });

  it("rejects a service name that could break the interactive command", () => {
    expect(() => new KeychainSecretStore(fakeSecurity().exec, "agent hotline -A")).toThrow(SecretStoreError);
  });
});

describe("FileSecretStore", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hotline-secrets-"));
    path = join(dir, ".hotline", "secrets.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips secrets in a 0600 file", async () => {
    const store = new FileSecretStore(path);
    expect(store.kind).toBe("file");
    expect(await store.get("twilio.authToken")).toBeUndefined();
    await store.set("twilio.authToken", SECRET);
    await store.set("daemon.apiToken", "fake-daemon-token");
    expect(await store.get("twilio.authToken")).toBe(SECRET);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      secrets: { "twilio.authToken": SECRET, "daemon.apiToken": "fake-daemon-token" },
    });

    await store.delete("twilio.authToken");
    await store.delete("twilio.authToken");
    expect(await store.get("twilio.authToken")).toBeUndefined();
    expect(await store.get("daemon.apiToken")).toBe("fake-daemon-token");
  });

  it.skipIf(process.platform === "win32")("refuses a secrets file other users can read", async () => {
    const store = new FileSecretStore(path);
    await store.set("twilio.authToken", SECRET);
    await chmod(path, 0o640);
    await expect(store.get("twilio.authToken")).rejects.toThrow(/chmod 600/);
    await expect(store.set("daemon.apiToken", "x")).rejects.toThrow(SecretStoreError);
  });

  it.skipIf(process.platform === "win32")("refuses a secrets directory other users can access", async () => {
    const store = new FileSecretStore(path);
    await store.set("twilio.authToken", SECRET);
    await chmod(join(dir, ".hotline"), 0o755);
    await expect(store.get("twilio.authToken")).rejects.toThrow(/directory .*mode 755.*chmod 700/);
    const error = await store.set("daemon.apiToken", "fake-daemon-token").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretStoreError);
    expect((error as Error).message).toMatch(/chmod 700/);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlinked secrets file and leaves its target alone",
    async () => {
      const target = join(dir, "elsewhere.json");
      await writeFile(target, JSON.stringify({ version: 1, secrets: { "twilio.authToken": SECRET } }), {
        mode: 0o600,
      });
      await mkdir(join(dir, ".hotline"), { mode: 0o700 });
      await symlink(target, path);
      const store = new FileSecretStore(path);
      await expect(store.get("twilio.authToken")).rejects.toThrow(/symbolic link/);
      await expect(store.set("daemon.apiToken", "fake-daemon-token")).rejects.toThrow(/symbolic link/);
      expect(JSON.parse(await readFile(target, "utf8")).secrets).toEqual({ "twilio.authToken": SECRET });
    },
  );

  it("keeps every secret when sets and deletes overlap, across store instances", async () => {
    const names = [
      "daemon.apiToken",
      "elevenlabs.apiKey",
      "elevenlabs.toolSecret",
      "elevenlabs.webhookSecret",
      "twilio.accountSid",
      "twilio.authToken",
    ] as const;
    const first = new FileSecretStore(path);
    const second = new FileSecretStore(join(dir, ".hotline", "..", ".hotline", "secrets.json"));
    await first.set("twilio.authToken", "fake-old-value");
    await Promise.all(
      names.map((name, index) => (index % 2 === 0 ? first : second).set(name, `fake-${index}`)),
    );
    expect(JSON.parse(await readFile(path, "utf8")).secrets).toEqual(
      Object.fromEntries(names.map((name, index) => [name, `fake-${index}`])),
    );

    await Promise.all([
      first.delete("daemon.apiToken"),
      second.delete("elevenlabs.apiKey"),
      first.set("twilio.authToken", "fake-new-value"),
      second.delete("twilio.accountSid"),
    ]);
    expect(JSON.parse(await readFile(path, "utf8")).secrets).toEqual({
      "elevenlabs.toolSecret": "fake-2",
      "elevenlabs.webhookSecret": "fake-3",
      "twilio.authToken": "fake-new-value",
    });
  });

  it("still runs later updates after a queued one fails", async () => {
    const store = new FileSecretStore(path);
    await store.set("daemon.apiToken", "fake-daemon-token");
    await writeFile(path, "{not json", { mode: 0o600 });
    await expect(store.set("twilio.authToken", SECRET)).rejects.toThrow(/not valid JSON/);
    await writeFile(path, JSON.stringify({ version: 1, secrets: {} }), { mode: 0o600 });
    await store.set("twilio.authToken", SECRET);
    expect(await store.get("twilio.authToken")).toBe(SECRET);
  });

  it("reports a corrupt file without quoting it", async () => {
    const store = new FileSecretStore(path);
    await store.set("twilio.authToken", SECRET);
    await writeFile(path, `{"version":1,"secrets":{"twilio.authToken":"${SECRET}"`, { mode: 0o600 });
    const error = await store.get("twilio.authToken").catch((caught: unknown) => caught);
    expect((error as Error).message).toMatch(/not valid JSON/);
    expect((error as Error).message).not.toContain(SECRET);
  });
});

describe("openSecretStore", () => {
  const filePath = "/tmp/hotline-unused/secrets.json";
  const exec = fakeSecurity().exec;

  it("uses the Keychain on macOS and the file elsewhere when set to auto", () => {
    expect(openSecretStore({ choice: "auto", platform: "darwin", filePath, exec }).kind).toBe("keychain");
    expect(openSecretStore({ choice: "auto", platform: "linux", filePath, exec }).kind).toBe("file");
  });

  it("honours an explicit choice and refuses the Keychain off macOS", () => {
    expect(openSecretStore({ choice: "file", platform: "darwin", filePath, exec }).kind).toBe("file");
    expect(openSecretStore({ choice: "keychain", platform: "darwin", filePath, exec }).kind).toBe("keychain");
    expect(() => openSecretStore({ choice: "keychain", platform: "linux", filePath, exec })).toThrow(
      /needs macOS/,
    );
  });
});

describe("nodeExec", () => {
  // Runs Node itself, never `security`.
  it("passes stdin and returns exit code and output", async () => {
    const script = "process.stdin.pipe(process.stdout); process.stderr.write('warn'); process.exitCode = 3";
    expect(await nodeExec()(process.execPath, ["-e", script], "hello")).toEqual({
      exitCode: 3,
      stdout: "hello",
      stderr: "warn",
    });
  });

  it("kills a process that runs past the timeout", async () => {
    await expect(nodeExec(200)(process.execPath, ["-e", "setTimeout(() => {}, 10000)"])).rejects.toThrow(
      /killed/,
    );
  });

  it("rejects when the program does not exist", async () => {
    await expect(nodeExec()("/nonexistent/hotline-test-binary", [])).rejects.toThrow();
  });
});
