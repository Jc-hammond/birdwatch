import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";

const bundle = await readFile(new URL("../../sdk/dist/index.cjs", import.meta.url), "utf8");

export class WebDriver {
  constructor(collector, config = {}, nativeBundle) {
    this.nativeBundle = nativeBundle;
    this.collector = collector;
    this.config = config;
    this.now = Date.UTC(2026, 0, 1);
    this.storage = new Map();
    this.requests = [];
    this.errors = [];
    this.online = true;
    this.generation = 0;
    this.pending = 0;
    this.ready = this.start();
  }

  start() {
    const generation = ++this.generation;
    const timers = this.timers = new Map();
    let nextId = 0;
    const driver = this;
    class ClockDate extends Date {
      constructor(...args) { super(...(args.length ? args : [driver.now])); }
      static now() { return driver.now; }
    }
    const storage = this.storage;
    const window = new EventTarget(), document = new EventTarget();
    window.localStorage = {
      get length() { return storage.size; },
      key: i => [...storage.keys()][i] ?? null,
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
      clear: () => storage.clear(),
    };
    const send = async (url, init, beacon = false) => {
      if (!this.online) throw new TypeError("offline");
      this.requests.push({ sent: this.now, keepalive: init.keepalive || beacon });
      this.pending++;
      try {
        const res = await fetch(url, init);
        const text = await res.text();
        if (generation === this.generation) return new Response(text, {status:res.status, headers:res.headers});
      } catch (error) {
        if (generation === this.generation) throw error;
      } finally {
        this.pending--;
      }
      // A discarded page cannot observe a late response or schedule a retry.
      return new Promise(() => {});
    };
    const navigator = {sendBeacon: (url, body) => {
      void send(url,{method:"POST",body},true).catch(() => {});
      return true;
    }};
    Object.assign(window, {navigator, fetch: send, location: new URL("https://example.test/")});
    const module = {exports:{}};
    let sample = 0;
    const context = {
      module, crypto, URL, Blob, TextEncoder, AbortController, Date: ClockDate,
      nextJitter: () => this.config.jitter?.[sample++] ?? 0.5,
      setTimeout: (fn, ms) => {
        const id = ++nextId;
        timers.set(id, {fn, time:this.now + ms});
        return id;
      },
      clearTimeout: id => timers.delete(id),
    };
    if (this.config.browser) Object.assign(context, {window,document,navigator,localStorage:window.localStorage});
    if (this.nativeBundle) {
      const storage = {
        getItem: async key => this.storage.get(key) ?? null,
        setItem: async (key,value) => { this.storage.set(key,value); },
        removeItem: async key => { this.storage.delete(key); },
        multiGet: async keys => keys.map(k => [k,this.storage.get(k) ?? null]),
        multiRemove: async keys => { for (const k of keys) this.storage.delete(k); },
      };
      context.require = name => {
        if (name === "@react-native-async-storage/async-storage") return storage;
        if (name === "react-native") return {AppState: {addEventListener: (_,listener) => {
          this.background = () => listener("background");
          return {remove: () => { this.background=undefined; }};
        }}};
        throw Error("Unexpected React Native runtime dependency: " + name);
      };
      runInNewContext("Math.random = nextJitter;\n" + this.nativeBundle, context);
      return module.exports.createReactNativeClient({
        host: this.collector.host, writeKey:"test", batchSize:100, flushIntervalMs:60000,
        randomUUID:()=>crypto.randomUUID(), maxQueueSize:this.config.capacity ?? 1000,
        fetch:send, onError:error=>this.errors.push(error.code),
      }).then(client=>{this.client=client;});
    }
    runInNewContext("Math.random = nextJitter;\n" + bundle, context);
    const factory = this.config.browser ? module.exports.createBrowserClient : module.exports.createServerClient;
    this.client = factory({
      host: this.collector.host, writeKey:"test", batchSize:100, flushIntervalMs:60000,
      maxQueueSize:this.config.capacity ?? 1000, persist:this.config.persist ?? false,
      fetch:send, onError: error => this.errors.push(error.code),
    });
    this.document = document;
  }

  async capture(id) {
    const name = this.config.generatedIds ? id : "example";
    const options = this.config.generatedIds ? {} : {id};
    if (this.nativeBundle) { await this.client.enqueue(name,{},options); return; }
    const result = this.config.browser
      ? this.client.capture(name, {}, options)
      : this.client.capture({event:name,distinctId:"test",...options});
    void result.catch(() => {});
  }

  flush() { void this.client.flush().catch(() => {}); }

  async settle() {
    // Only wait for loopback I/O and promise callbacks. Retry time is entirely virtual.
    const deadline = Date.now() + 5000;
    for (;;) {
      await nextTurn();
      if (this.pending === this.collector.held) return;
      if (Date.now() > deadline) throw new Error("SDK transport did not settle");
      await sleep(1);
    }
  }

  async advance(ms) {
    const until = this.now + ms;
    for (let turns = 0; turns < 10000; turns++) {
      const next = [...this.timers].sort((a,b) => a[1].time - b[1].time)[0];
      if (!next || next[1].time > until) { this.now = until; return; }
      this.now = next[1].time;
      this.timers.delete(next[0]);
      next[1].fn();
      await this.settle();
    }
    throw new Error("SDK continuously scheduled immediate retries");
  }

  quarantined() {
    return this.storage.get(this.corruptKey) !== "{corrupt fixture" &&
      [...this.storage].some(([k,v]) => k !== this.corruptKey && v.includes("{corrupt fixture"));
  }
  async step(step) {
    await this.ready;
    if (step.capture) for (const id of step.capture) await this.capture(id);
    else if (step.advanceMs !== undefined) await this.advance(step.advanceMs);
    else if (step.clockAheadMs !== undefined) {
      this.now += step.clockAheadMs;
      for (const timer of this.timers.values()) timer.time += step.clockAheadMs;
    }
    else switch (step) {
      case "flush": this.flush(); break;
      case "offline": this.online = false; break;
      case "online": this.online = true; break;
      case "release": this.collector.release(); break;
      case "hide": {
        const before = this.requests.length;
        if (this.nativeBundle) this.background();
        else {
          this.document.visibilityState = "hidden";
          this.document.dispatchEvent(new Event("visibilitychange"));
        }
        await this.settle();
        this.unloadDelivery = this.collector.held > 0 && this.requests.slice(before).some(req => req.keepalive === true);
        break;
      }
      case "restart":
        this.ready = this.start();
        this.collector.release();
        await this.ready;
        break;
      case "corruptOutbox": {
        // Locate the stored test event by UUID, independent of the SDK's storage key.
        const entry = [...this.storage].find(([,value]) => value.includes("corrupt-seed"));
        if (entry) {
          this.corruptKey = entry[0];
          this.storage.set(entry[0],"{corrupt fixture");
        }
        break;
      }
      default: throw new Error("Unknown conformance step");
    }
    await this.settle();
  }
}
