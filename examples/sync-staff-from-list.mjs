/**
 * Keep your in-game staff ranks matching a list, sending only the changes.
 *
 * In a real bot the list would come from Discord roles or a database. Here it's Roblox user IDs
 * to rank names (use user IDs, not usernames: names change).
 *
 * Run it:
 *   npm install oxrpy
 *   set OXFD_SERVER_KEY
 *   node sync-staff-from-list.mjs            (shows what it would do)
 *   node sync-staff-from-list.mjs --apply    (does it)
 */

import { OxfordAPI } from "oxrpy";

const STAFF = {
  81234401: "Mod",
  81239912: "Senior Moderator",
  99120501: "Admin",
  77001200: null, // null takes someone off the staff
};

const api = new OxfordAPI(process.env.OXFD_SERVER_KEY);

// removeOthers: true would also unrank anyone on the staff who isn't in STAFF.
const planned = await api.planStaffSync(STAFF, { removeOthers: false });

if (!planned.length) {
  console.log("Staff already match. Nothing to do.");
} else if (!process.argv.includes("--apply")) {
  console.log("These commands would be sent (run with --apply to send them):");
  for (const command of planned) console.log(`  ${command}`);
} else {
  for (const [command, result] of await api.syncStaff(STAFF)) {
    console.log(`${String(result.Status).padEnd(10)} ${command}  (${result.Message})`);
  }
}
