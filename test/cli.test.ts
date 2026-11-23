import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { OxfordAPI } from "../src/index.js";
import { TOP, fakeFetch, ok } from "./helpers.js";

function run(argv: string[], replies: Parameters<typeof fakeFetch>[0], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const { fetch } = fakeFetch(replies);
  const code = main(argv, {
    out: (l) => out.push(l), err: (l) => err.push(l), env,
    makeApi: (key) => new OxfordAPI({ serverKey: key, rateLimit: "none", maxRetries: 0, fetch }),
  });
  return code.then((c) => ({ code: c, out: out.join("\n"), err: err.join("\n") }));
}

describe("oxrpy command", () => {
  it("status needs no key", async () => {
    const r = await run(["status"], [ok({ Status: "operational", UptimeSeconds: 90061, LastHour: { P50Ms: 4, P95Ms: 19 }, Uptime: { Windows: { "24h": 100 } } })]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("operational");
    expect(r.out).toContain("1d 1h 1m");
    expect(r.out).toContain("24h 100%");
  });

  it("players needs a key", async () => {
    const r = await run(["players"], []);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/OXFD_SERVER_KEY/);
  });

  it("lists players", async () => {
    const players = [
      { Username: "kieran_rd", Team: "Police", Location: { Area: "Oxford Bank" }, Rank: "Mod" },
      { Username: "amy", Team: "Civilian", Location: null },
    ];
    const r = await run(["players"], [ok({ ...TOP, Players: players })], { OXFD_SERVER_KEY: "k" });
    expect(r.out).toContain("kieran_rd");
    expect(r.out).toContain("[Mod]");
    expect(r.out).toContain("2 players");
  });

  it("--json prints raw data, --key overrides the environment", async () => {
    const r = await run(["server", "--json", "--key", "abc"], [ok(TOP)]);
    expect(JSON.parse(r.out).Server.Name).toBe("Test RP");
  });

  it("reports API errors with hints", async () => {
    const r = await run(["server", "--key", "bad"], [{ status: 403, body: { message: "Invalid API key" } }]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Invalid API key \(hint:/);
  });

  it("shows help for unknown commands", async () => {
    const r = await run(["nope"], []);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/Usage: oxrpy/);
  });
});

it("the examples are valid JavaScript", () => {
  const dir = fileURLToPath(new URL("../examples/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".mjs"));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) execFileSync(process.execPath, ["--check", dir + file]);
  for (const file of files) expect(readFileSync(dir + file, "utf8")).toContain('from "oxrpy"');
});
