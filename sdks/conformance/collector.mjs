import { createServer } from "node:http";
import { once } from "node:events";

// The collector never advances the SDK clock. It records what actually reaches HTTP.
export async function startCollector(answers) {
  const requests = [];
  const stored = new Set();
  const held = new Set();
  let duplicates = 0;
  let probe = false;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/api/capture") {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      res.writeHead(400).end();
      return;
    }
    const answer = probe ? "ack" : answers[requests.length];
    requests.push(body);
    const json = (status, value, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };
    if (!Array.isArray(body?.batch) || !body.batch.every(event => typeof event?.uuid === "string")) {
      json(400, {code:"invalid_event", error:"Expected a batch of events with UUIDs."});
      return;
    }
    if (!answer) {
      json(400, {code:"invalid_event", error:"Unexpected request beyond the scenario script."});
      return;
    }
    if (answer.html) {
      res.writeHead(answer.status, {"Content-Type":"text/html"}).end("<html>Proxy error</html>");
      return;
    }
    if (answer.status) {
      json(answer.status, {code:answer.code, error:"Scripted collector response."},
        answer.retryAfter === undefined ? {} : {"Retry-After":String(answer.retryAfter)});
      return;
    }
    let accepted = 0, repeated = 0;
    const rejected = [];
    for (const [index, item] of body.batch.entries()) {
      if (answer.reject?.includes(index)) {
        rejected.push({index,code:"invalid_event",message:"Scripted event rejection."});
      } else if (stored.has(item.uuid)) {
        repeated++;
      } else {
        stored.add(item.uuid);
        accepted++;
      }
    }
    duplicates += repeated;
    const acknowledge = () => json(200, {accepted, duplicates:repeated, rejected});
    if (answer === "loseAck") {
      req.socket.destroy();
    } else if (answer === "holdAck") {
      held.add(acknowledge);
      res.on("close", () => held.delete(acknowledge));
    } else {
      acknowledge();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    host: "http://127.0.0.1:" + server.address().port,
    requests, stored,
    get held() { return held.size; },
    get duplicates() { return duplicates; },
    release() { for (const send of held) send(); held.clear(); },
    beginProbe() { probe = true; },
    async close() {
      const closed = once(server,"close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
