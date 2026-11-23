/**
 * Putting API positions on Oxford's map image (https://docs.oxfd.re/#res-map). Its top-left
 * corner is x = -6700, z = -2500 and its bottom-right x = 1450, z = 3800; the full image is
 * 8151 × 6301 pixels, about 1 stud a pixel. Positions are `[x, y, z]`; `y` is height.
 */

export const MAP_IMAGE_URL = "https://docs.oxfd.re/map-march.png";
export const MAP_TOP_LEFT = [-6700, -2500] as const;
export const MAP_BOTTOM_RIGHT = [1450, 3800] as const;
export const MAP_IMAGE_SIZE = [8151, 6301] as const;

type Point = readonly number[] | null | undefined;

function xz(position: Point): [number, number] {
  if (!position) throw new TypeError("position is missing (the player hasn't spawned, or the server is offline)");
  if (position.length === 3) return [Number(position[0]), Number(position[2])];
  if (position.length === 2) return [Number(position[0]), Number(position[1])];
  throw new TypeError(`position must be [x, y, z] or [x, z], got ${JSON.stringify(position)}`);
}

/** Where a position falls on the map image, in pixels from its top-left corner. */
export function toPixels(
  position: Point,
  { width = MAP_IMAGE_SIZE[0], height = MAP_IMAGE_SIZE[1], clamp = false }: { width?: number; height?: number; clamp?: boolean } = {},
): [number, number] {
  const [x, z] = xz(position);
  const [left, top] = MAP_TOP_LEFT;
  const [right, bottom] = MAP_BOTTOM_RIGHT;
  let px = ((x - left) / (right - left)) * width;
  let py = ((z - top) / (bottom - top)) * height;
  if (clamp) {
    px = Math.min(Math.max(px, 0), width);
    py = Math.min(Math.max(py, 0), height);
  }
  return [px, py];
}

/** A pixel on the map image → `[x, z]` in studs (handy with `createIncident`). */
export function fromPixels(
  px: number,
  py: number,
  { width = MAP_IMAGE_SIZE[0], height = MAP_IMAGE_SIZE[1] }: { width?: number; height?: number } = {},
): [number, number] {
  const [left, top] = MAP_TOP_LEFT;
  const [right, bottom] = MAP_BOTTOM_RIGHT;
  return [left + (px / width) * (right - left), top + (py / height) * (bottom - top)];
}

/** Whether a position is inside the area the map image covers. */
export function onMap(position: Point): boolean {
  const [x, z] = xz(position);
  return x >= MAP_TOP_LEFT[0] && x <= MAP_BOTTOM_RIGHT[0] && z >= MAP_TOP_LEFT[1] && z <= MAP_BOTTOM_RIGHT[1];
}

/** Distance in studs between two positions, across the ground (ignoring height). */
export function distance(a: Point, b: Point): number {
  const [ax, az] = xz(a);
  const [bx, bz] = xz(b);
  return Math.hypot(ax - bx, az - bz);
}

/** The entry in `places` (anything with a `Position`) closest to `position`. */
export function nearest<T extends { Position?: Point }>(position: Point, places: Iterable<T>): T | undefined {
  let best: T | undefined;
  let bestDistance = Infinity;
  for (const place of places) {
    if (!place.Position) continue;
    const d = distance(position, place.Position);
    if (d < bestDistance) [best, bestDistance] = [place, d];
  }
  return best;
}
