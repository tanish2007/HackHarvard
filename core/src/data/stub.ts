/**
 * A TypeScript stand-in for Rudra's Contract C fake mode.
 *
 * Rudra's functions are Python, so Core cannot import them. Until they are
 * reachable over HTTP, Core uses this stub. It reads the same scenario and
 * returns the same shapes as data/api.py with DATA_MODE=fake, so swapping in
 * the real client changes no agent code.
 */
import { distanceKm } from "../lib/geo.js";
import type { Scenario } from "../scenario/schema.js";
import type { DataHazard, DataRoute, DataShelter, DataTools, DataWeather } from "./types.js";

/** Evacuation driving speed used for fake route times, as in data/routing.py. */
const EVAC_KMH = 40;

/** Waypoint distances tried around a fire, as multiples of its radius. */
const DETOUR_SCALES = [1.15, 1.4, 1.8, 2.4, 3.2];

/** A point in kilometres on a flat map centred on a hazard. */
type Xy = [number, number];

/**
 * Build the stub data tools for a scenario.
 *
 * Args:
 *     scenario (Scenario): The loaded scenario.
 *
 * Returns:
 *     DataTools: The four Contract C functions, answered from the scenario.
 */
export function createStubData(scenario: Scenario): DataTools {
  const fires = (): DataHazard[] => [
    {
      id: "hz_scenario_fire",
      kind: "fire",
      lat: scenario.fire_area.lat,
      lng: scenario.fire_area.lng,
      radius_km: scenario.fire_area.radius_km,
      severity: "high",
      source: "fake",
      updated_at: "",
    },
    ...scenario.extra_fires.map(
      (fire): DataHazard => ({
        id: fire.id,
        kind: "fire",
        lat: fire.lat,
        lng: fire.lng,
        radius_km: fire.radius_km,
        severity: "high",
        source: "fake",
        updated_at: "",
      }),
    ),
  ];

  // Name the route's end after the closest named spot, place or shelter.
  // Using shelters only (as data/api.py does) made a route to Oak St say
  // "Leave toward Shelter C", and the agent repeated it on the radio.
  const nearestName = (lat: number, lng: number): string => {
    let best: { name: string; d: number } | null = null;
    for (const s of [...scenario.places, ...scenario.shelters]) {
      const d = distanceKm(lat, lng, s.lat, s.lng);
      if (!best || d < best.d) best = { name: s.name, d };
    }
    return best?.name ?? "your destination";
  };

  return {
    async getHazards(lat, lng, radiusKm) {
      return fires().filter((fire) => distanceKm(lat, lng, fire.lat, fire.lng) <= radiusKm + fire.radius_km);
    },

    async getShelters(lat, lng) {
      return scenario.shelters
        .map(
          (s): DataShelter => ({
            id: s.id,
            name: s.name,
            lat: s.lat,
            lng: s.lng,
            distance_km: distanceKm(lat, lng, s.lat, s.lng),
            capacity_note: s.capacity_note,
            source: "fake",
          }),
        )
        .sort((a, b) => a.distance_km - b.distance_km);
    },

    async getWeather(): Promise<DataWeather> {
      return { ...scenario.fake_weather, source: "fake" };
    },

    async getRoute(fromLat, fromLng, toLat, toLng, _profile?: "driving" | "foot"): Promise<DataRoute> {
      const start = { lat: fromLat, lng: fromLng };
      const end = { lat: toLat, lng: toLng };
      const f = fires()[0];
      const waypoint = detourAround(start, end, f);
      const polyline = waypoint ? [start, waypoint, end] : [start, end];

      let distance = 0;
      for (let i = 1; i < polyline.length; i++) {
        distance += distanceKm(polyline[i - 1].lat, polyline[i - 1].lng, polyline[i].lat, polyline[i].lng);
      }
      const endName = nearestName(toLat, toLng);
      const avoided = waypoint ? [f.id] : [];
      return {
        distance_km: Math.round(distance * 100) / 100,
        duration_min: Math.round((distance / EVAC_KMH) * 60 * 10) / 10,
        steps: [`Leave toward ${endName}.`, ...avoided.map((id) => `Stay outside the ${id} fire circle.`), `Arrive at ${endName}.`],
        polyline,
        avoided_hazards: avoided,
        source: "fake",
      };
    },
  };
}

/**
 * Bend a straight line so it stays outside a hazard circle.
 *
 * Mirrors detour_around in data/geo.py: try a waypoint to either side of the
 * line, further out each time, until both legs clear the circle.
 *
 * Args:
 *     a ({lat, lng}): Start.
 *     b ({lat, lng}): End.
 *     hazard (DataHazard): The circle to avoid.
 *
 * Returns:
 *     {lat, lng} | null: The waypoint, or null if the line already clears the
 *         circle or an endpoint is inside it.
 */
function detourAround(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  hazard: DataHazard,
): { lat: number; lng: number } | null {
  const r = hazard.radius_km;
  const pa = toLocal(a.lat, a.lng, hazard);
  const pb = toLocal(b.lat, b.lng, hazard);
  if (Math.hypot(...pa) <= r || Math.hypot(...pb) <= r) return null;
  if (segmentDistance(pa, pb) >= r) return null;

  const dx = pb[0] - pa[0];
  const dy = pb[1] - pa[1];
  const len = Math.hypot(dx, dy) || 1;
  const perp: Xy = [-dy / len, dx / len];
  for (const scale of DETOUR_SCALES) {
    for (const sign of [1, -1]) {
      const w: Xy = [perp[0] * r * scale * sign, perp[1] * r * scale * sign];
      if (segmentDistance(pa, w) >= r && segmentDistance(w, pb) >= r) {
        const p = fromLocal(w, hazard);
        return { lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6 };
      }
    }
  }
  return null;
}

/**
 * Project a point to kilometres from the hazard centre.
 *
 * Args:
 *     lat (number): Latitude.
 *     lng (number): Longitude.
 *     origin ({lat, lng}): Hazard centre.
 *
 * Returns:
 *     Xy: [east km, north km].
 */
function toLocal(lat: number, lng: number, origin: { lat: number; lng: number }): Xy {
  const kmPerLng = 111.32 * Math.cos((origin.lat * Math.PI) / 180);
  return [(lng - origin.lng) * kmPerLng, (lat - origin.lat) * 110.574];
}

/**
 * Inverse of toLocal.
 *
 * Args:
 *     p (Xy): [east km, north km].
 *     origin ({lat, lng}): Hazard centre.
 *
 * Returns:
 *     {lat, lng}: The point in degrees.
 */
function fromLocal(p: Xy, origin: { lat: number; lng: number }): { lat: number; lng: number } {
  const kmPerLng = 111.32 * Math.cos((origin.lat * Math.PI) / 180);
  return { lat: origin.lat + p[1] / 110.574, lng: origin.lng + p[0] / kmPerLng };
}

/**
 * Distance from the origin (the hazard centre) to a line segment.
 *
 * Args:
 *     a (Xy): Segment start.
 *     b (Xy): Segment end.
 *
 * Returns:
 *     number: Shortest distance in kilometres.
 */
function segmentDistance(a: Xy, b: Xy): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / len2));
  return Math.hypot(a[0] + t * dx, a[1] + t * dy);
}
