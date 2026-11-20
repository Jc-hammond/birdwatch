import { BirdwatchError } from "../../sdk/src/types.js";
import { utf8Length } from "../../sdk/src/utf8.js";
import type { EncodedEvent } from "../../sdk/src/event.js";

export interface IdentityStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem?(key: string): Promise<void>;
  multiGet?(
    keys: string[],
  ): Promise<readonly (readonly [string, string | null])[]>;
  multiRemove?(keys: string[]): Promise<void>;
}

export interface Row extends EncodedEvent {
  sequence: number;
  epoch: string;
}
interface Header {
  epoch: string;
  first: number;
  next: number;
}
const locks = new Map<string, Promise<void>>();
// Leave a spare slot so a failed header write never overwrites a committed event.
const slots = 100001;

export function storageError(cause: unknown) {
  return cause instanceof BirdwatchError
    ? cause
    : new BirdwatchError(
        "storage",
        "Birdwatch could not access local storage.",
        undefined,
        { cause },
      );
}

function checkedEvent(json: string) {
  const event = JSON.parse(json);
  if (
    !event ||
    typeof event.uuid !== "string" ||
    !event.uuid ||
    typeof event.event !== "string" ||
    typeof event.distinct_id !== "string" ||
    typeof event.timestamp !== "string" ||
    !Number.isFinite(Date.parse(event.timestamp)) ||
    !event.properties ||
    typeof event.properties !== "object" ||
    Array.isArray(event.properties)
  )
    throw Error("Invalid outbox entry");
  return { id: event.uuid, json, bytes: utf8Length(json) };
}

export class Outbox {
  private header: Header = { epoch: "initial", first: 0, next: 0 };
  private raw: string | null | undefined;
  private readonly rows = new Map<string, Row>();
  constructor(
    private storage: IdentityStorage | null,
    private key: string,
    private capacity: number,
    private id: () => string,
    private report: (error: BirdwatchError) => void,
  ) {}

  private run<T>(work: () => Promise<T> | T): Promise<T> {
    const task = (locks.get(this.key) ?? Promise.resolve()).then(async () => {
      try {
        await this.load();
        return await work();
      } catch (cause) {
        this.raw = undefined;
        throw storageError(cause);
      }
    });
    const tail = task.then(
      () => {},
      () => {},
    );
    locks.set(this.key, tail);
    void tail.then(() => {
      if (locks.get(this.key) === tail) locks.delete(this.key);
    });
    return task;
  }
  private slot(sequence: number, epoch = this.header.epoch) {
    return this.key + ":row:" + epoch + ":" + (sequence % slots);
  }
  private async publish(header: Header) {
    const raw = JSON.stringify(header);
    await this.storage?.setItem(this.key, raw);
    this.header = header;
    this.raw = raw;
  }
  private async clear(keys: string[]) {
    if (!keys.length || !this.storage) return;
    if (this.storage.multiRemove) await this.storage.multiRemove(keys);
    else
      await Promise.all(
        keys.map(
          (key) =>
            this.storage!.removeItem?.(key) ?? this.storage!.setItem(key, ""),
        ),
      );
  }
  private async quarantine(value: string, key: string) {
    await this.storage!.setItem(key + ":corrupt:" + this.id(), value);
  }
  private async load() {
    if (!this.storage) return;
    const raw = await this.storage.getItem(this.key);
    if (this.raw === raw) return;
    this.rows.clear();
    if (raw === null) {
      this.raw = null;
      this.header = { epoch: "initial", first: 0, next: 0 };
      return;
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      /* preserve the damaged bytes below */
    }
    if (
      !value ||
      typeof value.epoch !== "string" ||
      !value.epoch ||
      !Number.isSafeInteger(value.first) ||
      !Number.isSafeInteger(value.next) ||
      value.first < 0 ||
      value.next < value.first ||
      value.next - value.first >= slots
    ) {
      await this.recoverHeader(raw);
      return;
    }
    this.header = value;
    let damaged = false;
    for (let start = value.first; start < value.next; start += 100) {
      const keys = Array.from(
        { length: Math.min(100, value.next - start) },
        (_, i) => this.slot(start + i),
      );
      const pairs = this.storage.multiGet
        ? await this.storage.multiGet(keys)
        : await Promise.all(
            keys.map(async (k) => [k, await this.storage!.getItem(k)] as const),
          );
      const values = new Map(pairs);
      for (const [i, key] of keys.entries()) {
        const json = values.get(key);
        if (!json) continue;
        try {
          const event = checkedEvent(json);
          this.rows.set(event.id, {
            ...event,
            sequence: start + i,
            epoch: value.epoch,
          });
        } catch {
          await this.quarantine(json, key);
          await this.clear([key]);
          damaged = true;
        }
      }
    }
    this.raw = raw;
    if (damaged)
      this.report(
        new BirdwatchError("storage", "Moved damaged outbox data aside."),
      );
  }
  private async recoverHeader(raw: string) {
    await this.quarantine(raw, this.key);
    this.rows.clear();
    await this.publish({ epoch: this.id(), first: 0, next: 0 });
    this.report(
      new BirdwatchError("storage", "Moved damaged outbox data aside."),
    );
  }
  open() {
    return this.run(() => {});
  }
  put(event: EncodedEvent) {
    return this.run(async () => {
      const existing = this.rows.get(event.id);
      if (existing)
        return { row: existing, dropped: [] as Row[], size: this.rows.size };
      const { epoch, next } = this.header;
      const row: Row = { ...event, sequence: next, epoch };
      const dropped: Row[] = [];
      const firstUnexpired = Math.max(
        this.header.first,
        next + 1 - this.capacity,
      );
      for (const saved of this.rows.values()) {
        if (saved.sequence >= firstUnexpired) break;
        dropped.push(saved);
      }
      await this.storage?.setItem(this.slot(next), event.json);
      await this.publish({ epoch, first: firstUnexpired, next: next + 1 });
      for (const saved of dropped) this.rows.delete(saved.id);
      this.rows.set(row.id, row);
      await this.cleanup(dropped);
      return { row, dropped, size: this.rows.size };
    });
  }
  take(limit: number, bytes: number) {
    return this.run(() => {
      const rows: Row[] = [];
      for (const row of this.rows.values()) {
        if (rows.length >= limit || (rows.length && row.bytes + 1 > bytes))
          break;
        rows.push(row);
        bytes -= row.bytes + 1;
      }
      return rows;
    });
  }
  private async cleanup(rows: Row[]) {
    // The published header is the commit point. Unreferenced slots are safe to reuse.
    try {
      await this.clear(rows.map((r) => this.slot(r.sequence, r.epoch)));
    } catch (cause) {
      this.report(storageError(cause));
    }
  }
  acknowledge(batch: Row[]) {
    return this.run(async () => {
      const matches = new Map(batch.map((row) => [row.id, row]));
      const removed: Row[] = [];
      let first = this.header.next;
      for (const saved of this.rows.values()) {
        const row = matches.get(saved.id);
        if (row?.sequence !== saved.sequence || row.epoch !== saved.epoch) {
          first = saved.sequence;
          break;
        }
        removed.push(saved);
      }
      if (!removed.length) return [];
      await this.publish({ ...this.header, first });
      for (const saved of removed) this.rows.delete(saved.id);
      await this.cleanup(removed);
      return removed;
    });
  }
}
