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
import { Answer, Ask, type AskStatus, answerProblem, CallRecord, Id, Session } from "@hotline/core";
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
];

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

export class HotlineStore {
  private closed = false;

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
  }

  getAsk(id: string): Ask | undefined {
    const row = this.db.prepare("SELECT id, record FROM asks WHERE id = ?").get(id);
    return row === undefined ? undefined : this.decode(Ask, "ask", row);
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
    return this.transaction(() => {
      const ask = this.getAsk(id);
      if (ask === undefined || (ask.status !== "pending" && ask.status !== "in-flight")) return false;
      this.writeAskStatus({ ...ask, status });
      return true;
    });
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
