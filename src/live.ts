/**
 * `api.latest`: the newest copy of the server's live state, kept in memory.
 *
 * Every response from `GET /v1/server` (from `runForever`, `follow`, `getPlayers()`…) updates
 * it. Reading it costs no request, which matters when you only get one `GET /v1/server` a second.
 * Logs aren't kept (each response only has the new entries), nor are `Bans` and `Audit` (paged).
 */

import type {
  Group, Incidents, Player, QueueEntry, Robbery, ServerData, ServerInfo, Staff, Teams, Vehicle, World,
} from "./types.js";

const NOT_KEPT = new Set([
  "KillLogs", "ModCalls", "RadioCalls", "JoinLogs", "Events", "CommandLogs", "CommandResults", "Shots", "Bans", "Audit",
]);

export class LiveState {
  private data = new Map<string, unknown>();
  private seen = new Map<string, number>();
  /** When it was last updated (ms since the epoch), or `undefined` before the first response. */
  updatedAt?: number;

  /** Store the sections in a `GET /v1/server` response (done for you). */
  update(response: ServerData): void {
    const now = performance.now();
    for (const [key, value] of Object.entries(response)) {
      if (NOT_KEPT.has(key)) continue;
      this.data.set(key, value);
      this.seen.set(key, now);
    }
    this.updatedAt = Date.now();
  }

  clear(): void {
    this.data.clear();
    this.seen.clear();
    this.updatedAt = undefined;
  }

  /** A section by name (`"Players"`, `"World"`…), or `undefined` if it hasn't arrived yet. */
  get<T = unknown>(section: string): T | undefined {
    return this.data.get(section) as T | undefined;
  }

  has(section: string): boolean {
    return this.seen.has(section);
  }

  /** Seconds since `section` last arrived, or `undefined` if it never has. */
  age(section: string): number | undefined {
    const seen = this.seen.get(section);
    return seen === undefined ? undefined : (performance.now() - seen) / 1000;
  }

  /** Whether `section` arrived within the last `maxAge` seconds. */
  isFresh(section: string, maxAge: number): boolean {
    const age = this.age(section);
    return age !== undefined && age <= maxAge;
  }

  /** The names of the sections held. */
  get sections(): string[] {
    return [...this.data.keys()].sort();
  }

  /** Whether the server was online at the last response (`undefined` before any). */
  get online(): boolean | undefined {
    const value = this.data.get("Online");
    return value === undefined ? undefined : Boolean(value);
  }
  get server(): ServerInfo | undefined { return this.get("Server"); }
  /** `undefined` if never fetched; `null` while the server is offline. */
  get players(): Player[] | null | undefined { return this.get("Players"); }
  get vehicles(): Vehicle[] | null | undefined { return this.get("Vehicles"); }
  get world(): World | null | undefined { return this.get("World"); }
  get teams(): Teams | null | undefined { return this.get("Teams"); }
  get queue(): QueueEntry[] | null | undefined { return this.get("Queue"); }
  get robberies(): Robbery[] | null | undefined { return this.get("Robberies"); }
  get incidents(): Incidents | null | undefined { return this.get("Incidents"); }
  get staff(): Staff | null | undefined { return this.get("Staff"); }
  get groups(): Group[] | null | undefined { return this.get("Groups"); }
}
