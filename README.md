# oxrpy

**Documentation: [oxrpy.org](https://oxrpy.org)**

<!-- --8<-- [start:intro] -->
A JavaScript and TypeScript wrapper for the
[Oxford Response private server API](https://docs.oxfd.re/). Use it to read what's happening on
your server and run commands on it from your own bot, website backend or tool. It's the
JavaScript version of [oxrpy for Python](https://pypi.org/project/oxrpy/), with the same features.

```
npm install oxrpy
```

You'll need Node.js 20.19 or newer (or Bun or Deno). It has no dependencies, and it works with
both `import` and `require()`.

<!-- --8<-- [end:intro] -->
<!-- --8<-- [start:getting-started] -->
## Getting started

You'll need your server's API key. The server owner can find it in **Server Management >
External > API Key**, and the server needs the **API package**.

```js
import { OxfordAPI } from "oxrpy";

const api = new OxfordAPI(process.env.OXFD_SERVER_KEY);

// Grab a few sections in one request
const data = await api.getServerData(["Players", "Vehicles", "Robberies"]);
console.log(data.Server.Name, "online:", data.Online);

for (const player of data.Players ?? []) {   // null if the server's offline
  console.log(player.Username, player.Team, player.Location);
}

// Or just ask for one thing
const players = await api.getPlayers();

// Run a command
await api.announce("Server restart in 5 minutes");
await api.ban("m4tty_b", "Combat logging", "7d");
```

Keep your key private. Anyone who has it can run commands on your server, change its settings
and ban people. Keep it on your own machine or bot. oxrpy refuses to run in a web browser for
this reason: a key in website code can be read by anyone.

<!-- --8<-- [end:getting-started] -->
<!-- --8<-- [start:reading-data] -->
## Reading data

`getServerData()` asks for any mix of sections in one request (names aren't case-sensitive).
`Online`, `LastHeartbeat`, `NextHeartbeat`, `Cursor` and `Server` always come back.

| Kind | Sections |
| --- | --- |
| Live | `Players`, `Tracks`, `Vehicles`, `World`, `Teams`, `Queue`, `Robberies`, `Atms`, `Incidents`, `Fires`, `Medical`, `Trees`, `TrafficLights`, `Doors`, `Radio`, `Jobs`, `Bounties`, `Economy`, `Trailers`, `Placeables`, `PlaceablesSummary` |
| Server | `Staff`, `Groups`, `Bans`, `Settings`, `Catalogue` |
| Logs | `KillLogs`, `ModCalls`, `RadioCalls`, `JoinLogs`, `Events`, `CommandLogs`, `CommandResults`, `Shots`, `Audit` |

```js
const data = await api.getServerData(["Events", "KillLogs"], { since: cursor, limit: 200 });

for await (const ban of api.iterBans()) { /* every ban, page by page */ }
for await (const entry of api.iterAudit({ category: "Moderation" })) { /* the whole audit log */ }
```

There's a helper for each section too: `getPlayers`, `getVehicles`, `getWorld`, `getTeams`,
`getQueue`, `getRobberies`, `getAtms`, `getIncidents`, `getStaff`, `getGroups`, `getBans`,
`getSettings`, `getCatalogue`, `getKillLogs`, `getModCalls`, `getRadioCalls`, `getJoinLogs`,
`getEvents`, `getCommandLogs`, `getCommandResults`, `getShots`, `getAudit`, `getServer` and
`isOnline`. Each one is a request, and a server key only gets one `GET /v1/server` a second, so
ask for several sections at once when you can. `getCatalogue()` is kept for an hour, so repeat
calls are free.

### Live data without extra requests

Every response updates `api.latest`, which holds the newest copy of each live section:

```js
api.latest.players          // undefined if never fetched, null while offline
api.latest.online
api.latest.age("Players")   // seconds since it arrived
```

Keep `runForever({ sections: ["Players"] })` going and your bot can answer "who's online?"
from `api.latest` instantly, without using up requests.

### Finding players and vehicles

These match the way Oxford's commands do: username or display name (any case), then user ID,
then part of a name. They use `api.latest` when it's under 2 seconds old.

```js
await api.findPlayer("kieran");        // one player, or undefined
await api.playersOnTeam("Police");
await api.staffOnline();
await api.findVehicle("rj75flk");      // by plate (spaces and case don't matter) or owner
```

If a name matches several people, `findPlayer` throws `AmbiguousMatchError`, with `.matches`.

<!-- --8<-- [end:reading-data] -->
<!-- --8<-- [start:events] -->
## Reacting to events

```js
api.on("Kill", (kill) => {
  console.log(`${kill.KillerUsername} downed ${kill.VictimUsername} with ${kill.Weapon}`);
});

api.on(["Join", "Leave"], (entry) => console.log(entry.Username, entry.Type));

api.on("SpeedCamera", async (event) => {
  if (event.SpeedMph > event.Limit + 30) await api.pm(event.UserId, "Slow down!");
});

api.on("ServerOffline", () => console.log("The server went offline"));

await api.runForever({ saveTo: "cursor.json" });
```

- **What you can listen for:**
  - any entry type (`Kill`, `ModCall`, `Join`, `Leave`, `Command`, `Shot`, or any of
    [the game events](https://docs.oxfd.re/#events));
  - a whole log (`"KillLogs"`);
  - `"poll"`, after every request;
  - `"error"`, when a request fails and is retried;
  - `"ServerOnline"`, `"ServerOffline"` and `"ServerRestart"`.
- **Typed handlers:** in TypeScript the handler's argument is typed for you (a `KillLog` for
  `"Kill"`), so editors autocomplete it and catch typos.
- **Order and startup:** entries arrive oldest first, and what was already in the logs at
  startup is skipped.
- **Errors don't stop it:** a handler that throws is logged and the bot carries on. Network
  problems and API hiccups are retried, waiting longer each time, up to a minute. A wrong key
  stops it with an error.
- **`saveTo` remembers where it got to,** in a file or your own `{ load, save }` store. After a
  restart it carries on exactly there, without missing or repeating anything.
- **Stopping:** call `api.stop()`, or pass a `signal`, to end `runForever()`.

To loop yourself:

```js
for await (const { data, fresh } of api.follow(["Events", "KillLogs"])) {
  for (const kill of fresh.KillLogs) console.log(kill.Weapon);
}
```

<!-- --8<-- [end:events] -->
<!-- --8<-- [start:commands] -->
## Running commands

```js
await api.runCommand(":kick dxrkrider Exploiting");             // returns { Status, Code, Message }
await api.runCommands(["weather rain", "lockweather"]);         // up to 10 in one request
await api.runMany(listOfManyCommands);                           // any number, paced for the game
```

A command can come back without an error and still have failed, so check `Status`, or use the
helpers. They check your arguments first, and throw `CommandFailedError` if the command didn't
work (pass `{ check: false }` to get the result instead):

- **Moderation:** `kick`, `ban`, `unban`, `jail`, `release`, `wanted`, `pm` and
  `resolveModcall`.
- **Staff:** `rank`, `unrank`, `groupAdd` and `groupRemove`.
- **Players and vehicles:** `setTeam`, `respawn`, `revive`, `teleport`, `teleportToVehicle`,
  `setInvincible`, `give`, `despawnVehicle`, `removeVehicle`, `spawnVehicle`, `repair` and
  `refuel`.
- **World:** `setTime`, `lockTime`, `setWeather`, `lockWeather`, `announce`, `teamAnnounce`,
  `alert`, `setMessage`, `removeMessage`, `countdown` and `speedLimit`.
- **Control room:** `createIncident`, `assignIncident`, `closeIncident`, `radio`,
  `startCallout`, `ambulanceCallout`, `listCallouts` and `stopFires`.
- **Server:** `setSetting`, `newJoinCode`, `queueRemove`, `queueFront`, `clearPlaceables` and
  `shutdown`.

The same command text is available without a client, as `commands.ban("x", "RDM", "7d")`.

### Changing part of a setting

Oxford replaces a list or object setting with exactly what you send, so sending one custom
vehicle would wipe the other 149. `updateSetting` reads the current value first:

```js
await api.updateSetting("CustomVehicles", (cars) => [...cars, newCar]);
await api.updateSetting("TeamLimits", (limits) => { limits.Police = 8; });
```

Nothing is sent if nothing changed. Misspelled names get suggestions, and webhook settings are
refused (the API never shows their real value, so it can't be read back).

### Keeping staff and groups in sync

```js
await api.syncStaff({ 81234401: "Mod", 81239912: "Senior Moderator", 77001200: null });
await api.syncGroup("CID", [81234401, 81239912]);
console.log(await api.planStaffSync({ 81234401: "Admin" }));   // see the changes first
```

Only the changes are sent. Users are identified by Roblox user ID, and the owner is never
touched.

<!-- --8<-- [end:commands] -->
<!-- --8<-- [start:many-servers] -->
## Many servers in one app

If you're building something lots of servers use (a Discord bot, a CAD, a dashboard), each
server's owner gives your app their server key. `ServerPool` follows all of them with one set of
handlers, and shares Oxford's rate limits between them fairly:

```js
import { ServerPool } from "oxrpy";

const pool = new ServerPool({ appKey: process.env.OXFD_APP_KEY });   // app key optional

// When someone links their server (a /link command, say), check the key first.
const info = await pool.verify(serverKey);   // AuthenticationError if it's wrong
pool.add("guild-1234", serverKey);           // followed straight away if the pool's running
console.log(`Linked to ${info.Name}`);

pool.on("Kill", (server, kill) => postToGuild(server, kill));   // the server's name comes first
pool.on("error", (server, err) => tellGuild(server, `Lost touch with your server: ${err.message}`));

await pool.runForever({ sections: ["Players"], saveDir: "positions" });
```

- **Fair turns:** when there's more to check than the limit allows, servers take turns, so none
  is left behind. Busy servers are checked more often than quiet and empty ones (which wait up to
  5 seconds, or `maxIdle`).
- **Your own requests first:** requests you make yourself, like a `/players` command's, go ahead
  of background polling, so they stay quick however many servers the pool follows.
  `pool.each()` and `pool.runCommandOnAll()` wait behind them too.
- **Reuse what the pool already has:** with `sections: ["Players"]` every poll brings the player
  list too, so `await pool.get("guild-1234").getPlayers({ maxAge: 10 })` answers without a
  request. Every live helper takes `maxAge`.
- **Bad keys don't spread:** a server whose key stops working is dropped, reported to your
  `error` handler and listed in `pool.failed`. The others carry on. When the owner gives you a
  new key, `await pool.updateKey("guild-1234", newKey)` carries on from where it stopped.
- **Add and remove while running:** `pool.add()` and `await pool.remove()` work at any time.
- **Restarts don't miss anything:** `saveDir` keeps each server's place in its logs.
- **Custom limits just work:** with an app key, the pool follows the limits Oxford reports, so a
  higher tier needs no settings.
- **See how it's keeping up:** `pool.stats` has overall figures and each server's:

```js
const stats = pool.stats;
console.log(`${stats.following} servers, each updated about every ${stats.averageInterval?.toFixed(1)}s`);
console.log(stats.perServer["guild-1234"].interval, stats.readLimit, stats.waiting);
```

### How many servers can one app follow?

Every request from one IP address counts towards Oxford's limit of 30 a second, whatever the key.
With an app key, your app's own limit (20 a second on the standard tier) is shared by every
server too. Each server needs one request per check, so the more servers, the longer each waits
for its turn:

| Servers | Each one checked about every (no app key) | (standard app key) |
| --- | --- | --- |
| up to 30 | 1 to 5 seconds, as often as it's useful | 1.5 to 5 seconds |
| 100 | 3.5 seconds | 5 seconds |
| 300 | 10 seconds | 15 seconds |
| 1,000 | 35 seconds | 50 seconds |

Nothing is missed when it's slower: each check picks up everything since the last one. It just
arrives later. `pool.stats` shows the real figures for your app.

To go further, ask Oxford Roleplay for an app key with higher limits (the pool picks them up by
itself), or run your app on more than one IP address, each with its own share of the servers.
An Unlimited app key isn't held to the per-IP limit: pass `rateLimit: "none"` to turn pacing off.

<!-- --8<-- [end:many-servers] -->
<!-- --8<-- [start:map] -->
## Maps and positions

```js
import { map } from "oxrpy";

map.toPixels(player.Position, { width: 1630, height: 1260 });   // on Oxford's map image
map.fromPixels(800, 600, { width: 1630, height: 1260 });         // a click → [x, z]
map.distance(a.Position, b.Position);
```

<!-- --8<-- [end:map] -->
<!-- --8<-- [start:limits-and-errors] -->
## Rate limits and errors

oxrpy paces requests to Oxford's limits (one `GET /v1/server` a second with a server key) and
waits and retries on a 429. `api.rateLimitStatus` shows Oxford's latest figures, and
`api.onRequest(info => ...)` is called after every request, for logging and metrics.

Errors are `OxfordAPIError` or one of its subclasses: `AuthenticationError`, `BadRequestError`,
`NotFoundError`, `RateLimitError`, `ServerOfflineError` and `CommandFailedError`. Each has
`.status`, `.code`, `.apiMessage` and, where there's an obvious fix, a `.hint`, for example:
*"403: Invalid API key (hint: Check the key in Server Management > External > API Key…)"*.

<!-- --8<-- [end:limits-and-errors] -->
<!-- --8<-- [start:cli] -->
## From the command line

oxrpy comes with an `oxrpy` command for quick checks. Run it with `npx`, no install needed:

```
npx oxrpy status       # is the Oxford API up? (no key needed)
npx oxrpy server       # your server's name, player count, join code and packages
npx oxrpy players      # who's in your server
```

`server` and `players` read your key from the `OXFD_SERVER_KEY` environment variable. Add
`--json` to any of them to get the raw data.

<!-- --8<-- [end:cli] -->
<!-- --8<-- [start:examples] -->
## Examples

The [examples folder](https://github.com/BLK-TTAUDI/oxrpy-js/tree/main/examples) has scripts you
can copy and run:

- [discord-kill-feed.mjs](https://github.com/BLK-TTAUDI/oxrpy-js/blob/main/examples/discord-kill-feed.mjs)
  is a discord.js bot that posts kills to a channel and answers `!players`.
- [discord-server-status.mjs](https://github.com/BLK-TTAUDI/oxrpy-js/blob/main/examples/discord-server-status.mjs)
  is a discord.js bot that posts when the server goes offline, comes back or restarts, and shows
  the player count as its status.
- [join-leave-log.mjs](https://github.com/BLK-TTAUDI/oxrpy-js/blob/main/examples/join-leave-log.mjs)
  prints joins, leaves, kills and the server going up or down. No Discord needed.
- [sync-staff-from-list.mjs](https://github.com/BLK-TTAUDI/oxrpy-js/blob/main/examples/sync-staff-from-list.mjs)
  keeps staff ranks matching a list, and shows you the changes before making them.

<!-- --8<-- [end:examples] -->
<!-- --8<-- [start:security] -->
## Security

- **Redirects are never followed,** so your key can't be sent to another site.
- **HTTPS only:** the key is never sent unencrypted (plain `http://` is only allowed to
  `localhost`, for testing).
- **No running in a web browser** unless you pass `allowBrowser: true`.
- **No dependencies,** so nothing extra comes along when you install it.

<!-- --8<-- [end:security] -->
## Support

oxrpy is free to use. If it's saved you some time, you can
[buy me a coffee](https://buymeacoffee.com/blk_ttaudi) to help keep it going.

<!-- --8<-- [start:license] -->
## License

Proprietary. See the [LICENSE](https://github.com/BLK-TTAUDI/oxrpy-js/blob/main/LICENSE) file.
<!-- --8<-- [end:license] -->
