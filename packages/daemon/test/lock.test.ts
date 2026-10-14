import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireDaemonLock, DaemonLockError, processIsAlive } from "../src/index.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hotline-lock-"));
  path = join(dir, "daemon.lock");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const missing = async () =>
  stat(path).then(
    () => false,
    () => true,
  );

describe("acquireDaemonLock", () => {
  it("writes this process's id, 0600, and removes it on release", async () => {
    const lock = await acquireDaemonLock(path);
    expect(await readFile(path, "utf8")).toBe(`${process.pid}\n`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await lock.release();
    await lock.release();
    expect(await missing()).toBe(true);
  });

  it("refuses while a live daemon holds it, including one in this process", async () => {
    const held = await acquireDaemonLock(path);
    await expect(acquireDaemonLock(path)).rejects.toThrow(/already running/);
    await expect(acquireDaemonLock(path, { pid: 4242, isAlive: () => true })).rejects.toThrow(
      DaemonLockError,
    );
    await held.release();
  });

  it("replaces a lock left by a process that is gone", async () => {
    await writeFile(path, "999999\n");
    const lock = await acquireDaemonLock(path, { pid: 4242, isAlive: () => false });
    expect(await readFile(path, "utf8")).toBe("4242\n");
    await lock.release();
  });

  it("lets exactly one of several simultaneous starters replace a stale lock", async () => {
    const starters = [1001, 1002, 1003, 1004];
    const live = (pid: number) => starters.includes(pid);
    for (let round = 0; round < 25; round++) {
      await writeFile(path, "999999\n");
      const results = await Promise.allSettled(
        starters.map((pid) => acquireDaemonLock(path, { pid, isAlive: live })),
      );
      const winners = results.filter((result) => result.status === "fulfilled");
      expect(winners).toHaveLength(1);
      for (const result of results) {
        if (result.status === "rejected") expect(result.reason).toBeInstanceOf(DaemonLockError);
      }
      const holder = Number((await readFile(path, "utf8")).trim());
      expect(starters).toContain(holder);
      await expect(stat(`${path}.break`)).rejects.toThrow(/ENOENT/);
      await (winners[0] as PromiseFulfilledResult<{ release(): Promise<void> }>).value.release();
    }
  });

  it("refuses to replace a stale lock while another starter is replacing it", async () => {
    await writeFile(path, "999999\n");
    await writeFile(`${path}.break`, "1001\n");
    await expect(acquireDaemonLock(path, { pid: 4242, isAlive: () => false })).rejects.toThrow(/is starting/);
    expect(await readFile(path, "utf8")).toBe("999999\n");
  });

  it("refuses an unreadable lock rather than guessing", async () => {
    await writeFile(path, "not a pid");
    await expect(acquireDaemonLock(path)).rejects.toThrow(/unreadable/);
  });

  it("does not remove a lock another process took over", async () => {
    const lock = await acquireDaemonLock(path, { pid: 4242 });
    await writeFile(path, "5151\n");
    await lock.release();
    expect(await readFile(path, "utf8")).toBe("5151\n");
  });
});

describe("processIsAlive", () => {
  it("knows this process exists", () => {
    expect(processIsAlive(process.pid)).toBe(true);
  });
});
