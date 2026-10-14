// `hotline doctor`'s monthly cost estimate: usage over the last 30 days, read
// from the daemon's SQLite store without changing it, priced with the owner's
// rate assumptions (`config.costs`, defaults in core's DEFAULT_COST_RATES). It
// makes no network call and is an estimate, never a bill.
import { stat } from "node:fs/promises";
import type { CostRates } from "@hotline/core";

/** The usage window, treated as one month. */
export const COST_WINDOW_DAYS = 30;
const WINDOW_MS = COST_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export interface Usage {
  /** Calls the daemon placed to the owner. */
  callsPlaced: number;
  /** Calls the owner made to the hotline. */
  callsReceived: number;
  /** Each call's duration rounded up to whole minutes, as Twilio bills, summed. */
  billedMinutes: number;
  /** Texts the daemon sent on its own: asks, notifications, notices. */
  textsSent: number;
  /** Replies to the owner's texts: at most one per text received from the owner. */
  replies: number;
  /** Texts received, from the owner and from any other number. */
  textsReceived: number;
}

export const NO_USAGE: Usage = {
  callsPlaced: 0,
  callsReceived: 0,
  billedMinutes: 0,
  textsSent: 0,
  replies: 0,
  textsReceived: 0,
};

export type UsageReading =
  | { kind: "read"; usage: Usage }
  | { kind: "missing" }
  | { kind: "unreadable"; problem: string };

/** Audit events that stand for a text Hotline sent: `text.sent` and the crash notice. */
const SENT_EVENTS = ["text.sent", "sms.interrupted"] as const;
/** The owner's handled texts; each gets at most one reply. */
const OWNER_TEXT_EVENT = "sms.received";
/** Texts from other numbers: rejected, but Twilio still bills them as received. */
const OTHER_TEXT_EVENT = "sms.other-sender";

/**
 * Reads the last 30 days of usage from the store at `path`, read-only: no
 * migration, no file created. A missing file is `missing`; a database without
 * Hotline's tables reads as no usage.
 */
export async function readUsage(path: string, now: Date): Promise<UsageReading> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", problem: (error as Error).message };
  }
  const { DatabaseSync } = await import("node:sqlite");
  let db: InstanceType<typeof DatabaseSync> | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 2_000 });
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name)),
    );
    const until = now.getTime();
    const since = until - WINDOW_MS;
    const usage: Usage = { ...NO_USAGE };
    if (tables.has("calls")) {
      const rows = db
        .prepare(
          `SELECT started_at, json_extract(record, '$.direction') AS direction,
             json_extract(record, '$.durationSeconds') AS seconds FROM calls`,
        )
        .all();
      for (const row of rows) {
        const started = Date.parse(String(row.started_at));
        if (!(started > since && started <= until)) continue;
        if (row.direction === "inbound") usage.callsReceived++;
        else usage.callsPlaced++;
        const seconds = Number(row.seconds);
        if (Number.isFinite(seconds) && seconds > 0) usage.billedMinutes += Math.ceil(seconds / 60);
      }
    }
    if (tables.has("audit")) {
      const events = [...SENT_EVENTS, OWNER_TEXT_EVENT, OTHER_TEXT_EVENT];
      // The store writes `at` with toISOString, so the strings compare as times.
      const rows = db
        .prepare(
          `SELECT event, COUNT(*) AS n FROM audit WHERE event IN (${events.map(() => "?").join(", ")})
           AND at > ? AND at <= ? GROUP BY event`,
        )
        .all(...events, new Date(since).toISOString(), now.toISOString());
      for (const row of rows) {
        const n = Number(row.n);
        if ((SENT_EVENTS as readonly string[]).includes(String(row.event))) usage.textsSent += n;
        if (row.event === OWNER_TEXT_EVENT) {
          usage.replies += n;
          usage.textsReceived += n;
        }
        if (row.event === OTHER_TEXT_EVENT) usage.textsReceived += n;
      }
    }
    return { kind: "read", usage };
  } catch (error) {
    return { kind: "unreadable", problem: (error as Error).message };
  } finally {
    db?.close();
  }
}

export interface CostLine {
  label: string;
  /** Whole US cents, rounded per line so the lines add up to the total. */
  cents: number;
  /** How the line was worked out, such as "14 min x $0.014". */
  basis: string;
}

export interface CostEstimate {
  twilio: CostLine[];
  elevenLabs: CostLine[];
  totalCents: number;
}

const cents = (dollars: number) => Math.round(dollars * 100);
/** A rate as written, without float noise: $0.0083, $6, $1.15. */
const rateText = (dollars: number) => `$${Number(dollars.toPrecision(6))}`;

/** Prices `usage` with `rates`. Pure. Fixed monthly fees count even with no usage. */
export function estimateMonthlyCost(usage: Usage, rates: CostRates): CostEstimate {
  const minutes = usage.billedMinutes;
  const texts = usage.textsSent + usage.replies + usage.textsReceived;
  const perText = rates.twilioTextPerSegment + rates.twilioCarrierFeePerSegment;
  const overMinutes = Math.max(0, minutes - rates.elevenLabsIncludedMinutes);
  const twilio: CostLine[] = [
    { label: "number", cents: cents(rates.twilioNumberPerMonth), basis: "monthly" },
    {
      label: "calls",
      cents: cents(minutes * rates.twilioCallPerMinute),
      basis: `${minutes} min x ${rateText(rates.twilioCallPerMinute)}`,
    },
    {
      label: "texts",
      cents: cents(texts * perText),
      basis: `${texts} x ${rateText(perText)} with carrier fees, one segment each`,
    },
  ];
  const elevenLabs: CostLine[] = [
    {
      label: "plan",
      cents: cents(rates.elevenLabsPlanPerMonth),
      basis: `monthly, ${rates.elevenLabsIncludedMinutes} min included`,
    },
    {
      label: "extra minutes",
      cents: cents(overMinutes * rates.elevenLabsPerMinute),
      basis: `${overMinutes} min x ${rateText(rates.elevenLabsPerMinute)}`,
    },
    {
      label: "LLM",
      cents: cents(minutes * rates.llmPerMinute),
      basis: `${minutes} min x ${rateText(rates.llmPerMinute)}`,
    },
  ];
  const totalCents = [...twilio, ...elevenLabs].reduce((sum, line) => sum + line.cents, 0);
  return { twilio, elevenLabs, totalCents };
}

const dollars = (value: number) => `$${(value / 100).toFixed(2)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const lineText = (lines: readonly CostLine[]) =>
  lines.map((line) => `${line.label} ${dollars(line.cents)} (${line.basis})`).join(", ");

/** The doctor's info lines for a usage reading. Never pass/fail. */
export function costLines(reading: UsageReading, rates: CostRates, storePath: string): string[] {
  const usage = reading.kind === "read" ? reading.usage : NO_USAGE;
  const estimate = estimateMonthlyCost(usage, rates);
  const source =
    reading.kind === "read"
      ? `from the last ${COST_WINDOW_DAYS} days in ${storePath}`
      : reading.kind === "missing"
        ? `with no usage: no store at ${storePath} yet`
        : `with no usage: could not read ${storePath} (${reading.problem})`;
  const sent = usage.textsSent + usage.replies;
  return [
    `estimate: about ${dollars(estimate.totalCents)} a month, ${source} (assumed rates, not a bill; computed locally)`,
    `usage: ${plural(usage.callsPlaced + usage.callsReceived, "call")} (${usage.callsPlaced} placed, ${usage.callsReceived} received), ${usage.billedMinutes} billed min, ${plural(sent, "text")} sent (including ${plural(usage.replies, "reply", "replies")}), ${usage.textsReceived} received`,
    `Twilio: ${lineText(estimate.twilio)}`,
    `ElevenLabs: ${lineText(estimate.elevenLabs)}`,
    "rates: config costs.* in dollars as listed (defaults match the README cost table)",
  ];
}
