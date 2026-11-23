/**
 * Print who joins and leaves, every kill, and the server going up or down. No Discord needed.
 *
 * Run it:
 *   npm install oxrpy
 *   set OXFD_SERVER_KEY      (PowerShell: $env:OXFD_SERVER_KEY = "your-key")
 *   node join-leave-log.mjs
 */

import { OxfordAPI } from "oxrpy";

const api = new OxfordAPI(process.env.OXFD_SERVER_KEY);
const time = (entry) => new Date(entry.At * 1000).toLocaleTimeString();

api.on("Join", (entry) => console.log(`${time(entry)}  + ${entry.Username} joined`));
api.on("Leave", (entry) => console.log(`${time(entry)}  - ${entry.Username} left`));
api.on("Kill", (kill) => console.log(`${time(kill)}  x ${kill.KillerUsername} downed ${kill.VictimUsername} with ${kill.Weapon ?? "unknown weapon"}`));
api.on("ServerOffline", () => console.log("The server went offline"));
api.on("ServerOnline", () => console.log("The server is back online"));

process.on("SIGINT", () => api.stop());
console.log("Watching the server. Press Ctrl+C to stop.");
await api.runForever();
