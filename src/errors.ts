/** Errors thrown by oxrpy. Every one is an {@link OxfordAPIError}. */

const MESSAGE_HINTS: Array<[string, string]> = [
  ["Missing required header: server-key", "Pass your server key: new OxfordAPI(key), or set OXFD_SERVER_KEY."],
  [
    "Invalid API key",
    "Check the key in Server Management > External > API Key. If it was regenerated, the old one stops working within a few seconds.",
  ],
  ["This server does not have the API package", "The server needs the API package: buy it in Server Management > Packages."],
  ["Invalid app key", "Check appKey (it starts with oxa_). It may have been replaced or removed."],
  ["This app key is suspended", "Contact Oxford Roleplay about the app key."],
  ["Endpoint not found", "Your oxrpy may be out of date: npm install oxrpy@latest"],
  ["This endpoint was removed", "Upgrade oxrpy: npm install oxrpy@latest"],
  ["Too many long commands waiting", "Long commands (over about 900 bytes) queue up; wait a few seconds between them."],
  ["Failed to send command", "The command wasn't run. Try again in a moment."],
  ["No command with that id", "Command results are kept for 7 days. Check the CommandId."],
  ["Server is offline", "The server must be online to run commands. Reading data still works while it's offline."],
];

const CODE_HINTS: Record<string, string> = {
  TARGET_NOT_FOUND: "Nobody matched. Use a Roblox user ID to be exact; names can change.",
  INVALID_ARGS: "The message shows how the command is used.",
  FORBIDDEN: "The owner and staff can't be targeted by that command.",
  PACKAGE_REQUIRED: "The command needs a package (RoleplayKit, FleetKit or AdvancedServer).",
  RATE_LIMITED: "The game runs at most 15 commands every 10 seconds. runMany() paces them for you.",
  OFFLINE: "The server must be online to run commands.",
  UNKNOWN_COMMAND: "See the list of commands: https://docs.oxfd.re/#commands",
};

/** A short suggestion for fixing an error, or `undefined`. */
export function hintFor(status: number | undefined, message: string, code?: string, body?: unknown): string | undefined {
  const valid = (body as { ValidParameters?: unknown } | undefined)?.ValidParameters;
  if (status === 400 && Array.isArray(valid) && valid.length) {
    const bad = message.split(":").slice(1).join(":").trim();
    const close = closestMatch(bad, valid.map(String));
    return close ? `Did you mean '${close}'?` : `Valid parameters: ${valid.join(", ")}`;
  }
  for (const [prefix, hint] of MESSAGE_HINTS) if (message.startsWith(prefix)) return hint;
  if (code && CODE_HINTS[code]) return CODE_HINTS[code];
  if (status === 429) return "Too many requests. oxrpy already waited and retried; slow down or raise maxRetries.";
  if (status !== undefined && status >= 500) {
    return "A problem on Oxford's side. Try again shortly; https://docs.oxfd.re/#status shows API status.";
  }
  return undefined;
}

/** The candidate most like `word` (case-insensitive edit distance), if it's close enough. */
export function closestMatch(word: string, candidates: string[]): string | undefined {
  const target = word.toLowerCase();
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const score = editDistance(target, candidate.toLowerCase());
    if (score < bestScore) [best, bestScore] = [candidate, score];
  }
  return best !== undefined && bestScore <= Math.max(2, Math.floor(target.length / 3)) ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[b.length];
}

export interface ErrorDetails {
  status?: number;
  code?: string;
  body?: unknown;
  hint?: string;
}

/** Base class for every error oxrpy throws. */
export class OxfordAPIError extends Error {
  /** The HTTP status code, if there was a response. */
  readonly status?: number;
  /** The API's `Code` (e.g. `"OFFLINE"`, `"RATE_LIMITED"`), if any. */
  readonly code?: string;
  /** The decoded JSON body, if there was one. */
  readonly body?: unknown;
  /** A suggestion for fixing it, if oxrpy has one (also in the error's `toString()`). */
  readonly hint?: string;
  /** The API's message on its own, without the status or hint. */
  readonly apiMessage: string;

  constructor(message: string, details: ErrorDetails = {}) {
    const hint = details.hint ?? hintFor(details.status, message, details.code, details.body);
    const prefix = [details.status, details.code].filter((x) => x !== undefined && x !== "").join(" ");
    super(`${prefix ? `${prefix}: ` : ""}${message}${hint ? ` (hint: ${hint})` : ""}`);
    this.name = new.target.name;
    this.apiMessage = message;
    this.status = details.status;
    this.code = details.code;
    this.body = details.body;
    this.hint = hint;
  }
}

/** 401/403: missing or invalid server key, missing API package, or a bad or suspended app key. */
export class AuthenticationError extends OxfordAPIError {}

/** 400: an unknown parameter, a bad value, or a malformed command body. */
export class BadRequestError extends OxfordAPIError {
  /** Every parameter `GET /v1/server` accepts, when the API sends the list. */
  get validParameters(): string[] {
    const valid = (this.body as { ValidParameters?: unknown } | undefined)?.ValidParameters;
    return Array.isArray(valid) ? valid.map(String) : [];
  }
}

/** 404: no such endpoint, or no command with that id. */
export class NotFoundError extends OxfordAPIError {}

/** 410: a removed endpoint. */
export class EndpointRemovedError extends OxfordAPIError {}

/** 429: still rate limited after retrying. */
export class RateLimitError extends OxfordAPIError {
  /** Seconds the API asked to wait. */
  readonly retryAfter?: number;
  constructor(message: string, details: ErrorDetails & { retryAfter?: number } = {}) {
    super(message, details);
    this.retryAfter = details.retryAfter;
  }
}

/** 503: the server is offline, so the command wasn't run. */
export class ServerOfflineError extends OxfordAPIError {}

/** A command reached the server but didn't work (thrown by the helpers, or with `check: true`). */
export class CommandFailedError extends OxfordAPIError {
  /** The whole result: `CommandId`, `Status`, `Code`, `Message`. */
  readonly result: Record<string, unknown>;
  readonly commandId?: string;
  constructor(result: Record<string, unknown>) {
    super(String(result.Message ?? "Command failed"), { status: 200, code: result.Code as string | undefined, body: result });
    this.result = result;
    this.commandId = result.CommandId as string | undefined;
  }
}

/** More than one player matched a name. `matches` holds them. */
export class AmbiguousMatchError extends Error {
  readonly query: string;
  readonly matches: Array<Record<string, unknown>>;
  constructor(query: string, matches: Array<Record<string, unknown>>) {
    const names = matches.slice(0, 5).map((p) => String(p.Username)).join(", ");
    const more = matches.length > 5 ? ` and ${matches.length - 5} more` : "";
    super(`'${query}' matches ${matches.length} players (${names}${more}); name one`);
    this.name = "AmbiguousMatchError";
    this.query = query;
    this.matches = matches;
  }
}
