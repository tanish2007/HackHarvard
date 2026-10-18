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
