import { BirdwatchError } from "../../sdk/src/types.js";
import type { BatchCounts } from "../../sdk/src/types.js";
import type { ExactEvent } from "./index.js";

export const exactOutboxPath = "app:/data/birdwatch.sqlite";
interface Database {
  execute(sql: string, params?: string[]): Promise<{ changes: number }>;
  query(sql: string, params?: string[]): Promise<{ rows: unknown[][] }>;
  close(): Promise<void>;
}
export interface ExactSQLite {
  open(path: string): Promise<Database>;
}
export interface QueuedExactEvent extends ExactEvent {
  timestamp: string;
}

// Exact's web storage host holds an exclusive file lock until close.
let lastUse: Promise<unknown> = Promise.resolve();

export function exactOutbox(
  scope: string,
  capture: (event: ExactEvent) => Promise<BatchCounts>,
  normalize: (event: ExactEvent) => ExactEvent
) {
  function use<T>(sqlite: ExactSQLite, action: (db: Database) => Promise<T>) {
    const run = lastUse.then(async () => {
      const db = await sqlite.open(exactOutboxPath);
      try {
        await db.execute(
          "CREATE TABLE IF NOT EXISTS events_v1 (seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, uuid TEXT NOT NULL, event TEXT NOT NULL, UNIQUE(scope,uuid))"
        );
        return await action(db);
      } finally {
        await db.close();
      }
    });
    lastUse = run.catch(() => {});
    return run;
  }
  async function enqueue(input: QueuedExactEvent, sqlite: ExactSQLite) {
    const event = normalize(input);
    if (
      typeof event.timestamp !== "string" ||
      !/(Z|[+-]\d{2}:\d{2})$/.test(event.timestamp) ||
      !Number.isFinite(Date.parse(event.timestamp))
    ) {
      throw new BirdwatchError(
        "invalid_input",
        "Queued events require their original ISO timestamp with a time zone."
      );
    }
    const body = JSON.stringify(event);
    await use(sqlite, async (db) => {
      const stored = await db.execute(
        "INSERT INTO events_v1(scope,uuid,event) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM events_v1 WHERE scope=?) < 1000 ON CONFLICT(scope,uuid) DO NOTHING",
        [scope, event.id, body, scope]
      );
      if (
        !stored.changes &&
        !(
          await db.query("SELECT seq FROM events_v1 WHERE scope=? AND uuid=?", [
            scope,
            event.id,
          ])
        ).rows.length
      )
        throw new BirdwatchError("queue_full", "The Exact outbox is full.");
    });
    return { id: event.id };
  }
  async function flush(sqlite: ExactSQLite): Promise<BatchCounts> {
    // Close handles before network I/O. A concurrent answer can still enqueue.
    const rows = await use(sqlite, (db) =>
      db.query(
        "SELECT seq,event FROM events_v1 WHERE scope=? ORDER BY seq LIMIT 100",
        [scope]
      )
    );
    let accepted = 0,
      duplicates = 0;
    for (const [seq, raw] of rows.rows) {
      const event: ExactEvent = JSON.parse(String(raw));
      try {
        const result = await capture(event);
        accepted += result.accepted;
        duplicates += result.duplicates;
      } catch (error) {
        if (
          !(
            error instanceof BirdwatchError &&
            (error.status === 400 || error.status === 413)
          )
        )
          throw error;
        await use(sqlite, (db) =>
          db.execute("DELETE FROM events_v1 WHERE scope=? AND seq=?", [
            scope,
            String(seq),
          ])
        );
        throw error;
      }
      await use(sqlite, (db) =>
        db.execute("DELETE FROM events_v1 WHERE scope=? AND seq=?", [
          scope,
          String(seq),
        ])
      );
    }
    return { accepted, duplicates };
  }
  return { enqueue, flush };
}
