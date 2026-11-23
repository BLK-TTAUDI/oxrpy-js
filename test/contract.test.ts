/**
 * The shared contract: test/fixtures/contract.json and the sample responses next to it.
 * They're an exact copy of fixtures/ in the Python wrapper (BLK-TTAUDI/OXRPY), which runs the same
 * cases, so the two wrappers can't drift apart. `npm run fixtures` refreshes the copy; CI checks it.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/util.js", () => ({ sleep: vi.fn(async () => {}) }));

import * as oxrpy from "../src/index.js";
import { AmbiguousMatchError, lookup, OxfordAPIError } from "../src/index.js";
import { OK, client, ok } from "./helpers.js";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const CONTRACT = load("contract.json");
const FULL = load("server_full.json");
const OFFLINE = load("server_offline.json");
const LOGS = ["KillLogs", "ModCalls", "RadioCalls", "JoinLogs", "Events", "CommandLogs", "CommandResults", "Shots"];

/** JSON has no undefined, so `null` stands for "leave this argument out". */
const jsArgs = (args: unknown[]) => args.map((a) => (a === null ? undefined : a));

describe("command text", () => {
  it.each((CONTRACT.commands as any[]).map((c: any): [string, any] => [c.text, c]))("%s", async (_text, c: any) => {
    const { api, calls } = client([ok(OK)]);
    await (api as any)[c.js](...jsArgs(c.args));
    expect(calls[0].body).toEqual({ command: c.text });
  });

  it.each((CONTRACT.invalid_commands as any[]).map((c: any): [string, any] => [`${c.js}(${JSON.stringify(c.args)})`, c]))(
    "refuses %s before sending",
    (_label, c: any) => {
      const { api, calls } = client([]);
      expect(() => (api as any)[c.js](...jsArgs(c.args))).toThrow();
      expect(calls).toHaveLength(0);
    },
  );
});

describe("lookups", () => {
  it.each((CONTRACT.find_player as any[]).map((c: any): [string, any] => [c.why, c]))("findPlayer: %s", (_why, c: any) => {
    if (c.ambiguous) {
      let err: unknown;
      try { lookup.findPlayer(FULL.Players, c.query); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(AmbiguousMatchError);
      expect((err as AmbiguousMatchError).matches.map((p) => p.Username).sort()).toEqual([...c.ambiguous].sort());
    } else {
      expect(lookup.findPlayer(FULL.Players, c.query)?.UserId ?? null).toBe(c.user_id);
    }
  });

  it.each((CONTRACT.find_vehicle as any[]).map((c: any): [string, any] => [c.why, c]))("findVehicle: %s", (_why, c: any) => {
    expect(lookup.findVehicle(FULL.Vehicles, c.query, FULL.Players)?.Plate).toBe(c.plate);
  });

  it("teams and staff", () => {
    expect(lookup.playersOnTeam(FULL.Players, CONTRACT.players_on_team.team).map((p) => p.Username)).toEqual(CONTRACT.players_on_team.usernames);
    expect(lookup.staffOnline(FULL.Players).map((p) => p.Username)).toEqual(CONTRACT.staff_online.usernames);
  });
});

it("dispatches oldest first across logs", async () => {
  const top = Object.fromEntries(Object.entries(FULL).filter(([k]) => !LOGS.includes(k)));
  const second = { ...top, ...CONTRACT.dispatch.second_poll };
  const { api } = client([ok(FULL), ok(second)]);
  const fired: string[] = [];
  for (const key of ["Kill", "Join", "Leave", "SpeedCamera"]) {
    api.on(key, (entry: any) => { fired.push(`${entry.Type}:${entry.Seq}`); });
  }
  api.on("poll", (data) => { if (data.Cursor === CONTRACT.dispatch.second_poll.Cursor) api.stop(); });
  await api.runForever();
  expect(fired).toEqual(CONTRACT.dispatch.order);
});

describe("errors", () => {
  it.each((CONTRACT.errors as any[]).map((c: any): [string, any] => [`${c.status} ${c.body.message.slice(0, 30)}`, c]))("%s", async (_label, c: any) => {
    const { api } = client([{ status: c.status, body: c.body }], { maxRetries: 0 });
    const err = await api.getServerData(["Players"]).catch((e) => e);
    expect(err).toBeInstanceOf(OxfordAPIError);
    expect(err.constructor.name).toBe(c.type);
    expect(err).toBeInstanceOf((oxrpy as any)[c.type]);
    if (c.hint) expect(err.hint).toBe(c.hint);
    else expect((err.hint ?? "").toLowerCase()).toContain(c.hint_contains.toLowerCase());
  });

  it("failed command", async () => {
    const { result, hint_contains } = CONTRACT.failed_command;
    const { api } = client([ok(result)]);
    const err = await api.runCommand("kick x", { check: true }).catch((e) => e);
    expect(err).toBeInstanceOf(oxrpy.CommandFailedError);
    expect(err.code).toBe(result.Code);
    expect(err.hint).toContain(hint_contains);
  });
});

it("api.latest keeps live sections only", async () => {
  const { api } = client([ok(FULL)]);
  await api.getServerData(Object.keys(FULL).filter((k) => !["Online", "LastHeartbeat", "NextHeartbeat", "Cursor", "Server"].includes(k)));
  for (const section of CONTRACT.latest.kept) expect(api.latest.has(section), section).toBe(true);
  for (const section of CONTRACT.latest.not_kept) expect(api.latest.has(section), section).toBe(false);
});

it("an offline server", async () => {
  const { api } = client([ok(OFFLINE)]);
  const data = await api.getServerData(["Players", "Staff"]);
  expect(data!.Players).toBe(CONTRACT.offline.players);
  expect(api.latest.online).toBe(CONTRACT.offline.online);
  expect(data!.Staff!.Staff).toHaveLength(CONTRACT.offline.staff_count);
});
