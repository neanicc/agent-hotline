// Files only the owner may read: the config (it holds the PIN hash) and the
// fallback secrets file. Both are written 0600 inside a 0700 directory, and
// neither the file nor its directory may be a symlink, owned by someone else,
// or open to other users.
import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function ownerProblem(info: Stats): string | undefined {
  const uid = process.getuid?.();
  return uid !== undefined && info.uid !== uid ? "is owned by another user" : undefined;
}

/** Why `info` (from lstat) is not a private file of the current user, or undefined when it is. */
export function privateFileProblem(info: Stats): string | undefined {
  if (info.isSymbolicLink()) return "is a symbolic link; replace it with a regular file";
  if (!info.isFile()) return "is not a regular file";
  if ((info.mode & 0o077) !== 0) {
    return `is readable or writable by other users (mode ${(info.mode & 0o777).toString(8)}); run chmod 600 on it`;
  }
  return ownerProblem(info);
}

/** Why `info` (from lstat) is not a private directory of the current user, or undefined when it is. */
export function privateDirectoryProblem(info: Stats): string | undefined {
  if (info.isSymbolicLink()) return "is a symbolic link; use a real directory";
  if (!info.isDirectory()) return "is not a directory";
  if ((info.mode & 0o077) !== 0) {
    return `is accessible to other users (mode ${(info.mode & 0o777).toString(8)}); run chmod 700 on it`;
  }
  return ownerProblem(info);
}

/** lstat() that returns undefined for a missing path. Never follows a symlink. */
export async function lstatIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Why `path` cannot be trusted as a private file, or undefined when it can.
 * Checks the parent directory first: a directory others can write to lets them
 * swap the file. Returns `"missing"` when the directory is fine and the file
 * does not exist.
 */
export async function privatePathProblem(path: string): Promise<string | undefined> {
  const directory = dirname(path);
  const dirInfo = await lstatIfExists(directory);
  if (dirInfo === undefined) return "missing";
  const dirProblem = privateDirectoryProblem(dirInfo);
  if (dirProblem !== undefined) return `is in directory ${directory}, which ${dirProblem}`;
  const info = await lstatIfExists(path);
  if (info === undefined) return "missing";
  return privateFileProblem(info);
}

/**
 * Atomically replaces `path` with `contents`, mode 0600, creating its directory
 * with mode 0700 if needed. Refuses an existing directory or file that is not
 * private. A reader never sees a partial file.
 */
export async function writePrivateFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const problem = await privatePathProblem(path);
  if (problem !== undefined && problem !== "missing")
    throw new Error(`Refusing to write ${path}: it ${problem}`);
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
