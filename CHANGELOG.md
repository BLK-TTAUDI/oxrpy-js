# Changelog

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
