/**
 * Small geography helpers.
 */

const EARTH_RADIUS_KM = 6371;

/**
 * Great-circle distance between two points.
 *
 * Args:
 *     aLat (number): Latitude of the first point, in degrees.
 *     aLng (number): Longitude of the first point, in degrees.
 *     bLat (number): Latitude of the second point, in degrees.
 *     bLng (number): Longitude of the second point, in degrees.
 *
 * Returns:
 *     number: Distance in kilometres, rounded to 2 decimal places.
 */
export function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h)) * 100) / 100;
}

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

/**
 * Which way to look from one point to another, as a spoken compass word.
 *
 * Args:
 *     aLat (number): Latitude of where you are.
 *     aLng (number): Longitude of where you are.
 *     bLat (number): Latitude of what you are looking at.
 *     bLng (number): Longitude of what you are looking at.
 *
 * Returns:
 *     string: One of eight directions, e.g. "northeast".
 */
export function compassDirection(aLat: number, aLng: number, bLat: number, bLng: number): string {
  const rad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(rad(bLng - aLng)) * Math.cos(rad(bLat));
  const x = Math.cos(rad(aLat)) * Math.sin(rad(bLat)) - Math.sin(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(rad(bLng - aLng));
  const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(bearing / 45) % 8];
}

/**
 * Where the nearest fire is from someone, and which way leads away from it.
 *
 * Attributes:
 *     fireKm (number): Distance from them to the fire's edge, in km. 0 inside it.
 *     direction (string): Compass word from them to the fire, e.g. "northeast".
 *     away (string): Compass word pointing directly away from the fire's
 *         centre, e.g. "southwest".
 *     inside (boolean): True if they are inside the fire circle.
 */
export interface EscapeInfo {
  fireKm: number;
  direction: string;
  away: string;
  inside: boolean;
}

/**
 * Find the nearest fire to a point and the direction that escapes it.
 *
 * "Away" is the bearing from the fire's centre to the person, so moving
 * that way always increases the distance from the fire.
 *
 * Args:
 *     lat (number): The person's latitude.
 *     lng (number): The person's longitude.
 *     fires ({ lat: number, lng: number, radius_km: number }[]): Fire circles.
 *
 * Returns:
 *     EscapeInfo | null: The nearest fire by edge distance, or null if there
 *         are no fires.
 */
/** A person must move at least this far before Relay calls the direction right or wrong. */
export const MOVE_JUDGE_KM = 0.03;

/** Whether a move got someone closer to the place they were sent. */
export type MoveJudgment = "closer" | "farther" | "still";

/**
 * Decide if a move was toward a goal.
 *
 * A shift under {@link MOVE_JUDGE_KM} is "still", so a Find My wobble is not
 * called the wrong way. Anything else is "closer" only when the goal is at
 * least 20 metres nearer than before.
 *
 * Args:
 *     fromLat (number): Latitude where they were when last directed.
 *     fromLng (number): Longitude where they were when last directed.
 *     toLat (number): Latitude where they are now.
 *     toLng (number): Longitude where they are now.
 *     goalLat (number): Latitude of the shelter.
 *     goalLng (number): Longitude of the shelter.
 *
 * Returns:
 *     { judgment: MoveJudgment; walked: string }: "still", "closer", or
 *         "farther", and the compass word of the move. `walked` is empty
 *         when they have not moved enough.
 */
export function judgeMove(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  goalLat: number,
  goalLng: number,
): { judgment: MoveJudgment; walked: string } {
  if (distanceKm(fromLat, fromLng, toLat, toLng) < MOVE_JUDGE_KM) return { judgment: "still", walked: "" };
  const before = distanceKm(fromLat, fromLng, goalLat, goalLng);
  const after = distanceKm(toLat, toLng, goalLat, goalLng);
  const walked = compassDirection(fromLat, fromLng, toLat, toLng);
  if (after + 0.02 < before) return { judgment: "closer", walked };
  return { judgment: "farther", walked };
}

export function escapeFrom(lat: number, lng: number, fires: { lat: number; lng: number; radius_km: number }[]): EscapeInfo | null {
  let best: { fire: (typeof fires)[number]; edge: number } | null = null;
  for (const fire of fires) {
    const edge = distanceKm(lat, lng, fire.lat, fire.lng) - fire.radius_km;
    if (!best || edge < best.edge) best = { fire, edge };
  }
  if (!best) return null;
  return {
    fireKm: Math.max(0, Math.round(best.edge * 100) / 100),
    direction: compassDirection(lat, lng, best.fire.lat, best.fire.lng),
    away: compassDirection(best.fire.lat, best.fire.lng, lat, lng),
    inside: best.edge <= 0,
  };
}
