# Changelog

## 0.4.0

Nothing in this release should break existing code.

- **Outages handled together:** when Oxford's API itself goes down, `ServerPool` notices
  (most servers failing at once), holds every server's polling back, and checks with one request
  at a time (after 2s, then 4, 8... up to a minute). The first answer lets everyone carry on
  straight away. `pool.stats.apiDown` shows when it's waiting. Before, every server retried on
  its own, and could take up to a minute after the API came back to notice.
- **Lighter start:** the first poll of `runForever` (and the pool) only asks for the newest
  entry of each log when what's there would be skipped anyway. Much less to download when an
  app starts up with hundreds of servers. A `"poll"` handler sees just that one entry per log on
  the first poll.
- **Background polls report failures straight away**, rather than retrying inside the request
  first; the poll loop does the retrying.
- **Faster bookkeeping** for large pools: request counts and the JavaScript version's queues no
  longer slow down with thousands of servers.
- `scripts/release.mjs`: one command to check, bump, test, commit, tag and publish a release.

## 0.3.0

Nothing in this release should break existing code.

### For apps that follow many servers

- **Fair turns:** `ServerPool` shares the rate limit between servers in turn, instead of
  every server racing for each free slot. Nobody's left behind, however many servers there are.
- **Your own requests first:** requests you make yourself (a Discord command's lookup) go ahead
  of background polling, with a single client too. `pool.each()` and
  `pool.runCommandOnAll()` wait behind them.
- **`pool.stats`:** how the pool is keeping up, overall and per server (`PoolStats`,
  `ServerStats`), including how often each server is really being checked.
- **`pool.verify(key)`:** checks a server key (for a `/link` command) and returns the server's
  details, without adding it.
- **`pool.updateKey(name, key)`:** swaps in a new key and carries on where it stopped.
- **Limits that follow Oxford:** with an app key, the limits Oxford reports are used, so custom
  tiers work without settings.
- **`{ maxAge }` on every live helper** (`getPlayers`, `getVehicles`, `getStaff`...): answers
  from `api.latest` without a request when it's that fresh.
- **Quick shutdown:** stopping a pool stops every server at once, and polls still waiting for
  their turn are dropped instead of being sent first.

## 0.2.0

Nothing in this release should break existing code.

- **The `oxrpy` command:** `npx oxrpy status`, `npx oxrpy server` and `npx oxrpy players`, with
  `--json` for the raw data. The same commands as the Python version's `oxrpy`.
- **Examples:** ready-to-run discord.js bots (a kill feed with `!players`, and server
  status), a join/leave log, and a staff sync. They're checked against discord.js and oxrpy
  itself, so they keep working.
- **Shared tests with the Python version:** both wrappers now run the same set of sample API
  responses and expected results, so they can't drift apart.

## 0.1.0

The first release: the JavaScript and TypeScript version of
[oxrpy for Python](https://pypi.org/project/oxrpy/), with the same features.

- Every section of `GET /v1/server`, with a helper for each, plus `iterBans()` and `iterAudit()`.
- Every command, with helpers that check their arguments, `runCommands()` for batches and
  `runMany()` for long lists paced to the game's limit.
- Events with typed handlers (`api.on("Kill", kill => ...)`), `runForever()` and `follow()`,
  which keep going through errors and can save their position across restarts.
- `api.latest`, `findPlayer()`, `playersOnTeam()`, `staffOnline()` and `findVehicle()`.
- `updateSetting()`, which changes part of a setting without wiping the rest.
- Staff and group sync, map helpers, and `ServerPool` for apps used by many servers.
- Rate limiting that matches Oxford's limits, request hooks, and errors with hints.
- Security: no redirects, HTTPS only, and no running in a web browser by default.
