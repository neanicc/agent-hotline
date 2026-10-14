// Guards for docs/live-check.md, the owner's live-call protocol (HL-16): every
// scenario in docs/eval.md and every acceptance item in plan section 11 maps to
// a live step, the results template has exactly one row per step, every
// relative link in the docs that points into it resolves, and no phone number
// other than the fake 555-01xx range is written in it.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const LIVE = "docs/live-check.md";
const live = read(LIVE);

/** Lines outside fenced code blocks. */
function prose(text: string): string[] {
  let fenced = false;
  return text.split("\n").filter((line) => {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
}

/** The text between a heading that starts with `start` and the next heading of the same level. */
function section(text: string, start: string): string {
  const lines = text.split("\n");
  const from = lines.findIndex((line) => line.startsWith(start));
  if (from < 0) throw new Error(`no heading starting with ${start}`);
  const level = /^#+/.exec(start)?.[0] ?? "##";
  const to = lines.findIndex((line, index) => index > from && new RegExp(`^${level} `).test(line));
  return lines.slice(from + 1, to < 0 ? undefined : to).join("\n");
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens, repeats numbered. */
function anchors(text: string): Set<string> {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  for (const line of prose(text)) {
    const match = /^#{1,6} (.+)$/.exec(line);
    if (!match?.[1]) continue;
    const base = match[1]
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  return result;
}

/** Relative Markdown links in `text`, outside code blocks. */
function relativeLinks(text: string): string[] {
  const links: string[] = [];
  for (const line of prose(text)) {
    for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1] as string;
      if (!/^[a-z]+:/i.test(target)) links.push(target);
    }
  }
  return links;
}

/** Problems with the relative links in the file at `path` (repository-relative). */
function brokenLinks(path: string, only?: (target: string) => boolean): string[] {
  const problems: string[] = [];
  for (const link of relativeLinks(read(path))) {
    const [file = "", anchor] = link.split("#");
    const target = file === "" ? path : normalize(join(dirname(path), file));
    if (only && !only(target)) continue;
    let text: string;
    try {
      text = read(target);
    } catch {
      problems.push(`${path}: ${link} (no such file)`);
      continue;
    }
    if (anchor !== undefined && target.endsWith(".md") && !anchors(text).has(anchor)) {
      problems.push(`${path}: ${link} (no such heading)`);
    }
  }
  return problems;
}

/**
 * Phone numbers as written: E.164 (also `%2B`-encoded), bare runs of 10 to 15
 * digits, and North American numbers with spaces, dots, dashes or parentheses.
 */
function phoneNumbers(text: string): string[] {
  const patterns = [
    /\+\d{10,15}\b/g,
    /%2B\d{10,15}\b/gi,
    /(?<![\d.+B])\d{10,15}(?![\d.])/g,
    /(?<![\d+])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/g,
  ];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((m) => m[0]));
}

/** The fake range tests and docs use: +1 555 555 0100 to 0199. */
const isFakeNumber = (written: string) => /^1?555555(01\d\d)$/.test(written.replace(/%2B|\D/gi, ""));

const STEP = /^### ([PRL]\d+)\. /;
const steps = prose(live)
  .map((line) => STEP.exec(line)?.[1])
  .filter((id): id is string => id !== undefined);

describe("docs/live-check.md", () => {
  it("numbers its steps P, R and L from 1 without gaps or repeats", () => {
    expect(steps.length).toBeGreaterThan(30);
    for (const prefix of ["P", "R", "L"]) {
      const numbers = steps.filter((id) => id.startsWith(prefix)).map((id) => Number(id.slice(1)));
      expect(numbers.length, prefix).toBeGreaterThan(0);
      expect(numbers, prefix).toEqual(numbers.map((_, index) => index + 1));
    }
  });

  it("has exactly one results row per step", () => {
    const template = section(live, "## 5. Results template");
    const rows = [...template.matchAll(/^\| ([PRL]\d+) \|/gm)].map((m) => m[1]);
    expect(rows).toEqual(steps);
  });

  it("only refers to steps that exist", () => {
    const known = new Set(steps);
    const referenced = new Set<string>();
    for (const line of prose(live)) {
      for (const match of line.matchAll(/\b([PRL])(\d+) to \1(\d+)\b/g)) {
        for (let n = Number(match[2]); n <= Number(match[3]); n++) referenced.add(`${match[1]}${n}`);
      }
      for (const match of line.matchAll(/\b([PRL]\d+)\b/g)) referenced.add(match[1] as string);
    }
    expect([...referenced].filter((id) => !known.has(id))).toEqual([]);
  });

  it("maps every scenario in docs/eval.md to a live step or says it is fakes only", () => {
    const scenarios = [...read("docs/eval.md").matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
    expect(scenarios.length).toBeGreaterThanOrEqual(22);
    const coverage = section(live, "### Scenario suite");
    const rows = new Map(
      [...coverage.matchAll(/^\| `([a-z0-9-]+)` \| (.+) \|$/gm)].map((m) => [m[1], m[2] as string]),
    );
    expect([...rows.keys()].sort()).toEqual([...scenarios].sort());
    for (const [name, where] of rows) {
      expect(/\b[PRL]\d+\b/.test(where) || where.startsWith("fakes only:"), name).toBe(true);
    }
  });

  it("maps every acceptance item in plan section 11", () => {
    const plan = section(read("docs/plan.md"), "## 11.");
    const items = plan.split("\n").filter((line) => line.startsWith("- [ ]"));
    expect(items.length).toBeGreaterThan(0);
    const table = section(live, "### Acceptance checklist");
    const rows = [...table.matchAll(/^\| (\d+)\. .+ \| (.+) \|$/gm)];
    expect(rows.map((m) => Number(m[1]))).toEqual(items.map((_, index) => index + 1));
  });

  it("resolves every relative link it holds", () => {
    expect(brokenLinks(LIVE)).toEqual([]);
  });

  it("is linked correctly from the other docs", () => {
    const docs = [
      "README.md",
      ...readdirSync(new URL("docs/", root))
        .filter((name) => name.endsWith(".md"))
        .map((name) => `docs/${name}`),
    ];
    const problems = docs.flatMap((path) => brokenLinks(path, (target) => target === LIVE));
    expect(problems).toEqual([]);
  });

  it("writes no phone number but the fake 555-01xx ones", () => {
    const numbers = phoneNumbers(live);
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers.filter((written) => !isFakeNumber(written))).toEqual([]);
  });

  it("finds real-looking numbers in every written form", () => {
    const real = ["+14165550199", "%2B14165550199", "4165550199", "(416) 555-0199", "416.555.0199"];
    const found = phoneNumbers(`call ${real.join(" or ")} today`);
    expect(found).toEqual(expect.arrayContaining(real));
    expect(found.filter(isFakeNumber)).toEqual([]);
  });
});
