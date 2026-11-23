import { describe, expect, it, vi } from "vitest";

vi.mock("../src/util.js", () => ({ sleep: vi.fn(async () => {}) }));

import {
  AuthenticationError, BadRequestError, CommandFailedError, NotFoundError, OxfordAPI, OxfordAPIError,
  RateLimitError, ServerOfflineError, VERSION,
} from "../src/index.js";
import { sleep } from "../src/util.js";
import { OK, TOP, client, ok } from "./helpers.js";

describe("setting up", () => {
  it("needs a server key", () => {
    expect(() => new OxfordAPI("")).toThrow(/serverKey is required/);
    expect(() => new OxfordAPI({} as any)).toThrow(/serverKey is required/);
  });

  it("sends the keys and a user agent", async () => {
    const { api, calls } = client([ok(TOP)], { appKey: "oxa_abc" });
    await api.getServer();
    expect(calls[0].headers.get("server-key")).toBe("sk_test");
    expect(calls[0].headers.get("authorization")).toBe("Bearer oxa_abc");
    expect(calls[0].headers.get("user-agent")).toBe(`oxrpy-js/${VERSION} (+https://github.com/BLK-TTAUDI/oxrpy-js)`);
  });

  it("leaves Authorization out without an app key", async () => {
    const { api, calls } = client([ok(TOP)]);
    await api.getServer();
    expect(calls[0].headers.has("authorization")).toBe(false);
  });

  it("validates rateLimit", () => {
    expect(() => new OxfordAPI({ serverKey: "k", rateLimit: "fast" as any })).toThrow(RangeError);
    expect(() => new OxfordAPI({ serverKey: "k", rateLimit: -1 })).toThrow(RangeError);
  });
});

describe("GET /v1/server", () => {
  it("asks for the new shape with no sections", async () => {
    const { api, calls } = client([ok(TOP)]);
    const data = await api.getServer();
    expect(calls[0].url.toString()).toBe("https://api.oxfd.re/v1/server?Players=false");
    expect(data.Online).toBe(true);
    expect(data.Server?.Name).toBe("Test RP");
  });

  it("builds parameters, fixing section case", async () => {
    const { api, calls } = client([ok({ ...TOP, Players: [] }, { ETag: 'W/"1"' })]);
    const data = await api.getServerData(["players", "EVENTS", "Bans"], {
      since: 88210, limit: 200, offset: 5, auditBefore: 9, auditCategory: ["Moderation", "Staff"], auditUser: "@amy",
    });
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      Players: "true", Events: "true", Bans: "true", Since: "88210", Limit: "200", Offset: "5",
      AuditBefore: "9", AuditCategory: "Moderation,Staff", AuditUser: "@amy",
    });
    expect(data?.etag).toBe('W/"1"');
    expect(Object.keys(data!)).not.toContain("etag"); // not mixed in with the data
  });

  it("resolves null on 304 Not Modified", async () => {
    const { api, calls } = client([{ status: 304 }]);
    expect(await api.getServerData(["Players"], { ifNoneMatch: 'W/"1"' })).toBeNull();
    expect(calls[0].headers.get("if-none-match")).toBe('W/"1"');
  });

  it("section helpers return the section", async () => {
    const { api, calls } = client([
      ok({ ...TOP, Players: [{ UserId: 1 }] }),
      ok({ ...TOP, Players: null, Online: false }),
      ok({ ...TOP, KillLogs: null }),
    ]);
    expect(await api.getPlayers()).toEqual([{ UserId: 1 }]);
    expect(await api.getPlayers()).toBeNull();
    expect(await api.getKillLogs({ since: 3 })).toEqual([]);
    expect(Object.fromEntries(calls[2].url.searchParams)).toEqual({ KillLogs: "true", Since: "3" });
  });

  it("iterBans pages through everything", async () => {
    const { api, calls } = client([
      ok({ ...TOP, Bans: { Total: 3, Offset: 0, List: [{ UserId: 1 }, { UserId: 2 }] } }),
      ok({ ...TOP, Bans: { Total: 3, Offset: 2, List: [{ UserId: 3 }] } }),
    ]);
    const ids: number[] = [];
    for await (const ban of api.iterBans(2)) ids.push(ban.UserId!);
    expect(ids).toEqual([1, 2, 3]);
    expect(calls[1].url.searchParams.get("Offset")).toBe("2");
  });

  it("caches the Catalogue", async () => {
    const { api, calls } = client([ok({ ...TOP, Catalogue: { Version: "1" } }), ok({ ...TOP, Catalogue: { Version: "2" } })]);
    expect(await api.getCatalogue()).toEqual({ Version: "1" });
    expect(await api.getCatalogue()).toEqual({ Version: "1" });
    expect(calls).toHaveLength(1);
    expect(await api.getCatalogue({ refresh: true })).toEqual({ Version: "2" });
  });

  it("checks the API status", async () => {
    const { api, calls } = client([ok({ Status: "operational" })]);
    expect((await api.getStatus()).Status).toBe("operational");
    expect(calls[0].url.toString()).toBe("https://api.oxfd.re/status");
  });
});

describe("errors", () => {
  it.each([
    [400, { message: "Unknown parameter: Player", ValidParameters: ["Players"] }, BadRequestError],
    [401, { message: "Missing required header: server-key" }, AuthenticationError],
    [403, { message: "Invalid API key" }, AuthenticationError],
    [404, { message: "No command with that id" }, NotFoundError],
    [503, { message: "Server is offline or unavailable", Code: "OFFLINE" }, ServerOfflineError],
  ])("maps %i to the right error", async (status, body, type) => {
    const { api } = client([{ status, body }], { maxRetries: 0 });
    const err = await api.getServerData(["Players"]).catch((e) => e);
    expect(err).toBeInstanceOf(type);
    expect(err).toBeInstanceOf(OxfordAPIError);
    expect(err.status).toBe(status);
    expect(err.apiMessage).toBe(body.message);
  });

  it("adds hints, and suggests section names", async () => {
    const { api } = client([
      { status: 403, body: { message: "Invalid API key" } },
      { status: 400, body: { message: "Unknown parameter: Player", ValidParameters: ["Players", "Vehicles"] } },
    ]);
    const auth = await api.getServer().catch((e) => e);
    expect(auth.hint).toMatch(/regenerated/);
    expect(auth.message).toMatch(/^403: Invalid API key \(hint: /);
    const bad = await api.getServerData(["Player"]).catch((e) => e);
    expect(bad.hint).toBe("Did you mean 'Players'?");
    expect(bad.validParameters).toEqual(["Players", "Vehicles"]);
  });
});

describe("retries", () => {
  it("waits Retry-After on 429 and tries again", async () => {
    vi.mocked(sleep).mockClear();
    const { api, calls } = client([{ status: 429, body: { message: "slow down" }, headers: { "Retry-After": "1" } }, ok(TOP)]);
    expect((await api.getServer()).Online).toBe(true);
    expect(calls).toHaveLength(2);
    expect(vi.mocked(sleep).mock.calls[0][0]).toBe(1000);
  });

  it("gives up after maxRetries", async () => {
    const rl = { status: 429, body: { message: "slow down", retryAfter: 2 } };
    const { api } = client([rl, rl], { maxRetries: 1 });
    const err = await api.getServer().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfter).toBe(2);
  });

  it("retries reads after network errors, never commands", async () => {
    const reads = client([new TypeError("fetch failed"), ok(TOP)]);
    expect((await reads.api.getServer()).Online).toBe(true);
    const cmds = client([new TypeError("fetch failed")]);
    await expect(cmds.api.runCommand("announce hi")).rejects.toThrow(/failed/);
    expect(cmds.calls).toHaveLength(1);
  });
});

describe("commands", () => {
  it("runCommand posts JSON and returns the result", async () => {
    const { api, calls } = client([ok(OK)]);
    expect(await api.runCommand(":kick x spam")).toEqual(OK);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/v1/server/command");
    expect(calls[0].body).toEqual({ command: ":kick x spam" });
    expect(calls[0].headers.get("content-type")).toBe("application/json");
  });

  it("check: true throws on a failed command", async () => {
    const failed = { CommandId: "c2", Status: "Failed", Code: "TARGET_NOT_FOUND", Message: "No one matches x" };
    const { api } = client([ok(failed)]);
    const err = await api.runCommand("kick x", { check: true }).catch((e) => e);
    expect(err).toBeInstanceOf(CommandFailedError);
    expect(err.code).toBe("TARGET_NOT_FOUND");
    expect(err.commandId).toBe("c2");
    expect(err.hint).toMatch(/user ID/);
  });

  it("batches up to 10", async () => {
    const { api, calls } = client([ok([OK, OK])]);
    expect(await api.runCommands(["weather rain", "lockweather"])).toHaveLength(2);
    expect(calls[0].body).toEqual({ commands: ["weather rain", "lockweather"] });
    await expect(api.runCommands(Array(11).fill("x"))).rejects.toThrow(RangeError);
    await expect(api.runCommands([])).rejects.toThrow(TypeError);
  });

  it("waitForCommand polls until it's done", async () => {
    const { api, calls } = client([ok({ Id: "c1", Status: "pending" }), ok({ Id: "c1", Status: "succeeded" })]);
    expect((await api.waitForCommand("c1")).Status).toBe("succeeded");
    expect(calls[0].url.pathname).toBe("/v1/server/commands/c1");
  });
});
