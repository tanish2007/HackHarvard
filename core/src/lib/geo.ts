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
