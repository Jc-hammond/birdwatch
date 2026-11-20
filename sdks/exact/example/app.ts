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

const sources: Sources = {
  recordCompletion: async ([distinctId, id, at], _store, storage) => {
    const context = { storage, at };
    await client.identify(context, distinctId);
    return { id: await client.capture(context, "onboarding_completed", { step: "welcome" }, { id }) };
  },
  replay: ([at, background, retryToken], _store, storage) => client.flush({ storage, at, background, retryToken }),
};
export const answer: Answer = (source, args, store, storage, native) =>
  sources[source](args, store, storage, native);
