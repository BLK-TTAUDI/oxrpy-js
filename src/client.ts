/** The Oxford Response private server API client. */

import { commands, type Duration, type Target } from "./commands.js";
import {
  AUDIT_CATEGORIES, BASE_URL, MAX_BATCH, MAX_RETRY_WAIT_MS, USER_AGENT, sectionName,
} from "./constants.js";
import {
  AuthenticationError, BadRequestError, CommandFailedError, EndpointRemovedError, NotFoundError,
  OxfordAPIError, RateLimitError, ServerOfflineError, closestMatch,
} from "./errors.js";
import { Handlers, ServerWatcher, dispatchPlan, type EventKey, type EventMap, type Handler } from "./events.js";
import { LogFollower, type FollowOptions } from "./follower.js";
import { LiveState } from "./live.js";
import * as lookup from "./lookup.js";
import { TokenBucket } from "./ratelimit.js";
import type { StateStore } from "./state.js";
import { sleep } from "./util.js";
import { CommandWindow, chunk, planGroupChanges, planStaffChanges, type UserKey } from "./sync.js";
import type {
  ApiStatus, Atm, AuditEntry, AuditPage, Ban, BansPage, Catalogue, CommandLog, CommandResult, CommandResultLog,
  CommandStatus, Event, Group, Incidents, JoinLog, KillLog, ModCall, Player, QueueEntry, RadioCall, Robbery,
  ServerData, Settings, Shot, Staff, Teams, Tracks, Vehicle, World,
} from "./types.js";

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
/** The kinds of request Oxford rate-limits separately: `GET /v1/server`, other reads, and commands. */
export type RequestKind = "data" | "get" | "command";
type Limiter = RequestKind;

export interface ClientOptions {
  /** Your server's API key (Server Management > External > API Key). */
  serverKey: string;
  /** Optional app key (`oxa_…`) from Oxford Roleplay, sent alongside the server key. */
  appKey?: string;
  /** Seconds to wait for a response (commands always get at least 15). Default 10. */
  timeout?: number;
  /** `"auto"` (default) paces requests to Oxford's limits; `"none"` turns that off; a number is seconds between requests. */
  rateLimit?: "auto" | "none" | number;
  /** Retries after a 429, or a network error / 5xx on a read. Default 3. */
  maxRetries?: number;
  /** Override the API URL (for testing). Must be https, except for localhost. */
  baseUrl?: string;
  /** Your own `fetch` (for testing, proxies…). Defaults to the global one. */
  fetch?: typeof fetch;
  /** Allow running in a web browser. Off by default: a server key in website code can be stolen. */
  allowBrowser?: boolean;
}

export interface ServerDataOptions {
  /** A `Cursor` from an earlier response: logs and shots only return newer entries. */
  since?: number;
  /** Most entries per log (max 500), bans (max 1000) or audit entries (max 100). */
  limit?: number;
  /** Bans to skip. */
  offset?: number;
  /** Audit entries numbered below this (the last `Audit.Next`). */
  auditBefore?: number;
  auditCategory?: AuditCategory | AuditCategory[] | string | string[];
  /** Only audit entries by this username or user ID. */
  auditUser?: string | number;
  /** A previous response's `etag`: resolves `null` if nothing changed. */
  ifNoneMatch?: string;
  /**
   * Wait behind your own requests for a rate limit slot, for as long as it takes. Polling uses
   * this, so a Discord command's lookup isn't stuck behind hundreds of servers' polls.
   */
  background?: boolean;
  /** Give up when this aborts (while waiting for a rate limit slot, or for the answer). */
  signal?: AbortSignal;
}

export interface CachedReadOptions {
  /** Answer from `api.latest` without a request if it's at most this many seconds old. */
  maxAge?: number;
}

/** The JSON from `GET /v1/server`, plus its ETag. */
export type ServerDataResponse = ServerData & { readonly etag?: string };

/** What `onRequest` hooks are told about each HTTP attempt. */
export interface RequestInfo {
  method: string;
  /** The API path, e.g. `/server` (never includes your key). */
  path: string;
  /** The HTTP status, or `undefined` if there was no response. */
  status?: number;
  /** Seconds the attempt took. */
  elapsed: number;
  /** 0 for the first try, then 1, 2… */
  attempt: number;
  willRetry: boolean;
  error?: unknown;
  rateLimit?: RateLimitInfo;
}

export interface RateLimitInfo { Limit?: number; Remaining?: number; Reset?: number; At?: number }

export interface CommandOptions {
  /** Throw `CommandFailedError` if the command didn't work. Default `true` for helpers, `false` for `runCommand`. */
  check?: boolean;
}

export interface RunForeverOptions extends Omit<FollowOptions, "cursor"> {
  cursor?: number;
  /** Don't replay entries already in the logs at start (default `true`; ignored when resuming). */
  skipExisting?: boolean;
  /** Stop when this aborts (as well as `api.stop()`). */
  signal?: AbortSignal;
}

interface Spec {
  method: "GET" | "POST";
  path: string;
  limiter: Limiter;
  params?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  timeout?: number;
  url?: string;
  serverData?: boolean;
  /** 0 for your own requests, 1 for background polling (waits behind them, with no time limit). */
  priority?: number;
  signal?: AbortSignal;
}

const isBrowser = () => typeof window !== "undefined" && typeof (globalThis as { document?: unknown }).document !== "undefined";

function checkBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError(`baseUrl must be an https:// URL, so your key is never sent unencrypted: ${JSON.stringify(baseUrl)}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new TypeError(`baseUrl must be an https:// URL, so your key is never sent unencrypted: ${JSON.stringify(baseUrl)}`);
  }
  return baseUrl.replace(/\/+$/, "");
}

function retryAfterMs(headers: Headers, body: unknown): number | undefined {
  const b = body as { RetryAfter?: unknown; retryAfter?: unknown } | null;
  const raw = headers.get("Retry-After") ?? b?.RetryAfter ?? b?.retryAfter;
  const seconds = Number(raw);
  if (raw === undefined || raw === null || !Number.isFinite(seconds)) return undefined;
  return Math.min(Math.max(seconds * 1000, 0), MAX_RETRY_WAIT_MS);
}

function rateLimitHeaders(headers: Headers): RateLimitInfo | undefined {
  const out: RateLimitInfo = {};
  for (const name of ["Limit", "Remaining", "Reset"] as const) {
    const v = Number(headers.get(`X-RateLimit-${name}`));
    if (headers.get(`X-RateLimit-${name}`) !== null && Number.isFinite(v)) out[name] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function checkResult<T extends CommandResult>(result: T): T {
  if (String(result?.Status ?? "").toLowerCase() === "failed") throw new CommandFailedError(result as Record<string, unknown>);
  return result;
}

/**
 * Client for the Oxford Response private server API (https://docs.oxfd.re).
 *
 * ```ts
 * const api = new OxfordAPI(process.env.OXFD_SERVER_KEY!);
 * const players = await api.getPlayers();
 * await api.kick("dxrkrider", "Exploiting");
 * ```
 */
export class OxfordAPI {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly hasAppKey: boolean;
  /** The newest copy of each live section this client has received. */
  readonly latest = new LiveState();
  /** The cursor `runForever` reached, once it stops. */
  cursor?: number;

  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  /** @internal shared with AsyncServerPool */
  limiters: Record<Limiter, TokenBucket | undefined>;
  /** @internal an extra limit shared with other clients (the pool's 30/s per IP) */
  ipBucket?: TokenBucket;
  /** @internal the priority for requests with none of their own (ServerPool.each uses 1) */
  defaultPriority = 0;
  /** @internal awaited before each background poll (ServerPool holds polls back while the API is down) */
  gate?: (signal?: AbortSignal) => Promise<void>;
  /** With an app key on "auto", follow the limits Oxford reports (custom tiers differ). */
  private readonly followLimits: boolean;
  private readonly handlers = new Handlers<Handler<any>>();
  private readonly requestHooks: Array<(info: RequestInfo) => unknown> = [];
  private readonly rateLimits: Partial<Record<Limiter, RateLimitInfo>> = {};
  private readonly commandWindow = new CommandWindow();
  private catalogueCache?: { at: number; value: Catalogue };
  private stopController?: AbortController;

  constructor(serverKey: string);
  constructor(options: ClientOptions);
  constructor(keyOrOptions: string | ClientOptions) {
    const options: ClientOptions = typeof keyOrOptions === "string" ? { serverKey: keyOrOptions } : keyOrOptions;
    if (!options?.serverKey) {
      throw new TypeError("serverKey is required (Server Management > External > API Key). App keys are sent in addition to a server key.");
    }
    if (isBrowser() && !options.allowBrowser) {
      throw new Error("oxrpy refuses to run in a web browser: a server key in website code can be read by anyone and gives full control of the server. Call the API from your own server or bot instead.");
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new Error("No fetch available: use Node 20.19 or newer, Bun or Deno.");
    this.fetchImpl = fetchImpl;
    this.baseUrl = checkBaseUrl(options.baseUrl ?? BASE_URL);
    this.timeout = options.timeout ?? 10;
    this.maxRetries = options.maxRetries ?? 3;
    if (this.maxRetries < 0) throw new RangeError("maxRetries must be 0 or more");
    this.hasAppKey = Boolean(options.appKey);
    this.headers = { "server-key": options.serverKey, Accept: "application/json", "User-Agent": USER_AGENT };
    if (options.appKey) this.headers.Authorization = `Bearer ${options.appKey}`;
    this.limiters = this.makeLimiters(options.rateLimit ?? "auto");
    this.followLimits = (options.rateLimit ?? "auto") === "auto" && this.hasAppKey;
  }

  private makeLimiters(rateLimit: "auto" | "none" | number): Record<Limiter, TokenBucket | undefined> {
    if (rateLimit === "none" || rateLimit === 0) return { data: undefined, get: undefined, command: undefined };
    if (rateLimit === "auto") {
      if (this.hasAppKey) {
        const shared = new TokenBucket(20, 40); // standard app tier: GETs 20/s, commands 2/s
        return { data: shared, get: shared, command: new TokenBucket(2, 5) };
      }
      return { data: new TokenBucket(1, 2), get: new TokenBucket(5, 15), command: new TokenBucket(1, 1) };
    }
    if (typeof rateLimit === "number" && rateLimit > 0) {
      const rate = 1 / rateLimit;
      return { data: new TokenBucket(rate, 1), get: new TokenBucket(rate, 1), command: new TokenBucket(rate, 1) };
    }
    throw new RangeError("rateLimit must be 'auto', 'none' or a positive number of seconds");
  }

  // ------------------------------------------------------------------ requests

  private async request<T = any>(spec: Spec): Promise<T> {
    const bucket = this.limiters[spec.limiter];
    let url = spec.url ?? `${this.baseUrl}${spec.path}`;
    if (spec.params) url += `?${new URLSearchParams(spec.params)}`;
    let attempt = 0;
    // Background polling waits its turn behind requests you make yourself, for as long as it
    // takes: with thousands of servers on one limit, a long queue is expected.
    const priority = spec.priority ?? this.defaultPriority;
    const wait = { priority, timeoutMs: priority > 0 ? undefined : 60_000, signal: spec.signal };
    const stopped = () => new OxfordAPIError(`${spec.method} ${spec.path} was stopped`);
    // Background polls don't retry here: the poll loop does, and the pool needs to hear about
    // failures straight away to spot an outage.
    const background = priority > 0 && spec.serverData === true;
    if (background && this.gate) {
      await this.gate(spec.signal);
      if (spec.signal?.aborted) throw stopped();
    }
    for (;;) {
      if (bucket && !(await bucket.acquire(wait))) {
        if (spec.signal?.aborted) throw stopped();
        throw new RateLimitError(`Timed out waiting for a rate limit slot for ${spec.path}`);
      }
      if (this.ipBucket && !(await this.ipBucket.acquire(wait))) {
        if (spec.signal?.aborted) throw stopped();
        throw new RateLimitError(`Timed out waiting for a rate limit slot for ${spec.path}`);
      }
      const started = performance.now();
      let response: Response;
      const timeout = AbortSignal.timeout((spec.timeout ?? this.timeout) * 1000);
      try {
        response = await this.fetchImpl(url, {
          method: spec.method,
          headers: { ...this.headers, ...(spec.body !== undefined ? { "Content-Type": "application/json" } : {}), ...spec.headers },
          body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
          // Never followed: a redirect elsewhere would carry the server key with it.
          redirect: "manual",
          signal: spec.signal ? AbortSignal.any([timeout, spec.signal]) : timeout,
        });
      } catch (err) {
        if (spec.signal?.aborted) throw stopped();
        // Commands may have run, so only reads are retried.
        const retry = spec.method === "GET" && attempt < this.maxRetries && !background;
        this.afterAttempt(spec, undefined, undefined, started, attempt, err, retry);
        if (!retry) {
          const timedOut = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
          throw new OxfordAPIError(timedOut ? `${spec.method} ${spec.path} timed out` : `${spec.method} ${spec.path} failed: ${(err as Error)?.message ?? err}`);
        }
        attempt += 1;
        await sleep(Math.min(2 ** attempt, 10) * 1000);
        continue;
      }

      const text = await response.text();
      let body: any = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      let delay = this.retryDelay(spec, response.status, response.headers, body, attempt);
      if (background && response.status !== 429) delay = undefined;
      this.afterAttempt(spec, response.status, response.headers, started, attempt, undefined, delay !== undefined);
      if (delay !== undefined) {
        attempt += 1;
        if (response.status === 429) bucket?.drain();
        await sleep(delay);
        continue;
      }
      return this.handle(spec, response, body) as T;
    }
  }

  private retryDelay(spec: Spec, status: number, headers: Headers, body: unknown, attempt: number): number | undefined {
    if (attempt >= this.maxRetries) return undefined;
    if (status === 429) return retryAfterMs(headers, body) ?? 2 ** (attempt + 1) * 1000;
    if (status >= 500 && status !== 503 && spec.method === "GET") return Math.min(2 ** (attempt + 1), 10) * 1000;
    return undefined;
  }

  /** Follow the steady rate Oxford reports (`X-RateLimit-Limit`), so custom app tiers just work. */
  private adoptLimit(kind: Limiter, limit: number | undefined): void {
    const bucket = this.limiters[kind];
    if (!bucket || !limit || limit <= 0 || Math.abs(limit - bucket.rate) <= bucket.rate * 0.01) return;
    bucket.setRate(limit, limit * (kind === "command" ? 2.5 : 2));
  }

  private afterAttempt(spec: Spec, status: number | undefined, headers: Headers | undefined, started: number,
    attempt: number, error: unknown, willRetry: boolean): void {
    const rateLimit = headers ? rateLimitHeaders(headers) : undefined;
    if (rateLimit) {
      this.rateLimits[spec.limiter] = { ...rateLimit, At: Date.now() };
      if (this.followLimits) this.adoptLimit(spec.limiter, rateLimit.Limit);
    }
    if (!this.requestHooks.length) return;
    const info: RequestInfo = {
      method: spec.method, path: spec.path, status, elapsed: (performance.now() - started) / 1000,
      attempt, willRetry, error, rateLimit,
    };
    for (const hook of [...this.requestHooks]) {
      try {
        hook(info);
      } catch (err) {
        console.error("[oxrpy] onRequest hook threw:", err);
      }
    }
  }

  private handle(spec: Spec, response: Response, body: any): unknown {
    const status = response.status;
    if (status === 304 && spec.serverData) return null;
    if (status >= 300 && status < 400) {
      throw new OxfordAPIError(
        `The API answered with a redirect (${status}) to ${JSON.stringify(response.headers.get("Location"))}. oxrpy doesn't follow redirects, so your key isn't sent anywhere else.`,
        { status },
      );
    }
    if (status >= 400 || response.type === "opaqueredirect") throw this.error(status, response.headers, body);
    if (spec.serverData) {
      const data = (body ?? {}) as ServerData;
      Object.defineProperty(data, "etag", { value: response.headers.get("ETag") ?? undefined, enumerable: false });
      this.latest.update(data);
      return data;
    }
    return body;
  }

  private error(status: number, headers: Headers, body: any): OxfordAPIError {
    const message = (body && typeof body === "object" && body.message) || `HTTP ${status}`;
    const details = { status, code: body?.Code as string | undefined, body };
    if (status === 400) return new BadRequestError(message, details);
    if (status === 401 || status === 403) return new AuthenticationError(message, details);
    if (status === 404) return new NotFoundError(message, details);
    if (status === 410) return new EndpointRemovedError(message, details);
    if (status === 429) {
      const wait = retryAfterMs(headers, body);
      return new RateLimitError(message, { ...details, retryAfter: wait === undefined ? undefined : wait / 1000 });
    }
    if (status === 503) return new ServerOfflineError(message, details);
    return new OxfordAPIError(message, details);
  }

  /** Call `hook(info)` after every HTTP attempt, retries included: for logging, metrics or watching rate limits. */
  onRequest(hook: (info: RequestInfo) => unknown): () => void {
    this.requestHooks.push(hook);
    return () => {
      const i = this.requestHooks.indexOf(hook);
      if (i >= 0) this.requestHooks.splice(i, 1);
    };
  }

  /** Oxford's latest rate limit figures per kind of request: `data` (`GET /v1/server`), `get` and `command`. */
  get rateLimitStatus(): Partial<Record<RequestKind, RateLimitInfo>> {
    return structuredClone(this.rateLimits);
  }

  // ------------------------------------------------------------------ GET /v1/server

  private serverDataSpec(sections: string[] = [], o: ServerDataOptions = {}): Spec {
    const params: Record<string, string> = {};
    for (const s of sections) params[sectionName(s)] = "true";
    if (o.since !== undefined) params.Since = String(Math.trunc(o.since));
    if (o.limit !== undefined) params.Limit = String(Math.trunc(o.limit));
    if (o.offset !== undefined) params.Offset = String(Math.trunc(o.offset));
    if (o.auditBefore !== undefined) params.AuditBefore = String(Math.trunc(o.auditBefore));
    if (o.auditCategory !== undefined) params.AuditCategory = Array.isArray(o.auditCategory) ? o.auditCategory.join(",") : o.auditCategory;
    if (o.auditUser !== undefined) params.AuditUser = String(o.auditUser);
    // With no parameters at all the API returns the deprecated old shape; Players=false asks for nothing extra.
    if (!Object.keys(params).length) params.Players = "false";
    return {
      method: "GET", path: "/server", limiter: "data", params, serverData: true,
      headers: o.ifNoneMatch ? { "If-None-Match": o.ifNoneMatch } : undefined,
      priority: o.background ? 1 : undefined, signal: o.signal,
    };
  }

  /**
   * Everything about the server in one request: `GET /v1/server`. Name the sections you want
   * (case doesn't matter). `Online`, `LastHeartbeat`, `NextHeartbeat`, `Cursor` and `Server` always
   * come back. Resolves `null` if `ifNoneMatch` matched (nothing changed).
   */
  getServerData(sections: string[] = [], options: ServerDataOptions = {}): Promise<ServerDataResponse | null> {
    return this.request(this.serverDataSpec(sections, options));
  }

  private async section<T>(name: string, options: ServerDataOptions & CachedReadOptions = {}): Promise<T> {
    const { maxAge = 0, ...rest } = options;
    if (maxAge > 0 && this.latest.isFresh(name, maxAge)) return (this.latest.get(name) ?? null) as T;
    const data = await this.request<ServerData>(this.serverDataSpec([name], rest));
    return (data?.[name] ?? null) as T;
  }

  /** The always-returned fields: `Online`, `LastHeartbeat`, `NextHeartbeat`, `Cursor`, `Server`. */
  async getServer(): Promise<ServerDataResponse> {
    return (await this.getServerData())!;
  }

  async isOnline(): Promise<boolean> {
    return Boolean((await this.getServer()).Online);
  }

  /**
   * Everyone in the server (`null` while offline). Like the other live helpers, pass `{ maxAge }`
   * to answer from `api.latest` without a request when it's that fresh.
   */
  getPlayers(options: CachedReadOptions = {}): Promise<Player[] | null> { return this.section("Players", options); }
  getTracks(): Promise<Tracks | null> { return this.section("Tracks"); }
  getVehicles(options: CachedReadOptions = {}): Promise<Vehicle[] | null> { return this.section("Vehicles", options); }
  getWorld(options: CachedReadOptions = {}): Promise<World | null> { return this.section("World", options); }
  getTeams(options: CachedReadOptions = {}): Promise<Teams | null> { return this.section("Teams", options); }
  getQueue(options: CachedReadOptions = {}): Promise<QueueEntry[] | null> { return this.section("Queue", options); }
  getRobberies(options: CachedReadOptions = {}): Promise<Robbery[] | null> { return this.section("Robberies", options); }
  getAtms(options: CachedReadOptions = {}): Promise<Atm[] | null> { return this.section("Atms", options); }
  getIncidents(options: CachedReadOptions = {}): Promise<Incidents | null> { return this.section("Incidents", options); }
  getStaff(options: CachedReadOptions = {}): Promise<Staff | null> { return this.section("Staff", options); }
  getGroups(options: CachedReadOptions = {}): Promise<Group[] | null> { return this.section("Groups", options); }
  getSettings(): Promise<Settings | null> { return this.section("Settings"); }
  /** One page of bans: `{ Total, Offset, List }`. See `iterBans`. */
  getBans(options: { limit?: number; offset?: number } = {}): Promise<BansPage | null> { return this.section("Bans", options); }
  /** One page of the full audit log: `{ Entries, Next, Total }`. Slower than the rest. */
  getAudit(options: { before?: number; category?: string | string[]; user?: string | number; limit?: number } = {}): Promise<AuditPage | null> {
    return this.section("Audit", { auditBefore: options.before, auditCategory: options.category, auditUser: options.user, limit: options.limit });
  }

  private async log<T>(name: string, options: { since?: number; limit?: number }): Promise<T[]> {
    return (await this.section<T[] | null>(name, options)) ?? [];
  }
  getKillLogs(options: { since?: number; limit?: number } = {}): Promise<KillLog[]> { return this.log("KillLogs", options); }
  getModCalls(options: { since?: number; limit?: number } = {}): Promise<ModCall[]> { return this.log("ModCalls", options); }
  getRadioCalls(options: { since?: number; limit?: number } = {}): Promise<RadioCall[]> { return this.log("RadioCalls", options); }
  getJoinLogs(options: { since?: number; limit?: number } = {}): Promise<JoinLog[]> { return this.log("JoinLogs", options); }
  getEvents(options: { since?: number; limit?: number } = {}): Promise<Event[]> { return this.log("Events", options); }
  getCommandLogs(options: { since?: number; limit?: number } = {}): Promise<CommandLog[]> { return this.log("CommandLogs", options); }
  getCommandResults(options: { since?: number; limit?: number } = {}): Promise<CommandResultLog[]> { return this.log("CommandResults", options); }
  getShots(options: { since?: number; limit?: number } = {}): Promise<Shot[]> { return this.log("Shots", options); }

  /**
   * Game data that only changes with an update. Kept for `maxAge` seconds (an hour by default)
   * and handed back without a request; `refresh: true` fetches a new copy.
   */
  async getCatalogue({ maxAge = 3600, refresh = false }: { maxAge?: number; refresh?: boolean } = {}): Promise<Catalogue | null> {
    const cached = this.catalogueCache;
    if (cached && !refresh && maxAge > 0 && (performance.now() - cached.at) / 1000 < maxAge) return cached.value;
    const value = await this.section<Catalogue | null>("Catalogue");
    if (value) this.catalogueCache = { at: performance.now(), value };
    return value;
  }

  clearCatalogueCache(): void {
    this.catalogueCache = undefined;
  }

  /** Every ban, fetching pages as needed. */
  async *iterBans(pageSize = 1000): AsyncGenerator<Ban> {
    let offset = 0;
    for (;;) {
      const page = (await this.getBans({ limit: pageSize, offset })) ?? {};
      const bans = page.List ?? [];
      yield* bans;
      offset += bans.length;
      if (!bans.length || offset >= (page.Total ?? 0)) return;
    }
  }

  /** The whole audit log, newest first, fetching pages as needed. */
  async *iterAudit({ category, user, pageSize = 100 }: { category?: string | string[]; user?: string | number; pageSize?: number } = {}): AsyncGenerator<AuditEntry> {
    let before: number | undefined;
    for (;;) {
      const page = (await this.getAudit({ before, category, user, limit: pageSize })) ?? {};
      yield* page.Entries ?? [];
      const next = page.Next;
      if (next === null || next === undefined || (before !== undefined && next >= before)) return;
      before = next;
    }
  }

  /** The API's own health (`GET /status`). Needs no key; don't ask more than every 30 seconds. */
  getStatus(): Promise<ApiStatus> {
    const root = this.baseUrl.replace(/\/v1$/, "");
    return this.request({ method: "GET", path: "/status", limiter: "get", url: `${root}/status` });
  }

  // ------------------------------------------------------------------ finding players and vehicles

  private async fromLatest<T>(sections: string[], maxAge: number, pick: (d: Record<string, any>) => T): Promise<T> {
    if (maxAge > 0 && sections.every((s) => this.latest.isFresh(s, maxAge))) {
      return pick(Object.fromEntries(sections.map((s) => [s, this.latest.get(s)])));
    }
    return pick((await this.getServerData(sections)) ?? {});
  }

  /**
   * The player `query` means, matched the way Oxford's commands do: username or display name
   * (any case), then user ID, then part of a name. `undefined` if nobody matches.
   * Uses `api.latest` if its Players are under `maxAge` seconds old (default 2).
   * @throws AmbiguousMatchError if several players match.
   */
  findPlayer(query: string | number, { maxAge = 2 } = {}): Promise<Player | undefined> {
    return this.fromLatest(["Players"], maxAge, (d) => lookup.findPlayer(d.Players, query));
  }
  /** Everyone on a team (`"Police"`, `"civilian"`…). */
  playersOnTeam(team: string, { maxAge = 2 } = {}): Promise<Player[]> {
    return this.fromLatest(["Players"], maxAge, (d) => lookup.playersOnTeam(d.Players, team));
  }
  /** Players in the server with a staff rank. */
  staffOnline({ maxAge = 2 } = {}): Promise<Player[]> {
    return this.fromLatest(["Players"], maxAge, (d) => lookup.staffOnline(d.Players));
  }
  /** A vehicle by registration (`"rj75flk"` finds `"RJ75 FLK"`), or by its owner. */
  findVehicle(plateOrPlayer: string | number, { maxAge = 2 } = {}): Promise<Vehicle | undefined> {
    return this.fromLatest(["Vehicles", "Players"], maxAge, (d) => lookup.findVehicle(d.Vehicles, plateOrPlayer, d.Players));
  }

  // ------------------------------------------------------------------ commands

  private commandSpec(payload: unknown): Spec {
    return { method: "POST", path: "/server/command", limiter: "command", body: payload, timeout: Math.max(this.timeout, 15) };
  }

  /**
   * Run one command (as typed in game; the leading `:` is optional). Waits up to 8 s for
   * `{ CommandId, Status, Code, Message }`. A failed command is a normal result unless `check: true`.
   */
  async runCommand(command: string, { check = false }: CommandOptions = {}): Promise<CommandResult> {
    if (typeof command !== "string" || !command.trim()) throw new TypeError("command must be a non-empty string");
    const result = await this.request<CommandResult>(this.commandSpec({ command }));
    return check ? checkResult(result) : result;
  }

  /** Run up to 10 commands in order, in one request. */
  async runCommands(list: string[], { check = false }: CommandOptions = {}): Promise<CommandResult[]> {
    if (!list.length) throw new TypeError("commands must be a non-empty list");
    if (list.length > MAX_BATCH) throw new RangeError(`Too many commands (max ${MAX_BATCH} per batch)`);
    if (!list.every((c) => typeof c === "string" && c.trim())) throw new TypeError("Every command must be a non-empty string");
    let results = await this.request<CommandResult[] | CommandResult>(this.commandSpec({ commands: list }));
    if (!Array.isArray(results)) results = [results];
    if (check) results.forEach(checkResult);
    return results;
  }

  /** Run any number of commands in order, batched and paced under the game's 15 every 10 seconds. */
  async runMany(list: string[], options: CommandOptions = {}): Promise<CommandResult[]> {
    const results: CommandResult[] = [];
    for (const batch of chunk(list, MAX_BATCH)) {
      const wait = this.commandWindow.waitTime(batch.length);
      if (wait) await sleep(wait);
      results.push(...(await this.runCommands(batch, options)));
      this.commandWindow.record(batch.length);
    }
    return results;
  }

  /** One command's result, for one that was still `Pending` (kept 7 days, lower-case `Status`). */
  getCommand(commandId: string): Promise<CommandStatus> {
    if (!commandId) throw new TypeError("commandId is required");
    return this.request({ method: "GET", path: `/server/commands/${encodeURIComponent(commandId)}`, limiter: "get" });
  }

  /** Poll `getCommand` until it's no longer `pending` (gives up after `timeout` seconds). */
  async waitForCommand(commandId: string, { timeout = 130, interval = 2 } = {}): Promise<CommandStatus> {
    const deadline = performance.now() + timeout * 1000;
    for (;;) {
      const result = await this.getCommand(commandId);
      if (String(result.Status ?? "").toLowerCase() !== "pending" || performance.now() >= deadline) return result;
      await sleep(interval * 1000);
    }
  }

  private send(command: string, options: CommandOptions = {}): Promise<CommandResult> {
    return this.runCommand(command, { check: options.check ?? true });
  }

  // Command helpers: they check arguments before sending, and throw CommandFailedError if the
  // command didn't work (pass { check: false } to get the result instead).
  kick(player: Target, reason?: string, o?: CommandOptions) { return this.send(commands.kick(player, reason), o); }
  /** `duration`: `"30m"`, `"12h"`, `"7d"`, `"1d12h"` or seconds; leave it out for permanent. */
  ban(user: Target, reason?: string, duration?: Duration, o?: CommandOptions) { return this.send(commands.ban(user, reason, duration), o); }
  unban(user: Target, o?: CommandOptions) { return this.send(commands.unban(user), o); }
  jail(player: Target, seconds?: number, o?: CommandOptions) { return this.send(commands.jail(player, seconds), o); }
  release(player: Target, o?: CommandOptions) { return this.send(commands.release(player), o); }
  wanted(players: Target, level: number, o?: CommandOptions) { return this.send(commands.wanted(players, level), o); }
  pm(players: Target, message: string, o?: CommandOptions) { return this.send(commands.pm(players, message), o); }
  resolveModcall(caseId: Target, o?: CommandOptions) { return this.send(commands.resolveModcall(caseId), o); }
  rank(user: Target, rank: string, o?: CommandOptions) { return this.send(commands.rank(user, rank), o); }
  unrank(user: Target, o?: CommandOptions) { return this.send(commands.unrank(user), o); }
  groupAdd(user: Target, group: string, o?: CommandOptions) { return this.send(commands.groupAdd(user, group), o); }
  groupRemove(user: Target, group: string, o?: CommandOptions) { return this.send(commands.groupRemove(user, group), o); }
  setTeam(player: Target, team: string, o?: CommandOptions) { return this.send(commands.setTeam(player, team), o); }
  respawn(players: Target, o?: CommandOptions) { return this.send(commands.respawn(players), o); }
  revive(players: Target, o?: CommandOptions) { return this.send(commands.revive(players), o); }
  teleport(players: Target, toPlayer: Target, o?: CommandOptions) { return this.send(commands.teleport(players, toPlayer), o); }
  teleportToVehicle(players: Target, owner: Target, o?: CommandOptions) { return this.send(commands.teleportToVehicle(players, owner), o); }
  setInvincible(players: Target, invincible = true, o?: CommandOptions) { return this.send(commands.setInvincible(players, invincible), o); }
  give(players: Target, tool: string, o?: CommandOptions) { return this.send(commands.give(players, tool), o); }
  despawnVehicle(player: Target, o?: CommandOptions) { return this.send(commands.despawnVehicle(player), o); }
  removeVehicle(plateOrPlayer: Target, o?: CommandOptions) { return this.send(commands.removeVehicle(plateOrPlayer), o); }
  spawnVehicle(player: Target, customVehicleId: string, o?: CommandOptions) { return this.send(commands.spawnVehicle(player, customVehicleId), o); }
  repair(player: Target, o?: CommandOptions) { return this.send(commands.repair(player), o); }
  refuel(player: Target, o?: CommandOptions) { return this.send(commands.refuel(player), o); }
  setTime(hour: number, o?: CommandOptions) { return this.send(commands.setTime(hour), o); }
  lockTime(locked = true, o?: CommandOptions) { return this.send(commands.lockTime(locked), o); }
  setWeather(weather: string, o?: CommandOptions) { return this.send(commands.setWeather(weather), o); }
  lockWeather(locked = true, o?: CommandOptions) { return this.send(commands.lockWeather(locked), o); }
  announce(message: string, o?: CommandOptions) { return this.send(commands.announce(message), o); }
  teamAnnounce(team: string, message: string, o?: CommandOptions) { return this.send(commands.teamAnnounce(team, message), o); }
  alert(message: string, style: "normal" | "yellow" | "red" = "normal", o?: CommandOptions) { return this.send(commands.alert(message, style), o); }
  setMessage(message: string, o?: CommandOptions) { return this.send(commands.setMessage(message), o); }
  removeMessage(o?: CommandOptions) { return this.send(commands.removeMessage(), o); }
  countdown(seconds: number, o?: CommandOptions) { return this.send(commands.countdown(seconds), o); }
  speedLimit(mph: number | null, o?: CommandOptions) { return this.send(commands.speedLimit(mph), o); }
  createIncident(team: string, priority: number, x: number, z: number, text: string, o?: CommandOptions) {
    return this.send(commands.createIncident(team, priority, x, z, text), o);
  }
  assignIncident(incidentId: string, player: Target, o?: CommandOptions) { return this.send(commands.assignIncident(incidentId, player), o); }
  closeIncident(incidentId: string, o?: CommandOptions) { return this.send(commands.closeIncident(incidentId), o); }
  radio(team: string, message: string, o?: CommandOptions) { return this.send(commands.radio(team, message), o); }
  startCallout(team: "Fire" | "Highways", key: string, o?: CommandOptions) { return this.send(commands.startCallout(team, key), o); }
  ambulanceCallout(player?: Target, o?: CommandOptions) { return this.send(commands.ambulanceCallout(player), o); }
  listCallouts(o?: CommandOptions) { return this.send(commands.listCallouts(), o); }
  stopFires(o?: CommandOptions) { return this.send(commands.stopFires(), o); }
  /** Change a setting; `value` is sent as JSON. Lists and objects replace the whole value: see `updateSetting`. */
  setSetting(name: string, value: unknown, o?: CommandOptions) { return this.send(commands.setSetting(name, value), o); }
  newJoinCode(o?: CommandOptions) { return this.send(commands.newJoinCode(), o); }
  queueRemove(user: Target, o?: CommandOptions) { return this.send(commands.queueRemove(user), o); }
  queueFront(user: Target, o?: CommandOptions) { return this.send(commands.queueFront(user), o); }
  clearPlaceables(player: Target = "all", o?: CommandOptions) { return this.send(commands.clearPlaceables(player), o); }
  shutdown(o?: CommandOptions) { return this.send(commands.shutdown(), o); }

  /**
   * Change part of a setting safely: read it, apply `change`, send the whole value back. Oxford
   * replaces list/object settings with exactly what you send, so this stops one new custom
   * vehicle from wiping the rest. `change` gets a copy and returns the new value (or changes the
   * copy and returns nothing). Resolves `null` if nothing changed (then nothing is sent).
   */
  async updateSetting<T = any>(name: string, change: ((current: T) => T | void) | T, o?: CommandOptions): Promise<CommandResult | null> {
    const settings = await this.getSettings();
    if (!settings) throw new OxfordAPIError("Couldn't read the settings right now; try again shortly");
    if (!(name in settings)) {
      const close = closestMatch(name, Object.keys(settings));
      throw new RangeError(`No setting called '${name}' (names are case-sensitive).${close ? ` Did you mean '${close}'?` : ""}`);
    }
    const current = settings[name] as T;
    if ((current as unknown) === "(set)") {
      throw new TypeError(`${name} is a webhook URL, which the API never returns (it shows "(set)"), so it can't be changed this way. Use setSetting() with the full URL.`);
    }
    let next: T;
    if (typeof change === "function") {
      const copy = structuredClone(current);
      const returned = (change as (c: T) => T | void)(copy);
      next = returned === undefined ? copy : returned;
    } else {
      next = change;
    }
    if (JSON.stringify(next) === JSON.stringify(current)) return null;
    return this.setSetting(name, next, o);
  }

  // ------------------------------------------------------------------ staff and group sync

  /** The `rank`/`unrank` commands needed to make the staff match `desired` (user ID → rank, or `null`). Sends nothing. */
  async planStaffSync(desired: Record<string, string | null> | Map<UserKey, string | null>, { removeOthers = false } = {}): Promise<string[]> {
    const staff = await this.getStaff();
    if (!staff) throw new OxfordAPIError("Couldn't read the staff list right now; try again shortly");
    return planStaffChanges(staff, desired, { removeOthers });
  }

  /** The `group add`/`group remove` commands needed to make `group` contain exactly `members`. Sends nothing. */
  async planGroupSync(group: string, members: Iterable<UserKey>, { removeOthers = true } = {}): Promise<string[]> {
    const groups = await this.getGroups();
    if (!groups) throw new OxfordAPIError("Couldn't read the groups right now; try again shortly");
    return planGroupChanges(groups, group, members, { removeOthers });
  }

  /** Make the staff match `desired`, sending only the changes. Resolves `[command, result]` pairs. */
  async syncStaff(desired: Record<string, string | null> | Map<UserKey, string | null>, options: { removeOthers?: boolean } = {}): Promise<Array<[string, CommandResult]>> {
    const planned = await this.planStaffSync(desired, options);
    const results = await this.runMany(planned);
    return planned.map((c, i) => [c, results[i]]);
  }

  /** Make `group` contain exactly `members` (user IDs), sending only the changes. */
  async syncGroup(group: string, members: Iterable<UserKey>, options: { removeOthers?: boolean } = {}): Promise<Array<[string, CommandResult]>> {
    const planned = await this.planGroupSync(group, members, options);
    const results = await this.runMany(planned);
    return planned.map((c, i) => [c, results[i]]);
  }

  // ------------------------------------------------------------------ events and following

  /**
   * Register a handler for `runForever`. Keys: an entry type (`"Kill"`, `"Join"`, `"SpeedCamera"`…),
   * a log (`"KillLogs"`), `"poll"`, `"error"`, or `"ServerOnline"`/`"ServerOffline"`/`"ServerRestart"`.
   * Pass an array for several. Returns a function that removes the handler.
   */
  on<K extends EventKey>(key: K | K[], handler: (arg: EventMap[K]) => unknown): () => void;
  on(key: string | string[], handler: (event: Event) => unknown): () => void;
  on(key: string | string[], handler: (arg: any) => unknown): () => void {
    return this.handlers.add(Array.isArray(key) ? key : [key], handler);
  }

  /** A follower that yields only new log entries: `for await (const { fresh } of api.follow(["Events"]))`. */
  follow(logs: string[] = ["Events"], options: FollowOptions = {}): LogFollower {
    return new LogFollower(this, logs, options);
  }

  /**
   * Poll the server and call the `on(...)` handlers until `stop()` (or `signal` aborts). Entries
   * arrive oldest first; a handler that throws is logged and skipped; request errors are retried.
   * A wrong key still throws.
   */
  async runForever(options: RunForeverOptions = {}): Promise<void> {
    if (!this.handlers.size) throw new TypeError("No handlers registered: use api.on('Kill', ...) (or another event) first");
    this.stopController = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, this.stopController.signal]) : this.stopController.signal;
    await this.run(this.handlers, (fn, arg) => fn(arg), { ...options, signal });
  }

  /** @internal The loop behind runForever and the pool. */
  async run(
    handlers: Handlers<any>,
    invoke: (fn: any, arg: unknown) => unknown,
    options: RunForeverOptions & {
      onError?: (err: OxfordAPIError) => unknown;
      onPoll?: (data: ServerData) => unknown;
      maxApiErrorDelay?: number;
      wake?: () => Promise<void>;
    },
  ): Promise<void> {
    const follower = new LogFollower(this, handlers.logsNeeded(), options);
    // Load any saved position before deciding whether to skip the backlog.
    await follower.ready();
    let skip = (options.skipExisting ?? true) && follower.cursor === undefined;
    if (skip) follower.skipBacklog();
    if (options.maxApiErrorDelay !== undefined) follower.maxApiErrorDelay = options.maxApiErrorDelay;
    follower.wake = options.wake;
    const watcher = new ServerWatcher();
    const call = async (fn: any, arg: unknown) => {
      try {
        await invoke(fn, arg);
      } catch (err) {
        console.error(`[oxrpy] Handler ${fn?.name || "(anonymous)"} threw:`, err);
      }
    };
    const onError = async (err: OxfordAPIError) => {
      await options.onError?.(err);
      for (const fn of handlers.get("error")) await call(fn, err);
    };
    for await (const { data, fresh } of follower.iterate({ signal: options.signal, onError })) {
      options.onPoll?.(data);
      for (const [fn, arg] of dispatchPlan(handlers, watcher, data, fresh, skip)) await call(fn, arg);
      skip = false;
    }
    this.cursor = follower.cursor;
  }

  /** Make `runForever` return after the current poll. */
  stop(): void {
    this.stopController?.abort();
  }
}

export type { StateStore };
