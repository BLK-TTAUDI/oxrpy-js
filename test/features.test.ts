import { describe, expect, it, vi } from "vitest";

vi.mock("../src/util.js", () => ({ sleep: vi.fn(async () => {}) }));

import { AmbiguousMatchError, lookup, map, type RequestInfo, sync } from "../src/index.js";
import { sleep } from "../src/util.js";
import { OK, TOP, client, ok } from "./helpers.js";

const PLAYERS = [
  { UserId: 81234401, Username: "kieran_rd", DisplayName: "Kieran", Team: "Police", Rank: "Mod" },
  { UserId: 99120344, Username: "dxrkrider", DisplayName: "Dark", Team: "Civilian", Rank: null },
  { UserId: 99120377, Username: "kierstan", DisplayName: "K", Team: "civilian", Rank: null },
  { UserId: 55, Username: "ownerman", DisplayName: "Boss", Team: "Civilian", Rank: "Owner" },
];
const VEHICLES = [
  { Plate: "RJ75 FLK", OwnerId: 99120344, Model: "Strassen Solo" },
  { Plate: "OX24 KRD", OwnerId: 81234401, Model: "Strassen Reuter" },
];

describe("api.latest", () => {
  it("keeps live sections but not logs", async () => {
    const { api } = client([ok({ ...TOP, Players: PLAYERS, Events: [{ Seq: 1 }], Bans: { Total: 0 } })]);
    expect(api.latest.players).toBeUndefined();
    await api.getServerData(["Players", "Events", "Bans"]);
    expect(api.latest.players).toEqual(PLAYERS);
    expect(api.latest.online).toBe(true);
    expect(api.latest.server?.Name).toBe("Test RP");
    expect(api.latest.age("Players")).toBeLessThan(1);
    expect(api.latest.has("Events")).toBe(false);
    expect(api.latest.sections).toEqual(["Cursor", "LastHeartbeat", "NextHeartbeat", "Online", "Players", "Server"]);
  });
});

describe("lookups", () => {
  it("follow Oxford's matching rules", () => {
    expect(lookup.findPlayer(PLAYERS, "KIERAN_RD")?.UserId).toBe(81234401);
    expect(lookup.findPlayer(PLAYERS, "boss")?.Username).toBe("ownerman");
    expect(lookup.findPlayer(PLAYERS, 99120344)?.Username).toBe("dxrkrider");
    expect(lookup.findPlayer(PLAYERS, "@dxrk")?.UserId).toBe(99120344);
    expect(lookup.findPlayer(PLAYERS, "nobody")).toBeUndefined();
    expect(lookup.findPlayer(null, "x")).toBeUndefined();
    const err = (() => { try { lookup.findPlayer(PLAYERS, "kier"); } catch (e) { return e as AmbiguousMatchError; } })();
    expect(err).toBeInstanceOf(AmbiguousMatchError);
    expect(err!.matches.map((p) => p.Username).sort()).toEqual(["kieran_rd", "kierstan"]);
  });

  it("teams, staff and vehicles", () => {
    expect(lookup.playersOnTeam(PLAYERS, "CIVILIAN").map((p) => p.Username)).toEqual(["dxrkrider", "kierstan", "ownerman"]);
    expect(lookup.staffOnline(PLAYERS).map((p) => p.Username)).toEqual(["kieran_rd", "ownerman"]);
    expect(lookup.findVehicle(VEHICLES, "rj75flk")?.OwnerId).toBe(99120344);
    expect(lookup.findVehicle(VEHICLES, "kieran_rd", PLAYERS)?.Plate).toBe("OX24 KRD");
    expect(lookup.findVehicle(VEHICLES, 99120344)?.Plate).toBe("RJ75 FLK");
  });

  it("the client uses api.latest when it's fresh", async () => {
    const { api, calls } = client([ok({ ...TOP, Players: PLAYERS }), ok({ ...TOP, Players: PLAYERS.slice(0, 1) })]);
    expect((await api.findPlayer("dxrkrider"))?.UserId).toBe(99120344);
    expect(await api.staffOnline()).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(await api.findPlayer("dxrkrider", { maxAge: 0 })).toBeUndefined();
    expect(calls).toHaveLength(2);
  });
});

describe("updateSetting", () => {
  const SETTINGS = { TeamLimits: { Police: 8, Fire: 4 }, Tags: ["UK"], AdminWebhook: "(set)", MaxPlayers: 36 };

  it("sends the whole new value, without touching the original", async () => {
    const { api, calls } = client([ok({ ...TOP, Settings: SETTINGS }), ok(OK), ok({ ...TOP, Settings: SETTINGS }), ok(OK)]);
    await api.updateSetting<string[]>("Tags", (tags) => [...tags, "Serious"]);
    expect(calls[1].body).toEqual({ command: 'setting Tags ["UK","Serious"]' });
    await api.updateSetting<Record<string, number>>("TeamLimits", (limits) => { limits.Police = 10; });
    expect(calls[3].body).toEqual({ command: 'setting TeamLimits {"Police":10,"Fire":4}' });
    expect(SETTINGS.TeamLimits.Police).toBe(8);
  });

  it("skips no-ops and refuses unsafe changes", async () => {
    const { api, calls } = client(Array.from({ length: 4 }, () => ok({ ...TOP, Settings: SETTINGS })));
    expect(await api.updateSetting("MaxPlayers", 36)).toBeNull();
    expect(await api.updateSetting<string[]>("Tags", () => undefined)).toBeNull();
    await expect(api.updateSetting("teamlimits", {})).rejects.toThrow(/Did you mean 'TeamLimits'/);
    await expect(api.updateSetting("AdminWebhook", "https://x")).rejects.toThrow(/webhook/);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});

it("iterAudit pages through everything", async () => {
  const pages = [
    { Entries: [{ Number: 5 }, { Number: 4 }], Next: 4 },
    { Entries: [{ Number: 3 }], Next: 3 },
    { Entries: [{ Number: 2 }, { Number: 1 }], Next: null },
  ];
  const { api, calls } = client(pages.map((Audit) => ok({ ...TOP, Audit })));
  const numbers: number[] = [];
  for await (const entry of api.iterAudit({ category: "Moderation", pageSize: 2 })) numbers.push(entry.Number!);
  expect(numbers).toEqual([5, 4, 3, 2, 1]);
  expect(calls.map((c) => c.url.searchParams.get("AuditBefore"))).toEqual([null, "4", "3"]);
});

it("onRequest sees every attempt and rate limits are recorded", async () => {
  const { api } = client([
    { status: 429, body: { message: "slow down", retryAfter: 1 }, headers: { "Retry-After": "1" } },
    ok(TOP, { "X-RateLimit-Limit": "1", "X-RateLimit-Remaining": "1", "X-RateLimit-Reset": "0" }),
  ]);
  const seen: RequestInfo[] = [];
  api.onRequest((info) => seen.push(info));
  api.onRequest(() => { throw new Error("a bad hook must not break requests"); });
  vi.spyOn(console, "error").mockImplementation(() => {});
  await api.getServer();
  expect(seen.map((i) => [i.status, i.attempt, i.willRetry])).toEqual([[429, 0, true], [200, 1, false]]);
  expect(seen[1].rateLimit).toEqual({ Limit: 1, Remaining: 1, Reset: 0 });
  expect(api.rateLimitStatus.data?.Remaining).toBe(1);
  expect(JSON.stringify(seen)).not.toContain("sk_test");
});

describe("staff and group sync", () => {
  const STAFF = {
    OwnerId: 1,
    Staff: [{ UserId: 10, RankId: "mod" }, { UserId: 11, RankId: "admin" }, { UserId: 12, RankId: "mod" }],
    Ranks: [{ Id: "admin", Name: "Admin" }, { Id: "senior-mod", Name: "Senior Moderator" }, { Id: "mod", Name: "Mod" }],
  };

  it("plans only the changes", () => {
    expect(sync.planStaffChanges(STAFF, { 10: "mod", 11: "Senior Moderator", 13: "Admin", 12: null, 1: "Mod" }))
      .toEqual(["unrank 12", "rank 11 senior-mod", "rank 13 admin"]);
    expect(sync.planStaffChanges(STAFF, { 10: "Mod" }, { removeOthers: true })).toEqual(["unrank 11", "unrank 12"]);
    expect(() => sync.planStaffChanges(STAFF, { kieran_rd: "Mod" })).toThrow(/user IDs/);
    expect(() => sync.planStaffChanges(STAFF, { 10: "Overlord" })).toThrow(/Senior Moderator/);
    const groups = [{ Id: "cid", Name: "CID", Members: [10, 11] }];
    expect(sync.planGroupChanges(groups, "CID", [11, 12])).toEqual(["group add 12 cid", "group remove 10 cid"]);
  });

  it("syncStaff sends them, and runMany paces long lists", async () => {
    const { api, calls } = client([ok({ ...TOP, Staff: STAFF }), ok([OK, OK])]);
    const done = await api.syncStaff({ 11: "Senior Moderator", 13: "Mod" });
    expect(done.map(([cmd]) => cmd)).toEqual(["rank 11 senior-mod", "rank 13 mod"]);
    expect(calls[1].body).toEqual({ commands: ["rank 11 senior-mod", "rank 13 mod"] });

    vi.mocked(sleep).mockClear();
    const many = client([ok(Array(10).fill(OK)), ok(Array(10).fill(OK)), ok(Array(3).fill(OK))]);
    expect(await many.api.runMany(Array.from({ length: 23 }, (_, i) => `announce ${i}`))).toHaveLength(23);
    expect(many.calls.map((c) => c.body.commands.length)).toEqual([10, 10, 3]);
    expect(vi.mocked(sleep).mock.calls.filter(([ms]) => ms > 9000)).toHaveLength(2);
  });

  it("CommandWindow", () => {
    const w = new sync.CommandWindow();
    expect(w.waitTime(10, 0)).toBe(0);
    w.record(10, 0);
    w.record(5, 1000);
    expect(w.waitTime(1, 2000)).toBe(8250);
    expect(w.waitTime(1, 10_500)).toBe(0);
  });
});

describe("map", () => {
  it("converts positions", () => {
    expect(map.toPixels([-6700, 50, -2500])).toEqual([0, 0]);
    expect(map.toPixels([1450, 3800])).toEqual([8151, 6301]);
    const [px, py] = map.toPixels([512.4, 14.2, -88], { width: 1630, height: 1260 });
    const [x, z] = map.fromPixels(px, py, { width: 1630, height: 1260 });
    expect(x).toBeCloseTo(512.4);
    expect(z).toBeCloseTo(-88);
    expect(map.onMap([0, 0, 0])).toBe(true);
    expect(map.distance([0, 100, 0], [3, 0, 4])).toBe(5);
    expect(map.nearest([400, 0, 1200], [{ Name: "Bank", Position: [412, 10, 1238] }, { Name: "Station", Position: [210, 6, 905] }])?.Name).toBe("Bank");
    expect(() => map.toPixels(null)).toThrow(TypeError);
  });
});
