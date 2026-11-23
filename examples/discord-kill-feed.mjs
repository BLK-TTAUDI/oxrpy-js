/**
 * A Discord bot that posts kills to a channel and answers "!players".
 *
 * Run it:
 *   npm install oxrpy discord.js
 *   set OXFD_SERVER_KEY, DISCORD_TOKEN and KILL_FEED_CHANNEL_ID
 *   node discord-kill-feed.mjs
 *
 * Turn on the Message Content intent for your bot in the Discord developer portal, for !players.
 */

import { Client, Events, GatewayIntentBits } from "discord.js";
import { OxfordAPI } from "oxrpy";

const api = new OxfordAPI(process.env.OXFD_SERVER_KEY);
const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

api.on("Kill", async (kill) => {
  const channel = await bot.channels.fetch(process.env.KILL_FEED_CHANNEL_ID);
  const headshot = kill.Headshot ? " (headshot)" : "";
  if (!channel?.isSendable()) return; // wrong ID, or not a text channel
  await channel.send(`**${kill.KillerUsername}** downed **${kill.VictimUsername}** with ${kill.Weapon ?? "unknown weapon"}${headshot}`);
});

bot.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.content.trim() !== "!players") return;
  const players = await api.getPlayers();
  if (players === null) {
    await message.reply("The server is offline.");
    return;
  }
  const teams = {};
  for (const p of players) (teams[p.Team ?? "Unknown"] ??= []).push(p);
  const lines = [`**${players.length} players online**`];
  for (const [team, members] of Object.entries(teams)) {
    lines.push(`${team} (${members.length}): ${members.map((p) => p.Username).sort().join(", ")}`);
  }
  await message.reply(lines.join("\n").slice(0, 2000));
});

bot.once(Events.ClientReady, () => {
  console.log(`Logged in as ${bot.user.tag}`);
  // Remembers where it got to, so a restart doesn't miss any kills.
  api.runForever({ saveTo: "kill-feed-position.json" }).catch(console.error);
});

await bot.login(process.env.DISCORD_TOKEN);
