// The daemon's SQLite store, through Node's built-in `node:sqlite` (no native
// dependency). Each table keeps the full record as validated JSON plus the
// columns the daemon queries by; every write and every read goes through the
// HL-02 schemas, so a malformed row fails loudly instead of flowing on.
//
// Times are passed in by callers (the daemon's injected clock); the store never
// reads the wall clock.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type AgentKind,
  Answer,
  Ask,
  type AskKind,
  type AskStatus,
  answerProblem,
  CallRecord,
  Id,
  NoAnswerReason,
  Session,
  Timestamp,
} from "@hotline/core";
import { z } from "zod";
import { privatePathProblem } from "./private-file.js";
import { createRedactor, type Redactor } from "./redact.js";

export class StoreError extends Error {
  override readonly name = "StoreError";
}

/**
 * Schema migrations, applied in order. `PRAGMA user_version` records how many have
 * run. Append new migrations; never edit or reorder a released one.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    agent_session_id TEXT,
    state TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    record TEXT NOT NULL
  ) STRICT;

  CREATE TABLE asks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id),
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
  CREATE INDEX asks_by_status ON asks (status, created_at);

  -- One answer per ask: the primary key stops an ask from being answered twice.
  CREATE TABLE answers (
    ask_id TEXT PRIMARY KEY REFERENCES asks (id),
    answered_at TEXT NOT NULL,
    record TEXT NOT NULL
  ) STRICT;

  CREATE TABLE calls (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    record TEXT NOT NULL
  ) STRICT;

  CREATE TABLE audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    event TEXT NOT NULL,
    detail TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
    BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
    BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
  `,
  // The ask, session and call an audit entry refers to, in their own columns. The
  // redactor removes UUID-shaped values, so ids inside `detail` would be stored as
  // [REDACTED]. ADD COLUMN keeps the append-only triggers.
  `
  ALTER TABLE audit ADD COLUMN ask_id TEXT;
  ALTER TABLE audit ADD COLUMN session_id TEXT;
  ALTER TABLE audit ADD COLUMN call_id TEXT;
  CREATE INDEX audit_by_ask ON audit (ask_id) WHERE ask_id IS NOT NULL;
  CREATE INDEX audit_by_session ON audit (session_id) WHERE session_id IS NOT NULL;
  CREATE INDEX audit_by_call ON audit (call_id) WHERE call_id IS NOT NULL;
  `,
  // Call orchestration (HL-09): why an ask ended without an answer, the
  // orchestrator's saved state, and the owner's texts already handled.
  `
  ALTER TABLE asks ADD COLUMN end_reason TEXT;
  CREATE TABLE daemon_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
  CREATE TABLE inbound_messages (
    message_sid TEXT PRIMARY KEY,
    handled_at TEXT NOT NULL,
    finished INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  `,
  // The inbound line (HL-10): instructions the owner gave a session on a call,
  // queued until that session's next ask, inbox read or Stop hook.
  `
  CREATE TABLE instructions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id),
    status TEXT NOT NULL,
    received_at TEXT NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
  CREATE INDEX instructions_by_session ON instructions (session_id, status, received_at);
  `,
  // Limits and memories that must survive a restart (HL-13b): wrong PINs per
  // call direction, the inbound line's calls with the instructions they hold
  // until the post-call event, and the server-tool deliveries that changed
  // state. Times are epoch milliseconds from the daemon's clock.
  `
  CREATE TABLE pin_failures (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    at_ms INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX pin_failures_by_direction ON pin_failures (direction, at_ms);
  CREATE TABLE inbound_calls (
    conversation_id TEXT PRIMARY KEY,
    expires_at_ms INTEGER NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
  CREATE TABLE tool_deliveries (
    key TEXT PRIMARY KEY,
    expires_at_ms INTEGER NOT NULL,
    response TEXT NOT NULL
  ) STRICT;
  CREATE INDEX tool_deliveries_by_expiry ON tool_deliveries (expires_at_ms);
  `,
];

/** The two PIN failure budgets: calls to the Hotline number, and calls Hotline placed. */
export type PinFailureDirection = "inbound" | "outbound";

/** Where an owner instruction is in its life: waiting for its session, handed over, or dropped undelivered. */
export const InstructionStatus = z.enum(["queued", "delivered", "dropped"]);
export type InstructionStatus = z.infer<typeof InstructionStatus>;

/** How a queued instruction reached its session. */
export const InstructionDelivery = z.enum(["inbox", "ask", "stop"]);
export type InstructionDelivery = z.infer<typeof InstructionDelivery>;

/** Why a queued instruction was dropped without being delivered. */
export const InstructionDrop = z.enum(["session-ended", "expired"]);
export type InstructionDrop = z.infer<typeof InstructionDrop>;

const notBlank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((text) => text.trim().length > 0, "must not be blank");

/**
 * An instruction the owner gave one session on a call, after the PIN, confirmed
 * against the owner's own turns in the post-call transcript. Never agent text.
 */
export const Instruction = z.strictObject({
  id: Id,
  sessionId: Id,
  /** The instruction in the owner's own words, redacted and capped. */
  text: notBlank(1000),
  /** The owner's transcript turns that back it, verbatim apart from redaction. */
  ownerExcerpt: notBlank(2000),
  /** The call it came from (the ElevenLabs conversation id). */
  sourceId: Id,
  channel: z.literal("voice"),
  receivedAt: Timestamp,
  status: InstructionStatus,
  deliveredVia: InstructionDelivery.optional(),
  dropReason: InstructionDrop.optional(),
  /** When it was delivered or dropped. */
  closedAt: Timestamp.optional(),
});
export type Instruction = z.infer<typeof Instruction>;

/**
 * Why an ask ended without an answer, stored next to its final status: a
 * `NoAnswerReason`, or `delivered` for a notification whose text went out.
 */
export const AskEndReason = z.enum([...NoAnswerReason.options, "delivered"]);
export type AskEndReason = z.infer<typeof AskEndReason>;

/**
 * The ask, session and call an audit entry refers to. Validated against core's
 * `Id`, then stored as given in their own columns: never redacted.
 */
export interface AuditIds {
  askId?: string;
  sessionId?: string;
  callId?: string;
}

const AUDIT_ID_COLUMNS = { askId: "ask_id", sessionId: "session_id", callId: "call_id" } as const;
type AuditIdKey = keyof typeof AUDIT_ID_COLUMNS;
const AUDIT_ID_KEYS = Object.keys(AUDIT_ID_COLUMNS) as AuditIdKey[];

export interface AuditEntry extends AuditIds {
  seq: number;
  at: string;
  event: string;
  /** Redacted before it was stored. Ids belong in the typed fields, not here. */
  detail: Record<string, unknown>;
}

export interface OpenStoreOptions {
  /** Applied to audit details before they are stored. Defaults to pattern-only redaction. */
  redactor?: Redactor;
  /** For tests; defaults to `MIGRATIONS`. */
  migrations?: readonly string[];
}

const AUDIT_EVENT = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  return Number(row?.user_version ?? 0);
}

function migrate(db: DatabaseSync, migrations: readonly string[]): void {
  const current = schemaVersion(db);
  if (current > migrations.length) {
    throw new StoreError(
      `The Hotline database has schema version ${current}, newer than this hotline understands (${migrations.length}); upgrade hotline`,
    );
  }
  for (let version = current; version < migrations.length; version++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migrations[version] ?? "");
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new StoreError(`Database migration ${version + 1} failed: ${(error as Error).message}`);
    }
  }
}

/**
 * Opens (creating if needed) the database at `path` and brings its schema up to
 * date. The file is mode 0600 in a 0700 directory, and a file or directory that
 * other users can reach, or a symlink, is refused.
 */
export async function openStore(path: string, options: OpenStoreOptions = {}): Promise<HotlineStore> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const problem = await privatePathProblem(path);
  if (problem !== undefined && problem !== "missing") {
    throw new StoreError(`Hotline database ${path} ${problem}`);
  }
  if (problem === "missing") {
    // Create the file 0600 ourselves, so it never exists with umask permissions.
    // SQLite treats an empty file as a new database. If another process created it
    // in the meantime, re-check it instead.
    try {
      await writeFile(path, "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const again = await privatePathProblem(path);
      if (again !== undefined) throw new StoreError(`Hotline database ${path} ${again}`);
    }
  }
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  try {
    await chmod(path, 0o600);
    // Overwritten and deleted rows are zeroed on disk, so state replaced since
    // (such as a plaintext code from before HL-13a) does not linger in free pages.
    db.exec("PRAGMA secure_delete = ON");
    migrate(db, options.migrations ?? MIGRATIONS);
  } catch (error) {
    db.close();
    throw error;
  }
  return new HotlineStore(db, options.redactor ?? createRedactor());
}

type Row = Record<string, unknown>;

/** Checks audit ids against core's `Id`. An unknown key is an error, never dropped. */
function auditIds(ids: AuditIds): AuditIds {
  const valid: AuditIds = {};
  for (const [key, value] of Object.entries(ids)) {
    if (!Object.hasOwn(AUDIT_ID_COLUMNS, key)) throw new StoreError(`Unknown audit id "${key}"`);
    if (value === undefined) continue;
    if (!Id.safeParse(value).success) throw new StoreError(`Audit ${key} is not a valid id`);
    valid[key as AuditIdKey] = value;
  }
  return valid;
}

/** The part of a zod schema the store uses. */
interface Schema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

/** Told the id of an ask whose status changed, after the change is committed. */
export type AskChangeListener = (askId: string) => void;

/**
 * How long a finished owner text's SID is remembered. Twilio signatures carry no
 * timestamp, so a captured, validly signed reply can be replayed at any time: the
 * SID memory must outlive any realistic replay. Rows are tiny.
 */
export const INBOUND_MESSAGE_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

/** Told about each ask `addAsk` stored, after the insert. */
export type AskAddedListener = (ask: Ask) => void;

export class HotlineStore {
  private closed = false;
  private readonly askListeners = new Set<AskChangeListener>();
  private readonly addListeners = new Set<AskAddedListener>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly redactor: Redactor,
  ) {}

  get schemaVersion(): number {
    return schemaVersion(this.db);
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  /** Closes the database. Safe to call more than once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // Sessions ---------------------------------------------------------------

  /** Inserts or replaces a session. */
  putSession(session: Session): void {
    const record = Session.parse(session);
    this.db
      .prepare(
        `INSERT INTO sessions (id, agent_session_id, state, last_seen_at, record) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET agent_session_id = excluded.agent_session_id,
           state = excluded.state, last_seen_at = excluded.last_seen_at, record = excluded.record`,
      )
      .run(record.id, record.agentSessionId ?? null, record.state, record.lastSeenAt, JSON.stringify(record));
  }

  getSession(id: string): Session | undefined {
    const row = this.db.prepare("SELECT id, record FROM sessions WHERE id = ?").get(id);
    return row === undefined ? undefined : this.decode(Session, "session", row);
  }

  /** The live (not `ended`) session of `agent` with the agent's own session id, if any. */
  findLiveSession(agent: AgentKind, agentSessionId: string): Session | undefined {
    return this.db
      .prepare(
        "SELECT id, record FROM sessions WHERE agent_session_id = ? AND state != 'ended' ORDER BY last_seen_at DESC, id",
      )
      .all(agentSessionId)
      .map((row) => this.decode(Session, "session", row))
      .find((session) => session.agent === agent);
  }

  listSessions(): Session[] {
    return this.db
      .prepare("SELECT id, record FROM sessions ORDER BY last_seen_at DESC, id")
      .all()
      .map((row) => this.decode(Session, "session", row));
  }

  // Asks -------------------------------------------------------------------

  /** Inserts a new ask. Its session must exist and its id must be new. */
  addAsk(ask: Ask): void {
    const record = Ask.parse(ask);
    if (record.status === "answered") throw new StoreError("An ask is answered only through recordAnswer");
    this.wrap(`Could not add ask ${record.id}`, () =>
      this.db
        .prepare(
          "INSERT INTO asks (id, session_id, status, created_at, expires_at, record) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          record.id,
          record.sessionId,
          record.status,
          record.createdAt,
          record.expiresAt,
          JSON.stringify(record),
        ),
    );
    for (const listener of [...this.addListeners]) {
      try {
        listener(record);
      } catch {
        // A listener's failure must not undo or hide a committed write.
      }
    }
  }

  /**
   * Calls `listener` with each ask `addAsk` stores, after the insert. Returns a
   * function that stops listening. A listener that throws affects nothing else.
   */
  onAskAdded(listener: AskAddedListener): () => void {
    this.addListeners.add(listener);
    return () => {
      this.addListeners.delete(listener);
    };
  }

  getAsk(id: string): Ask | undefined {
    const row = this.db.prepare("SELECT id, record FROM asks WHERE id = ?").get(id);
    return row === undefined ? undefined : this.decode(Ask, "ask", row);
  }

  /**
   * How many asks of `kind` are still `pending` or `in-flight`, in one session or,
   * with `sessionId` undefined, in all of them.
   */
  countOpenAsks(sessionId: string | undefined, kind: AskKind): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS open FROM asks WHERE (? IS NULL OR session_id = ?)
         AND status IN ('pending', 'in-flight') AND json_extract(record, '$.kind') = ?`,
      )
      .get(sessionId ?? null, sessionId ?? null, kind);
    return Number(row?.open ?? 0);
  }

  /** The newest `limit` asks of one session, newest first. */
  listSessionAsks(sessionId: string, limit: number): Ask[] {
    return this.db
      .prepare("SELECT id, record FROM asks WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(sessionId, limit)
      .map((row) => this.decode(Ask, "ask", row));
  }

  /**
   * Calls `listener` with an ask's id each time `setAskStatus` or `recordAnswer`
   * changes that ask, after the transaction commits. Returns a function that stops
   * listening. A listener that throws affects neither the write nor other listeners.
   */
  onAskChange(listener: AskChangeListener): () => void {
    this.askListeners.add(listener);
    return () => {
      this.askListeners.delete(listener);
    };
  }

  /** Asks in creation order, optionally only those with one of `statuses`. */
  listAsks(statuses?: readonly AskStatus[]): Ask[] {
    const rows =
      statuses === undefined
        ? this.db.prepare("SELECT id, record FROM asks ORDER BY created_at, id").all()
        : this.db
            .prepare(
              `SELECT id, record FROM asks WHERE status IN (${statuses.map(() => "?").join(", ") || "NULL"})
               ORDER BY created_at, id`,
            )
            .all(...statuses);
    return rows.map((row) => this.decode(Ask, "ask", row));
  }

  /**
   * Moves an ask that is still `pending` or `in-flight` to `status`. Returns false,
   * changing nothing, when the ask is missing or already final. `answered` is set
   * only by `recordAnswer`, together with the answer itself.
   */
  setAskStatus(id: string, status: Exclude<AskStatus, "answered">): boolean {
    if ((status as AskStatus) === "answered") {
      throw new StoreError("An ask is answered only through recordAnswer");
    }
    const changed = this.transaction(() => {
      const ask = this.getAsk(id);
      if (ask === undefined || (ask.status !== "pending" && ask.status !== "in-flight")) return false;
      this.writeAskStatus({ ...ask, status });
      return true;
    });
    if (changed) this.askChanged(id);
    return changed;
  }

  /**
   * Ends an ask that is still open with `status` and records why. Returns true
   * when it changed the status. An ask that is already `expired` or `cancelled`
   * without a reason (the agent API expired it a moment earlier) gets the reason;
   * nothing else changes a final ask.
   */
  closeAsk(id: string, status: "expired" | "cancelled", reason: AskEndReason): boolean {
    const valid = AskEndReason.parse(reason);
    const changed = this.transaction(() => {
      const ask = this.getAsk(id);
      if (ask === undefined) return false;
      if (ask.status === "pending" || ask.status === "in-flight") {
        this.writeAskStatus({ ...ask, status });
        this.db.prepare("UPDATE asks SET end_reason = ? WHERE id = ?").run(valid, id);
        return true;
      }
      if (ask.status !== "answered") {
        this.db.prepare("UPDATE asks SET end_reason = ? WHERE id = ? AND end_reason IS NULL").run(valid, id);
      }
      return false;
    });
    if (changed) this.askChanged(id);
    return changed;
  }

  /** Why a closed ask ended without an answer, when that was recorded. */
  askEndReason(id: string): AskEndReason | undefined {
    const row = this.db.prepare("SELECT end_reason FROM asks WHERE id = ?").get(id);
    const parsed = AskEndReason.safeParse(row?.end_reason);
    return parsed.success ? parsed.data : undefined;
  }

  // Answers ----------------------------------------------------------------

  /**
   * Stores the owner's answer and marks its ask answered, atomically. Throws
   * StoreError, storing nothing, when `answerProblem` rejects it (unknown or closed
   * ask, expired, wrong kind of decision, unconfirmed high-risk approval).
   */
  recordAnswer(answer: Answer, receivedAt: Date): void {
    const record = Answer.parse(answer);
    this.transaction(() => {
      const ask = this.getAsk(record.askId);
      if (ask === undefined) throw new StoreError(`No ask ${record.askId}`);
      const problem = answerProblem(ask, record, receivedAt);
      if (problem !== undefined) throw new StoreError(`Answer for ask ${ask.id} refused: ${problem}`);
      this.db
        .prepare("INSERT INTO answers (ask_id, answered_at, record) VALUES (?, ?, ?)")
        .run(record.askId, record.answeredAt, JSON.stringify(record));
      this.writeAskStatus({ ...ask, status: "answered" });
    });
    this.askChanged(record.askId);
  }

  getAnswer(askId: string): Answer | undefined {
    const row = this.db.prepare("SELECT ask_id AS id, record FROM answers WHERE ask_id = ?").get(askId);
    return row === undefined ? undefined : this.decode(Answer, "answer", row);
  }

  // Calls ------------------------------------------------------------------

  /** Inserts or replaces a call record; calls are updated as they progress. */
  putCall(call: CallRecord): void {
    const record = CallRecord.parse(call);
    this.db
      .prepare(
        `INSERT INTO calls (id, started_at, outcome, record) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET started_at = excluded.started_at, outcome = excluded.outcome,
           record = excluded.record`,
      )
      .run(record.id, record.startedAt, record.outcome, JSON.stringify(record));
  }

  getCall(id: string): CallRecord | undefined {
    const row = this.db.prepare("SELECT id, record FROM calls WHERE id = ?").get(id);
    return row === undefined ? undefined : this.decode(CallRecord, "call", row);
  }

  listCalls(): CallRecord[] {
    return this.db
      .prepare("SELECT id, record FROM calls ORDER BY started_at, id")
      .all()
      .map((row) => this.decode(CallRecord, "call", row));
  }

  // Daemon state ------------------------------------------------------------

  /** A saved JSON value, such as the call orchestrator's state; undefined when none or unreadable. */
  getState(key: string): unknown {
    const row = this.db.prepare("SELECT value FROM daemon_state WHERE key = ?").get(key);
    if (row === undefined) return undefined;
    try {
      return JSON.parse(String(row.value)) as unknown;
    } catch {
      return undefined;
    }
  }

  putState(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO daemon_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify(value));
  }

  // Inbound texts -----------------------------------------------------------

  /** Whether the owner's text with this message SID was already handled, in this run or an earlier one. */
  inboundMessageHandled(messageSid: string): boolean {
    return (
      this.db.prepare("SELECT 1 AS seen FROM inbound_messages WHERE message_sid = ?").get(messageSid) !==
      undefined
    );
  }

  /** Records the owner's text as handled, so a redelivery is never handled again. */
  markInboundMessage(messageSid: string, at: Date): void {
    this.db
      .prepare("INSERT OR IGNORE INTO inbound_messages (message_sid, handled_at) VALUES (?, ?)")
      .run(messageSid, at.toISOString());
    // Finished messages are kept for 400 days, unfinished ones until they finish.
    this.db
      .prepare("DELETE FROM inbound_messages WHERE finished = 1 AND handled_at < ?")
      .run(new Date(at.getTime() - INBOUND_MESSAGE_RETENTION_MS).toISOString());
  }

  /** When a text with this SID was first seen (claimed), if it ever was. */
  inboundMessageFirstSeen(messageSid: string): Date | undefined {
    const row = this.db
      .prepare("SELECT handled_at FROM inbound_messages WHERE message_sid = ?")
      .get(messageSid);
    return row === undefined ? undefined : new Date(String(row.handled_at));
  }

  /** Records that a claimed text was handled to the end, whatever its outcome. */
  finishInboundMessage(messageSid: string): void {
    this.db.prepare("UPDATE inbound_messages SET finished = 1 WHERE message_sid = ?").run(messageSid);
  }

  /** Texts that were claimed but never finished: the daemon stopped part way through them. */
  unfinishedInboundMessages(): string[] {
    return this.db
      .prepare("SELECT message_sid FROM inbound_messages WHERE finished = 0 ORDER BY handled_at, message_sid")
      .all()
      .map((row) => String(row.message_sid));
  }

  // Owner instructions ------------------------------------------------------

  /**
   * Stores a new instruction; its session must exist. Idempotent by id: one
   * already stored is left as it is and false is returned, so a retried
   * post-call webhook can never queue the same instruction twice.
   */
  addInstruction(instruction: Instruction): boolean {
    const record = Instruction.parse(instruction);
    const result = this.wrap(`Could not add instruction ${record.id}`, () =>
      this.db
        .prepare(
          `INSERT INTO instructions (id, session_id, status, received_at, record) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
        )
        .run(record.id, record.sessionId, record.status, record.receivedAt, JSON.stringify(record)),
    );
    return Number(result.changes) > 0;
  }

  /** Instructions oldest first, optionally of one session and one status. */
  listInstructions(filter: { sessionId?: string; status?: InstructionStatus } = {}): Instruction[] {
    return this.db
      .prepare(
        `SELECT id, record FROM instructions WHERE (? IS NULL OR session_id = ?) AND (? IS NULL OR status = ?)
         ORDER BY received_at, id`,
      )
      .all(filter.sessionId ?? null, filter.sessionId ?? null, filter.status ?? null, filter.status ?? null)
      .map((row) => this.decode(Instruction, "instruction", row));
  }

  /**
   * A session's queued instructions, oldest first, without handing them over.
   * Those received before `expireBefore` are dropped as `expired` in the same
   * transaction and never returned.
   */
  peekInstructions(
    sessionId: string,
    at: Date,
    expireBefore: Date,
  ): { queued: Instruction[]; expired: Instruction[] } {
    return this.transaction(() => {
      const queued: Instruction[] = [];
      const expired: Instruction[] = [];
      for (const instruction of this.listInstructions({ sessionId, status: "queued" })) {
        if (Date.parse(instruction.receivedAt) < expireBefore.getTime()) {
          this.writeInstruction({
            ...instruction,
            status: "dropped",
            dropReason: "expired",
            closedAt: at.toISOString(),
          });
          expired.push(instruction);
        } else {
          queued.push(instruction);
        }
      }
      return { queued, expired };
    });
  }

  /**
   * Marks the session's instructions `ids` delivered, those still queued only,
   * in one transaction, and returns them oldest first. A reader acknowledges
   * only what it is about to pass on, so nothing is marked delivered and lost.
   */
  ackInstructions(
    sessionId: string,
    ids: readonly string[],
    via: InstructionDelivery,
    at: Date,
  ): Instruction[] {
    const wanted = new Set(ids);
    return this.transaction(() => {
      const acked = this.listInstructions({ sessionId, status: "queued" }).filter((i) => wanted.has(i.id));
      for (const instruction of acked) {
        this.writeInstruction({
          ...instruction,
          status: "delivered",
          deliveredVia: via,
          closedAt: at.toISOString(),
        });
      }
      return acked;
    });
  }

  /**
   * Drops queued instructions undelivered: one session's, or with `receivedBefore`
   * every one older than that. Returns the instructions it dropped.
   */
  dropInstructions(
    filter: { sessionId?: string; receivedBefore?: Date },
    reason: InstructionDrop,
    at: Date,
  ): Instruction[] {
    return this.transaction(() => {
      const before = filter.receivedBefore?.getTime();
      const dropped = this.listInstructions({
        ...(filter.sessionId === undefined ? {} : { sessionId: filter.sessionId }),
        status: "queued",
      }).filter((instruction) => before === undefined || Date.parse(instruction.receivedAt) < before);
      for (const instruction of dropped) {
        this.writeInstruction({
          ...instruction,
          status: "dropped",
          dropReason: reason,
          closedAt: at.toISOString(),
        });
      }
      return dropped;
    });
  }

  // PIN failures ------------------------------------------------------------

  /** Counts one wrong-PIN attempt on `direction`. Returns its handle, for `removePinFailure`. */
  addPinFailure(direction: PinFailureDirection, atMs: number): number {
    const result = this.db
      .prepare("INSERT INTO pin_failures (direction, at_ms) VALUES (?, ?)")
      .run(direction, Math.trunc(atMs));
    return Number(result.lastInsertRowid);
  }

  /** Takes back an attempt that was counted before its PIN turned out right. */
  removePinFailure(handle: number): void {
    this.db.prepare("DELETE FROM pin_failures WHERE seq = ?").run(handle);
  }

  /** When each kept wrong-PIN attempt on `direction` was made, oldest first. */
  pinFailureTimes(direction: PinFailureDirection): number[] {
    return this.db
      .prepare("SELECT at_ms FROM pin_failures WHERE direction = ? ORDER BY at_ms, seq")
      .all(direction)
      .map((row) => Number(row.at_ms));
  }

  /** Forgets wrong-PIN attempts made at or before `beforeMs`. */
  prunePinFailures(beforeMs: number): void {
    this.db.prepare("DELETE FROM pin_failures WHERE at_ms <= ?").run(Math.trunc(beforeMs));
  }

  // Inbound calls -------------------------------------------------------------

  /**
   * Saves one call's inbound-line memory (the session numbers its status read
   * out and the instructions it holds), as the inbound line validated it.
   */
  putInboundCall(conversationId: string, expiresAtMs: number, record: unknown): void {
    this.db
      .prepare(
        `INSERT INTO inbound_calls (conversation_id, expires_at_ms, record) VALUES (?, ?, ?)
         ON CONFLICT (conversation_id) DO UPDATE SET expires_at_ms = excluded.expires_at_ms,
           record = excluded.record`,
      )
      .run(conversationId, Math.trunc(expiresAtMs), JSON.stringify(record));
  }

  deleteInboundCall(conversationId: string): void {
    this.db.prepare("DELETE FROM inbound_calls WHERE conversation_id = ?").run(conversationId);
  }

  /**
   * Every saved call memory, oldest expiry first. `record` is the parsed JSON,
   * or undefined when it is not JSON; the inbound line validates it.
   */
  listInboundCalls(): { conversationId: string; expiresAtMs: number; record: unknown }[] {
    return this.db
      .prepare(
        "SELECT conversation_id, expires_at_ms, record FROM inbound_calls ORDER BY expires_at_ms, conversation_id",
      )
      .all()
      .map((row) => {
        let record: unknown;
        try {
          record = JSON.parse(String(row.record)) as unknown;
        } catch {
          record = undefined;
        }
        return {
          conversationId: String(row.conversation_id),
          expiresAtMs: Number(row.expires_at_ms),
          record,
        };
      });
  }

  // Server-tool deliveries ----------------------------------------------------

  /** The response a remembered tool delivery got, while it has not expired. */
  toolDelivery(key: string, nowMs: number): Record<string, unknown> | undefined {
    const row = this.db
      .prepare("SELECT response FROM tool_deliveries WHERE key = ? AND expires_at_ms > ?")
      .get(key, Math.trunc(nowMs));
    if (row === undefined) return undefined;
    try {
      const response = JSON.parse(String(row.response)) as unknown;
      return typeof response === "object" && response !== null && !Array.isArray(response)
        ? (response as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Remembers a tool delivery that changed state, with the response it got. */
  putToolDelivery(key: string, expiresAtMs: number, response: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO tool_deliveries (key, expires_at_ms, response) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET expires_at_ms = excluded.expires_at_ms, response = excluded.response`,
      )
      .run(key, Math.trunc(expiresAtMs), JSON.stringify(response));
  }

  /** How many remembered tool deliveries have not expired. */
  countToolDeliveries(nowMs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS kept FROM tool_deliveries WHERE expires_at_ms > ?")
      .get(Math.trunc(nowMs));
    return Number(row?.kept ?? 0);
  }

  /** Forgets tool deliveries that expired at or before `nowMs`. */
  pruneToolDeliveries(nowMs: number): void {
    this.db.prepare("DELETE FROM tool_deliveries WHERE expires_at_ms <= ?").run(Math.trunc(nowMs));
  }

  // Audit ------------------------------------------------------------------

  /**
   * Appends to the audit log. `event` is a dotted lowercase name such as
   * `daemon.started`. `detail` is free text and is redacted before it is stored.
   * `ids` are validated and stored as given in their own columns, so the entry
   * stays linked to its ask, session and call. Entries cannot be changed or
   * deleted afterwards.
   */
  appendAudit(event: string, detail: Record<string, unknown>, at: Date, ids: AuditIds = {}): number {
    if (!AUDIT_EVENT.test(event)) throw new StoreError(`Invalid audit event name "${event}"`);
    if (Number.isNaN(at.getTime())) throw new StoreError("Audit time is invalid");
    const valid = auditIds(ids);
    const redacted = JSON.stringify(this.redactor.value(detail));
    const result = this.db
      .prepare("INSERT INTO audit (at, event, detail, ask_id, session_id, call_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        at.toISOString(),
        event,
        redacted,
        valid.askId ?? null,
        valid.sessionId ?? null,
        valid.callId ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  /** Audit entries in order, optionally only those matching every id in `filter`. */
  listAudit(filter: AuditIds = {}): AuditEntry[] {
    const valid = auditIds(filter);
    const keys = AUDIT_ID_KEYS.filter((key) => valid[key] !== undefined);
    const where = keys.map((key) => `${AUDIT_ID_COLUMNS[key]} = ?`).join(" AND ");
    return this.db
      .prepare(
        `SELECT seq, at, event, detail, ask_id, session_id, call_id FROM audit
         ${where === "" ? "" : `WHERE ${where}`} ORDER BY seq`,
      )
      .all(...keys.map((key) => valid[key] ?? null))
      .map((row) => {
        const entry: AuditEntry = {
          seq: Number(row.seq),
          at: String(row.at),
          event: String(row.event),
          detail: JSON.parse(String(row.detail)) as Record<string, unknown>,
        };
        for (const key of AUDIT_ID_KEYS) {
          const value = row[AUDIT_ID_COLUMNS[key]];
          if (value !== null && value !== undefined) entry[key] = String(value);
        }
        return entry;
      });
  }

  // Internals --------------------------------------------------------------

  private askChanged(askId: string): void {
    for (const listener of [...this.askListeners]) {
      try {
        listener(askId);
      } catch {
        // A listener's failure must not undo or hide a committed write.
      }
    }
  }

  private writeInstruction(instruction: Instruction): void {
    const record = Instruction.parse(instruction);
    this.db
      .prepare("UPDATE instructions SET status = ?, record = ? WHERE id = ?")
      .run(record.status, JSON.stringify(record), record.id);
  }

  private writeAskStatus(ask: Ask): void {
    const record = Ask.parse(ask);
    this.db
      .prepare("UPDATE asks SET status = ?, record = ? WHERE id = ?")
      .run(record.status, JSON.stringify(record), record.id);
  }

  private decode<T>(schema: Schema<T>, kind: string, row: Row): T {
    let decoded: unknown;
    try {
      decoded = JSON.parse(String(row.record));
    } catch {
      throw new StoreError(`Stored ${kind} ${String(row.id)} is not valid JSON`);
    }
    const parsed = schema.safeParse(decoded);
    if (!parsed.success) throw new StoreError(`Stored ${kind} ${String(row.id)} does not match its schema`);
    return parsed.data;
  }

  private wrap<T>(message: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      throw new StoreError(`${message}: ${(error as Error).message}`);
    }
  }

  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
