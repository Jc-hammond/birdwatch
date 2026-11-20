import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";

const bundle = await readFile(new URL("../exact/dist/index.cjs", import.meta.url), "utf8");
const require = createRequire(import.meta.url);

// Drive the same scoped SQLite and fetch interfaces a Contract answer receives.
export class ExactDriver {
  static async create(collector, config) {
    const driver = new ExactDriver();
    Object.assign(driver, {
      collector,
      config,
      requests: [],
      errors: [],
      online: true,
      now: Date.UTC(2026, 0, 1),
      generation: 0,
      work: new Set(),
      handles: new Set(),
    });
    driver.dir = await mkdtemp(join(tmpdir(), "birdwatch-exact-"));
    driver.file = join(driver.dir, "outbox.sqlite");
    driver.start();
    return driver;
  }
  start() {
    const gen = ++this.generation;
    this.due = undefined;
    this.work = new Set();
    this.sqlite = {
      open: async () => {
        const db = new DatabaseSync(this.file);
        this.handles.add(db);
        const execute = (sql, params = []) => db.prepare(sql).run(...params);
        return {
          execute: async (...args) => execute(...args),
          query: async (sql, params = []) => ({
            rows: db
              .prepare(sql)
              .all(...params)
              .map(Object.values),
          }),
          transaction: async (commands) => {
            db.exec("BEGIN IMMEDIATE");
            try {
              const results = commands.map((c) => execute(c.sql, c.params));
              db.exec("COMMIT");
              return results;
            } catch (error) {
              db.exec("ROLLBACK");
              throw error;
            }
          },
          close: async () => {
            if (this.handles.delete(db)) db.close();
          },
        };
      },
    };
    const local = (path) => join(this.dir, path.replace("app:/data/", "").replace("birdwatch.sqlite", "outbox.sqlite"));
    this.storage = { sqlite: this.sqlite, fs: {
      mkdir: (path) => mkdir(local(path), { recursive: true }),
      rename: (from, to) => rename(local(from), local(to)),
    } };
    const mod = { exports: {} };
    let sample = 0;
    const random = {
      getRandomValues: (a) => {
        if (a instanceof Uint32Array && this.config.jitter) {
          a[0] = (this.config.jitter[sample++] ?? 0.5) * 2 ** 32;
          return a;
        }
        if (a instanceof Uint32Array) {
          a[0] = 2 ** 31;
          return a;
        }
        return crypto.getRandomValues(a);
      },
    };
    class ExplicitDate extends Date {
      constructor(...args) {
        if (!args.length) throw Error("Pass time from the Exact answer");
        super(...args);
      }
      static now() {
        throw Error("Exact has no ambient clock");
      }
    }
    const context = {
      module: mod,
      require,
      crypto: random,
      Uint32Array,
      Date: ExplicitDate,
      URL,
      AbortController,
      TextEncoder,
      setTimeout,
      clearTimeout,
    };
    runInNewContext('Math.random=()=>{throw Error("Exact has no ambient randomness")};\n' + bundle, context);
    this.client = mod.exports.createExactClient({
      host: this.collector.host,
      writeKey: "test",
      maxQueueSize: this.config.capacity ?? 1000,
      onError: (e) => this.errors.push(e.code),
      fetch: async (url, init) => {
        if (!this.online) throw Error("offline");
        this.requests.push({ sent: this.now });
        const response = await fetch(url, init);
        const text = await response.text();
        if (gen !== this.generation) return new Promise(() => {});
        return new Response(text, { status: response.status, headers: response.headers });
      },
    });
  }
  flush(background = false, token = 0) {
    const work = this.work;
    let task;
    task = this.client
      .flush({ storage: this.storage, at: this.now, background, retryToken: token })
      .then((outcome) => {
        if (work === this.work && outcome.retryToken) {
          this.due = Math.max(this.now + outcome.retryAfterMs, Math.min(this.now + 300000, outcome.retryAtMs ?? 0));
          this.retryToken = outcome.retryToken;
        }
      })
      .finally(() => work.delete(task));
    work.add(task);
    task.catch(() => {});
  }
  async settle() {
    const until = Date.now() + 5000;
    while (this.work.size > this.collector.held) {
      if (Date.now() > until) throw Error("Exact answer did not settle");
      await sleep(1);
    }
  }
  async advance(ms) {
    const until = this.now + ms;
    while (this.due !== undefined && this.due <= until) {
      this.now = this.due;
      this.due = undefined;
      this.flush(false, this.retryToken);
      await this.settle();
    }
    this.now = until;
  }
  async step(step) {
    if (step.capture) {
      for (const id of step.capture)
        await this.client.capture({ storage: this.storage, at: this.now }, this.config.generatedIds ? id : "example", {},
          this.config.generatedIds ? {} : { id });
      this.due ??= this.now + 60000;
    } else if (step.advanceMs !== undefined) await this.advance(step.advanceMs);
    else if (step.clockAheadMs !== undefined) this.now += step.clockAheadMs;
    else
      switch (step) {
        case "flush":
          this.flush();
          break;
        case "hide": {
          const before = this.requests.length;
          this.flush(true);
          await this.settle();
          this.unloadDelivery = this.collector.held > 0 && this.requests.length > before;
          break;
        }
        case "release":
          this.collector.release();
          break;
        case "offline":
          this.online = false;
          break;
        case "online":
          this.online = true;
          break;
        case "restart":
          this.start();
          this.collector.release();
          break;
        case "corruptOutbox": {
          await writeFile(this.file, "{corrupt fixture");
          break;
        }
        default:
          throw Error("Unknown conformance step");
      }
    await this.settle();
  }
  async quarantined() {
    const dir = join(this.dir, "birdwatch-quarantine");
    for (const file of await readdir(dir).catch(() => []))
      if ((await readFile(join(dir, file), "utf8")).includes("{corrupt fixture")) return true;
    return false;
  }
  async close() {
    this.generation++;
    for (const db of this.handles) db.close();
    this.handles.clear();
    await rm(this.dir, { recursive: true, force: true });
  }
}
