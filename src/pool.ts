/**
 * One app, many servers: `ServerPool`.
 *
 * For bots, CADs and dashboards that many servers use (each owner gives your app their server
 * key). One pool holds a client per server, shares one set of rate limits when you have an app key
 * (an app key's limits count across every server it calls), and runs your handlers for every
 * server at once.
 *
 * ```ts
 * const pool = new ServerPool({ appKey: process.env.OXFD_APP_KEY });
 * pool.add("guild-1234", keyFromGuild1234);
 * pool.on("Kill", (server, kill) => postKill(server, kill));
 * await pool.runForever({ saveDir: "positions" });
 * ```
 */

import { OxfordAPI, type ClientOptions } from "./client.js";
import type { OxfordAPIError } from "./errors.js";
import { Handlers, type EventKey, type EventMap } from "./events.js";
import { isApiProblem, isPermanent } from "./follower.js";
import { TokenBucket } from "./ratelimit.js";
import { trimEnd } from "./text.js";
import type { Event, ServerData, ServerInfo } from "./types.js";

/** Every request from one IP address, whatever the key: 30 a second. */
export const IP_REQUESTS_PER_SECOND = 30;

export interface PoolOptions extends Omit<ClientOptions, "serverKey"> {}

export interface PoolRunOptions {
  /** Other sections to fetch every time, for `poll` handlers. */
  sections?: string[];
  limit?: number;
  /** Don't replay what was already in the logs at start (default `true`). */
  skipExisting?: boolean;
  /** A folder to keep each server's position in (one small JSON file per server). */
  saveDir?: string;
  /** Poll quiet and empty servers less often (default `true`), so one app can follow more servers. */
  adaptive?: boolean;
  /** The slowest a quiet server is polled, in seconds (default 5). */
  maxIdle?: number;
  signal?: AbortSignal;
}

/** How one server in the pool is doing. See `ServerPool.stats`. */
export interface ServerStats {
  /** Successful polls since the server was added. */
  polls: number;
  /** Failed polls in a row (0 while all is well). */
  errors: number;
  /** When the last successful poll was (ms since 1970), or `undefined` before the first. */
  lastPoll?: number;
  /** Seconds between polls lately: how out of date this server's events and data can be. */
  interval?: number;
  /** Whether the server was online at the last poll. */
  online?: boolean;
  /** Players in the server at the last poll. */
  players?: number;
  /** Why following stopped for good (e.g. the key was regenerated). */
  failed?: unknown;
}

/** How the whole pool is doing: `pool.stats`. Use it to check the pool keeps up, or to tell your users how fresh their data is. */
export interface PoolStats {
  /** Servers in the pool. */
  servers: number;
  /** Servers being followed right now (`runForever` running and not failed). */
  following: number;
  /** Servers whose following stopped for good. */
  failed: number;
  /** Reads a second the pool keeps to across every server, or `undefined` with no limit. */
  readLimit?: number;
  /** Requests sent a second, over the last 10 seconds. */
  requestsPerSecond: number;
  /** Requests queued for a rate limit slot right now. */
  waiting: number;
  /** True while Oxford's API looks down and the pool is holding polls back until it answers. */
  apiDown: boolean;
  /** The average of the servers' `interval`: typical seconds between updates. */
  averageInterval?: number;
  /** The longest `interval`: the most out of date any server gets. */
  slowestInterval?: number;
  /** Each server's stats, by name. */
  perServer: Record<string, ServerStats>;
}

/** Events in the last `seconds`, counted in one-second buckets: cheap however busy it gets. */
class RecentCount {
  private readonly buckets: Array<[second: number, count: number]> = [];
  constructor(private readonly seconds = 10) {}

  add(): void {
    const second = Math.floor(performance.now() / 1000);
    const last = this.buckets[this.buckets.length - 1];
    if (last && last[0] === second) last[1] += 1;
    else {
      this.buckets.push([second, 1]);
      while (this.buckets.length && this.buckets[0][0] <= second - this.seconds) this.buckets.shift();
    }
  }

  total(): number {
    const second = Math.floor(performance.now() / 1000);
    return this.buckets.reduce((sum, [at, count]) => (at > second - this.seconds ? sum + count : sum), 0);
  }
}

/**
 * Holds every server's polling back together while Oxford's API itself is down.
 *
 * Without it each server would keep retrying on its own; with hundreds of servers that's hundreds
 * of failing requests, and the pool would only notice the API was back as each server's own wait ran
 * out. Instead, once most servers are failing together, polls wait here and one at a time is let
 * through as a probe (after 2 s, then 4, 8... up to a minute). The first poll that works opens the
 * gate for everyone.
 * @internal
 */
export class OutageGate {
  static minDelay = 2000;
  static maxDelay = 60_000;
  delay = 0; // 0 while all is well
  failures = 0;
  private until = 0;
  private probing = false;
  private waiters = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private changes = new Set<() => void>();

  get closed(): boolean {
    return this.delay > 0;
  }

  succeeded(): void {
    this.failures = 0;
    if (!this.closed) return;
    console.warn("[oxrpy] Oxford's API is answering again; carrying on");
    this.delay = 0;
    this.probing = false;
    this.wakeAll();
    this.notify();
  }

  failed(servers: number): void {
    this.failures += 1;
    if (this.closed) {
      if (!this.probing) return; // a poll that was already on its way when the gate closed
      this.probing = false;
    } else if (this.failures < Math.max(3, Math.ceil(servers / 2))) {
      return;
    }
    const justClosed = !this.closed;
    this.delay = Math.min(OutageGate.maxDelay, Math.max(OutageGate.minDelay, this.delay * 2));
    this.until = performance.now() + this.delay;
    if (justClosed) this.notify();
    console.warn(`[oxrpy] Oxford's API looks down (${this.failures} failed polls in a row); trying again in ${Math.round(this.delay / 1000)}s`);
    this.schedule();
  }

  /** Resolves when the gate next closes (an outage is spotted) or opens (it's over). */
  changed(): Promise<void> {
    return new Promise((resolve) => {
      this.changes.add(resolve);
    });
  }

  private notify(): void {
    const changes = [...this.changes];
    this.changes.clear();
    for (const resolve of changes) resolve();
  }

  /** Resolves when a poll may go: straight away normally, or as the next probe during an outage. */
  async wait(signal?: AbortSignal): Promise<void> {
    while (this.closed && !signal?.aborted) {
      if (performance.now() >= this.until) {
        this.until = performance.now() + this.delay; // this poll is the probe
        this.probing = true;
        this.schedule();
        return;
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          this.waiters.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        this.waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
        this.schedule();
      });
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.closed || !this.waiters.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.wakeAll();
    }, Math.max(1, this.until - performance.now()));
  }

  private wakeAll(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const wake of [...this.waiters]) wake();
  }
}

/** A safe file name for a server's position; changed names get a short hash so they never collide. */
export async function fileName(name: string): Promise<string> {
  let safe = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "server";
  if (safe !== name) {
    const { createHash } = await import("node:crypto");
    safe += `-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
  }
  return safe;
}

export class ServerPool {
  /** Servers whose polling stopped for good (e.g. their key was regenerated), with the error. */
  readonly failed = new Map<string, unknown>();

  private readonly options: PoolOptions;
  private readonly servers = new Map<string, OxfordAPI>();
  private readonly handlers = new Handlers<(server: string, arg: any) => unknown>();
  private readonly sharedLimiters?: OxfordAPI["limiters"];
  private readonly ipBucket?: TokenBucket;
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private runOptions?: PoolRunOptions;
  private stopController?: AbortController;
  private readonly serverStats = new Map<string, ServerStats>();
  private readonly sent = new RecentCount();
  private readonly outage = new OutageGate();

  constructor(options: PoolOptions = {}) {
    this.options = options;
    const pacing = (options.rateLimit ?? "auto") === "auto";
    if (pacing && options.appKey) {
      const shared = new TokenBucket(20, 40);
      this.sharedLimiters = { data: shared, get: shared, command: new TokenBucket(2, 5) };
    }
    if (pacing) this.ipBucket = new TokenBucket(IP_REQUESTS_PER_SECOND, IP_REQUESTS_PER_SECOND);
  }

  /**
   * Add a server under a name you choose (a guild ID, a database ID…). Returns its client, for
   * that server's reads and commands. While the pool is running, it's followed straight away.
   */
  add(name: string, serverKey: string): OxfordAPI {
    if (this.servers.has(name)) throw new RangeError(`There's already a server called '${name}' in the pool`);
    const api = this.client(serverKey);
    this.servers.set(name, api);
    this.serverStats.set(name, { polls: 0, errors: 0 });
    this.failed.delete(name);
    if (this.runOptions) this.start(name);
    return api;
  }

  /** A client for one server, sharing the pool's rate limits. */
  private client(serverKey: string): OxfordAPI {
    const api = new OxfordAPI({ ...this.options, serverKey });
    if (this.sharedLimiters) api.limiters = this.sharedLimiters;
    api.ipBucket = this.ipBucket;
    api.gate = (signal) => this.outage.wait(signal);
    api.onRequest((info) => {
      if (info.status !== undefined) this.sent.add();
    });
    return api;
  }

  /**
   * Check a server key before you save it, e.g. in a `/link` command. Resolves the server's details
   * (`Name`, `OwnerId`, `CurrentPlayers`…), so you can show which server it is. Uses the pool's
   * rate limits; doesn't add the server.
   * @throws AuthenticationError if the key is wrong, was regenerated, or the server doesn't have the API package.
   */
  async verify(serverKey: string): Promise<ServerInfo> {
    return (await this.client(serverKey).getServer()).Server as ServerInfo;
  }

  /**
   * Swap in a new server key for `name`, e.g. after the owner regenerated theirs. Following carries
   * on from where it was (from `saveDir` if you use one), and the server leaves `failed`.
   * Resolves the new client.
   */
  async updateKey(name: string, serverKey: string): Promise<OxfordAPI> {
    const old = this.servers.get(name);
    if (!old) throw new RangeError(`No server called '${name}' in the pool`);
    await this.stopServer(name);
    const api = this.client(serverKey);
    (api as { latest: OxfordAPI["latest"] }).latest = old.latest; // keep what's known, with its real age
    api.cursor = old.cursor;
    this.servers.set(name, api);
    this.failed.delete(name);
    const stats = this.serverStats.get(name) ?? { polls: 0, errors: 0 };
    stats.failed = undefined;
    stats.errors = 0;
    this.serverStats.set(name, stats);
    if (this.runOptions) this.start(name);
    return api;
  }

  /** Stop following a server and forget it. */
  async remove(name: string): Promise<void> {
    if (!this.servers.delete(name)) throw new RangeError(`No server called '${name}' in the pool`);
    await this.stopServer(name);
    this.failed.delete(name);
    this.serverStats.delete(name);
  }

  get(name: string): OxfordAPI | undefined {
    return this.servers.get(name);
  }

  has(name: string): boolean {
    return this.servers.has(name);
  }

  get size(): number {
    return this.servers.size;
  }

  get names(): string[] {
    return [...this.servers.keys()];
  }

  /**
   * Run `action(api)` for every server at once. Resolves `{ name: result }`, where a server that
   * failed has its error instead (one failure doesn't stop the others).
   */
  async each<T>(action: (api: OxfordAPI) => Promise<T>, names = this.names): Promise<Record<string, T | Error>> {
    // Each server's client, but with requests that wait behind single ones (a Discord command's
    // lookup, say), so one big job across every server doesn't hold up everyone else's.
    const behind = (api: OxfordAPI) => Object.assign(Object.create(api) as OxfordAPI, { defaultPriority: 1 });
    const results = await Promise.allSettled(names.map((n) => action(behind(this.servers.get(n)!))));
    return Object.fromEntries(names.map((n, i) => {
      const r = results[i];
      return [n, r.status === "fulfilled" ? r.value : (r.reason as Error)];
    }));
  }

  /** Run one command on every server (an announcement, say). */
  runCommandOnAll(command: string, names = this.names) {
    return this.each((api) => api.runCommand(command), names);
  }

  /** Register a handler, like `OxfordAPI.on`, except handlers get the server's name first. */
  on<K extends EventKey>(key: K | K[], handler: (server: string, arg: EventMap[K]) => unknown): () => void;
  on(key: string | string[], handler: (server: string, event: Event) => unknown): () => void;
  on(key: string | string[], handler: (server: string, arg: any) => unknown): () => void {
    return this.handlers.add(Array.isArray(key) ? key : [key], handler);
  }

  /**
   * Follow every server and call the handlers until `stop()` (or `signal` aborts). A server whose
   * key stops working is dropped, reported to `error` handlers as `(server, error)`, and listed in
   * `failed`; the others carry on.
   */
  async runForever(options: PoolRunOptions = {}): Promise<void> {
    if (!this.handlers.size) throw new TypeError("No handlers registered: use pool.on('Kill', ...) (or another event) first");
    this.stopController = new AbortController();
    const stopped = new Promise<void>((resolve) => {
      this.stopController!.signal.addEventListener("abort", () => resolve(), { once: true });
      options.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    this.runOptions = { adaptive: true, maxIdle: 5, ...options };
    try {
      for (const name of this.servers.keys()) this.start(name);
      await stopped;
    } finally {
      this.runOptions = undefined;
      await Promise.all([...this.running.keys()].map((n) => this.stopServer(n)));
    }
  }

  stop(): void {
    this.stopController?.abort();
  }

  /**
   * Reads a second the pool keeps to across every server (`undefined`: no limit). Without an app
   * key that's the per-IP limit; with one, your app's limit (which follows what Oxford reports, so
   * custom tiers are picked up), capped by the per-IP limit.
   */
  get readLimit(): number | undefined {
    const rates = [this.sharedLimiters?.data?.rate, this.ipBucket?.rate].filter((r): r is number => r !== undefined);
    return rates.length ? Math.min(...rates) : undefined;
  }

  /**
   * How the pool is keeping up: overall figures, and each server's stats in `perServer`.
   *
   * ```ts
   * const { following, averageInterval } = pool.stats;
   * console.log(`${following} servers, updated about every ${averageInterval?.toFixed(1)}s`);
   * ```
   */
  get stats(): PoolStats {
    const recent = this.sent.total();
    const all = [...this.serverStats.values()];
    const intervals = all.filter((s) => s.interval !== undefined && s.failed === undefined).map((s) => s.interval!);
    const buckets = [this.sharedLimiters?.data, this.ipBucket].filter((b) => b !== undefined);
    return {
      servers: this.servers.size,
      following: [...this.running.keys()].filter((n) => !this.failed.has(n)).length,
      failed: this.failed.size,
      readLimit: this.readLimit,
      requestsPerSecond: recent / 10,
      waiting: Math.max(0, ...buckets.map((b) => b!.waiting)),
      apiDown: this.outage.closed,
      averageInterval: intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : undefined,
      slowestInterval: intervals.length ? Math.max(...intervals) : undefined,
      perServer: Object.fromEntries([...this.serverStats].map(([n, s]) => [n, { ...s }])),
    };
  }

  private start(name: string): void {
    if (this.running.has(name)) return;
    const controller = new AbortController();
    const done = this.follow(name, controller.signal).finally(() => {
      if (this.running.get(name)?.controller === controller) this.running.delete(name);
    });
    this.running.set(name, { controller, done });
  }

  private async stopServer(name: string): Promise<void> {
    const entry = this.running.get(name);
    if (!entry) return;
    entry.controller.abort();
    await entry.done;
  }

  private async follow(name: string, signal: AbortSignal): Promise<void> {
    const api = this.servers.get(name);
    const o = this.runOptions;
    if (!api || !o) return;
    const saveTo = o.saveDir ? `${trimEnd(o.saveDir, "\\/")}/${await fileName(name)}.json` : undefined;
    const stats = this.serverStats.get(name) ?? { polls: 0, errors: 0 };
    this.serverStats.set(name, stats);
    const onPoll = (data: ServerData) => {
      const now = Date.now();
      if (stats.lastPoll !== undefined) {
        const gap = (now - stats.lastPoll) / 1000;
        stats.interval = stats.interval === undefined ? gap : stats.interval * 0.7 + gap * 0.3;
      }
      stats.lastPoll = now;
      stats.polls += 1;
      stats.errors = 0;
      stats.online = Boolean(data.Online);
      stats.players = data.Server?.CurrentPlayers;
      this.outage.succeeded();
    };
    try {
      await api.run(this.handlers, (fn, arg) => fn(name, arg), {
        sections: o.sections, limit: o.limit, skipExisting: o.skipExisting, saveTo,
        // Carry on from a position kept in memory (after updateKey) unless saveDir has one.
        cursor: saveTo ? undefined : api.cursor,
        adaptive: o.adaptive, maxIdle: o.maxIdle, signal, onPoll,
        // The outage gate does the long waiting, so a server comes back soon after the API.
        maxApiErrorDelay: 5000,
        // A server waiting after an error goes again as soon as an outage is spotted (to wait at
        // the gate) or is over.
        wake: () => this.outage.changed(),
        onError: (err) => {
          stats.errors += 1;
          if (isApiProblem(err)) this.outage.failed([...this.running.keys()].length);
          else this.outage.succeeded(); // the API answered (e.g. "server offline"), so it's up
        },
      });
    } catch (err) {
      const permanent = isPermanent(err);
      if (permanent) this.outage.succeeded(); // the API answered, so it's up
      console.error(`[oxrpy] Stopped following ${name}${permanent ? "" : " after an unexpected error"}:`, (err as Error)?.message ?? err);
      this.failed.set(name, err);
      stats.failed = err;
      for (const fn of this.handlers.get("error")) {
        try {
          await fn(name, err as OxfordAPIError);
        } catch (hookErr) {
          console.error("[oxrpy] error handler threw:", hookErr);
        }
      }
    }
  }
}
