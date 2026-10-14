// A small line diff for `hotline install`, so the owner sees exactly what changes
// in an agent's config. The unchanged head and tail are trimmed before the
// longest-common-subsequence step, so a large file with a small edit stays cheap.

const CONTEXT_LINES = 2;
/** Largest alignment table (cells) before falling back to a block replacement. */
export const MAX_TABLE_CELLS = 1_000_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Lines of `before` and `after` marked " ", "-" or "+", in order. */
function diffLines(before: readonly string[], after: readonly string[]): Array<[string, string]> {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  const a = before.slice(head, before.length - tail);
  const b = after.slice(head, after.length - tail);
  const context = (lines: readonly string[]) => lines.map((line): [string, string] => [" ", line]);
  if ((a.length + 1) * (b.length + 1) > MAX_TABLE_CELLS) {
    // Too large a change to align cheaply (a reformatted file): show it as a
    // block replacement rather than use a table of a.length * b.length cells.
    return [
      ...context(before.slice(0, head)),
      ...a.map((line): [string, string] => ["-", line]),
      ...b.map((line): [string, string] => ["+", line]),
      ...context(before.slice(before.length - tail)),
    ];
  }
  // lengths[i][j]: longest common subsequence of a[i..] and b[j..].
  const lengths = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lengths[i] as number[];
      const next = lengths[i + 1] as number[];
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const middle: Array<[string, string]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      middle.push([" ", a[i++] as string]);
      j++;
    } else if (i < a.length && (j >= b.length || (lengths[i + 1]?.[j] ?? 0) >= (lengths[i]?.[j + 1] ?? 0))) {
      // Removals before additions, as diff prints them.
      middle.push(["-", a[i++] as string]);
    } else {
      middle.push(["+", b[j++] as string]);
    }
  }
  return [
    ...before.slice(0, head).map((line): [string, string] => [" ", line]),
    ...middle,
    ...before.slice(before.length - tail).map((line): [string, string] => [" ", line]),
  ];
}

/**
 * A unified-style diff of two texts with a little context around each change,
 * or "" when they are equal. `label` names the file in the header.
 */
export function lineDiff(label: string, before: string, after: string): string {
  if (before === after) return "";
  const lines = diffLines(splitLines(before), splitLines(after));
  const keep = lines.map(() => false);
  lines.forEach(([mark], index) => {
    if (mark === " ") return;
    for (
      let k = Math.max(0, index - CONTEXT_LINES);
      k <= Math.min(lines.length - 1, index + CONTEXT_LINES);
      k++
    ) {
      keep[k] = true;
    }
  });
  const out = [`--- ${label} (before)`, `+++ ${label} (after)`];
  let skipped = false;
  lines.forEach(([mark, line], index) => {
    if (!keep[index]) {
      if (!skipped) out.push("@@");
      skipped = true;
      return;
    }
    skipped = false;
    out.push(`${mark}${line}`);
  });
  return out.join("\n");
}
