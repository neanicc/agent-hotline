// SecretStore implementations: the macOS Keychain through /usr/bin/security
// (recommended, plan section 12 question 5) and a user-only 0600 JSON file.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  SecretFile,
  type SecretName,
  type SecretStore,
  type SecretStoreChoice,
  SecretStoreError,
  SecretValue,
} from "@hotline/core";
import { privateFileProblem, statIfExists, writePrivateFile } from "./private-file.js";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs `file` with `args` (no shell), writing `input` to its stdin. Injected so tests never run `security`. */
export type Exec = (file: string, args: readonly string[], input?: string) => Promise<ExecResult>;

/** Exec backed by child_process.spawn, killed after `timeoutMs`. */
export function nodeExec(timeoutMs = 30_000): Exec {
  return (file, args, input) =>
    new Promise((resolve, reject) => {
      const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (signal !== null) reject(new Error(`${file} was killed by ${signal}`));
        else resolve({ exitCode: code ?? 1, stdout, stderr });
      });
      child.stdin.on("error", () => {
        // The process may exit before reading stdin; its exit code reports the failure.
      });
      child.stdin.end(input ?? "");
    });
}

export const SECURITY_PATH = "/usr/bin/security";
export const KEYCHAIN_SERVICE = "agent-hotline";
/** errSecItemNotFound, which `security` returns as its exit status. */
const ITEM_NOT_FOUND = 44;

function checkValue(value: string): void {
  if (!SecretValue.safeParse(value).success) {
    throw new SecretStoreError("Secret values must be one line of printable ASCII without spaces");
  }
}

/**
 * Generic passwords in the login Keychain, service `agent-hotline`, account = secret
 * name. Values are written through `security -i` on stdin as hex (`-X`), so a secret
 * never appears in a process argument list, then read back to confirm the write.
 */
export class KeychainSecretStore implements SecretStore {
  readonly kind = "keychain" as const;

  constructor(
    private readonly exec: Exec,
    private readonly service: string = KEYCHAIN_SERVICE,
  ) {
    if (!/^[A-Za-z0-9._-]+$/.test(service)) throw new SecretStoreError("Invalid Keychain service name");
  }

  async get(name: SecretName): Promise<string | undefined> {
    const result = await this.exec(SECURITY_PATH, [
      "find-generic-password",
      "-s",
      this.service,
      "-a",
      name,
      "-w",
    ]);
    if (result.exitCode === ITEM_NOT_FOUND) return undefined;
    if (result.exitCode !== 0) throw this.failure("read", name, result);
    return result.stdout.replace(/\r?\n$/, "");
  }

  async set(name: SecretName, value: string): Promise<void> {
    checkValue(value);
    const hex = Buffer.from(value, "utf8").toString("hex");
    const command = `add-generic-password -U -s ${this.service} -a ${name} -X ${hex}\n`;
    const result = await this.exec(SECURITY_PATH, ["-i"], command);
    // Interactive mode can exit 0 after a failed command, so the read-back is the real check.
    if (result.exitCode !== 0 || (await this.get(name)) !== value) {
      throw this.failure("store", name, result);
    }
  }

  async delete(name: SecretName): Promise<void> {
    const result = await this.exec(SECURITY_PATH, [
      "delete-generic-password",
      "-s",
      this.service,
      "-a",
      name,
    ]);
    if (result.exitCode !== 0 && result.exitCode !== ITEM_NOT_FOUND)
      throw this.failure("delete", name, result);
  }

  // stderr from `security` describes the error, never the secret; stdout is never included.
  private failure(action: string, name: SecretName, result: ExecResult): SecretStoreError {
    const detail = result.stderr.trim().split("\n")[0] ?? "";
    return new SecretStoreError(
      `Could not ${action} ${name} in the Keychain (security exit ${result.exitCode}${detail ? `: ${detail}` : ""})`,
    );
  }
}

/** A JSON file, mode 0600, that only the owner can read. Refuses to use a file others can read. */
export class FileSecretStore implements SecretStore {
  readonly kind = "file" as const;

  constructor(private readonly path: string) {}

  async get(name: SecretName): Promise<string | undefined> {
    return (await this.read()).secrets[name];
  }

  async set(name: SecretName, value: string): Promise<void> {
    checkValue(value);
    const file = await this.read();
    await this.write({ ...file, secrets: { ...file.secrets, [name]: value } });
  }

  async delete(name: SecretName): Promise<void> {
    const file = await this.read();
    if (!(name in file.secrets)) return;
    const { [name]: _removed, ...rest } = file.secrets;
    await this.write({ ...file, secrets: rest });
  }

  private async read(): Promise<SecretFile> {
    const info = await statIfExists(this.path);
    if (info === undefined) return { version: 1, secrets: {} };
    const problem = privateFileProblem(info);
    if (problem !== undefined) throw new SecretStoreError(`Secrets file ${this.path} ${problem}`);
    let decoded: unknown;
    try {
      decoded = JSON.parse(await readFile(this.path, "utf8"));
    } catch {
      throw new SecretStoreError(`Secrets file ${this.path} is not valid JSON`);
    }
    const parsed = SecretFile.safeParse(decoded);
    // Issue paths name secrets, never values, but keep the message generic anyway.
    if (!parsed.success) throw new SecretStoreError(`Secrets file ${this.path} has an unexpected format`);
    return parsed.data;
  }

  private async write(file: SecretFile): Promise<void> {
    await writePrivateFile(this.path, `${JSON.stringify(file, null, 2)}\n`);
  }
}

export interface OpenSecretStoreOptions {
  choice: SecretStoreChoice;
  /** `process.platform`; the Keychain exists only on darwin. */
  platform: NodeJS.Platform;
  /** Path of the fallback file (`HotlinePaths.secrets`). */
  filePath: string;
  exec?: Exec;
}

/** `auto` uses the Keychain on macOS and the 0600 file elsewhere. */
export function openSecretStore({ choice, platform, filePath, exec }: OpenSecretStoreOptions): SecretStore {
  const keychain = choice === "keychain" || (choice === "auto" && platform === "darwin");
  if (!keychain) return new FileSecretStore(filePath);
  if (platform !== "darwin") throw new SecretStoreError("The Keychain secret store needs macOS");
  return new KeychainSecretStore(exec ?? nodeExec());
}
