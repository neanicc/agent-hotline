import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bearerToken,
  ensureApiToken,
  FileSecretStore,
  generateApiToken,
  MIN_API_TOKEN_LENGTH,
  tokensMatch,
} from "../src/index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hotline-token-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("generateApiToken", () => {
  it("returns 43 base64url characters and never repeats", () => {
    const tokens = new Set(Array.from({ length: 50 }, generateApiToken));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("ensureApiToken", () => {
  it("creates the token once, in a 0600 secrets file, and reuses it", async () => {
    const path = join(dir, "home", "secrets.json");
    const store = new FileSecretStore(path);
    const first = await ensureApiToken(store);
    expect(first.length).toBeGreaterThanOrEqual(MIN_API_TOKEN_LENGTH);
    expect(await ensureApiToken(new FileSecretStore(path))).toBe(first);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "home"))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      secrets: { "daemon.apiToken": first },
    });
  });

  it("replaces a stored token too short to be one Hotline generated", async () => {
    const store = new FileSecretStore(join(dir, "secrets.json"));
    await store.set("daemon.apiToken", "short-token");
    const token = await ensureApiToken(store);
    expect(token).not.toBe("short-token");
    expect(await store.get("daemon.apiToken")).toBe(token);
  });
});

describe("tokensMatch", () => {
  const token = generateApiToken();

  it("accepts only the exact token", () => {
    expect(tokensMatch(token, token)).toBe(true);
    expect(tokensMatch(`${token}x`, token)).toBe(false);
    expect(tokensMatch(token.slice(1), token)).toBe(false);
    expect(tokensMatch(token.toUpperCase(), token)).toBe(false);
    expect(tokensMatch("", token)).toBe(false);
  });

  it("never matches an empty expected token", () => {
    expect(tokensMatch("", "")).toBe(false);
  });
});

describe("bearerToken", () => {
  it("reads a Bearer credential and nothing else", () => {
    expect(bearerToken("Bearer abc.DEF-123")).toBe("abc.DEF-123");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken("Bearer ")).toBeUndefined();
    expect(bearerToken("Bearer a b")).toBeUndefined();
    expect(bearerToken("abc")).toBeUndefined();
  });
});
