import { BirdwatchError, type BatchCounts } from "../../sdk/src/types.js";
import { DeliveryFailure } from "../../sdk/src/transport.js";
import { utf8Length } from "../../sdk/src/utf8.js";
import type { ExactEvent } from "./index.js";

export const exactOutboxPath = "app:/data/birdwatch.sqlite";
type Command = { sql: string; params?: string[] };
interface Database {
  execute(sql: string, params?: string[]): Promise<{ changes: number }>;
  query(sql: string, params?: string[]): Promise<{ rows: unknown[][] }>;
  transaction(commands: Command[]): Promise<{ changes: number }[]>;
  close(): Promise<void>;
}
export interface ExactSQLite {
  open(path: string): Promise<Database>;
}
export interface QueuedExactEvent extends ExactEvent {
  timestamp: string;
}
type Delivery = { counts: BatchCounts; rejected: Map<number, BirdwatchError> };
type Replay = BatchCounts & { retryAfterMs?: number };

let released = Promise.resolve();
const leases = new WeakMap<ExactSQLite, { db: Promise<Database>; users: number; release: () => void }>();
// Reuse the granted handle during overlapping answers. A different host opens only after close.
async function use<T>(sqlite: ExactSQLite, action: (db: Database) => Promise<T>) {
  let lease = leases.get(sqlite);
  if (!lease) {
    const db = released.then(async () => {
      const handle = await sqlite.open(exactOutboxPath);
      try {
        await handle.execute(
          "CREATE TABLE IF NOT EXISTS events_v1(seq INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,uuid TEXT NOT NULL,event TEXT NOT NULL,UNIQUE(scope,uuid))",
        );
      } catch (error) {
        await handle.close();
        throw error;
      }
      return handle;
    });
    let release!: () => void;
    released = new Promise((done) => {
      release = done;
    });
    lease = { db, users: 0, release };
    leases.set(sqlite, lease);
  }
  lease.users++;
  try {
    return await action(await lease.db);
  } finally {
    if (--lease.users === 0) {
      leases.delete(sqlite);
      try {
        await (await lease.db).close();
      } finally {
        lease.release();
      }
    }
  }
}

export function exactOutbox(
  scope: string,
  capacity: number,
  normalize: (e: ExactEvent) => ExactEvent & { id: string },
  deliver: (events: ExactEvent[], at: number, background: boolean) => Promise<Delivery>,
  report: (e: BirdwatchError) => void,
) {
  let overflow = false,
    paused = false,
    ceiling = 1000,
    retryAt = 0;
  let running: Promise<Replay> | undefined;
  let retryThrough: string | undefined;
  const empty = { accepted: 0, duplicates: 0 };
  async function enqueue(input: QueuedExactEvent, sqlite: ExactSQLite) {
    if (!input.timestamp)
      throw new BirdwatchError("invalid_input", "Pass the event occurrence time from Contract.");
    const event = normalize(input);
    const results = await use(sqlite, (db) =>
      db.transaction([
        {
          sql: "INSERT INTO events_v1(scope,uuid,event) VALUES(?,?,?) ON CONFLICT(scope,uuid) DO NOTHING",
          params: [scope, event.id, JSON.stringify(event)],
        },
        {
          sql: "DELETE FROM events_v1 WHERE scope=? AND seq IN (SELECT seq FROM events_v1 WHERE scope=? ORDER BY seq DESC LIMIT -1 OFFSET ?)",
          params: [scope, scope, String(capacity)],
        },
      ]),
    );
    if (results[1].changes && !overflow) {
      overflow = true;
      report(new BirdwatchError("queue_full", "Dropped the oldest queued event."));
    }
    return { id: event.id };
  }
  async function replay(db: Database, at: number, background: boolean): Promise<Replay> {
    if (paused) return empty;
    if (at < retryAt) return { ...empty, retryAfterMs: retryAt - at };
    const bound = background ? undefined : retryThrough;
    const { rows } = await db.query(
      "SELECT seq,uuid,event FROM events_v1 WHERE scope=?" +
        (bound ? " AND seq<=?" : "") +
        " ORDER BY seq LIMIT 100",
      bound ? [scope, bound] : [scope],
    );
    const events: ExactEvent[] = [],
      seqs: string[] = [];
    let bytes = 256 + utf8Length(scope),
      damaged = false;
    for (const [seq, uuid, raw] of rows) {
      try {
        const stored = JSON.parse(String(raw));
        if (stored?.id !== uuid || !stored.timestamp) throw new Error("Damaged stored event");
        const event = normalize(stored);
        const size = utf8Length(JSON.stringify(event)) + 40;
        if (events.length && bytes + size > 1048576) break;
        bytes += size;
        events.push(event);
        seqs.push(String(seq));
      } catch {
        await db.transaction([
          { sql: "CREATE TABLE IF NOT EXISTS corrupt_events(scope TEXT,uuid TEXT,event TEXT)" },
          {
            sql: "INSERT INTO corrupt_events SELECT scope,uuid,event FROM events_v1 WHERE scope=? AND seq=?",
            params: [scope, String(seq)],
          },
          { sql: "DELETE FROM events_v1 WHERE scope=? AND seq=?", params: [scope, String(seq)] },
        ]);
        damaged = true;
      }
    }
    if (damaged) report(new BirdwatchError("storage", "Moved unreadable Exact events aside."));
    if (!events.length) {
      retryThrough = undefined;
      return empty;
    }
    const where = "scope=? AND seq IN (" + seqs.map(() => "?").join(",") + ")",
      params = [scope, ...seqs];
    let result: Delivery;
    try {
      result = await deliver(events, at, background);
    } catch (error) {
      if (!(await db.query("SELECT 1 FROM events_v1 WHERE " + where + " LIMIT 1", params)).rows.length)
        return empty;
      if (error instanceof DeliveryFailure && error.outcome === "pause") {
        if (!paused) report(error);
        paused = true;
        return empty;
      }
      if (error instanceof DeliveryFailure && error.outcome === "drop") {
        await db.execute("DELETE FROM events_v1 WHERE " + where, params);
        report(error);
        return empty;
      }
      const wait = error instanceof DeliveryFailure ? error.retryAfter : undefined;
      const delay = Math.ceil(wait ?? (crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * ceiling);
      retryAt = Math.max(retryAt, at + delay);
      ceiling = Math.min(60000, ceiling * 2);
      retryThrough = seqs.at(-1);
      return { ...empty, retryAfterMs: retryAt - at };
    }
    const removed = await db.transaction(
      seqs.map((seq) => ({ sql: "DELETE FROM events_v1 WHERE scope=? AND seq=?", params: [scope, seq] })),
    );
    for (const [index, error] of result.rejected) if (removed[index].changes) report(error);
    retryThrough = undefined;
    ceiling = 1000;
    overflow = false;
    return result.counts;
  }
  function flush(sqlite: ExactSQLite, at: number, background = false): Promise<Replay> {
    if (!Number.isFinite(at))
      throw new BirdwatchError("invalid_input", "Pass the current time from Contract.");
    if (!background && running) return running;
    const run = use(sqlite, (db) => replay(db, at, background));
    if (background) return run;
    running = run.finally(() => {
      running = undefined;
    });
    return running;
  }
  return { enqueue, flush };
}
