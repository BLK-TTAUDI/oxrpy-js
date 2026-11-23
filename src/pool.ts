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
import { isPermanent } from "./follower.js";
import { TokenBucket } from "./ratelimit.js";
import type { Event } from "./types.js";

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
    const api = new OxfordAPI({ ...this.options, serverKey });
    if (this.sharedLimiters) api.limiters = this.sharedLimiters;
    api.ipBucket = this.ipBucket;
    this.servers.set(name, api);
    this.failed.delete(name);
    if (this.runOptions) this.start(name);
    return api;
  }

  /** Stop following a server and forget it. */
  async remove(name: string): Promise<void> {
    if (!this.servers.delete(name)) throw new RangeError(`No server called '${name}' in the pool`);
    await this.stopServer(name);
    this.failed.delete(name);
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
    const results = await Promise.allSettled(names.map((n) => action(this.servers.get(n)!)));
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
    const saveTo = o.saveDir ? `${o.saveDir.replace(/[\\/]+$/, "")}/${await fileName(name)}.json` : undefined;
    try {
      await api.run(this.handlers, (fn, arg) => fn(name, arg), {
        sections: o.sections, limit: o.limit, skipExisting: o.skipExisting, saveTo,
        adaptive: o.adaptive, maxIdle: o.maxIdle, signal,
      });
    } catch (err) {
      const permanent = isPermanent(err);
      console.error(`[oxrpy] Stopped following ${name}${permanent ? "" : " after an unexpected error"}:`, (err as Error)?.message ?? err);
      this.failed.set(name, err);
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
