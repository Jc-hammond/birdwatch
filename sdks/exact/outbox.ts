import { invalid, newId, type EncodedEvent } from "../../sdk/src/event.js";
import { BirdwatchError } from "../../sdk/src/types.js";
import { DeliveryFailure, retryDelay, type send } from "../../sdk/src/transport.js";
import type { ExactEvent } from "./index.js";

export const exactOutboxPath = "app:/data/birdwatch.sqlite";
const quarantine = "app:/data/birdwatch-quarantine";
type Command = { sql: string; params?: string[] };
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
type Report = (error: BirdwatchError) => void;
const empty = { accepted: 0, duplicates: 0, retryAfterMs: 0, retryAtMs: 0, retryToken: 0 };
const create = "CREATE TABLE IF NOT EXISTS events_v1(seq INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,uuid TEXT NOT NULL,event TEXT NOT NULL,UNIQUE(scope,uuid))";

type Lease = { db: Promise<Database>; users: number; damaged: boolean; release(): void; closed: Promise<void> };
const handles = new WeakMap<ExactStorage["sqlite"], Lease>();

function open(storage: ExactStorage, report: Report): Lease {
  const db = storage.sqlite.open(exactOutboxPath);
  let release!: () => void;
  const released = new Promise<void>(done => { release = done; });
  const lease: Lease = { db, users: 0, damaged: false, release, closed: released.then(async () => {
    try {
      await db.then(handle => handle.close(), () => {});
      if (!lease.damaged) return;
      const backup = quarantine + "/" + newId();
      await storage.fs.mkdir(quarantine);
      for (const suffix of ["-wal", "-shm", "-journal", ""]) {
        try { await storage.fs.rename(exactOutboxPath + suffix, backup + suffix); }
        catch (error) { if (!suffix || !/ENOENT|no such file/i.test(String(error))) throw error; }
      }
      report(new BirdwatchError("storage", "Moved the unreadable Exact outbox aside."));
    } finally { handles.delete(storage.sqlite); }
  }) };
  handles.set(storage.sqlite, lease);
  return lease;
}

// Share the granted handle until all operations finish. Exactly one closer
// quarantines a damaged file before waiting answers reopen it.
async function use<T>(storage: ExactStorage, report: Report, action: (db: Database) => Promise<T>, recover = true): Promise<T> {
  const current = handles.get(storage.sqlite);
  if (current && (!current.users || current.damaged)) {
    await current.closed;
    return use(storage, report, action, recover);
  }
  const lease = current ?? open(storage, report);
  lease.users++;
  try {
    const db = await lease.db;
    await db.execute(create);
    return await action(db);
  } catch (error) {
    if (!recover || !/SQLITE_(CORRUPT|NOTADB)|file is not a database|database disk image is malformed/i.test(String(error))) throw error;
    lease.damaged = true;
  } finally {
    if (--lease.users === 0) { lease.release(); await lease.closed; }
  }
  await lease.closed;
  return use(storage, report, action, false);
}

export function exactOutbox(scope: string, capacity: number, overhead: number,
  encode: (event: ExactEvent) => EncodedEvent,
  deliver: (rows: EncodedEvent[], at: number, background: boolean) => ReturnType<typeof send>, report: Report) {
  let overflow = false, paused = false;
  let failures = 0, generation = 0, waiting = 0, wait = 0, retryAt = 0;
  let running: Promise<typeof empty> | undefined, retryThrough: string | undefined;
  async function enqueue(input: QueuedExactEvent, storage: ExactStorage) {
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
  async function replay(db: Database, at: number, background: boolean, bound?: string): Promise<typeof empty> {
    const started = generation;
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
        if (events.length && bytes + event.bytes + 1 > (background ? 49152 : 1048576)) break;
        events.push(event);
        bytes += event.bytes + 1;
        sequences.push(String(seq));
      } catch {
        // Each corrupt row keeps its own scope and original bytes.
        const removed = await db.execute("UPDATE events_v1 SET scope='corrupt:'||seq||':'||scope WHERE scope=? AND seq=?", params);
        damaged ||= !!removed.changes;
      }
    }
    if (damaged) report(new BirdwatchError("storage", "Moved unreadable Exact events aside."));
    if (!events.length) return empty;
    const deletes = sequences.map(seq => ({ sql: "DELETE FROM events_v1 WHERE scope=? AND seq=?", params: [scope, seq] }));
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
        if (!paused) { paused = true; report(error); }
        return empty;
      }
      const jitter = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
      if (error instanceof DeliveryFailure && error.retryAt !== undefined) retryAt = Math.max(retryAt, error.retryAt);
      else wait = Math.max(wait, Math.ceil(retryDelay(error, failures, jitter)));
      failures++;
      retryThrough = sequences.at(-1);
      waiting = ++generation;
      return { ...empty, retryAfterMs: wait, retryAtMs: retryAt, retryToken: waiting };
    }
    const removed = await db.transaction(deletes);
    for (const [index, error] of result.rejected) if (removed[index].changes) report(error);
    overflow = false;
    if (started === generation) failures = 0;
    return { ...empty, ...result.counts };
  }
  function flush(storage: ExactStorage, at: number, background = false, retryToken = 0): Promise<typeof empty> {
    if (!Number.isFinite(at)) invalid("Pass epoch milliseconds from Contract.");
    if (paused || waiting !== retryToken) return Promise.resolve(empty);
    if (!background && !retryToken && running) return running;
    const bound = retryThrough;
    retryThrough = undefined;
    waiting = wait = retryAt = 0;
    const work = use(storage, report, db => replay(db, at, background, bound));
    if (background) return work;
    const active = work.finally(() => { if (running === active) running = undefined; });
    running = active;
    return running;
  }
  return { enqueue, flush };
}
