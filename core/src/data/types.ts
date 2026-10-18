/**
 * Contract C: the four data functions Core calls as agent tools.
 *
 * Rudra owns the real functions (Python, in data/api.py). Core only talks to
 * them through this interface, so the stub and the real client can be
 * swapped without changing the agent. Shapes match data/api.py exactly,
 * including the `source` field ("fake", "fallback", or the live source).
 */
import type { Hazard } from "../contracts.js";

/** A hazard row. Same as the /state shape. */
export type DataHazard = Hazard;

/** A shelter row, nearest first. */
export interface DataShelter {
  id: string;
  name: string;
  lat: number;
  lng: number;
  distance_km: number;
  capacity_note: string;
  source: string;
}

/** A route that stays outside known fire circles. */
export interface DataRoute {
  distance_km: number;
  duration_min: number;
  steps: string[];
  polyline: { lat: number; lng: number }[];
  avoided_hazards: string[];
  source: string;
}

/** A short forecast. */
export interface DataWeather {
  summary: string;
  wind_mph: number;
  wind_dir: string;
  temp_f: number;
  next_2h: string;
  source: string;
}

/**
 * The four Contract C functions. Async, because the real ones are reached
 * over the network. They must never reject: on failure they return the fake
 * payload with source "fallback".
 */
export interface DataTools {
  getHazards(lat: number, lng: number, radiusKm: number): Promise<DataHazard[]>;
  getRoute(fromLat: number, fromLng: number, toLat: number, toLng: number): Promise<DataRoute>;
  getShelters(lat: number, lng: number): Promise<DataShelter[]>;
  getWeather(lat: number, lng: number): Promise<DataWeather>;
}
