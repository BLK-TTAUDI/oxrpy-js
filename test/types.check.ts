// Compile-time checks: type-checking fails if any of the marked lines stop being errors.
import { OxfordAPI, ServerPool } from "../src/index.js";

const api = new OxfordAPI("k");
api.on("Kill", (kill) => kill.Weapon?.toUpperCase());            // kill is a KillLog
api.on(["Join", "Leave"], (entry) => entry.JoinType);             // entry is a JoinLog
api.on("poll", (data) => data.Online);                            // data is the response
api.on("error", (err) => err.hint);                               // err is an OxfordAPIError
api.on("SpeedCamera", (event) => event.SpeedMph);                 // game events are Events
// @ts-expect-error a Kill entry has no JoinType
api.on("Kill", (kill) => kill.JoinType);
// @ts-expect-error a typo in a field name is caught
api.on("Join", (entry) => entry.Usernmae);
// @ts-expect-error helpers check their argument types
api.wanted("x", "three");
new ServerPool().on("Kill", (server: string, kill) => kill.KillerUsername);
