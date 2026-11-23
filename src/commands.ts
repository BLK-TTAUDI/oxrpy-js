/**
 * Builders for command text, so `api.ban("user", "RDM", "7d")` sends `ban user RDM 7d`.
 *
 * Each checks its arguments and throws a `RangeError`/`TypeError` before anything is sent, so a
 * bad duration or team fails straight away. The client's methods (`api.kick` …) send them.
 */

export const TEAMS = ["Civilian", "Police", "Ambulance", "Highways", "Fire"] as const;
export const EMERGENCY_TEAMS = ["Police", "Ambulance", "Fire", "Highways"] as const;
export const WEATHER = ["Clear", "Rain", "Snow", "Thunderstorm"] as const;
export const TOOLS = ["megaphone", "firestarter", "lectern", "flag", "staffcuffs"] as const;
export const ALERT_STYLES = { normal: "alert", yellow: "yellowalert", red: "redalert" } as const;

export type Team = (typeof TEAMS)[number];
export type Target = string | number;
/** `"30m"`, `"12h"`, `"7d"`, `"1d12h"`, `"permanent"`, or a number of seconds. */
export type Duration = string | number;

const MAX_BAN_MINUTES = 3653 * 24 * 60; // "up to 10 years"; the server has the final say

/** A single name, user ID or keyword like `all` / `team:Police`: no spaces. */
export function target(value: Target, what = "player"): string {
  let text = String(value).trim();
  if (text.startsWith("@")) text = text.slice(1);
  if (!text || /\s/.test(text)) throw new TypeError(`${what} must be one username, display name or user ID, got ${JSON.stringify(value)}`);
  return text;
}

/** Free text: the rest of the line. Newlines and runs of spaces become one space. */
export function text(value: unknown, what: string, maxLength?: number): string {
  const out = String(value ?? "").split(/\s+/).filter(Boolean).join(" ");
  if (!out) throw new TypeError(`${what} can't be empty`);
  if (maxLength !== undefined && out.length > maxLength) {
    throw new RangeError(`${what} is ${out.length} characters; the most is ${maxLength}`);
  }
  return out;
}

export function choice<T extends string>(value: string, options: readonly T[], what: string): T {
  const wanted = String(value).trim().toLowerCase();
  const found = options.find((o) => o.toLowerCase() === wanted);
  if (!found) throw new RangeError(`${what} must be one of ${options.join(", ")}, got ${JSON.stringify(value)}`);
  return found;
}

export function intRange(value: unknown, low: number, high: number, what: string): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new TypeError(`${what} must be a whole number, got ${JSON.stringify(value)}`);
  if (n < low || n > high) throw new RangeError(`${what} must be from ${low} to ${high}, got ${n}`);
  return n;
}

function num(value: unknown, what: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${what} must be a number, got ${JSON.stringify(value)}`);
  return String(n);
}

/** Turn `"7d"`, `"1d12h"` or a number of seconds into the `ban` command's duration. */
export function formatDuration(duration: Duration | null | undefined): string {
  if (duration === null || duration === undefined) return "permanent";
  let minutes: number;
  if (typeof duration === "number") {
    minutes = Math.floor(duration / 60);
  } else {
    const t = duration.trim().toLowerCase().replace(/\s+/g, "");
    if (t === "permanent") return "permanent";
    const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/.exec(t);
    if (!t || !m) throw new RangeError(`Ban duration must look like 30m, 12h, 7d or 1d12h (or 'permanent'), got ${JSON.stringify(duration)}`);
    const [d, h, mi] = [m[1], m[2], m[3]].map((x) => (x ? Number(x) : 0));
    minutes = d * 1440 + h * 60 + mi;
    if (minutes >= 1 && minutes <= MAX_BAN_MINUTES) return t;
  }
  if (!(minutes >= 1 && minutes <= MAX_BAN_MINUTES)) throw new RangeError("Ban duration must be from 1 minute to 10 years");
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  return [days && `${days}d`, hours && `${hours}h`, mins && `${mins}m`].filter(Boolean).join("");
}

const join = (...parts: Array<string | number | undefined | false>) =>
  parts.filter((p) => p !== undefined && p !== false && p !== "").join(" ");

/** Every command, as text. `commands.ban("x", "RDM", "7d")` → `"ban x RDM 7d"`. */
export const commands = {
  // Moderation
  kick: (player: Target, reason?: string) => join("kick", target(player), reason ? text(reason, "reason") : undefined),
  ban(user: Target, reason?: string, duration?: Duration) {
    const parts: string[] = ["ban", target(user, "user")];
    if (reason) parts.push(text(reason, "reason", 200));
    // Always end with the duration, so a reason ending in a number isn't read as one.
    if (reason || duration !== undefined) parts.push(formatDuration(duration));
    return parts.join(" ");
  },
  unban: (user: Target) => join("unban", target(user, "user")),
  jail: (player: Target, seconds?: number) =>
    join("jail", target(player), seconds !== undefined && intRange(seconds, 10, 3600, "seconds")),
  release: (player: Target) => join("release", target(player)),
  wanted: (players: Target, level: number) => join("wanted", target(players, "players"), intRange(level, 0, 3, "level")),
  pm: (players: Target, message: string) => join("pm", target(players, "players"), text(message, "message")),
  resolveModcall: (caseId: Target) => join("modcall", "resolve", target(caseId, "caseId")),

  // Staff and groups
  rank: (user: Target, rank: string) => join("rank", target(user, "user"), text(rank, "rank")),
  unrank: (user: Target) => join("unrank", target(user, "user")),
  groupAdd: (user: Target, group: string) => join("group", "add", target(user, "user"), text(group, "group")),
  groupRemove: (user: Target, group: string) => join("group", "remove", target(user, "user"), text(group, "group")),

  // Players and vehicles
  setTeam: (player: Target, team: string) => join("team", target(player), choice(team, TEAMS, "team")),
  respawn: (players: Target) => join("load", target(players, "players")),
  revive: (players: Target) => join("revive", target(players, "players")),
  teleport: (players: Target, toPlayer: Target) => join("tp", target(players, "players"), target(toPlayer, "toPlayer")),
  teleportToVehicle: (players: Target, owner: Target) => join("tocar", target(players, "players"), target(owner, "owner")),
  setInvincible: (players: Target, invincible = true) => join(invincible ? "invincible" : "uninvincible", target(players, "players")),
  give: (players: Target, tool: string) => join("give", target(players, "players"), choice(tool, TOOLS, "tool")),
  despawnVehicle: (player: Target) => join("despawn", target(player)),
  removeVehicle: (plateOrPlayer: Target) => join("removevehicle", target(String(plateOrPlayer).replace(/\s+/g, ""), "plateOrPlayer")),
  spawnVehicle: (player: Target, customVehicleId: string) => join("spawnvehicle", target(player), target(customVehicleId, "customVehicleId")),
  repair: (player: Target) => join("repair", target(player)),
  refuel: (player: Target) => join("refuel", target(player)),

  // World and messages
  setTime(hour: number) {
    const h = Number(hour);
    if (!Number.isFinite(h)) throw new TypeError(`hour must be a number, got ${JSON.stringify(hour)}`);
    if (h < 0 || h > 24) throw new RangeError(`hour must be from 0 to 24, got ${hour}`);
    return join("time", String(h));
  },
  lockTime: (locked = true) => (locked ? "locktime" : "unlocktime"),
  setWeather: (weather: string) => join("weather", choice(weather, WEATHER, "weather").toLowerCase()),
  lockWeather: (locked = true) => (locked ? "lockweather" : "unlockweather"),
  announce: (message: string) => join("announce", text(message, "message")),
  teamAnnounce: (team: string, message: string) => join("teamannounce", choice(team, TEAMS, "team"), text(message, "message")),
  alert(message: string, style: keyof typeof ALERT_STYLES = "normal") {
    const key = choice(style, Object.keys(ALERT_STYLES) as Array<keyof typeof ALERT_STYLES>, "style");
    return join(ALERT_STYLES[key], text(message, "message"));
  },
  setMessage: (message: string) => join("setmessage", text(message, "message")),
  removeMessage: () => "removemessage",
  countdown: (seconds: number) => join("countdown", intRange(seconds, 0, 10 ** 7, "seconds")),
  speedLimit: (mph: number | null) => join("speedlimit", !mph ? "off" : intRange(mph, 5, 200, "mph")),

  // Control room and callouts
  createIncident: (team: string, priority: number, x: number, z: number, description: string) =>
    join("incident", "create", choice(team, EMERGENCY_TEAMS, "team"), intRange(priority, 1, 3, "priority"),
      num(x, "x"), num(z, "z"), text(description, "text", 200)),
  assignIncident: (incidentId: string, player: Target) => join("incident", "assign", target(incidentId, "incidentId"), target(player)),
  closeIncident: (incidentId: string) => join("incident", "close", target(incidentId, "incidentId")),
  radio: (team: string, message: string) => join("radio", choice(team, EMERGENCY_TEAMS, "team"), text(message, "message")),
  startCallout: (team: "Fire" | "Highways", key: string) => join("callout", choice(team, ["Fire", "Highways"] as const, "team"), target(key, "key")),
  ambulanceCallout: (player?: Target) => join("callout", "ambulance", player !== undefined ? target(player) : undefined),
  listCallouts: () => "callouts",
  stopFires: () => "stopfires",

  // Server
  setSetting: (name: string, value: unknown) => join("setting", target(name, "name"), JSON.stringify(value)),
  newJoinCode: () => "joincode",
  queueRemove: (user: Target) => join("queue", "remove", target(user, "user")),
  queueFront: (user: Target) => join("queue", "front", target(user, "user")),
  clearPlaceables: (player: Target = "all") => join("clearplaceables", target(player)),
  shutdown: () => "shutdown",
};

export type CommandName = keyof typeof commands;
