/** Names and limits shared across the package. */

export const BASE_URL = "https://api.oxfd.re/v1";

/** Every section `GET /v1/server` knows about, in the API's spelling. */
export const SECTIONS = [
  // Live
  "Players", "Tracks", "Vehicles", "World", "Teams", "Queue", "Robberies", "Atms", "Incidents",
  "Fires", "Medical", "Trees", "TrafficLights", "Doors", "Radio", "Jobs", "Bounties", "Economy",
  "Trailers", "Placeables", "PlaceablesSummary",
  // Server
  "Staff", "Groups", "Bans", "Settings", "Catalogue",
  // Logs
  "KillLogs", "ModCalls", "RadioCalls", "JoinLogs", "Events", "CommandLogs", "CommandResults",
  "Shots", "Audit",
] as const;

export type Section = (typeof SECTIONS)[number];

/** Sections that take `since`/`limit` and whose entries carry a `Seq`. */
export const LOG_SECTIONS = [
  "KillLogs", "ModCalls", "RadioCalls", "JoinLogs", "Events", "CommandLogs", "CommandResults", "Shots",
] as const;

export type LogSection = (typeof LOG_SECTIONS)[number];

export const AUDIT_CATEGORIES = ["Commands", "Moderation", "Settings", "Staff", "HelpRequests", "Placeables"] as const;

export const MAX_BATCH = 10;

/** The longest oxrpy waits because the API said so, whatever `Retry-After` says. */
export const MAX_RETRY_WAIT_MS = 60_000;

/** The game runs at most 15 commands every 10 seconds per server. */
export const GAME_COMMANDS_PER_WINDOW = 15;
export const GAME_WINDOW_MS = 10_000;

const LOOKUP = new Map<string, string>(SECTIONS.map((name) => [name.toLowerCase(), name]));

/** The API's spelling of a section name (case doesn't matter); unknown names pass through. */
export function sectionName(name: string): string {
  return LOOKUP.get(name.toLowerCase()) ?? name;
}

export const VERSION = "0.1.0";
export const USER_AGENT = `oxrpy-js/${VERSION} (+https://github.com/BLK-TTAUDI/oxrpy-js)`;
