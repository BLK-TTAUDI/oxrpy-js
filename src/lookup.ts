/**
 * Finding players and vehicles in the API's data, the same way Oxford's commands do. These work
 * on any list you already have; the client's `findPlayer` & co. use `api.latest` when it's fresh.
 */

import { AmbiguousMatchError } from "./errors.js";
import type { Player, Vehicle } from "./types.js";

const lower = (v: unknown) => String(v ?? "").toLowerCase();

/**
 * Everyone `query` could mean, using Oxford's `<player>` rules, best matches first:
 * a username, then a display name (any case), then a user ID, then part of a name.
 */
export function findPlayers(players: Iterable<Player> | null | undefined, query: string | number): Player[] {
  const people = [...(players ?? [])];
  let text = String(query).trim();
  if (text.startsWith("@")) text = text.slice(1);
  if (!text) return [];
  const q = text.toLowerCase();

  const byUsername = people.filter((p) => lower(p.Username) === q);
  if (byUsername.length) return byUsername;
  const byDisplay = people.filter((p) => lower(p.DisplayName) === q);
  if (byDisplay.length) return byDisplay;
  if (/^\d+$/.test(text)) {
    const byId = people.filter((p) => String(p.UserId) === text);
    if (byId.length) return byId;
  }
  return people.filter((p) => lower(p.Username).includes(q) || lower(p.DisplayName).includes(q));
}

/**
 * The one player `query` means, or `undefined` if nobody matches.
 * @throws AmbiguousMatchError if several players match (its `matches` lists them).
 */
export function findPlayer(players: Iterable<Player> | null | undefined, query: string | number): Player | undefined {
  const matches = findPlayers(players, query);
  if (matches.length > 1) throw new AmbiguousMatchError(String(query), matches as Array<Record<string, unknown>>);
  return matches[0];
}

/** Everyone on a team (any case: `"police"` works). */
export function playersOnTeam(players: Iterable<Player> | null | undefined, team: string): Player[] {
  const wanted = team.trim().toLowerCase();
  return [...(players ?? [])].filter((p) => lower(p.Team) === wanted);
}

/** Players in the server with a staff rank (the owner included). */
export function staffOnline(players: Iterable<Player> | null | undefined): Player[] {
  return [...(players ?? [])].filter((p) => p.Rank);
}

const plate = (v: unknown) => String(v ?? "").replace(/\s+/g, "").toUpperCase();

/**
 * A vehicle by registration (spaces and case don't matter: `"rj75flk"` finds `"RJ75 FLK"`), or
 * else by its owner: a user ID, or a name looked up in `players`.
 */
export function findVehicle(
  vehicles: Iterable<Vehicle> | null | undefined,
  plateOrPlayer: string | number,
  players?: Iterable<Player> | null,
): Vehicle | undefined {
  const cars = [...(vehicles ?? [])];
  const wanted = plate(plateOrPlayer);
  const byPlate = cars.find((car) => plate(car.Plate) === wanted);
  if (byPlate) return byPlate;
  const text = String(plateOrPlayer).trim().replace(/^@/, "");
  let ownerId: number | undefined = /^\d+$/.test(text) ? Number(text) : undefined;
  if (players) {
    const owner = findPlayer(players, plateOrPlayer);
    if (owner?.UserId !== undefined) ownerId = owner.UserId;
  }
  return ownerId === undefined ? undefined : cars.find((car) => car.OwnerId === ownerId);
}
