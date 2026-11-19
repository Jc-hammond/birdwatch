// AsyncStorage replaces a single value atomically. Keep the whole snapshot below
// Android's per-row read limit and serialize read/modify/write across client instances.
import { utf8Length } from "../../sdk/src/utf8.js";
import { BirdwatchError } from "../../sdk/src/types.js";

export interface IdentityStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
export interface WireEvent {
  uuid: string;
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
}
const writers = new Map<string, Promise<void>>();
const maxBytes = 1024 * 1024;

export class Outbox {
  private memory: WireEvent[] = [];
  constructor(
    private storage: IdentityStorage | null,
    private key: string,
    private capacity: number
  ) {}
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const task = (writers.get(this.key) ?? Promise.resolve()).then(fn);
    const tail = task.then(
      () => {},
      () => {}
    );
    writers.set(this.key, tail);
    void tail.then(() => {
      if (writers.get(this.key) === tail) writers.delete(this.key);
    });
    return task;
  }
  private async load(): Promise<WireEvent[]> {
    if (!this.storage) return this.memory;
    const raw = await this.storage.getItem(this.key);
    if (raw === null) return [];
    const rows = JSON.parse(raw);
    if (
      !Array.isArray(rows) ||
      rows.some(
        (row) =>
          !row ||
          typeof row.uuid !== "string" ||
          typeof row.event !== "string" ||
          typeof row.distinct_id !== "string" ||
          typeof row.timestamp !== "string" ||
          typeof row.properties !== "object" ||
          row.properties === null
      )
    )
      throw new Error(
        "Unreadable Birdwatch outbox. The stored data was preserved."
      );
    return rows;
  }
  private async save(rows: WireEvent[]) {
    if (!this.storage) {
      this.memory = rows;
      return;
    }
    const value = JSON.stringify(rows);
    if (utf8Length(value) > maxBytes)
      throw new BirdwatchError("queue_full", "Birdwatch outbox exceeds 1 MiB.");
    await this.storage.setItem(this.key, value);
  }
  list() {
    return this.run(() => this.load());
  }
  put(row: WireEvent) {
    return this.run(async () => {
      const rows = await this.load();
      const existing = rows.find((event) => event.uuid === row.uuid);
      if (existing) return existing;
      if (rows.length >= this.capacity)
        throw new BirdwatchError("queue_full", "Birdwatch outbox is full.");
      await this.save([...rows, row]);
      return row;
    });
  }
  remove(id: string) {
    return this.run(async () => {
      const rows = await this.load();
      const next = rows.filter((row) => row.uuid !== id);
      if (next.length !== rows.length) await this.save(next);
    });
  }
}
