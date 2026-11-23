/**
 * A Discord bot that posts when your server goes offline, comes back or restarts, and shows the
 * player count as its status.
 *
 * Run it:
 *   npm install oxrpy discord.js
 *   set OXFD_SERVER_KEY, DISCORD_TOKEN and STATUS_CHANNEL_ID
 *   node discord-server-status.mjs
 */

import { ActivityType, Client, Events, GatewayIntentBits } from "discord.js";
import { OxfordAPI } from "oxrpy";

const api = new OxfordAPI(process.env.OXFD_SERVER_KEY);
const bot = new Client({ intents: [GatewayIntentBits.Guilds] });

async function post(text) {
  const channel = await bot.channels.fetch(process.env.STATUS_CHANNEL_ID);
  if (channel?.isSendable()) await channel.send(text);
}

api.on("ServerOnline", (data) => post(`🟢 **${data.Server?.Name}** is back online`));
api.on("ServerOffline", () => post("🔴 The server is offline"));
api.on("ServerRestart", () => post("🔄 The server restarted"));

let lastCount;
api.on("poll", (data) => {
  // After every check: keep the bot's status showing the player count.
  const count = data.Online ? `${data.Server?.CurrentPlayers ?? 0}/${data.Server?.MaxPlayers ?? "?"}` : "offline";
  if (count !== lastCount && bot.isReady()) {
    lastCount = count;
    bot.user.setActivity(`Oxford RP: ${count}`, { type: ActivityType.Watching });
  }
});

bot.once(Events.ClientReady, () => {
  console.log(`Logged in as ${bot.user.tag}`);
  api.runForever().catch(console.error);
});

await bot.login(process.env.DISCORD_TOKEN);
