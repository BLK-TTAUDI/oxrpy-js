/**
 * Remembering where a follower got to, so a restarted bot carries on where it left off.
 *
 * Pass `saveTo` to `runForever()` or `follow()`: a file path (Node, Bun and Deno), or your own
 * object with `load()` and `save(state)` (sync or async), to keep it in a database. The position
 * is saved after your handlers have run for a poll, so a crash part-way through means those
 * entries come round again rather than being lost.
 */

export interface SavedState {
  Version: number;
  Cursor: number;
  Handled: Record<string, number>;
  SavedAt: number;
}

export interface StateStore {
  load(): SavedState | null | undefined | Promise<SavedState | null | undefined>;
  save(state: SavedState): void | Promise<void>;
}

/** Keeps the position in a small JSON file. Writes are atomic: a crash mid-write can't corrupt it. */
export class FileState implements StateStore {
  constructor(readonly path: string) {}

  async load(): Promise<SavedState | null> {
    const fs = await import("node:fs/promises");
    let text: string;
    try {
      text = await fs.readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    try {
      const state = JSON.parse(text);
      return state && typeof state === "object" ? state : null;
    } catch {
      console.warn(`[oxrpy] Ignoring ${this.path}: it isn't valid JSON, so starting from the newest entries`);
      return null;
    }
  }

  async save(state: SavedState): Promise<void> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.mkdir(path.dirname(path.resolve(this.path)), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
      await fs.rename(tmp, this.path);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }
}

export function asStore(saveTo: string | StateStore | undefined): StateStore | undefined {
  if (saveTo === undefined) return undefined;
  if (typeof saveTo === "string") return new FileState(saveTo);
  if (typeof saveTo.load === "function" && typeof saveTo.save === "function") return saveTo;
  throw new TypeError("saveTo must be a file path or an object with load() and save(state)");
}

export function makeState(cursor: number, handled: Record<string, number>): SavedState {
  return { Version: 1, Cursor: cursor, Handled: { ...handled }, SavedAt: Math.floor(Date.now() / 1000) };
}

/** Check a loaded state; returns it cleaned up, or `null` if it's unusable. */
export function readState(state: unknown): { Cursor: number; Handled: Record<string, number> } | null {
  const s = state as Partial<SavedState> | null | undefined;
  if (!s || s.Cursor === undefined || s.Cursor === null) return null;
  const cursor = Number(s.Cursor);
  if (!Number.isFinite(cursor)) return null;
  const handled: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.Handled ?? {})) if (Number.isFinite(Number(v))) handled[k] = Number(v);
  return { Cursor: cursor, Handled: handled };
}
