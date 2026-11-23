import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/util.js", () => ({ sleep: vi.fn(async () => {}) }));

import { AuthenticationError, FileState, LogFollower, type ServerData } from "../src/index.js";
import { sleep } from "../src/util.js";
import { TOP, client, kills, ok } from "./helpers.js";

const tmp = () => mkdtemp(join(tmpdir(), "oxrpy-"));

describe("runForever", () => {
  it("dispatches oldest first, skips the backlog, survives bad handlers and errors", async () => {
    const old = { ...TOP, Cursor: 5, KillLogs: [{ Seq: 5, Type: "Kill" }], JoinLogs: [{ Seq: 4, Type: "Join" }] };
    const fresh = {
      ...TOP, Cursor: 9, Players: [],
      KillLogs: [{ Seq: 8, Type: "Kill", Weapon: "G36C" }],
      JoinLogs: [{ Seq: 9, Type: "Leave" }, { Seq: 6, Type: "Join" }],
    };
    const { api, calls } = client([ok(old), { status: 500, body: { message: "oops" } }, ok(fresh)], { maxRetries: 0 });
    const seen: Array<[string, number]> = [];
    const polls: number[] = [];
    const errors: unknown[] = [];
    api.on("Kill", (kill) => { seen.push(["kill", kill.Seq!]); });
    api.on(["Join", "Leave"], (entry) => { seen.push([entry.Type!.toLowerCase(), entry.Seq!]); });
    api.on("JoinLogs", () => { throw new Error("a bad handler shouldn't stop the bot"); });
    api.on("error", (err) => { errors.push(err); });
    api.on("poll", (data) => {
      polls.push(data.Cursor!);
      if (polls.length === 2) api.stop();
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await api.runForever({ sections: ["Players"] });
    expect(seen).toEqual([["join", 6], ["kill", 8], ["leave", 9]]);
    expect(polls).toEqual([5, 9]);
    expect(errors).toHaveLength(1);
    const first = Object.fromEntries(calls[0].url.searchParams);
    expect(first).toMatchObject({ KillLogs: "true", JoinLogs: "true", Players: "true" });
    expect(first.Events).toBeUndefined();
    expect(calls[2].url.searchParams.get("Since")).toBe("5");
    expect(api.cursor).toBe(9);
  });

  it("game event types go to the Events log", async () => {
    const { api, calls } = client([
      ok({ ...TOP, Events: [{ Seq: 1, Type: "SpeedCamera" }] }),
      ok({ ...TOP, Events: [{ Seq: 2, Type: "SpeedCamera", SpeedMph: 61 }] }),
    ]);
    const caught: number[] = [];
    api.on("speedcamera", (e) => { caught.push(e.SpeedMph as number); api.stop(); });
    await api.runForever();
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ Events: "true" });
    expect(caught).toEqual([61]);
  });

  it("fires server online/offline/restart events", async () => {
    const polls = [
      { ...TOP, Online: true, Server: { StartedAt: 1 } },
      { ...TOP, Online: false, Server: { StartedAt: 1 } },
      { ...TOP, Online: true, Server: { StartedAt: 2 } },
    ];
    const { api } = client(polls.map((p) => ok(p)));
    const seen: string[] = [];
    api.on("ServerOffline", () => { seen.push("offline"); });
    api.on("ServerOnline", () => { seen.push("online"); });
    api.on("ServerRestart", () => { seen.push("restart"); api.stop(); });
    await api.runForever();
    expect(seen).toEqual(["offline", "online", "restart"]);
  });

  it("needs handlers, and on() returns an unsubscribe", async () => {
    const { api } = client([]);
    await expect(api.runForever()).rejects.toThrow(/No handlers/);
    const off = api.on("Kill", () => {});
    off();
    await expect(api.runForever()).rejects.toThrow(/No handlers/);
  });

  it("stops on a bad key", async () => {
    const { api } = client([{ status: 403, body: { message: "Invalid API key" } }]);
    api.on("Kill", () => {});
    await expect(api.runForever()).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe("follow", () => {
  it("de-duplicates and advances the cursor", async () => {
    const { api, calls } = client([
      ok({ ...TOP, Cursor: 12, Events: [{ Seq: 12, Type: "B" }, { Seq: 10, Type: "A" }] }),
      ok({ ...TOP, Cursor: 13, Events: [{ Seq: 13, Type: "C" }, { Seq: 12, Type: "B" }] }),
    ]);
    const f = api.follow(["events"], { sections: ["Players"] });
    expect((await f.poll()).fresh.Events.map((e) => e.Type)).toEqual(["A", "B"]);
    expect(calls[0].url.searchParams.has("Since")).toBe(false);
    expect((await f.poll()).fresh.Events.map((e) => e.Type)).toEqual(["C"]);
    expect(calls[1].url.searchParams.get("Since")).toBe("12");
    expect(f.cursor).toBe(13);
  });

  it("keeps going after temporary errors", async () => {
    vi.mocked(sleep).mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { api } = client([
      { status: 500, body: { message: "Internal server error" } },
      { status: 429, body: { message: "Rate limit exceeded.", retryAfter: 5 } },
      ok({ ...TOP, Events: [{ Seq: 1, Type: "Downed" }] }),
    ], { maxRetries: 0 });
    for await (const { fresh } of api.follow(["Events"])) {
      expect(fresh.Events.map((e) => e.Type)).toEqual(["Downed"]);
      break;
    }
    expect(vi.mocked(sleep).mock.calls.slice(0, 2).map((c) => c[0])).toEqual([2000, 5000]);
  });

  it("rejects non-log sections", () => {
    const { api } = client([]);
    expect(() => api.follow(["Players"])).toThrow(RangeError);
  });
});

describe("saving the position", () => {
  it("resumes after a restart without missing or repeating anything", async () => {
    const path = join(await tmp(), "state", "cursor.json");
    const first = client([ok(kills(5, 4, 5)), ok(kills(6, 6))]);
    const seen: number[] = [];
    first.api.on("Kill", (k) => { seen.push(k.Seq!); first.api.stop(); });
    await first.api.runForever({ saveTo: path });
    expect(seen).toEqual([6]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ Cursor: 6, Handled: { KillLogs: 6 } });

    const second = client([ok(kills(8, 6, 7, 8))]);
    const seen2: number[] = [];
    second.api.on("Kill", (k) => { seen2.push(k.Seq!); if (k.Seq === 8) second.api.stop(); });
    await second.api.runForever({ saveTo: path });
    expect(seen2).toEqual([7, 8]);
    expect(second.calls[0].url.searchParams.get("Since")).toBe("6");
    expect(JSON.parse(await readFile(path, "utf8")).Cursor).toBe(8);
  });

  it("saves only after the handlers ran", async () => {
    const path = join(await tmp(), "cursor.json");
    const { api } = client([ok(kills(1, 1)), ok(kills(2, 2))]);
    const loop = api.follow(["KillLogs"], { saveTo: path }).iterate();
    await loop.next();
    await expect(readFile(path, "utf8")).rejects.toThrow(); // still handling the first poll
    await loop.next();
    expect(JSON.parse(await readFile(path, "utf8")).Cursor).toBe(1);
    await loop.return(undefined);
  });

  it("works with your own store, and ignores broken files", async () => {
    const store = { state: { Version: 1, Cursor: 40, Handled: { Events: 40 }, SavedAt: 0 }, load() { return this.state; }, save(s: any) { this.state = s; } };
    const { api, calls } = client([ok({ ...TOP, Cursor: 41, Events: [{ Seq: 41 }] })]);
    const f = api.follow(["Events"], { saveTo: store });
    await f.poll();
    await f.save();
    expect(f.resumed).toBe(true);
    expect(calls[0].url.searchParams.get("Since")).toBe("40");
    expect(store.state.Cursor).toBe(41);

    const broken = join(await tmp(), "broken.json");
    await writeFile(broken, "{not json");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await new FileState(broken).load()).toBeNull();
    expect(() => api.follow(["Events"], { saveTo: 123 as any })).toThrow(TypeError);
  });
});

describe("adaptive polling", () => {
  const beat = (players = 10): ServerData => ({ ...TOP, NextHeartbeat: Date.now() / 1000, Server: { CurrentPlayers: players } });

  it("backs off when quiet and resets on activity", () => {
    const { api } = client([]);
    const f = new LogFollower(api, ["Events"], { adaptive: true, maxIdle: 5 });
    expect(f.nextDelay(beat())).toBeCloseTo(1000, -2);
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      f.process({ ...beat(), Events: [] });
      delays.push(Math.round(f.nextDelay()));
    }
    expect(delays).toEqual([1500, 2250, 3375, 5000, 5000, 5000]);
    f.process({ ...beat(), Events: [{ Seq: 1 }] });
    expect(f.nextDelay()).toBeCloseTo(1000, -2);
    expect(f.nextDelay(beat(0))).toBe(5000);
    const plain = new LogFollower(api, ["Events"]);
    plain.process({ ...beat(0), Events: [] });
    expect(plain.nextDelay()).toBeCloseTo(1000, -2);
  });
});
