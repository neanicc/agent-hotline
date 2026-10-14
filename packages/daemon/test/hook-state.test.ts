import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileContinuationStore, readAwayState, writeAwayState } from "../src/index.js";

const AT = new Date("2026-10-14T09:00:00.000Z");
let dir: string;
let home: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hotline-hook-state-"));
  home = join(dir, "home");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("away state", () => {
  it("is off until switched on, and written 0600 in a 0700 directory", async () => {
    const path = join(home, "away.json");
    expect(await readAwayState(path)).toEqual({ away: false });
    await writeAwayState(path, true, AT);
    expect(await readAwayState(path)).toEqual({ away: true, changedAt: AT.toISOString() });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    await writeAwayState(path, false, AT);
    expect((await readAwayState(path)).away).toBe(false);
  });

  it("counts as off when the file is open to others, a symlink or malformed", async () => {
    const path = join(home, "away.json");
    await writeAwayState(path, true, AT);
    await chmod(path, 0o644);
    expect(await readAwayState(path)).toMatchObject({
      away: false,
      problem: expect.stringContaining("chmod 600"),
    });

    await rm(path);
    const elsewhere = join(dir, "elsewhere.json");
    await writeFile(elsewhere, JSON.stringify({ version: 1, away: true, changedAt: AT.toISOString() }), {
      mode: 0o600,
    });
    await symlink(elsewhere, path);
    expect(await readAwayState(path)).toMatchObject({
      away: false,
      problem: expect.stringContaining("symbolic"),
    });

    await rm(path);
    await writeFile(path, "{ not json", { mode: 0o600 });
    expect(await readAwayState(path)).toMatchObject({
      away: false,
      problem: expect.stringContaining("JSON"),
    });
    await writeFile(path, JSON.stringify({ version: 1, away: "yes", changedAt: AT.toISOString() }));
    expect((await readAwayState(path)).away).toBe(false);
  });

  it("counts as off when the hotline home is open to others", async () => {
    await mkdir(home, { mode: 0o755 });
    await chmod(home, 0o755);
    const path = join(home, "away.json");
    await writeFile(path, JSON.stringify({ version: 1, away: true, changedAt: AT.toISOString() }), {
      mode: 0o600,
    });
    expect((await readAwayState(path)).away).toBe(false);
    await expect(writeAwayState(path, true, AT)).rejects.toThrow(/Refusing/);
  });
});

describe("FileContinuationStore", () => {
  it("keeps one hashed private file per agent session", async () => {
    const store = new FileContinuationStore(join(home, "hook-state"));
    expect(await store.get("claude-code", "../../etc/passwd")).toBe(0);
    await store.set("claude-code", "../../etc/passwd", 2, AT);
    await store.set("codex", "../../etc/passwd", 1, AT);
    expect(await store.get("claude-code", "../../etc/passwd")).toBe(2);
    expect(await store.get("codex", "../../etc/passwd")).toBe(1);
    const files = await readdir(join(home, "hook-state"));
    expect(files).toHaveLength(2);
    for (const file of files) expect(file).toMatch(/^(claude-code|codex)-[0-9a-f]{32}\.json$/);
    expect((await stat(join(home, "hook-state"))).mode & 0o777).toBe(0o700);

    await store.set("claude-code", "../../etc/passwd", 0, AT);
    expect(await store.get("claude-code", "../../etc/passwd")).toBe(0);
    await store.clear();
    expect(await store.get("codex", "../../etc/passwd")).toBe(0);
  });

  it("refuses a count it cannot trust, so the Stop hook lets the agent stop", async () => {
    const store = new FileContinuationStore(join(home, "hook-state"));
    await store.set("codex", "s1", 1, AT);
    const [file = ""] = await readdir(join(home, "hook-state"));
    await chmod(join(home, "hook-state", file), 0o666);
    await expect(store.get("codex", "s1")).rejects.toThrow(/chmod 600/);
    await writeFile(join(home, "hook-state", file), JSON.stringify({ version: 1, continuations: -1 }));
    await chmod(join(home, "hook-state", file), 0o600);
    await expect(store.get("codex", "s1")).rejects.toThrow(/unexpected shape/);
  });

  it("does not create a file just to store zero", async () => {
    const store = new FileContinuationStore(join(home, "hook-state"));
    await store.set("codex", "s1", 0, AT);
    await expect(readdir(join(home, "hook-state"))).rejects.toThrow();
  });
});
