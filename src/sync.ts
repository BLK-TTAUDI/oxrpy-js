/**
 * Keeping staff ranks and groups in step with somewhere else (Discord roles, a database…):
 * work out only the commands needed. Users are identified by Roblox user ID only, because a
 * username can match nobody, or someone else after a name change.
 */

import { GAME_COMMANDS_PER_WINDOW, GAME_WINDOW_MS } from "./constants.js";
import type { Group, Staff } from "./types.js";

export type UserKey = string | number;

function userId(value: UserKey): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  throw new TypeError(`Sync needs Roblox user IDs, not names (a name can change or match someone else): ${JSON.stringify(value)}`);
}

function findRank(ranks: NonNullable<Staff["Ranks"]>, wanted: string): string {
  const target = wanted.trim().toLowerCase();
  const rank = ranks.find((r) => [String(r.Id ?? "").toLowerCase(), String(r.Name ?? "").toLowerCase()].includes(target));
  if (!rank?.Id) throw new RangeError(`No rank called '${wanted}' on this server (ranks: ${ranks.map((r) => r.Name).join(", ") || "none"})`);
  return rank.Id;
}

/**
 * The `rank`/`unrank` commands that turn the current staff list into `desired`
 * (user ID → rank name or Id, or `null` to take them off the staff). The owner is never touched.
 * With `removeOthers`, staff not in `desired` are unranked too.
 */
export function planStaffChanges(
  staff: Staff,
  desired: Record<string, string | null> | Map<UserKey, string | null>,
  { removeOthers = false }: { removeOthers?: boolean } = {},
): string[] {
  const owner = staff.OwnerId;
  const ranks = staff.Ranks ?? [];
  const current = new Map<number, string>();
  for (const member of staff.Staff ?? []) current.set(Number(member.UserId), String(member.RankId ?? "").toLowerCase());

  const wanted = new Map<number, string | null>();
  const entries = desired instanceof Map ? [...desired.entries()] : Object.entries(desired);
  for (const [key, rank] of entries) {
    const id = userId(key);
    if (id === owner) continue;
    wanted.set(id, rank === null ? null : findRank(ranks, rank));
  }

  const removals: string[] = [];
  const changes: string[] = [];
  for (const id of [...wanted.keys()].sort((a, b) => a - b)) {
    const rankId = wanted.get(id);
    if (rankId === null || rankId === undefined) {
      if (current.has(id)) removals.push(`unrank ${id}`);
    } else if (current.get(id) !== rankId.toLowerCase()) {
      changes.push(`rank ${id} ${rankId}`);
    }
  }
  if (removeOthers) {
    for (const id of [...current.keys()].sort((a, b) => a - b)) {
      if (!wanted.has(id) && id !== owner) removals.push(`unrank ${id}`);
    }
  }
  return [...removals, ...changes];
}

/** The `group add`/`group remove` commands that make `group` contain exactly `members`. */
export function planGroupChanges(
  groups: Group[],
  group: string,
  members: Iterable<UserKey>,
  { removeOthers = true }: { removeOthers?: boolean } = {},
): string[] {
  const target = group.trim().toLowerCase();
  const found = groups.find((g) => [String(g.Id ?? "").toLowerCase(), String(g.Name ?? "").toLowerCase()].includes(target));
  if (!found?.Id) {
    const names = groups.map((g) => g.Name).join(", ") || "none (groups need AdvancedServer)";
    throw new RangeError(`No group called '${group}' on this server (groups: ${names})`);
  }
  const current = new Set((found.Members ?? []).map(Number));
  const wanted = new Set([...members].map(userId));
  const byNumber = (a: number, b: number) => a - b;
  const commands = [...wanted].filter((id) => !current.has(id)).sort(byNumber).map((id) => `group add ${id} ${found.Id}`);
  if (removeOthers) {
    commands.push(...[...current].filter((id) => !wanted.has(id)).sort(byNumber).map((id) => `group remove ${id} ${found.Id}`));
  }
  return commands;
}

/** Tracks commands sent in the last 10 seconds, to stay under the game's 15. */
export class CommandWindow {
  private sent: number[] = [];
  constructor(
    readonly limit = GAME_COMMANDS_PER_WINDOW,
    readonly windowMs = GAME_WINDOW_MS,
  ) {}

  /** Milliseconds to wait before `count` more commands fit. */
  waitTime(count: number, now = performance.now()): number {
    while (this.sent.length && this.sent[0] <= now - this.windowMs) this.sent.shift();
    const over = this.sent.length + count - this.limit;
    if (over <= 0) return 0;
    return Math.max(0, this.sent[over - 1] + this.windowMs - now + 250);
  }

  record(count: number, now = performance.now()): void {
    for (let i = 0; i < count; i++) this.sent.push(now);
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
