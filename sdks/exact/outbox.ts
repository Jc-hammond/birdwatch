import { invalid, newId, type EncodedEvent } from "../../sdk/src/event.js";
import { BirdwatchError, type BatchCounts } from "../../sdk/src/types.js";
import { DeliveryFailure, retryDelay, type send } from "../../sdk/src/transport.js";
import type { ExactEvent } from "./index.js";

export const exactOutboxPath = "app:/data/birdwatch.sqlite";
const quarantine = "app:/data/birdwatch-quarantine";
type Command = { sql: string; params?: string[] };
const removeRow = "DELETE FROM events_v1 WHERE scope=? AND seq=?";
interface Database {
  execute(sql: string, params?: string[]): Promise<{ changes: number }>;
  query(sql: string, params?: string[]): Promise<{ rows: unknown[][] }>;
  transaction(commands: Command[]): Promise<{ changes: number }[]>;
  close(): Promise<void>;
}
export interface ExactStorage {
  sqlite: { open(path: string): Promise<Database> };
  fs: { mkdir(path: string): Promise<void>; rename(from: string, to: string): Promise<void> };
}
export type QueuedExactEvent = ExactEvent & { timestamp: string };
type Replay = BatchCounts & { retryAfterMs?: number; retryToken?: number };
type Report = (error: BirdwatchError) => void;
const empty = { accepted: 0, duplicates: 0 };
const create = "CREATE TABLE IF NOT EXISTS events_v1(seq INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,uuid TEXT NOT NULL,event TEXT NOT NULL,UNIQUE(scope,uuid))";

async function open(storage: ExactStorage, report: Report): Promise<Database> {
  async function initialize() {
    const db = await storage.sqlite.open(exactOutboxPath);
    try {
      await db.execute(create);
      return db;
    } catch (error) {
      await db.close();
      throw error;
    }
  }
  try { return await initialize(); }
  catch (error) {
    if (!/SQLITE_(CORRUPT|NOTADB)|file is not a database|database disk image is malformed/i.test(String(error))) throw error;
    const backup = quarantine + "/" + newId();
    await storage.fs.mkdir(quarantine);
    for (const suffix of ["-wal", "-shm", "-journal", ""]) {
      try { await storage.fs.rename(exactOutboxPath + suffix, backup + suffix); }
      catch (cause) { if (!suffix || !/ENOENT|no such file/i.test(String(cause))) throw cause; }
    }
    report(new BirdwatchError("storage", "Moved the unreadable Exact outbox aside."));
    return initialize();
  }
}
type Lease = { db: Promise<Database>; users: number; closing?: Promise<void> };
const handles = new WeakMap<ExactStorage["sqlite"], Lease>();

// Overlapping answers share the runtime's granted handle until the last user closes it.
async function use<T>(storage: ExactStorage, report: Report, action: (db: Database) => Promise<T>) {
  let lease = handles.get(storage.sqlite);
  if (!lease || lease.closing) {
    const db = Promise.resolve(lease?.closing).then(() => open(storage, report));
    lease = { db, users: 0 };
    handles.set(storage.sqlite, lease);
  }
  lease.users++;
  try { return await action(await lease.db); }
  finally {
    if (--lease.users === 0) await (lease.closing = lease.db.then(db => db.close(), () => {}));
  }
}

export function exactOutbox(scope: string, capacity: number, overhead: number,
  encode: (event: ExactEvent) => EncodedEvent,
  deliver: (rows: EncodedEvent[], at: number, background: boolean) => ReturnType<typeof send>, report: Report) {
  let overflow = false, paused = false;
  let failures = 0, generation = 0, waiting = 0, wait = 0;
  let running: Promise<Replay> | undefined, retryThrough: string | undefined;
  function enqueue(input: QueuedExactEvent, storage: ExactStorage) {
    if (!input.timestamp) invalid("Pass the original event time from Contract.");
    const encoded = encode(input);
    const { uuid: id, distinct_id: distinctId, ...fields } = JSON.parse(encoded.json);
    return use(storage, report, async db => {
      const [, dropped] = await db.transaction([
        { sql: "INSERT INTO events_v1(scope,uuid,event) VALUES(?,?,?) ON CONFLICT(scope,uuid) DO NOTHING",
          params: [scope, id, JSON.stringify({ id, distinctId, ...fields })] },
        { sql: "DELETE FROM events_v1 WHERE scope=? AND seq IN (SELECT seq FROM events_v1 WHERE scope=? ORDER BY seq DESC LIMIT -1 OFFSET ?)",
          params: [scope, scope, String(capacity)] },
      ]);
      if (dropped.changes && !overflow) {
        overflow = true;
        report(new BirdwatchError("queue_full", "Dropped the oldest queued event."));
      }
      return { id: encoded.id };
    });
  }
  async function replay(db: Database, at: number, background: boolean): Promise<Replay> {
    const bound = !background && retryThrough;
    const { rows } = await db.query("SELECT seq,uuid,event FROM events_v1 WHERE scope=?" +
      (bound ? " AND seq<=?" : "") + " ORDER BY seq LIMIT 100", bound ? [scope, bound] : [scope]);
    const events: EncodedEvent[] = [], sequences: string[] = [];
    let bytes = overhead, damaged = false;
    for (const [seq, uuid, raw] of rows) {
      const params = [scope, String(seq)];
      try {
        const stored = JSON.parse(String(raw));
        if (stored.id !== uuid || !stored.timestamp) throw Error();
        const event = encode(stored);
        if (events.length && bytes + event.bytes + 1 > 1048576) break;
        events.push(event);
        bytes += event.bytes + 1;
        sequences.push(String(seq));
      } catch {
        const [, , removed] = await db.transaction([
          { sql: "CREATE TABLE IF NOT EXISTS corrupt_events(scope TEXT,uuid TEXT,event TEXT)" },
          { sql: "INSERT INTO corrupt_events SELECT scope,uuid,event FROM events_v1 WHERE scope=? AND seq=?", params },
          { sql: removeRow, params },
        ]);
        damaged ||= !!removed.changes;
      }
    }
    if (damaged) report(new BirdwatchError("storage", "Moved unreadable Exact events aside."));
    if (!events.length) {
      retryThrough = undefined;
      return empty;
    }
    const deletes = sequences.map(seq => ({ sql: removeRow, params: [scope, seq] }));
    let result: Awaited<ReturnType<typeof send>>;
    try { result = await deliver(events, at, background); }
    catch (error) {
      if (error instanceof DeliveryFailure && error.outcome === "drop") {
        if ((await db.transaction(deletes)).some(row => row.changes)) report(error);
        return empty;
      }
      const live = await db.query("SELECT 1 FROM events_v1 WHERE scope=? AND seq BETWEEN ? AND ? LIMIT 1",
        [scope, sequences[0], sequences[sequences.length - 1]]);
      if (!live.rows.length) return empty;
      if (error instanceof DeliveryFailure && error.outcome === "pause") {
        if (!paused) report(error);
        paused = true;
        return empty;
      }
      const jitter = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
      wait = Math.max(wait, Math.ceil(retryDelay(error, failures++, jitter)));
      retryThrough = sequences.at(-1);
      waiting = ++generation;
      return { ...empty, retryAfterMs: wait, retryToken: waiting };
    }
    const removed = await db.transaction(deletes);
    for (const [index, error] of result.rejected) if (removed[index].changes) report(error);
    overflow = false;
    failures = 0;
    retryThrough = undefined;
    return result.counts;
  }
  function flush(storage: ExactStorage, at: number, background = false, retryToken = 0): Promise<Replay> {
    if (!Number.isFinite(at)) invalid("Pass epoch milliseconds from Contract.");
    if (paused || (waiting && retryToken !== waiting)) return Promise.resolve(empty);
    if (!background && running) return running;
    waiting = wait = 0;
    const work = use(storage, report, db => replay(db, at, background));
    if (background) return work;
    running = work.finally(() => { running = undefined; });
    return running;
  }
  return { enqueue, flush };
}
