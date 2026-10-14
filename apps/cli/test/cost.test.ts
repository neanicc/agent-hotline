// The monthly cost estimate: reading usage from a temporary store, pricing it,
// and keeping the README's cost table on the same default rates.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CostRates, DEFAULT_COST_RATES } from "@hotline/core";
import { MIGRATIONS, openStore } from "@hotline/daemon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { costLines, estimateMonthlyCost, NO_USAGE, readUsage } from "../src/cost.js";
import { NOW, seedTypicalUsage, TYPICAL } from "./cost-helpers.js";

const rates: CostRates = { ...DEFAULT_COST_RATES };

let dir: string;
let dbPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hl11b-cost-"));
  dbPath = join(dir, "hotline.db");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("readUsage", () => {
  it("counts the last 30 days of calls, minutes and texts", async () => {
    await seedTypicalUsage(dbPath);
    expect(await readUsage(dbPath, NOW)).toEqual({ kind: "read", usage: TYPICAL });
  });

  it("reads an empty store as no usage, and a missing one as missing without creating it", async () => {
    (await openStore(dbPath)).close();
    expect(await readUsage(dbPath, NOW)).toEqual({ kind: "read", usage: NO_USAGE });
    const empty = join(dir, "empty.db");
    await writeFile(empty, "", { mode: 0o600 });
    expect(await readUsage(empty, NOW)).toEqual({ kind: "read", usage: NO_USAGE });
    const missing = join(dir, "missing.db");
    expect(await readUsage(missing, NOW)).toEqual({ kind: "missing" });
    await expect(stat(missing)).rejects.toThrow(/ENOENT/);
  });

  it("never migrates or writes the store", async () => {
    // A store at an older schema stays at that schema after a read.
    (await openStore(dbPath, { migrations: MIGRATIONS.slice(0, 1) })).close();
    const before = await readFile(dbPath);
    expect((await readUsage(dbPath, NOW)).kind).toBe("read");
    expect(await readFile(dbPath)).toEqual(before);
    const store = await openStore(dbPath, { migrations: MIGRATIONS.slice(0, 1) });
    expect(store.schemaVersion).toBe(1);
    store.close();
  });

  it("reports a file that is not a database as unreadable", async () => {
    await writeFile(dbPath, "not a database, just text that is long enough to have a header".repeat(4));
    const reading = await readUsage(dbPath, NOW);
    expect(reading.kind).toBe("unreadable");
  });
});

describe("estimateMonthlyCost", () => {
  it("charges only the fixed monthly fees with no usage", () => {
    const estimate = estimateMonthlyCost(NO_USAGE, rates);
    expect(estimate.totalCents).toBe(115 + 600);
    expect(estimate.twilio.map((line) => line.cents)).toEqual([115, 0, 0]);
    expect(estimate.elevenLabs.map((line) => line.cents)).toEqual([600, 0, 0]);
  });

  it("prices typical usage line by line, and the lines add up to the total", () => {
    const estimate = estimateMonthlyCost(TYPICAL, rates);
    // 6 min x $0.014 = 8c; 9 texts x $0.0153 = 14c; LLM 6 min x $0.03 = 18c.
    expect(estimate.twilio.map((line) => line.cents)).toEqual([115, 8, 14]);
    expect(estimate.elevenLabs.map((line) => line.cents)).toEqual([600, 0, 18]);
    expect(estimate.totalCents).toBe(755);
  });

  it("charges ElevenLabs minutes beyond the included ones", () => {
    const estimate = estimateMonthlyCost({ ...NO_USAGE, billedMinutes: 100 }, rates);
    expect(estimate.elevenLabs[1]).toEqual({ label: "extra minutes", cents: 200, basis: "25 min x $0.08" });
  });

  it("uses overridden rates", () => {
    const custom = {
      ...rates,
      twilioNumberPerMonth: 0,
      elevenLabsPlanPerMonth: 22,
      elevenLabsIncludedMinutes: 5,
      elevenLabsPerMinute: 0.1,
      llmPerMinute: 0,
    };
    expect(estimateMonthlyCost(TYPICAL, custom).totalCents).toBe(0 + 8 + 14 + 2200 + 10 + 0);
  });

  it("lands the README's 60 minutes and 200 texts inside its stated total", () => {
    const estimate = estimateMonthlyCost({ ...NO_USAGE, billedMinutes: 60, textsSent: 200 }, rates);
    expect(estimate.totalCents).toBe(115 + 84 + 306 + 600 + 0 + 180);
    expect(estimate.totalCents).toBeGreaterThanOrEqual(1200);
    expect(estimate.totalCents).toBeLessThanOrEqual(1400);
  });
});

describe("costLines", () => {
  it("says it is an estimate and shows the breakdown", () => {
    const lines = costLines({ kind: "read", usage: TYPICAL }, rates, "/tmp/hl11b/hotline.db");
    expect(lines[0]).toContain("estimate: about $7.55 a month, from the last 30 days");
    expect(lines[0]).toContain("(assumed rates, not a bill; computed locally)");
    expect(lines[1]).toBe(
      "usage: 3 calls (2 placed, 1 received), 6 billed min, 6 texts sent (including 2 replies), 3 received",
    );
    expect(lines[2]).toContain("calls $0.08 (6 min x $0.014)");
    expect(lines[2]).toContain("texts $0.14 (9 x $0.0153 with carrier fees, one segment each)");
    expect(lines[3]).toContain("plan $6.00 (monthly, 75 min included)");
  });

  it("names a missing or unreadable store and prices no usage", () => {
    expect(costLines({ kind: "missing" }, rates, "/x/hotline.db")[0]).toContain(
      "about $7.15 a month, with no usage: no store at /x/hotline.db yet",
    );
    expect(costLines({ kind: "unreadable", problem: "locked" }, rates, "/x/hotline.db")[0]).toContain(
      "could not read /x/hotline.db (locked)",
    );
  });
});

describe("README cost table", () => {
  it("quotes the same default rates as the code", async () => {
    const readme = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "../../../README.md"),
      "utf8",
    );
    const section = readme.slice(readme.indexOf("## Costs"), readme.indexOf("## Development"));
    const r = DEFAULT_COST_RATES;
    for (const text of [
      `$${r.twilioNumberPerMonth} / month`,
      `$${r.twilioCallPerMinute} / min`,
      `$${r.twilioTextPerSegment} + about $${r.twilioCarrierFeePerSegment} / segment`,
      `$${r.elevenLabsPlanPerMonth} / month, ${r.elevenLabsIncludedMinutes} call minutes included, then $${r.elevenLabsPerMinute} / min`,
      `$${r.llmPerMinute} / min`,
      "DEFAULT_COST_RATES",
    ]) {
      expect(section).toContain(text);
    }
  });
});
