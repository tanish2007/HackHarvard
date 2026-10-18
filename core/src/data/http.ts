/**
 * The real Contract C client: Core asking Rudra's data server over HTTP.
 *
 * Rudra's functions are Python and are served by the map server (dashboard/
 * server.py) as GET /shelters, /route, /hazards and /weather. This client calls
 * them, so "nearest shelter" can mean a real shelter near where the person
 * actually is. If a call fails, times out, or comes back in a shape Core does
 * not expect, the scenario stub answers instead and the result is marked
 * source "fallback". Nothing on stage should ever show an error because an API
 * was slow.
 */
import type { DataHazard, DataRoute, DataShelter, DataTools, DataWeather } from "./types.js";

/** Longest to wait for the data server. The agent itself only waits about 3 seconds. */
export const DATA_TIMEOUT_MS = 2500;

/**
 * Settings for the HTTP data client.
 *
 * Attributes:
 *     baseUrl (string): Where the data server is, e.g. http://localhost:8080.
 *     fallback (DataTools): Answers when the server cannot, normally the stub.
 *     timeoutMs (number | undefined): Per-request timeout. Defaults to 2500.
 *     fetchImpl (typeof fetch | undefined): Injectable for tests.
 *     log ((msg: string) => void | undefined): Defaults to console.warn.
 */
export interface HttpDataOptions {
  baseUrl: string;
  fallback: DataTools;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

/** Check that a value is a non-null object. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Check that a value is a finite number. */
function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** A usable list of shelters: at least one, each with a name, coordinates and distance. */
function isShelterList(v: unknown): v is DataShelter[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((s) => isObject(s) && typeof s.name === "string" && isNum(s.lat) && isNum(s.lng) && isNum(s.distance_km))
  );
}

/** A usable list of hazards. An empty list is a real answer: no hazards. */
function isHazardList(v: unknown): v is DataHazard[] {
  return Array.isArray(v) && v.every((h) => isObject(h) && isNum(h.lat) && isNum(h.lng) && isNum(h.radius_km));
}

/** A usable route. */
function isRoute(v: unknown): v is DataRoute {
  return isObject(v) && isNum(v.distance_km) && isNum(v.duration_min) && Array.isArray(v.steps) && Array.isArray(v.polyline);
}

/** A usable forecast. */
function isWeather(v: unknown): v is DataWeather {
  return isObject(v) && typeof v.summary === "string" && isNum(v.temp_f);
}

/**
 * Mark a fallback answer, so the source field says it did not come from the server.
 *
 * Args:
 *     value (T): A list of rows or a single object.
 *
 * Returns:
 *     T: The same data with source "fallback" on every row.
 */
function markFallback<T>(value: T): T {
  if (Array.isArray(value)) return value.map((row) => ({ ...row, source: "fallback" })) as T;
  return { ...(value as object), source: "fallback" } as T;
}

/**
 * Create the data tools backed by Rudra's data server.
 *
 * Args:
 *     options (HttpDataOptions): The server address, the fallback, and test hooks.
 *
 * Returns:
 *     DataTools: The four Contract C functions. They never reject.
 */
export function createHttpData(options: HttpDataOptions): DataTools {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const log = options.log ?? ((m: string) => console.warn(m));

  /**
   * Ask the server, or fall back.
   *
   * Args:
   *     path (string): The endpoint, e.g. "/shelters".
   *     params (Record<string, number>): Query values.
   *     valid ((v: unknown) => v is T): Checks the response shape.
   *     fallback (() => Promise<T>): The stub's answer.
   *
   * Returns:
   *     Promise<T>: The server's answer, or the marked fallback.
   */
  async function ask<T>(
    path: string,
    params: Record<string, number | string>,
    valid: (v: unknown) => v is T,
    fallback: () => Promise<T>,
  ): Promise<T> {
    try {
      const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
      const res = await doFetch(`${base}${path}?${query}`, {
        signal: AbortSignal.timeout(options.timeoutMs ?? DATA_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body: unknown = await res.json();
      if (!valid(body)) throw new Error("unexpected response shape");
      return body;
    } catch (err) {
      log(`[data] ${path} failed, using the scenario instead: ${String(err)}`);
      return markFallback(await fallback());
    }
  }

  return {
    getHazards: (lat, lng, radiusKm) =>
      ask("/hazards", { lat, lng, radius_km: radiusKm }, isHazardList, () => options.fallback.getHazards(lat, lng, radiusKm)),
    getRoute: (fromLat, fromLng, toLat, toLng, profile) =>
      ask(
        "/route",
        {
          from_lat: fromLat,
          from_lng: fromLng,
          to_lat: toLat,
          to_lng: toLng,
          ...(profile === "foot" ? { profile } : {}),
        },
        isRoute,
        () => options.fallback.getRoute(fromLat, fromLng, toLat, toLng),
      ),
    getShelters: (lat, lng) => ask("/shelters", { lat, lng }, isShelterList, () => options.fallback.getShelters(lat, lng)),
    getWeather: (lat, lng) => ask("/weather", { lat, lng }, isWeather, () => options.fallback.getWeather(lat, lng)),
  };
}
