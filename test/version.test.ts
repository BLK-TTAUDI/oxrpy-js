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

it("README points to the docs site", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  expect(readme).toContain("https://oxrpy.org");
  expect(readme).not.toContain("--8<--"); // the docs site no longer pulls sections from here
});
