import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/util.js", () => ({ sleep: vi.fn(async () => {}) }));

import { OxfordAPI, OxfordAPIError, ServerOfflineError, ServerPool } from "../src/index.js";
import { fileName } from "../src/pool.js";
import { OK, TOP, client, fakeFetch, kills, ok, type Reply } from "./helpers.js";

function pool(routes: Record<string, Reply[]>, options = {}) {
  const queues = Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, [...v]]));
  const { fetch, calls } = fakeFetch((call) => {
    const q = queues[call.headers.get("server-key")!];
    return q.length > 1 ? q.shift()! : q[0];
  });
  return { pool: new ServerPool({ rateLimit: "none", fetch, ...options }), calls };
}

describe("ServerPool", () => {
  it("runs handlers for every server", async () => {
    const { pool: p, calls } = pool({ ka: [ok(kills(1, 1)), ok(kills(2, 2))], kb: [ok(kills(7, 7)), ok(kills(9, 8, 9))] });
    p.add("a", "ka");
    p.add("b", "kb");
    const seen: string[] = [];
    p.on("Kill", (server, kill) => {
      seen.push(`${server}:${kill.Seq}`);
      if (seen.length === 3) p.stop();
    });
    await p.runForever();
    expect(seen.sort()).toEqual(["a:2", "b:8", "b:9"]);
    expect(new Set(calls.map((c) => c.headers.get("server-key")))).toEqual(new Set(["ka", "kb"]));
  });

  it("drops a server whose key stops working, and the rest carry on", async () => {
    const { pool: p } = pool({ good: [ok(kills(1, 1)), ok(kills(2, 2))], revoked: [{ status: 403, body: { message: "Invalid API key" } }] });
    p.add("good", "good");
    p.add("revoked", "revoked");
    const errors: Array<[string, number | undefined]> = [];
    const seen: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    p.on("error", (server, err) => { errors.push([server, err.status]); });
    p.on("Kill", (server) => { seen.push(server); p.stop(); });
    await p.runForever();
    expect(errors).toEqual([["revoked", 403]]);
    expect([...p.failed.keys()]).toEqual(["revoked"]);
    expect(seen).toEqual(["good"]);
  });

  it("shares rate limits with an app key, and always shares the IP limit", () => {
    const withKey = new ServerPool({ appKey: "oxa_x" });
    const a = withKey.add("a", "ka");
    const b = withKey.add("b", "kb");
    expect(a.limiters.data).toBe(b.limiters.data);
    expect(a.limiters.command).toBe(b.limiters.command);
    expect(a.ipBucket).toBe(b.ipBucket);
    const solo = new ServerPool();
    const c = solo.add("c", "kc");
    const d = solo.add("d", "kd");
    expect(c.limiters.data).not.toBe(d.limiters.data);
    expect(c.ipBucket).toBe(d.ipBucket);
  });

  it("does something on every server, keeping failures apart", async () => {
    const { pool: p } = pool({ ka: [ok(OK)], kb: [{ status: 503, body: { message: "Server is offline or unavailable", Code: "OFFLINE" } }] });
    p.add("a", "ka");
    p.add("b", "kb");
    const results = await p.runCommandOnAll("announce Maintenance at 6pm");
    expect((results.a as any).Status).toBe("Succeeded");
    expect(results.b).toBeInstanceOf(ServerOfflineError);
  });

  it("adds, removes and saves a file per server", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oxrpy-"));
    const { pool: p } = pool({ k: [ok(kills(1, 1)), ok(kills(2, 2))] });
    p.add("guild/1", "k");
    expect(() => p.add("guild/1", "k")).toThrow(RangeError);
    p.on("Kill", () => { p.stop(); });
    await p.runForever({ saveDir: dir });
    const [file] = await readdir(dir);
    expect(file).toMatch(/^guild_1-[0-9a-f]{8}\.json$/);
    expect(JSON.parse(await readFile(join(dir, file), "utf8")).Cursor).toBe(2);
    await p.remove("guild/1");
    expect(p.has("guild/1")).toBe(false);
  });

  it("polls adaptively by default", async () => {
    const names = ["a/b", "a_b", "a\\b", "..", "guild-1", "x".repeat(300)];
    const files = await Promise.all(names.map(fileName));
    expect(new Set(files).size).toBe(files.length);
    expect(await fileName("guild-1")).toBe("guild-1");
  });
});

describe("security", () => {
  it("never follows redirects", async () => {
    const { api, calls } = client([{ status: 302, headers: { Location: "https://evil.example/steal" } }]);
    await expect(api.getServer()).rejects.toThrow(/redirect/);
    expect(calls).toHaveLength(1);
    expect(calls[0].redirect).toBe("manual");
  });

  it.each(["http://api.oxfd.re/v1", "ftp://x", "api.oxfd.re/v1", "http://10.0.0.5/v1"])("only sends the key over https (%s)", (url) => {
    expect(() => new OxfordAPI({ serverKey: "k", baseUrl: url })).toThrow(/https/);
  });

  it("allows plain http to localhost for testing", () => {
    expect(new OxfordAPI({ serverKey: "k", baseUrl: "http://localhost:8080/v1" }).baseUrl).toBe("http://localhost:8080/v1");
  });

  it("caps Retry-After", async () => {
    const { sleep } = await import("../src/util.js");
    vi.mocked(sleep).mockClear();
    const { api } = client([{ status: 429, body: { message: "slow" }, headers: { "Retry-After": "999999999" } }, ok(TOP)]);
    await api.getServer();
    expect(vi.mocked(sleep).mock.calls[0][0]).toBe(60_000);
  });

  it("escapes command IDs so they can't change the path", async () => {
    const { api, calls } = client([ok({ Status: "succeeded" })]);
    await api.getCommand("../../server?Settings=true");
    expect(calls[0].url.pathname).toBe("/v1/server/commands/..%2F..%2Fserver%3FSettings%3Dtrue");
    expect(calls[0].url.search).toBe("");
  });

  it("refuses to run in a browser unless told to", () => {
    const g = globalThis as any;
    g.window = {};
    g.document = {};
    try {
      expect(() => new OxfordAPI("k")).toThrow(/browser/);
      expect(() => new OxfordAPI({ serverKey: "k", allowBrowser: true })).not.toThrow();
    } finally {
      delete g.window;
      delete g.document;
    }
  });

  it("keeps the key out of errors", async () => {
    const { api } = client([{ status: 500, body: { message: "boom" } }], { maxRetries: 0 });
    const err: OxfordAPIError = await api.getServer().catch((e) => e);
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain("sk_test");
  });
});
