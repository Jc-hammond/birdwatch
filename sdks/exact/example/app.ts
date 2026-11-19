import { createExactClient } from "@birdwatch/exact";
import type { Answer, Sources } from "./app.contract.d.ts";

const host = "http://127.0.0.1:8123";
export const grants = `net.fetch ${host}\nsqlite.open app:/data/birdwatch.sqlite`;
const client = createExactClient({ host, writeKey: "YOUR_PROJECT_WRITE_KEY", fetch });

const sources: Sources = {
  recordCompletion: ([distinctId, id, at], _store, storage) =>
    client.enqueue({ id, distinctId, timestamp: new Date(at).toISOString(),
      event: "onboarding_completed", properties: { step: "welcome" } }, storage.sqlite),
  replay: (_args, _store, storage) => client.flush(storage.sqlite)
};
export const answer: Answer = (source, args, store, storage, native) =>
  sources[source](args, store, storage, native);
