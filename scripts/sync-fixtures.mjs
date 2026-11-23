// Keeps test/fixtures/ an exact copy of fixtures/ in the Python wrapper (BLK-TTAUDI/OXRPY), the
// shared contract both test suites run.
//
//   node scripts/sync-fixtures.mjs           # copy the latest from OXRPY's main branch
//   node scripts/sync-fixtures.mjs --check   # exit 1 if the copy differs (used in CI)

import { readdir, readFile, writeFile } from "node:fs/promises";

const REPO = "BLK-TTAUDI/OXRPY";
const DIR = new URL("../test/fixtures/", import.meta.url);
const check = process.argv.includes("--check");

// GitHub limits anonymous API calls per IP, and CI runners share IPs, so use a token when there is one.
const headers = { Accept: "application/vnd.github+json", "User-Agent": "oxrpy-js-fixtures" };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const listing = await fetch(`https://api.github.com/repos/${REPO}/contents/fixtures?ref=main`, { headers });
if (!listing.ok) throw new Error(`Couldn't list ${REPO}/fixtures: HTTP ${listing.status}`);
const files = (await listing.json()).filter((f) => f.type === "file" && f.name.endsWith(".json"));

const problems = [];
for (const file of files) {
  const upstream = await (await fetch(file.download_url)).text();
  let local = null;
  try {
    local = await readFile(new URL(file.name, DIR), "utf8");
  } catch {}
  // Compare the data, not the bytes, so line endings never matter.
  const same = local !== null && JSON.stringify(JSON.parse(local)) === JSON.stringify(JSON.parse(upstream));
  if (same) continue;
  if (check) problems.push(`${file.name} ${local === null ? "is missing" : "differs"}`);
  else {
    await writeFile(new URL(file.name, DIR), upstream);
    console.log(`Updated ${file.name}`);
  }
}
const extra = (await readdir(DIR)).filter((n) => n.endsWith(".json") && !files.some((f) => f.name === n));
if (extra.length) problems.push(`not in ${REPO}: ${extra.join(", ")}`);

if (problems.length) {
  console.error(`test/fixtures/ doesn't match ${REPO}/fixtures:\n  ${problems.join("\n  ")}\nRun: npm run fixtures`);
  process.exit(1);
}
console.log(check ? `test/fixtures/ matches ${REPO}/fixtures (${files.length} files)` : "Fixtures up to date");
