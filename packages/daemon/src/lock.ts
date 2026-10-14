// One daemon per hotline home. The lock is taken before the API token is created
// or the database opened, so two daemons started at once cannot each store a
// different token or write the same database.
import { readFile, rm, writeFile } from "node:fs/promises";

export class DaemonLockError extends Error {
  override readonly name = "DaemonLockError";
}

/** Whether a process with this id exists. EPERM means it exists but belongs to someone else. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface DaemonLock {
  /** Removes the lock file if it is still ours. Safe to call more than once. */
  release(): Promise<void>;
}

/**
 * Removes a lock whose process is gone. Two starters could both see the same
 * stale lock, and the second `rm` would then delete the first one's fresh lock.
 * So only the starter that exclusively creates `<lock>.break` may remove it, and
 * only after re-reading that the lock still holds the stale id. Any other starter
 * is refused while the break file exists.
 */
async function breakStaleLock(path: string, staleText: string, pid: number): Promise<void> {
  const breaker = `${path}.break`;
  try {
    await writeFile(breaker, `${pid}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new DaemonLockError(
      `Another hotline daemon is starting (${breaker}); if none is, delete that file and start again`,
    );
  }
  try {
    const current = (await readFile(path, "utf8").catch(() => "")).trim();
    if (current === staleText) await rm(path, { force: true });
  } finally {
    await rm(breaker, { force: true });
  }
}

export interface AcquireLockOptions {
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

/**
 * Creates `path` exclusively with this process's id (mode 0600). A lock left by a
 * process that no longer exists is replaced; a live one, or one whose contents
 * cannot be read as a process id, is refused with DaemonLockError.
 */
export async function acquireDaemonLock(path: string, options: AcquireLockOptions = {}): Promise<DaemonLock> {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, `${pid}\n`, { flag: "wx", mode: 0o600 });
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          const holder = await readFile(path, "utf8").catch(() => undefined);
          if (holder?.trim() === String(pid)) await rm(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const text = (await readFile(path, "utf8").catch(() => "")).trim();
    const holder = /^\d+$/.test(text) ? Number(text) : undefined;
    if (holder === undefined) {
      throw new DaemonLockError(
        `Lock file ${path} is unreadable; if no hotline daemon is running, delete it and start again`,
      );
    }
    // Our own pid counts as live: a second daemon in this process is refused too.
    if (holder === pid || isAlive(holder)) {
      throw new DaemonLockError(`Another hotline daemon (pid ${holder}) is already running (lock ${path})`);
    }
    await breakStaleLock(path, text, pid);
  }
  throw new DaemonLockError(`Could not take the daemon lock ${path}; another daemon is starting`);
}
