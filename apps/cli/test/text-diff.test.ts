import { describe, expect, it } from "vitest";
import { lineDiff } from "../src/text-diff.js";

describe("lineDiff", () => {
  it("is empty for equal texts", () => {
    expect(lineDiff("f", "a\nb\n", "a\nb\n")).toBe("");
  });

  it("marks added and removed lines with a little context and skips the rest", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].join("\n");
    const after = ["1", "2", "3", "4", "5", "six", "7", "8", "9", "10"].join("\n");
    expect(lineDiff("f", before, after).split("\n")).toEqual([
      "--- f (before)",
      "+++ f (after)",
      "@@",
      " 4",
      " 5",
      "-6",
      "+six",
      " 7",
      " 8",
      " 9",
      "+10",
    ]);
  });

  it("shows a new file as all additions", () => {
    expect(lineDiff("f", "", "a\nb\n").split("\n").slice(2)).toEqual(["+a", "+b"]);
  });
});
