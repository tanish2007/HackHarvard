/**
 * Turn a fire on the map plus the weather into a spread forecast.
 *
 * Runs the BehavePlus-validated Rothermel model (rothermel.ts) with the
 * scenario's fuel and moisture and the current wind, then grows the fire's
 * current area into projected perimeters (perimeter.ts).
 *
 * Honest limits, also shown to users: uniform fuel, steady wind, no
 * buildings, no spotting, no crown fire, no fire acceleration from
 * ignition. It is an estimate of where a grass or brush fire would go.
 */
import type { FireSpread, Hazard } from "../contracts.js";
import type { DataWeather } from "../data/types.js";
import type { Scenario } from "../scenario/schema.js";
import { fuelModel, MOISTURE_SCENARIOS } from "./fuelModels.js";
import { arrivalMinutes, perimeterAt, type LatLng, type SpreadEllipse } from "./perimeter.js";
import { surfaceFireNorth } from "./rothermel.js";

/** Name shown with every forecast. */
export const SPREAD_MODEL = "Rothermel 1972 surface spread with Anderson 1983 ellipse (BehavePlus-validated)";

const M_PER_FT = 0.3048;
/** Btu/ft/s to kW/m. */
const KW_M_PER_BTU_FT_S = 3.46141;

const COMPASS16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

/**
 * Read a wind direction as weather services write it.
 *
 * Args:
 *     dir (string): "NE", "north-east", "SSW", or degrees like "225".
 *
 * Returns:
 *     number | null: Degrees the wind comes from, or null if unknown
 *         ("variable", "calm", empty).
 */
export function windFromDegrees(dir: string): number | null {
  const s = dir.trim().toUpperCase().replace(/[\s-]/g, "");
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) % 360;
  const words: Record<string, string> = { NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W" };
  const code = s.replace(/NORTH|SOUTH|EAST|WEST/g, (w) => words[w]);
  const i = COMPASS16.indexOf(code);
  return i === -1 ? null : i * 22.5;
}

/**
 * Compute the spread of one fire.
 *
 * Args:
 *     hazard (Hazard): A fire hazard. Its circle is the current fire area.
 *     weather (DataWeather): Current weather near the fire.
 *     scenario (Scenario): For the fuel and moisture settings.
 *     nowIso (string): Time the forecast starts from.
 *
 * Returns:
 *     FireSpread | null: The forecast, or null if the fuel cannot burn, the
 *         fuel model or moisture scenario is unknown, or the hazard is not
 *         a fire.
 */
export function computeSpread(hazard: Hazard, weather: DataWeather, scenario: Scenario, nowIso: string): FireSpread | null {
  if (hazard.kind !== "fire") return null;
  const settings = scenario.fire_behavior;
  const fuel = fuelModel(settings.fuel_model);
  const moisture = MOISTURE_SCENARIOS[settings.moisture_scenario.toUpperCase()];
  if (!fuel || !moisture) return null;

  // Unknown or variable wind direction: treat as calm, which grows a circle.
  const windFrom = windFromDegrees(weather.wind_dir);
  const windMph = windFrom === null ? 0 : Math.max(0, weather.wind_mph);
  const [oneHour, tenHour, hundredHour, liveHerb, liveWoody] = moisture;
  const fire = surfaceFireNorth(
    {
      fuel,
      moisture: { oneHour, tenHour, hundredHour, liveHerb, liveWoody },
      wind: { speedMph: windMph, height: settings.wind_height },
      slopeTan: settings.slope_percent / 100,
    },
    windFrom ?? 0,
    settings.aspect_deg,
  );
  if (fire.spreadRate <= 0) return null;

  const ellipse: SpreadEllipse = {
    headRate: fire.spreadRate * M_PER_FT,
    backRate: fire.backingRate * M_PER_FT,
    flankRate: fire.flankingRate * M_PER_FT,
    headDirectionDeg: fire.directionFromNorth,
  };
  const center = { lat: hazard.lat, lng: hazard.lng };
  const radiusM = Math.max(0, hazard.radius_km * 1000);
  const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
  return {
    model: SPREAD_MODEL,
    fuel_model: fuel.code,
    fuel_name: fuel.name,
    moisture_scenario: settings.moisture_scenario.toUpperCase(),
    wind_mph: windMph,
    wind_from_deg: windFrom ?? 0,
    head_direction_deg: round(fire.directionFromNorth, 1),
    head_m_per_min: round(ellipse.headRate, 2),
    back_m_per_min: round(ellipse.backRate, 2),
    flank_m_per_min: round(ellipse.flankRate, 2),
    length_to_width: round(fire.lengthToWidthRatio, 3),
    flame_length_m: round(fire.flameLength * M_PER_FT, 2),
    fireline_intensity_kw_m: round(fire.firelineIntensity * KW_M_PER_BTU_FT_S, 0),
    computed_at: nowIso,
    forecast: [...settings.forecast_minutes]
      .sort((a, b) => a - b)
      .map((minutes) => ({
        minutes,
        polygon: perimeterAt(center, radiusM, ellipse, minutes).map((p) => ({ lat: round(p.lat, 6), lng: round(p.lng, 6) })),
      })),
  };
}

/**
 * Minutes until a fire would reach a point, from its forecast.
 *
 * The time counts from when the forecast was made.
 *
 * Args:
 *     hazard (Hazard): The fire.
 *     spread (FireSpread): Its forecast.
 *     point (LatLng): Where.
 *
 * Returns:
 *     number: 0 if already inside the fire, Infinity if it never gets there.
 */
export function fireArrivalMinutes(hazard: Hazard, spread: FireSpread, point: LatLng): number {
  const ellipse: SpreadEllipse = {
    headRate: spread.head_m_per_min,
    backRate: spread.back_m_per_min,
    flankRate: spread.flank_m_per_min,
    headDirectionDeg: spread.head_direction_deg,
  };
  return arrivalMinutes({ lat: hazard.lat, lng: hazard.lng }, Math.max(0, hazard.radius_km * 1000), ellipse, point);
}
