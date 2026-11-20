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
  recordCompletion: ([distinctId, id, at], _store, storage) =>
    client.enqueue({ id, distinctId, timestamp: new Date(at).toISOString(),
      event: "onboarding_completed", properties: { step: "welcome" } }, storage),
  replay: ([at, background, token], _store, storage) => client.flush(storage, at, background, token),
};
export const answer: Answer = (source, args, store, storage, native) =>
  sources[source](args, store, storage, native);
