// Release a new version of oxrpy-js in one step.
//
//   node scripts/release.mjs 0.4.0            # check everything, bump the version, commit and tag
//   node scripts/release.mjs 0.4.0 --push     # ...then push, which publishes to npm, and add the
//                                             # GitHub release page (needs the gh CLI)
//
// Before running it, put the release notes under "## Unreleased" at the top of CHANGELOG.md. It:
//
// 1. checks you're on main with nothing uncommitted, the version is newer than the last one, and
//    the shared test data still matches the Python wrapper's
// 2. sets the version in package.json, package-lock.json and src/constants.ts, and renames
//    "## Unreleased" to "## 0.4.0" in the changelog
// 3. type-checks, runs the tests (with coverage) and builds
// 4. commits ("0.4.0") and tags (v0.4.0)
//
// If any check fails, nothing is committed: fix it, `git checkout -- .` to undo the bump, and run
// it again. Pushing the tag is what publishes: GitHub Actions tests it again and uploads to npm.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const file = (path) => new URL(path, root);
// Windows checkouts can have CRLF line endings; work in LF (git converts them back as set up).
const read = (path) => readFileSync(file(path), "utf8").replace(/\r\n/g, "\n");
const write = (path, text) => writeFileSync(file(path), text);

function stop(message) {
  console.error(message);
  process.exit(1);
}

function run(cmd, args, { capture = false } = {}) {
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  // npm is npm.cmd on Windows, which needs a shell (the others don't, and their arguments have spaces)
  const shell = process.platform === "win32" && cmd === "npm";
  const result = spawnSync(cmd, args, { cwd: root, encoding: "utf8", stdio: capture ? "pipe" : "inherit", shell });
  if (result.status !== 0) {
    if (capture) console.error(result.stdout, result.stderr);
    stop(`Stopped: ${cmd} ${args.join(" ")} failed`);
  }
  return capture ? result.stdout : "";
}

const parse = (v) => {
  if (!/^\d+\.\d+\.\d+$/.test(v)) stop(`'${v}' isn't a version like 0.4.0`);
  return v.split(".").map(Number);
};
const newer = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

const args = process.argv.slice(2);
const push = args.includes("--push");
const version = args.find((a) => !a.startsWith("--"))?.replace(/^v/, "");
if (!version) stop("Usage: node scripts/release.mjs 0.4.0 [--push]");

console.log("Checking");
const current = JSON.parse(read("package.json")).version;
if (!newer(parse(version), parse(current))) stop(`${version} isn't newer than the current ${current}`);
if (run("git", ["status", "--porcelain"], { capture: true }).trim()) stop("There are uncommitted changes: commit or stash them first");
const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { capture: true }).trim();
if (branch !== "main") stop(`You're on '${branch}': release from main`);
if (run("git", ["tag", "--list", `v${version}`], { capture: true }).trim()) stop(`v${version} is already tagged`);
const changelog = read("CHANGELOG.md");
const unreleased = changelog.match(/^## Unreleased\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
if (!unreleased || !unreleased[1].trim()) stop('Put the release notes under "## Unreleased" at the top of CHANGELOG.md first');
run("node", ["scripts/sync-fixtures.mjs", "--check"]);

console.log(`Bumping ${current} -> ${version}`);
run("npm", ["version", version, "--no-git-tag-version", "--allow-same-version"], { capture: true });
const constants = read("src/constants.ts");
if (!/export const VERSION = "[^"]+";/.test(constants)) stop("No VERSION in src/constants.ts");
write("src/constants.ts", constants.replace(/export const VERSION = "[^"]+";/, `export const VERSION = "${version}";`));
write("CHANGELOG.md", changelog.replace("## Unreleased\n", `## ${version}\n`));

console.log("Testing");
run("npm", ["run", "typecheck"]);
run("npm", ["run", "coverage"]);
run("npm", ["run", "build"]);

console.log("Committing");
run("git", ["add", "package.json", "package-lock.json", "src/constants.ts", "CHANGELOG.md"]);
run("git", ["commit", "-m", version]);
run("git", ["tag", "-a", `v${version}`, "-m", `oxrpy-js ${version}`]);

if (!push) {
  console.log(`\nReady. To publish: git push origin main v${version}`);
  console.log("(or run this again with --push next time)");
  process.exit(0);
}
console.log("Pushing (GitHub Actions tests it again and publishes to npm)");
run("git", ["push", "origin", "main", `v${version}`]);
let hasGh = true;
try {
  execFileSync("gh", ["--version"], { stdio: "ignore" });
} catch {
  hasGh = false;
}
if (hasGh) {
  // This version's section: from its heading to the next one (plain text search, no regex built from input)
  const text = read("CHANGELOG.md");
  const heading = `## ${version}\n`;
  const start = text.indexOf(heading);
  const next = start === -1 ? -1 : text.indexOf("\n## ", start + heading.length);
  const section = start === -1 ? null : [null, text.slice(start + heading.length, next === -1 ? undefined : next)];
  const notesPath = ".release-notes.md";
  write(notesPath, `${section ? section[1].trim() : ""}\n\n\`\`\`\nnpm install oxrpy@${version}\n\`\`\`\n`);
  try {
    run("gh", ["release", "create", `v${version}`, "--title", `V${version}`, "--notes-file", notesPath]);
  } finally {
    unlinkSync(file(notesPath));
  }
} else {
  console.log("No gh CLI, so add the release page on GitHub yourself");
}
console.log(`\nDone: v${version} is on its way to npm. Watch it at https://github.com/BLK-TTAUDI/oxrpy-js/actions`);
