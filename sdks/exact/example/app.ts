import { createExactClient } from "@birdwatch/exact";
import type { Answer, Sources } from "./app.contract.d.ts";

const host = "http://127.0.0.1:8123";
const db = "app:/data/birdwatch.sqlite";
const read = "fs.read " + db, write = "fs.write " + db;
export const grants = [
  `net.fetch ${host}`, "sqlite.open " + db, "fs.write app:/data/birdwatch-quarantine",
  read, read + "-wal", read + "-shm", read + "-journal",
  write, write + "-wal", write + "-shm", write + "-journal",
].join("\n");
const client = createExactClient({ host, writeKey: "YOUR_PROJECT_WRITE_KEY", fetch });

// A data answer cannot read the clock. Contract supplies a fresh sample while
// delivery is active so consecutive HTTP batches get their actual send times.
const clocks = new Set<(time: number) => void>();
const sendTime = () => new Promise<number>(resolve => clocks.add(resolve));
const sources: Sources = {
  sampleClock: ([at]) => {
    for (const resolve of clocks) resolve(at);
    clocks.clear();
    return { at };
  },
  recordCompletion: async ([distinctId, id, at], _store, storage) => {
    const context = { storage, at };
    await client.identify(context, distinctId);
    return { id: await client.capture(context, "onboarding_completed", { step: "welcome" }, { id }) };
  },
  replay: ([at, background, retryToken], _store, storage) => client.flush({ storage, sendTime: background ? () => at : sendTime, background, retryToken }),
};
export const answer: Answer = (source, args, store, storage, native) =>
  sources[source](args, store, storage, native);
