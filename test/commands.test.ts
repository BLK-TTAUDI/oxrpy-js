import { describe, expect, it, vi } from "vitest";

vi.mock("../src/util.js", () => ({ sleep: vi.fn(async () => {}) }));

import { CommandFailedError, commands as c, formatDuration } from "../src/index.js";
import { OK, client, ok } from "./helpers.js";

describe("command text", () => {
  it("moderation", () => {
    expect([
      c.kick("dxrkrider", "Exploiting"),
      c.kick(12345),
      c.ban("m4tty_b", "Combat logging", "7d"),
      c.ban("m4tty_b", "Fail RP 2"), // a reason ending in a number gets an explicit duration
      c.ban("@m4tty_b"),
      c.ban(99120344, undefined, 36 * 3600),
      c.unban("m4tty_b"),
      c.jail("x", 120),
      c.wanted("team:Civilian", 0),
      c.pm("all", "Server\nrestart  soon"),
      c.resolveModcall(4821),
    ]).toEqual([
      "kick dxrkrider Exploiting",
      "kick 12345",
      "ban m4tty_b Combat logging 7d",
      "ban m4tty_b Fail RP 2 permanent",
      "ban m4tty_b",
      "ban 99120344 1d12h",
      "unban m4tty_b",
      "jail x 120",
      "wanted team:Civilian 0",
      "pm all Server restart soon",
      "modcall resolve 4821",
    ]);
  });

  it("everything else", () => {
    expect([
      c.rank("amy_hx", "Senior Moderator"),
      c.groupAdd(2938475610, "Undercover Police"),
      c.setTeam("x", "police"),
      c.setInvincible("all", false),
      c.removeVehicle("RJ75 FLK"),
      c.setTime(13.5),
      c.setWeather("THUNDERSTORM"),
      c.lockWeather(),
      c.alert("Storm incoming", "red"),
      c.speedLimit(null),
      c.speedLimit(60),
      c.createIncident("ambulance", 2, -640, 1712.5, "Cyclist down on Abingdon Rd"),
      c.radio("Police", "Suspect last seen on Cowley Rd"),
      c.setSetting("TeamLimits", { Police: 8, Fire: 4 }),
      c.setSetting("Description", "Serious RP"),
      c.respawn("nonadmins"),
      c.teleport("nonadmins", "Officer_Smith"),
    ]).toEqual([
      "rank amy_hx Senior Moderator",
      "group add 2938475610 Undercover Police",
      "team x Police",
      "uninvincible all",
      "removevehicle RJ75FLK",
      "time 13.5",
      "weather thunderstorm",
      "lockweather",
      "redalert Storm incoming",
      "speedlimit off",
      "speedlimit 60",
      "incident create Ambulance 2 -640 1712.5 Cyclist down on Abingdon Rd",
      "radio Police Suspect last seen on Cowley Rd",
      'setting TeamLimits {"Police":8,"Fire":4}',
      'setting Description "Serious RP"',
      "load nonadmins",
      "tp nonadmins Officer_Smith",
    ]);
  });

  it.each([
    () => c.ban("x", "RDM", "7 days"),
    () => c.ban("x", "RDM", "0m"),
    () => c.ban("x", "a".repeat(201)),
    () => c.ban("two words"),
    () => c.jail("x", 5),
    () => c.wanted("x", 4),
    () => c.wanted("x", 1.5),
    () => c.setTeam("x", "Swat"),
    () => c.give("x", "rocket"),
    () => c.setTime(25),
    () => c.speedLimit(300),
    () => c.createIncident("Civilian", 1, 0, 0, "x"),
    () => c.createIncident("Police", 4, 0, 0, "x"),
    () => c.announce("   "),
    () => c.alert("x", "blue" as any),
  ])("rejects bad arguments (%#)", (build) => {
    expect(build).toThrow();
  });

  it("formatDuration", () => {
    expect(formatDuration("1D12H")).toBe("1d12h");
    expect(formatDuration(undefined)).toBe("permanent");
    expect(formatDuration("permanent")).toBe("permanent");
    expect(formatDuration(90 * 60)).toBe("1h30m");
    expect(formatDuration(7 * 86400)).toBe("7d");
    expect(() => formatDuration(4000 * 86400)).toThrow(RangeError);
    expect(() => formatDuration("")).toThrow(RangeError);
  });
});

describe("helper methods", () => {
  it("send the command and nothing on bad arguments", async () => {
    const { api, calls } = client([ok(OK)]);
    await api.kick("dxrkrider", "Exploiting");
    expect(calls[0].body).toEqual({ command: "kick dxrkrider Exploiting" });
    expect(() => api.wanted("x", 9)).toThrow(RangeError);
    expect(calls).toHaveLength(1);
  });

  it("throw if the command failed, unless check: false", async () => {
    const failed = { CommandId: "c", Status: "Failed", Code: "FORBIDDEN", Message: "Can't kick staff" };
    const { api } = client([ok(failed), ok(failed)]);
    const err = await api.kick("amy_hx").catch((e) => e);
    expect(err).toBeInstanceOf(CommandFailedError);
    expect(err.code).toBe("FORBIDDEN");
    expect((await api.kick("amy_hx", undefined, { check: false })).Status).toBe("Failed");
  });
});
