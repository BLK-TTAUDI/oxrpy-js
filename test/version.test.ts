import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { VERSION } from "../src/index.js";

it("the version constant matches package.json", () => {
  expect(VERSION).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
});

it("README links work on npm (absolute URLs only)", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const relative = [...readme.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]).filter((l) => !/^(https?:|#)/.test(l));
  expect(relative).toEqual([]);
});

it("README sections for the docs site are intact", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const starts = [...readme.matchAll(/<!-- --8<-- \[start:([a-z-]+)\] -->/g)].map((m) => m[1]);
  const ends = [...readme.matchAll(/<!-- --8<-- \[end:([a-z-]+)\] -->/g)].map((m) => m[1]);
  expect(starts.length).toBeGreaterThan(0);
  expect(ends).toEqual(starts);
  for (const needed of ["intro", "getting-started", "reading-data", "events", "commands", "many-servers", "map"]) {
    expect(starts).toContain(needed);
  }
});
