import { newId } from "./event.js";
import { utf8Length } from "./utf8.js";
import type { EncodedEvent } from "./event.js";

export function browserOutbox(host: string, key: string, report: () => void) {
  const prefix = "birdwatch.outbox:" + JSON.stringify([host, key]) + ":";
  let reported = false;
  function failed() {
    if (!reported) {
      reported = true;
      report();
    }
  }
  return {
    restore(add: (row: EncodedEvent, slot: string) => void) {
      try {
        const store = window.localStorage;
        const slots: string[] = [];
        for (let i = 0; i < store.length; i++) {
          const slot = store.key(i);
          if (slot?.startsWith(prefix)) slots.push(slot);
        }
        for (const slot of slots.sort()) {
          const json = store.getItem(slot);
          if (json === null) continue;
          try {
            const data = JSON.parse(json);
            if (
              typeof data.uuid !== "string" ||
              typeof data.event !== "string" ||
              typeof data.distinct_id !== "string" ||
              typeof data.timestamp !== "string"
            )
              throw Error();
            add({ id: data.uuid, json, bytes: utf8Length(json) }, slot);
          } catch {
            store.setItem("corrupt:" + slot, json);
            store.removeItem(slot);
            failed();
          }
        }
      } catch {
        failed();
      }
    },
    save(json: string) {
      const slot =
        prefix +
        Date.now() +
        "." +
        String(sequence++).padStart(10, "0") +
        "." +
        newId();
      try {
        window.localStorage.setItem(slot, json);
        return slot;
      } catch {
        failed();
      }
    },
    remove(slot: string) {
      try {
        window.localStorage.removeItem(slot);
      } catch {
        failed();
      }
    },
  };
}
let sequence = 0;
