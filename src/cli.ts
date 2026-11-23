#!/usr/bin/env node
/**
 * A small command-line tool: `npx oxrpy status`, `npx oxrpy server`, `npx oxrpy players`.
 * Commands that read your server need your key in OXFD_SERVER_KEY (or --key, though that can end
 * up in your shell history).
 */

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OxfordAPI } from "./client.js";
import { VERSION } from "./constants.js";
import { OxfordAPIError } from "./errors.js";

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  /** Builds the client (tests swap in a fake). */
  makeApi?: (key: string) => OxfordAPI;
}

const HELP = `oxrpy ${VERSION}: the Oxford Response API from the command line.

Usage: oxrpy <command> [--key KEY] [--json]

Commands:
  status     Is the Oxford API up? (no key needed)
  server     Your server's name, players, join code and packages
  players    Who's in your server

Options:
  --key KEY  Your server's API key (defaults to the OXFD_SERVER_KEY environment variable)
  --json     Print the raw JSON
  --version  Print the version
  --help     Show this help`;

function ago(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "unknown";
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(" ");
}

export async function main(argv: string[], io: CliIO): Promise<number> {
  const args = [...argv];
  const json = args.includes("--json");
  if (args.includes("--version")) { io.out(`oxrpy ${VERSION}`); return 0; }
  const keyAt = args.indexOf("--key");
  const key = keyAt >= 0 ? args[keyAt + 1] : io.env.OXFD_SERVER_KEY;
  const command = args.filter((a, i) => !a.startsWith("--") && !(keyAt >= 0 && i === keyAt + 1))[0];
  if (!command || args.includes("--help") || !["status", "server", "players"].includes(command)) {
    io.out(HELP);
    return command && !args.includes("--help") ? 2 : 0;
  }
  const make = io.makeApi ?? ((k: string) => new OxfordAPI({ serverKey: k, rateLimit: "none" }));

  try {
    if (command === "status") {
      const status = await make("unused").getStatus();
      if (json) { io.out(JSON.stringify(status, null, 2)); return 0; }
      io.out(`Oxford API: ${status.Status ?? "unknown"}`);
      io.out(`Running for: ${ago(status.UptimeSeconds)}`);
      if (status.LastHour) io.out(`Response time (last hour): ${status.LastHour.P50Ms} ms median, ${status.LastHour.P95Ms} ms 95th`);
      const windows = (status.Uptime as { Windows?: Record<string, number> } | undefined)?.Windows;
      if (windows) io.out(`Uptime: ${Object.entries(windows).map(([k, v]) => `${k} ${v}%`).join(", ")}`);
      return 0;
    }

    if (!key) { io.err("Set OXFD_SERVER_KEY to your server's API key (or pass --key)."); return 1; }
    const api = make(key);

    if (command === "server") {
      const data = await api.getServer();
      if (json) { io.out(JSON.stringify(data, null, 2)); return 0; }
      const s = data.Server ?? {};
      io.out(s.Name ?? "Unknown server");
      io.out(`  ${data.Online ? "Online" : "Offline"}, ${s.CurrentPlayers ?? 0}/${s.MaxPlayers ?? "?"} players`);
      io.out(`  Join code: ${s.JoinCode || "-"}   Access: ${s.Access || "-"}`);
      io.out(`  Packages: ${(s.Packages ?? []).join(", ") || "none"}`);
      if (data.Online && s.Uptime !== undefined && s.Uptime !== null) io.out(`  Up for: ${ago(s.Uptime)}`);
      return 0;
    }

    const players = await api.getPlayers();
    if (json) { io.out(JSON.stringify(players, null, 2)); return 0; }
    if (players === null) { io.out("The server is offline."); return 0; }
    if (!players.length) { io.out("Nobody's in the server."); return 0; }
    const rows = [...players].sort((a, b) =>
      String(a.Team ?? "").localeCompare(String(b.Team ?? "")) || String(a.Username ?? "").toLowerCase().localeCompare(String(b.Username ?? "").toLowerCase()));
    const width = Math.max(...rows.map((p) => String(p.Username ?? "").length));
    for (const p of rows) {
      const where = p.Location?.Area ?? "";
      const rank = p.Rank ? ` [${p.Rank}]` : "";
      io.out(`${String(p.Username ?? "").padEnd(width)}  ${String(p.Team ?? "-").padEnd(10)} ${where}${rank}`);
    }
    io.out(`\n${rows.length} player${rows.length === 1 ? "" : "s"}`);
    return 0;
  } catch (err) {
    if (err instanceof OxfordAPIError) { io.err(`Error: ${err.message}`); return 1; }
    throw err;
  }
}

// Run when called as a command (not when imported, e.g. by the tests). npm runs commands through
// a symlink on macOS/Linux, so compare real paths.
function invokedDirectly(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked);
  } catch {
    return import.meta.url === pathToFileURL(invoked).href;
  }
}
if (invokedDirectly()) {
  main(process.argv.slice(2), { out: console.log, err: console.error, env: process.env }).then((code) => {
    process.exitCode = code;
  });
}
