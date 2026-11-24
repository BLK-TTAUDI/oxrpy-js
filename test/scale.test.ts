/**
 * Apps that follow many servers: the fair rate limiter, limits that follow what Oxford reports,
 * cached reads, and ServerPool's stats, verify() and updateKey(). (Mirrors tests/test_scale.py.)
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticationError, LogFollower, OxfordAPI, ServerPool, TokenBucket } from "../src/index.js";
import { TOP, fakeFetch, ok, type Call, type Reply } from "./helpers.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const APP_KEY = `oxa_${"a".repeat(40)}`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the fair limiter", () => {
  it("serves waiters in order, with your own requests first", async () => {
    const bucket = new TokenBucket(50, 1);
    expect(await bucket.acquire()).toBe(true); // the only token
    const order: string[] = [];
    const take = async (label: string, priority: number) => {
      await bucket.acquire({ priority });
      order.push(label);
    };
    const polls = [0, 1, 2].map((i) => take(`poll${i}`, 1));
    const mine = take("mine", 0); // arrives last, goes first
    await Promise.all([...polls, mine]);
    expect(order).toEqual(["mine", "poll0", "poll1", "poll2"]);
  });

  it("doesn't let a waiter that gave up hold up the rest", async () => {
    const bucket = new TokenBucket(5, 1);
    expect(await bucket.acquire()).toBe(true);
    expect(await bucket.acquire({ timeoutMs: 10 })).toBe(false);
    const controller = new AbortController();
    const aborted = bucket.acquire({ signal: controller.signal });
    controller.abort();
    expect(await aborted).toBe(false);
    expect(bucket.waiting).toBe(0);
    expect(await bucket.acquire({ timeoutMs: 1000 })).toBe(true);
  });

  it("doesn't let anyone jump the queue", async () => {
    const bucket = new TokenBucket(20, 1);
    expect(await bucket.acquire()).toBe(true);
    const waiter = bucket.acquire();
    expect(bucket.tryAcquire()).toBe(false);
    expect(await waiter).toBe(true);
  });

  it("changes rate", () => {
    const bucket = new TokenBucket(20, 40);
    bucket.setRate(100, 200);
    expect([bucket.rate, bucket.capacity]).toEqual([100, 200]);
    expect(() => bucket.setRate(0)).toThrow(RangeError);
  });
});

describe("limits that follow Oxford", () => {
  it("adopts the limit Oxford reports for an app key", async () => {
    const { fetch } = fakeFetch(() => ok(TOP, { "X-RateLimit-Limit": "100" }));
    const api = new OxfordAPI({ serverKey: "sk", appKey: APP_KEY, fetch });
    expect(api.limiters.data!.rate).toBe(20); // standard tier to start with
    await api.getPlayers();
    expect(api.limiters.data!.rate).toBe(100);
    expect(api.limiters.get!.rate).toBe(100); // all GETs share one limit with an app key
    expect(api.limiters.data!.capacity).toBe(200);
  });

  it("keeps its limits without an app key", async () => {
    const { fetch } = fakeFetch(() => ok(TOP, { "X-RateLimit-Limit": "30" }));
    const api = new OxfordAPI({ serverKey: "sk", fetch });
    await api.getPlayers();
    expect(api.limiters.data!.rate).toBe(1);
  });
});

describe("cached reads", () => {
  it("answers from latest with maxAge, without a request", async () => {
    const { fetch, calls } = fakeFetch(() => ok({ ...TOP, Players: [{ Username: "a" }] }));
    const api = new OxfordAPI({ serverKey: "sk", rateLimit: "none", fetch });
    expect(await api.getPlayers()).toEqual([{ Username: "a" }]);
    expect(await api.getPlayers({ maxAge: 5 })).toEqual([{ Username: "a" }]);
    expect(calls.length).toBe(1);
    await api.getPlayers(); // no maxAge: always fetches
    expect(calls.length).toBe(2);
  });
});

function poolFrom(reply: (call: Call) => Reply, options: Record<string, unknown> = {}) {
  const { fetch, calls } = fakeFetch(reply);
  return { pool: new ServerPool({ rateLimit: "none", fetch, ...options }), calls };
}

const entries = (seq: number) => ({
  ...TOP, Cursor: seq, Server: { Name: "RP", CurrentPlayers: 3 }, KillLogs: [{ Seq: seq, Type: "Kill" }],
});

describe("ServerPool at scale", () => {
  it("reports stats", async () => {
    vi.spyOn(LogFollower.prototype, "nextDelay").mockReturnValue(10);
    const seqs: Record<string, number> = {};
    const { pool } = poolFrom((call) => {
      const key = call.headers.get("server-key")!;
      seqs[key] = (seqs[key] ?? 0) + 1;
      return ok(entries(seqs[key]));
    });
    pool.add("a", "ka");
    pool.add("b", "kb");
    pool.on("Kill", () => {});
    const running = pool.runForever();
    await wait(300);
    const stats = pool.stats;
    pool.stop();
    await running;

    expect([stats.servers, stats.following, stats.failed]).toEqual([2, 2, 0]);
    expect(stats.readLimit).toBeUndefined(); // rateLimit: "none"
    expect(stats.requestsPerSecond).toBeGreaterThan(0);
    expect(stats.averageInterval).toBeGreaterThan(0);
    expect(stats.averageInterval).toBeLessThan(0.3);
    expect(stats.slowestInterval).toBeGreaterThanOrEqual(stats.averageInterval!);
    const a = stats.perServer.a;
    expect(a.polls).toBeGreaterThanOrEqual(3);
    expect([a.online, a.players, a.failed]).toEqual([true, 3, undefined]);
  });

  it("knows its read limit", () => {
    expect(new ServerPool().readLimit).toBe(30); // the per-IP limit
    expect(new ServerPool({ appKey: APP_KEY }).readLimit).toBe(20);
    expect(new ServerPool({ rateLimit: "none" }).readLimit).toBeUndefined();
  });

  it("verifies a key without adding it", async () => {
    const { pool } = poolFrom((call) => call.headers.get("server-key") === "good"
      ? ok({ ...TOP, Server: { Name: "Test RP", OwnerId: 1 } })
      : { status: 403, body: { message: "Invalid server key" } });
    expect((await pool.verify("good")).Name).toBe("Test RP");
    await expect(pool.verify("bad")).rejects.toBeInstanceOf(AuthenticationError);
    expect(pool.size).toBe(0);
  });

  it("brings a failed server back with updateKey", async () => {
    vi.spyOn(LogFollower.prototype, "nextDelay").mockReturnValue(10);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { pool } = poolFrom((call) => call.headers.get("server-key") === "old"
      ? { status: 403, body: { message: "Invalid server key" } }
      : ok(entries(9)));
    pool.add("a", "old");
    const errors: string[] = [];
    pool.on("error", (server) => { errors.push(server); });
    pool.on("poll", () => {});
    const running = pool.runForever();
    await wait(100);
    expect(pool.failed.has("a")).toBe(true);
    expect(errors).toEqual(["a"]);
    expect(pool.stats.perServer.a.failed).toBeDefined();

    await pool.updateKey("a", "new");
    await wait(100);
    const stats = pool.stats.perServer.a;
    pool.stop();
    await running;
    expect(pool.failed.has("a")).toBe(false);
    expect(stats.failed).toBeUndefined();
    expect(stats.polls).toBeGreaterThanOrEqual(1);
  });

  it("shares a busy limit fairly", async () => {
    // 60 servers on 60 requests a second, each wanting a poll every 0.2 s (300 a second).
    vi.spyOn(LogFollower.prototype, "nextDelay").mockReturnValue(200);
    const counts: Record<string, number> = {};
    const { pool } = poolFrom((call) => {
      const key = call.headers.get("server-key")!;
      counts[key] = (counts[key] ?? 0) + 1;
      return ok(TOP);
    }, { rateLimit: "auto" });
    (pool as unknown as { ipBucket: TokenBucket }).ipBucket.setRate(60, 60);
    for (let i = 0; i < 60; i++) pool.add(`s${i}`, `key-${i}`);
    pool.on("poll", () => {});
    const running = pool.runForever();
    await wait(2500);
    const stats = pool.stats;
    pool.stop();
    await running;

    const polls = Object.values(counts).sort((a, b) => a - b);
    expect(polls.length).toBe(60);
    expect(polls.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60 * 2.5 + 60 + 5); // per-IP limit plus its burst
    expect(polls[polls.length - 1] - polls[0]).toBeLessThanOrEqual(1); // nobody got far more turns
    expect(stats.waiting).toBeGreaterThan(0); // more demand than limit, so requests queue
  }, 10_000);

  it("puts your own requests ahead of a busy pool", async () => {
    vi.spyOn(LogFollower.prototype, "nextDelay").mockReturnValue(50);
    const { pool } = poolFrom(() => ok({ ...TOP, Players: [] }), { rateLimit: "auto", appKey: APP_KEY });
    const internals = pool as unknown as { ipBucket: TokenBucket };
    internals.ipBucket.setRate(20, 20);
    for (let i = 0; i < 40; i++) pool.add(`s${i}`, `key-${i}`);
    pool.on("poll", () => {});
    const running = pool.runForever();
    await wait(500); // the queue is full of polls by now
    const started = performance.now();
    await pool.get("s7")!.getPlayers(); // a Discord command's lookup, say
    const waited = performance.now() - started;
    pool.stop();
    await running;
    expect(waited).toBeLessThan(200); // one slot, not the 40 polls ahead of it
  });

  it("stops promptly even with polls queued", async () => {
    vi.spyOn(LogFollower.prototype, "nextDelay").mockReturnValue(10);
    const { pool } = poolFrom(() => ok(TOP), { rateLimit: "auto" });
    (pool as unknown as { ipBucket: TokenBucket }).ipBucket.setRate(5, 5);
    for (let i = 0; i < 100; i++) pool.add(`s${i}`, `key-${i}`);
    pool.on("poll", () => {});
    const running = pool.runForever();
    await wait(200);
    const started = performance.now();
    pool.stop();
    await running;
    expect(performance.now() - started).toBeLessThan(500); // not 100 queued polls at 5 a second
    expect(pool.stats.waiting).toBe(0);
  });
});
