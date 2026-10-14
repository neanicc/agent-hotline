import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { packageName } from "../src/index.js";

describe("@hotline/core", () => {
  it("exports the name its package.json declares", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      name: string;
    };
    expect(packageName).toBe(manifest.name);
  });
});
