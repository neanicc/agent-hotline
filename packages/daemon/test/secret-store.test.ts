import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
function fakeSecurity(options: { failAdd?: boolean; addExit?: number } = {}) {
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
        return result(options.addExit ?? 0);
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
