/** The handler registry behind `api.on(...)` and `api.runForever()`. */

import type { OxfordAPIError } from "./errors.js";
import type {
  CommandLog, CommandResultLog, Event, JoinLog, KillLog, ModCall, RadioCall, ServerData, Shot,
} from "./types.js";

/** What each `on(...)` key hands its handler. Any other key is a game event type, which gets an `Event`. */
export interface EventMap {
  Kill: KillLog;
  KillLogs: KillLog;
  ModCall: ModCall;
  ModCalls: ModCall;
  RadioCall: RadioCall;
  RadioCalls: RadioCall;
  Join: JoinLog;
  Leave: JoinLog;
  JoinLogs: JoinLog;
  Command: CommandLog;
  CommandLogs: CommandLog;
  CommandResult: CommandResultLog;
  CommandResults: CommandResultLog;
  Shot: Shot;
  Shots: Shot;
  Events: Event;
  /** Every response, after each poll. */
  poll: ServerData;
  ServerOnline: ServerData;
  ServerOffline: ServerData;
  ServerRestart: ServerData;
  /** A request failed and will be retried. */
  error: OxfordAPIError;
}

export type EventKey = keyof EventMap;
export type Handler<T> = (arg: T) => unknown;

const LOGS: Record<string, string> = Object.fromEntries(
  ["KillLogs", "ModCalls", "RadioCalls", "JoinLogs", "Events", "CommandLogs", "CommandResults", "Shots"].map((n) => [n.toLowerCase(), n]),
);

/** Entry `Type` → the log it comes from. Any other type is a game event, in `Events`. */
const TYPE_LOGS: Record<string, string> = {
  kill: "KillLogs", modcall: "ModCalls", radiocall: "RadioCalls", join: "JoinLogs", leave: "JoinLogs",
  command: "CommandLogs", commandresult: "CommandResults", shot: "Shots",
};

export const STATE_EVENTS = ["ServerOnline", "ServerOffline", "ServerRestart"] as const;
const SPECIAL = new Set(["poll", "error", ...STATE_EVENTS.map((s) => s.toLowerCase())]);

/** Maps keys (entry types, log names, `poll`, `error`, server events) to handler functions. */
export class Handlers<F extends (...args: any[]) => unknown = Handler<any>> {
  private byKey = new Map<string, F[]>();

  add(keys: string[], fn: F): () => void {
    if (!keys.length) throw new TypeError("on() needs at least one event type or log name, e.g. on('Kill', ...)");
    if (typeof fn !== "function") throw new TypeError("the handler must be a function");
    const normalised = keys.map((key) => {
      if (typeof key !== "string" || !key.trim()) throw new TypeError(`Not an event type or log name: ${JSON.stringify(key)}`);
      return key.trim().toLowerCase();
    });
    for (const key of normalised) {
      const list = this.byKey.get(key) ?? [];
      list.push(fn);
      this.byKey.set(key, list);
    }
    return () => {
      for (const key of normalised) this.byKey.set(key, (this.byKey.get(key) ?? []).filter((f) => f !== fn));
    };
  }

  get(key: string): F[] {
    return [...(this.byKey.get(key.toLowerCase()) ?? [])];
  }

  get size(): number {
    let n = 0;
    for (const list of this.byKey.values()) n += list.length;
    return n;
  }

  /** Which log sections to ask for, given the registered keys. */
  logsNeeded(): string[] {
    const logs: string[] = [];
    for (const [key, list] of this.byKey) {
      if (!list.length || SPECIAL.has(key)) continue;
      const log = LOGS[key] ?? TYPE_LOGS[key] ?? "Events";
      if (!logs.includes(log)) logs.push(log);
    }
    return logs;
  }

  /** Handlers for one entry: the log's own, then the entry type's. */
  forEntry(log: string, entry: { Type?: string }): F[] {
    const fns = this.get(log);
    const type = String(entry.Type ?? (log === "Shots" ? "Shot" : "")).toLowerCase();
    if (type && !LOGS[type] && !SPECIAL.has(type) && (TYPE_LOGS[type] ?? "Events") === log) {
      for (const fn of this.get(type)) if (!fns.includes(fn)) fns.push(fn);
    }
    return fns;
  }
}

/** Spots the server coming online, going offline or restarting between polls. */
export class ServerWatcher {
  private online?: boolean;
  private instance?: unknown;

  update(data: ServerData): string[] {
    const online = Boolean(data.Online);
    const instance = data.Server?.StartedAt || data.Server?.JobId || undefined;
    const events: string[] = [];
    if (this.online !== undefined) {
      if (online && !this.online) events.push("ServerOnline");
      else if (!online && this.online) events.push("ServerOffline");
      if (online && instance !== undefined && this.instance !== undefined && instance !== this.instance) events.push("ServerRestart");
    }
    this.online = online;
    if (instance !== undefined) this.instance = instance;
    return events;
  }
}

/** All new entries from every log, oldest first (by `Seq`, which all logs share). */
export function orderedEntries(fresh: Record<string, Array<{ Seq?: number }>>): Array<[string, any]> {
  const items: Array<[string, any]> = [];
  for (const [log, entries] of Object.entries(fresh)) for (const entry of entries) items.push([log, entry]);
  return items.sort(([, a], [, b]) => (a.Seq ?? Infinity) - (b.Seq ?? Infinity));
}

/** Every `[handler, argument]` call one poll should make: state changes, entries, then `poll`. */
export function dispatchPlan<F extends (...args: any[]) => unknown>(
  handlers: Handlers<F>,
  watcher: ServerWatcher,
  data: ServerData,
  fresh: Record<string, Array<{ Seq?: number }>>,
  skipEntries: boolean,
): Array<[F, unknown]> {
  const calls: Array<[F, unknown]> = [];
  for (const name of watcher.update(data)) for (const fn of handlers.get(name)) calls.push([fn, data]);
  if (!skipEntries) {
    for (const [log, entry] of orderedEntries(fresh)) for (const fn of handlers.forEntry(log, entry)) calls.push([fn, entry]);
  }
  for (const fn of handlers.get("poll")) calls.push([fn, data]);
  return calls;
}

/** A handler that takes longer than this (ms) gets a warning. */
export const SLOW_HANDLER_MS = 5000;

/**
 * Warn about a slow handler. Handlers run one at a time, in the order things happened, and the next
 * poll waits for them, so a slow one leaves the bot behind without any error.
 */
export function warnIfSlow(fn: { name?: string } | undefined, ms: number): void {
  if (ms < SLOW_HANDLER_MS) return;
  console.warn(
    `[oxrpy] Handler ${fn?.name || "(anonymous)"} took ${(ms / 1000).toFixed(1)}s. The next poll waits for handlers, `
    + "so events are arriving that much later. Hand slow work (a database write, a big upload) off to run "
    + "separately: https://oxrpy.org/js/events/#slow-handlers",
  );
}
