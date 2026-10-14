// Files only the owner may read: the config (it holds the PIN hash) and the
// fallback secrets file. Both are written 0600 inside a 0700 directory.
import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Why `info` is not a private file of the current user, or undefined when it is. */
export function privateFileProblem(info: Stats): string | undefined {
  if (!info.isFile()) return "is not a regular file";
  if ((info.mode & 0o077) !== 0) {
    return `is readable or writable by other users (mode ${(info.mode & 0o777).toString(8)}); run chmod 600 on it`;
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) return "is owned by another user";
  return undefined;
}

/** stat() that returns undefined for a missing file. */
export async function statIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Atomically replaces `path` with `contents`, mode 0600, creating its directory
 * with mode 0700 if needed. A reader never sees a partial file.
 */
export async function writePrivateFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, contents, { mode: 0o600, flag: "wx" });
    // The umask cannot widen 0600, but an explicit chmod keeps this independent of it.
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
