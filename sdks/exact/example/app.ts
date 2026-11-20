import { createExactClient } from "@birdwatch/exact";
import type { Answer, Sources } from "./app.contract.d.ts";

const host = "http://127.0.0.1:8123";
export const grants = `net.fetch ${host}
sqlite.open app:/data/birdwatch.sqlite
fs.write app:/data/birdwatch.sqlite
fs.write app:/data/birdwatch.sqlite-wal
fs.write app:/data/birdwatch.sqlite-shm
fs.write app:/data/birdwatch.sqlite-journal
fs.write app:/data/birdwatch-quarantine`;
const client = createExactClient({ host, writeKey: "YOUR_PROJECT_WRITE_KEY", fetch });

const sources: Sources = {
  recordCompletion: ([distinctId, id, at], _store, storage) =>
    client.enqueue({ id, distinctId, timestamp: new Date(at).toISOString(),
      event: "onboarding_completed", properties: { step: "welcome" } }, storage),
  replay: async ([at, background, token], _store, storage) => ({
    retryToken: 0, retryAfterMs: 0, ...await client.flush(storage, at, background, token),
  })
};
export const answer: Answer = (source, args, store, storage, native) =>
  sources[source](args, store, storage, native);
