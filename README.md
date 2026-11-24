# oxrpy

A JavaScript and TypeScript wrapper for the
[Oxford Response private server API](https://docs.oxfd.re/). Use it to read what's happening on
your server and run commands on it from your own bot, website backend or tool. It's the
JavaScript version of [oxrpy for Python](https://github.com/BLK-TTAUDI/OXRPY), with the same
features.

**Full documentation: [oxrpy.org/js](https://oxrpy.org/js/)**

```
npm install oxrpy
```

You'll need Node.js 20.19 or newer (or Bun or Deno). It's fully typed, has no dependencies, and
works with both `import` and `require()`.

## Quick look

```js
import { OxfordAPI } from "oxrpy";

const api = new OxfordAPI(process.env.OXFD_SERVER_KEY);

for (const player of (await api.getPlayers()) ?? []) {
  console.log(player.Username, player.Team);
}

api.on("Kill", (kill) => {
  console.log(kill.KillerUsername, "downed", kill.VictimUsername);
});

await api.announce("Server restart in 5 minutes");
await api.runForever();
```

You'll need your server's API key, from **Server Management > External > API Key**, and the
server needs the **API package**. Keep the key private: anyone with it can run commands on your
server. oxrpy refuses to run in a web browser for this reason.

## Documentation

Everything is on **[oxrpy.org](https://oxrpy.org/js/)**:

- [Getting started](https://oxrpy.org/js/)
- [Reading data](https://oxrpy.org/js/reading-data/): players, vehicles, bans, settings and more
- [Events and logs](https://oxrpy.org/js/events/): react to kills, joins and other events
- [Commands](https://oxrpy.org/js/commands/): kick, ban, announce, change settings
- [Many servers](https://oxrpy.org/js/many-servers/): for bots lots of servers use
- [Maps and positions](https://oxrpy.org/js/map/)
- [Rate limits, errors and security](https://oxrpy.org/js/limits-and-errors/)
- [Command line](https://oxrpy.org/js/cli/) (`npx oxrpy status`) and [examples](https://oxrpy.org/js/examples/)
- [Cookbook](https://oxrpy.org/cookbook/): complete recipes, like a Discord kill feed
- [API reference](https://oxrpy.org/js/api/)

## Support

oxrpy is free to use. If it's saved you some time, you can
[buy me a coffee](https://buymeacoffee.com/blk_ttaudi) to help keep it going.

## License

Proprietary. See the [LICENSE](https://github.com/BLK-TTAUDI/oxrpy-js/blob/main/LICENSE) file.
