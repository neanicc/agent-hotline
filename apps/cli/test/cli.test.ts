import { readFileSync } from "node:fs";
import { productName } from "@hotline/core";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";

function capture(argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = run(argv, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

describe("hotline CLI", () => {
  it.each(["--version", "-v", "version"])("%s prints the package version", (flag) => {
    const result = capture([flag]);
    expect(result).toEqual({ code: 0, stdout: `hotline ${manifest.version}`, stderr: "" });
  });

  it.each(["--help", "-h", "help"])("%s prints usage to stdout", (flag) => {
    const result = capture([flag]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: hotline <command>");
    expect(result.stdout).toContain(productName);
    expect(result.stderr).toBe("");
  });

  it("exits 2 with usage on stderr when no command is given", () => {
    const result = capture([]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: hotline <command>");
  });

  it("rejects an unknown command with exit 2", () => {
    const result = capture(["approve-everything"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('unknown command "approve-everything"');
  });
});
