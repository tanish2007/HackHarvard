/**
 * Turning spoken place names into coordinates.
 *
 * People say "route to Oak St" or "nearest shelter", not coordinates. Every
 * name comes from scenario.json (places, shelters, zones, people), so moving
 * the demo to a new venue is still a one-file change.
 */
import { distanceKm } from "../lib/geo.js";
import type { Scenario } from "../scenario/schema.js";
import type { TrackedPerson } from "../state/store.js";

/** A resolved place. */
export interface Point {
  name: string;
  lat: number;
  lng: number;
}

/** Words that mean "where I am". */
const HERE = new Set(["", "me", "here", "my location", "current location", "my position", "where i am", "my area"]);

/**
 * Lowercase and strip punctuation so "Oak St." matches "oak st".
 *
 * Args:
 *     s (string): Raw text.
 *
 * Returns:
 *     string: Normalized text.
 */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Check whether a query names something, allowing extra words around it.
 *
 * Args:
 *     query (string): Normalized query, e.g. "the oak st intersection".
 *     name (string): A name or alias, e.g. "Oak St".
 *
 * Returns:
 *     boolean: True on an exact match or a whole-word match inside the query.
 */
function names(query: string, name: string): boolean {
  const n = norm(name);
  return query === n || ` ${query} `.includes(` ${n} `);
}

/**
 * Resolve a spoken place to coordinates.
 *
 * Order: "me/here", a specific shelter, a named place, a zone, a person, then
 * "nearest shelter". Unknown names return null so the tool can tell the
 * model what it does know.
 *
 * Args:
 *     query (string | undefined): What the person said, e.g. "Oak St".
 *     origin (Point): Where "me" and "nearest shelter" are measured from.
 *     scenario (Scenario): The loaded scenario.
 *     people (TrackedPerson[]): Everyone tracked, for "route to Amit".
 *
 * Returns:
 *     Point | null: The place, or null if nothing matched.
 */
export function resolvePlace(
  query: string | undefined,
  origin: Point,
  scenario: Scenario,
  people: TrackedPerson[],
): Point | null {
  const q = norm(query ?? "");
  if (HERE.has(q)) return origin;

  for (const s of scenario.shelters) if (names(q, s.name)) return { name: s.name, lat: s.lat, lng: s.lng };
  for (const p of scenario.places) {
    if (names(q, p.name) || p.aliases.some((a) => names(q, a))) return { name: p.name, lat: p.lat, lng: p.lng };
  }
  for (const z of scenario.zones) {
    if (names(q, z.name)) {
      const lat = z.polygon.reduce((sum, [la]) => sum + la, 0) / z.polygon.length;
      const lng = z.polygon.reduce((sum, [, ln]) => sum + ln, 0) / z.polygon.length;
      return { name: z.name, lat, lng };
    }
  }
  for (const p of people) {
    if (p.lat !== null && p.lng !== null && names(q, p.name)) return { name: p.name, lat: p.lat, lng: p.lng };
  }
  if (/\bshelter\b/.test(q)) return nearestShelter(origin, scenario);
  return null;
}

/**
 * The shelter closest to a point.
 *
 * Args:
 *     from (Point): Where to measure from.
 *     scenario (Scenario): The loaded scenario.
 *
 * Returns:
 *     Point | null: The nearest shelter, or null if there are none.
 */
export function nearestShelter(from: Point, scenario: Scenario): Point | null {
  let best: Point | null = null;
  let bestD = Infinity;
  for (const s of scenario.shelters) {
    const d = distanceKm(from.lat, from.lng, s.lat, s.lng);
    if (d < bestD) {
      bestD = d;
      best = { name: s.name, lat: s.lat, lng: s.lng };
    }
  }
  return best;
}

/**
 * Every name the model can use, for the system prompt.
 *
 * Args:
 *     scenario (Scenario): The loaded scenario.
 *
 * Returns:
 *     string[]: Place, shelter, and zone names.
 */
export function knownPlaceNames(scenario: Scenario): string[] {
  return [...scenario.places.map((p) => p.name), ...scenario.shelters.map((s) => s.name), ...scenario.zones.map((z) => z.name)];
}
