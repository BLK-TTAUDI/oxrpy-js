/** Following the server's logs with `Since`/`Cursor`, getting each entry once. */

import { LOG_SECTIONS, sectionName } from "./constants.js";
import {
  AuthenticationError, BadRequestError, EndpointRemovedError, NotFoundError, OxfordAPIError, RateLimitError,
} from "./errors.js";
import { asStore, makeState, readState, type StateStore } from "./state.js";
import type { ServerData } from "./types.js";
import { sleep } from "./util.js";

/** Errors that won't fix themselves by waiting, so following stops and throws them. */
export function isPermanent(err: unknown): boolean {
  return err instanceof AuthenticationError || err instanceof BadRequestError
    || err instanceof NotFoundError || err instanceof EndpointRemovedError;
}

/**
 * A problem with Oxford's API itself (unreachable, timing out, or a 5xx other than 503, which means
 * the game server's offline), rather than with one server or its key.
 */
export function isApiProblem(err: unknown): boolean {
  if (!(err instanceof OxfordAPIError) || err instanceof RateLimitError) return false;
  return err.status === undefined || (err.status >= 500 && err.status !== 503);
}

/** How long to wait after the `failures`-th failure in a row (ms). */
export function errorDelay(err: OxfordAPIError, failures: number): number {
  if (err instanceof RateLimitError && err.retryAfter) return Math.max(1, err.retryAfter) * 1000;
  return Math.min(60, 2 ** failures) * 1000;
}

export interface FollowOptions {
  /** Other sections to fetch on every poll (e.g. `["Players"]`). */
  sections?: string[];
  /** Most entries per log per request (API default 100, max 500). */
  limit?: number;
  /** Resume from a saved `Cursor`. */
  cursor?: number;
  /** A file path, or an object with `load()`/`save(state)`, to remember the position. */
  saveTo?: string | StateStore;
  /** Poll less often while nothing's happening (up to every `maxIdle` seconds). */
  adaptive?: boolean;
  /** The slowest polling gets with `adaptive`, in seconds (default 5). */
  maxIdle?: number;
}

export interface IterateOptions {
  /** Keep going through temporary errors (default `true`). */
  retry?: boolean;
  /** Stop when this aborts. */
  signal?: AbortSignal;
  /** Called with each error that will be retried. */
  onError?: (err: OxfordAPIError) => unknown;
}

export interface Poll {
  data: ServerData;
  /** New entries per log, oldest first. */
  fresh: Record<string, any[]>;
}

/** Anything that can fetch `GET /v1/server` (the client). */
export interface ServerDataSource {
  getServerData(
    sections?: string[],
    options?: { since?: number; limit?: number; background?: boolean; signal?: AbortSignal },
  ): Promise<ServerData | null>;
}

/**
 * Polls `GET /v1/server` with `Since` and hands back only entries you haven't seen, oldest first.
 * Looping over it keeps going through network problems, rate limits and API errors (waiting a
 * little longer after each failure in a row, up to a minute); it only stops for errors that waiting
 * won't fix, like a wrong key.
 *
 * ```ts
 * for await (const { data, fresh } of api.follow(["Events", "KillLogs"])) {
 *   for (const kill of fresh.KillLogs) console.log(kill.KillerUsername);
 * }
 * ```
 */
export class LogFollower implements AsyncIterable<Poll> {
  readonly logs: string[];
  readonly sections: string[];
  readonly limit?: number;
  cursor?: number;
  handled: Record<string, number> = {};
  last?: ServerData;
  failures = 0;
  quietPolls = 0;
  /** Whether the position was loaded from `saveTo`. */
  resumed = false;
  readonly adaptive: boolean;
  readonly maxIdle: number;
  /**
   * The longest wait after an API problem (see `isApiProblem`), in ms. The pool lowers it, because
   * it watches for outages itself and holds every server back together.
   */
  maxApiErrorDelay = 60_000;
  private readonly store?: StateStore;
  private loaded = false;
  /** Ask for just the newest entry of each log next time (set by `skipBacklog()`). */
  private light = false;
  /**
   * Raced with the wait after an error: when it resolves, the wait is cut short. The pool uses it
   * to wake servers as soon as an outage is spotted or is over.
   */
  wake?: () => Promise<void>;

  constructor(private readonly api: ServerDataSource, logs: string[] = ["Events"], options: FollowOptions = {}) {
    this.logs = logs.map(sectionName);
    const unknown = this.logs.filter((log) => !(LOG_SECTIONS as readonly string[]).includes(log));
    if (unknown.length) throw new RangeError(`Not log sections: ${unknown.join(", ")} (choose from ${LOG_SECTIONS.join(", ")})`);
    this.sections = (options.sections ?? []).map(sectionName).filter((s) => !this.logs.includes(s));
    this.limit = options.limit;
    this.cursor = options.cursor;
    this.adaptive = options.adaptive ?? false;
    this.maxIdle = Math.max(1, options.maxIdle ?? 5);
    this.store = asStore(options.saveTo);
    if (this.cursor !== undefined || !this.store) this.loaded = true;
  }

  /** Load any saved position (done for you before the first poll). */
  async ready(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const saved = readState(await this.store!.load());
    if (saved) {
      this.cursor = saved.Cursor;
      this.handled = saved.Handled;
      this.resumed = true;
    }
  }

  /**
   * Make the first poll fetch only the newest entry of each log: enough to know where each log is
   * up to, when what's already there won't be handled anyway. Much less to download, which adds up
   * for an app starting hundreds of servers. Call it after `ready()`.
   */
  skipBacklog(): void {
    if (this.cursor === undefined && this.logs.length) this.light = true;
  }

  /**
   * Make one request. Errors are thrown, not retried. It waits behind your own requests for a
   * rate limit slot; `signal` gives up waiting.
   */
  async poll(signal?: AbortSignal): Promise<Poll> {
    await this.ready();
    const data = await this.api.getServerData([...this.logs, ...this.sections], {
      since: this.cursor, limit: this.light ? 1 : this.limit, background: true, signal,
    });
    if (!data) throw new OxfordAPIError("Empty response");
    return { data, fresh: this.process(data) };
  }

  /** Which entries in a response are new (also advances the cursor). */
  process(data: ServerData): Record<string, any[]> {
    const fresh: Record<string, any[]> = {};
    for (const log of this.logs) {
      const entries = ((data[log] as Array<{ Seq?: number }> | null | undefined) ?? []).slice().reverse();
      fresh[log] = entries.filter((entry) => {
        if (entry.Seq === undefined) return true;
        if (entry.Seq <= (this.handled[log] ?? -1)) return false;
        this.handled[log] = entry.Seq;
        return true;
      });
    }
    if (data.Cursor !== undefined && data.Cursor !== null) this.cursor = data.Cursor;
    this.last = data;
    this.failures = 0;
    this.light = false;
    this.quietPolls = Object.values(fresh).some((list) => list.length) ? 0 : this.quietPolls + 1;
    return fresh;
  }

  /** Save the position (done for you after each poll when you loop). Call it yourself with `poll()`. */
  async save(): Promise<void> {
    if (!this.store || this.cursor === undefined) return;
    try {
      await this.store.save(makeState(this.cursor, this.handled));
    } catch (err) {
      console.error("[oxrpy] Couldn't save the position:", err);
    }
  }

  /**
   * Milliseconds to wait before the next poll: just after `NextHeartbeat`, or 30 s while offline.
   * With `adaptive`, each poll that brings nothing new stretches the wait (1.5×, up to `maxIdle`),
   * an empty server goes straight to `maxIdle`, and the first new entry resets it.
   */
  nextDelay(data: ServerData | undefined = this.last, offlineDelayMs = 30_000): number {
    const next = data?.NextHeartbeat;
    if (!next) return offlineDelayMs;
    let delay = Math.max(1000, next * 1000 - Date.now() + 500);
    if (this.adaptive) {
      if (data?.Server?.CurrentPlayers === 0) return Math.max(delay, this.maxIdle * 1000);
      if (this.quietPolls) delay = Math.max(delay, Math.min(this.maxIdle, 1.5 ** this.quietPolls) * 1000);
    }
    return delay;
  }

  /** Poll until `signal` aborts (or forever). With `retry: false` the first error is thrown. */
  async *iterate({ retry = true, signal, onError }: IterateOptions = {}): AsyncGenerator<Poll> {
    while (!signal?.aborted) {
      let result: Poll;
      try {
        result = await this.poll(signal);
      } catch (err) {
        if (signal?.aborted) break; // stopped while waiting for its turn: nothing was handled
        if (!(err instanceof OxfordAPIError) || !retry || isPermanent(err)) throw err;
        this.failures += 1;
        let delay = errorDelay(err, this.failures);
        if (isApiProblem(err)) delay = Math.min(delay, this.maxApiErrorDelay);
        console.warn(`[oxrpy] Polling failed (${err.message}); trying again in ${Math.round(delay / 1000)}s`);
        await onError?.(err);
        await this.waitAfterError(delay, signal);
        continue;
      }
      yield result;
      await this.save(); // only once the caller has dealt with this poll
      await sleep(this.nextDelay(result.data), signal);
    }
  }

  private async waitAfterError(delay: number, signal?: AbortSignal): Promise<void> {
    if (!this.wake) return sleep(delay, signal);
    const cut = new AbortController();
    const stop = () => cut.abort();
    signal?.addEventListener("abort", stop, { once: true });
    this.wake().then(stop, stop);
    try {
      await sleep(delay, cut.signal);
    } finally {
      signal?.removeEventListener("abort", stop);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Poll> {
    return this.iterate();
  }
}

