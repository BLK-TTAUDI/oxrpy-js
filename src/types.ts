/**
 * The shapes of the data the API returns, so editors can autocomplete field names.
 *
 * Every field is optional because the API can leave fields out (a player still loading in only
 * has `UserId`, `Username` and `DisplayName`) and adds new ones over time. Anything the API
 * marks as "or null" is `| null`. Field reference: https://docs.oxfd.re/#reference
 */

/** `[x, y, z]` in studs. */
export type Position = [number, number, number];

export type TeamName = "Civilian" | "Police" | "Ambulance" | "Highways" | "Fire" | "Jailed";

export interface ServerInfo {
  ServerId?: string;
  Name?: string;
  OwnerId?: number;
  OwnerUsername?: string | null;
  CurrentPlayers?: number;
  MaxPlayers?: number;
  Access?: "Listed" | "Code" | "StaffOnly";
  JoinCode?: string | null;
  Packages?: string[];
  StartedAt?: number | null;
  Uptime?: number | null;
  PlaceVersion?: number | null;
  JobId?: string | null;
  CommandChannel?: string | null;
  StyledName?: string | null;
  Description?: string | null;
  Tags?: string[];
  ThemeColour?: string | null;
  Logo?: string | null;
  CreatedAt?: number | null;
  MatchmakingType?: string | null;
  ApiVersion?: unknown;
}

export interface Location {
  Road?: string | null;
  Area?: string | null;
  Grid?: string | null;
  Address?: string | null;
}

export interface Player {
  UserId?: number;
  Username?: string;
  DisplayName?: string;
  Team?: string | null;
  Callsign?: string | null;
  Rank?: string | null;
  RankId?: string | null;
  Position?: Position | null;
  Heading?: number | null;
  Location?: Location | null;
  Health?: number | null;
  MaxHealth?: number | null;
  Downed?: boolean;
  DownedCall?: boolean;
  Tased?: boolean;
  Invincible?: boolean;
  Custody?: { By?: number | null; Mode?: string | null; DeadlineAt?: number | null; StaffCustody?: boolean } | null;
  Wanted?: { Level?: number; EndsAt?: number | null; Paused?: boolean; Offences?: unknown[] } | null;
  Jailed?: { EndsAt?: number | null } | null;
  Vehicle?: { Plate?: string; Seat?: "Driver" | "FrontPassenger" | "RearLeft" | "RearRight" | "Rear"; Owner?: boolean } | null;
  Holding?: { Item?: string; Aiming?: boolean; Ammo?: number | null; Spare?: number | null } | null;
  Stance?: "Standing" | "Running" | "Crouching" | "Ragdolled" | null;
  Unit?: { Status?: string | null; IncidentId?: string | null; ControlOperator?: boolean } | null;
  Carrying?: string | null;
  Job?: { Job?: string; Stage?: string | null } | null;
  Disguised?: boolean;
  SessionSeconds?: number | null;
  AccountAgeDays?: number | null;
}

export interface Tracks {
  From?: number;
  /** Keyed by user ID; samples are `[t, x, z, heading]`. */
  Players?: Record<string, number[][]>;
  /** Keyed by plate. */
  Vehicles?: Record<string, number[][]>;
}

export interface Els {
  Style?: "Blue" | "Amber" | "Red";
  HasLightbar?: boolean;
  HasAlleys?: boolean;
  Mode?: "999" | "AtScene" | "Custom" | "Off";
  Active?: boolean;
  Panel?: Record<
    | "FrontBlues" | "RearBlues" | "GrilleBlues" | "RearReds" | "FrontSpots" | "TakeDown"
    | "Cruise" | "SlowPattern" | "LeftAlley" | "RightAlley" | "Rumbler",
    boolean
  >;
  Siren?: { Armed?: boolean; Tone?: "Wail" | "Yelp" | "Phaser" | null; Bullhorn?: boolean };
}

export interface Vehicle {
  Plate?: string;
  OwnerId?: number;
  Team?: string | null;
  Model?: string;
  Livery?: string | null;
  Custom?: { Id?: string; Name?: string } | null;
  Colour?: { Name?: string; Hex?: string } | null;
  Electric?: boolean;
  Position?: Position | null;
  Heading?: number | null;
  SpeedMph?: number | null;
  Location?: Location | null;
  EngineOn?: boolean;
  Locked?: boolean;
  Horn?: boolean;
  Anpr?: boolean;
  Health?: number | null;
  Smoking?: boolean;
  Fuel?: { Litres?: number; Capacity?: number } | null;
  Tyres?: Partial<Record<"FL" | "FR" | "RL" | "RR", "OK" | "Popped">> | null;
  Lights?: {
    Headlights?: "Off" | "Dipped" | "Full";
    Indicator?: "Off" | "Left" | "Right" | "Hazards";
    Braking?: boolean;
    Reversing?: boolean;
  } | null;
  Els?: Els | null;
  Occupants?: Array<{ Seat?: string; UserId?: number; Detained?: boolean }>;
  Towing?: Record<string, unknown> | null;
  Cargo?: string[];
  Appliance?: Record<string, unknown> | null;
  SpawnedAt?: number | null;
}

export interface World {
  Weather?: "Clear" | "Rain" | "Snow" | "Thunderstorm";
  WeatherLocked?: boolean;
  TemperatureC?: number | null;
  Clock?: string;
  ClockMinutes?: number;
  ClockLocked?: boolean;
  Night?: boolean;
  StreetLights?: boolean;
  SnowCover?: number;
  Season?: string | null;
  SpeedLimitMph?: number | null;
  StickyMessage?: string | null;
  CountdownEndsAt?: number | null;
  NpcCallouts?: boolean;
}

export interface TeamStatus {
  Players?: number | null;
  Limit?: number | null;
  DefaultLimit?: number | null;
  CustomLimit?: boolean;
  Access?: { Staff?: boolean; StaffRanks?: string[] | null; Groups?: string[] | null } | null;
}

export type Teams = Record<string, TeamStatus>;

export interface QueueEntry { UserId?: number; JoinedAt?: number; Priority?: number }

export interface Robbery {
  Name?: string;
  DisplayName?: string;
  State?: "Available" | "Robbery" | "Cooldown" | "OnFire";
  Stage?: string | null;
  Alarm?: boolean;
  Robbers?: number[];
  LootRemaining?: number | null;
  OpensAt?: number | null;
  Position?: Position | null;
}

export interface Atm { Name?: string; Available?: boolean; Alarm?: boolean; RobbedBy?: number | null; Position?: Position | null }

export interface Incident {
  Id?: string;
  Type?: string;
  Team?: string;
  Priority?: number;
  Status?: string;
  Place?: string | null;
  Position?: Position | null;
  Count?: number;
  Text?: string | null;
  Responders?: number[];
  Assigned?: number[];
  CreatedAt?: number;
  LastAt?: number;
}

export interface Incidents {
  Open?: Incident[];
  Units?: Array<{ UserId?: number; Callsign?: string | null; Team?: string; Status?: string | null; IncidentId?: string | null }>;
  Operators?: Array<Record<string, unknown>>;
  Timeline?: Array<Record<string, unknown>>;
}

export interface StaffMember { UserId?: number; Username?: string | null; RankId?: string; Rank?: string; Online?: boolean }
export interface Rank { Id?: string; Name?: string; Priority?: number; Sync?: { GroupId?: number; Rank?: number | null } }
export interface Staff { OwnerId?: number; Staff?: StaffMember[]; Ranks?: Rank[] }
export interface Group { Id?: string; Name?: string; Sync?: { GroupId?: number; Rank?: number | null }; Members?: number[] }

export interface Ban {
  UserId?: number;
  Username?: string | null;
  Reason?: string | null;
  BannedBy?: string | null;
  BannedById?: number | null;
  ExpiresAt?: number | null;
}
export interface BansPage { Total?: number; Offset?: number; List?: Ban[] }

export interface AuditEntry {
  Number?: number;
  Timestamp?: number;
  UserId?: number;
  Username?: string;
  Command?: string;
  Category?: string;
  Args?: string[];
  Description?: string;
}
export interface AuditPage { Entries?: AuditEntry[]; Next?: number | null; Total?: number }

/** Fields every log entry has. */
export interface LogEntry { Seq?: number; Id?: string; Type?: string; At?: number }

export interface KillLog extends LogEntry {
  KillerUserId?: number;
  KillerUsername?: string;
  VictimUserId?: number;
  VictimUsername?: string;
  Distance?: number | null;
  Weapon?: string | null;
  KillerPosition?: Position | null;
  VictimPosition?: Position | null;
  Part?: "Head" | "Torso" | "Limb" | null;
  Headshot?: boolean;
}

export interface ModCall extends LogEntry {
  CallerUserId?: number;
  CallerUsername?: string;
  CallerDisplayName?: string;
  CaseId?: string;
  Responders?: Array<{ UserId?: number; Username?: string; Timestamp?: number }>;
  UpdatedAt?: number | null;
  ResolvedAt?: number | null;
  ResolvedBy?: number | null;
  ResolvedByUsername?: string | null;
}

export interface RadioCall extends LogEntry {
  UserId?: number;
  Username?: string;
  Channel?: string;
  Callsign?: string | null;
  Location?: string | null;
  Coordinates?: Position | null;
  Description?: string | null;
}

export interface JoinLog extends LogEntry { UserId?: number; Username?: string; DisplayName?: string; JoinType?: "Join" | "Leave" }

export interface CommandLog extends LogEntry {
  UserId?: number;
  Username?: string;
  Command?: string;
  Category?: string;
  Args?: string[];
  Description?: string;
}

export interface CommandResultLog extends LogEntry {
  Command?: string;
  SentAt?: number;
  Success?: boolean | null;
  Code?: string | null;
  Message?: string | null;
  Status?: "Succeeded" | "Failed" | "Pending" | "NoResult";
}

/** A game event. Which fields are present depends on `Type`: https://docs.oxfd.re/#events */
export interface Event extends LogEntry {
  UserId?: number;
  Username?: string;
  By?: number;
  ByUsername?: string;
  From?: unknown;
  To?: unknown;
  Position?: Position;
  Plate?: string;
  Model?: string;
  Weapon?: string;
  Name?: string;
  Team?: string;
  Reason?: string;
  Amount?: number;
  SpeedMph?: number;
  Limit?: number;
  Fine?: number;
  Place?: string;
  IncidentId?: string;
  Status?: string;
  Channel?: string;
  [field: string]: unknown;
}

export interface Shot {
  Seq?: number;
  At?: number;
  Until?: number;
  Burst?: boolean;
  Count?: number;
  Hits?: number;
  Shooter?: number;
  Team?: string;
  Weapon?: string;
  From?: Position;
  To?: Position;
  Pellets?: number;
  Hit?: {
    UserId?: number;
    Part?: "Head" | "Torso" | "Limb";
    Damage?: number;
    HpAfter?: number;
    Downed?: boolean;
    World?: "Glass" | "Tyre" | "World";
    At?: Position;
    Blocked?: boolean;
  } | null;
}

/** What `runCommand` and the helpers return. */
export interface CommandResult {
  CommandId?: string;
  Status?: "Succeeded" | "Failed" | "Pending";
  Code?: "OK" | "TARGET_NOT_FOUND" | "INVALID_ARGS" | "FORBIDDEN" | "PACKAGE_REQUIRED" | "RATE_LIMITED" | "OFFLINE" | "UNKNOWN_COMMAND" | "FAILED";
  Message?: string;
}

/** What `getCommand` returns (the API's older shape, lower-case `Status`). */
export interface CommandStatus {
  Id?: string;
  Command?: string;
  SentAt?: number;
  Timestamp?: number | null;
  Success?: boolean | null;
  Message?: string | null;
  Status?: "succeeded" | "failed" | "pending" | "no_result";
}

export interface ApiStatus {
  Status?: "operational" | "degraded";
  GeneratedAt?: number;
  StartedAt?: number;
  UptimeSeconds?: number;
  LastHour?: Record<string, number>;
  Uptime?: Record<string, unknown>;
}

export type Settings = Record<string, unknown>;
export type Catalogue = Record<string, any>;

/** The JSON from `GET /v1/server`. The top-level fields are always there; sections you ask for are added. */
export interface ServerData {
  Online?: boolean;
  LastHeartbeat?: number | null;
  NextHeartbeat?: number | null;
  Cursor?: number;
  Server?: ServerInfo;
  Players?: Player[] | null;
  Tracks?: Tracks | null;
  Vehicles?: Vehicle[] | null;
  World?: World | null;
  Teams?: Teams | null;
  Queue?: QueueEntry[] | null;
  Robberies?: Robbery[] | null;
  Atms?: Atm[] | null;
  Incidents?: Incidents | null;
  Staff?: Staff | null;
  Groups?: Group[] | null;
  Bans?: BansPage | null;
  Settings?: Settings | null;
  Catalogue?: Catalogue | null;
  KillLogs?: KillLog[] | null;
  ModCalls?: ModCall[] | null;
  RadioCalls?: RadioCall[] | null;
  JoinLogs?: JoinLog[] | null;
  Events?: Event[] | null;
  CommandLogs?: CommandLog[] | null;
  CommandResults?: CommandResultLog[] | null;
  Shots?: Shot[] | null;
  Audit?: AuditPage | null;
  [section: string]: unknown;
}
