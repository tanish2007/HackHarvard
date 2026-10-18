/**
 * Live NASA FIRMS fires, with a spread forecast on each, shown next to the
 * staged incident.
 *
 * Read-only by design: these fires go to /state through
 * IncidentStore.setLiveFires, never into the incident hazards, so they
 * never trigger alerts, check-in calls, or SOS handling. The staged demo
 * fire works exactly as before.
 *
 * Fires come from the map server's GET /firms (NASA FIRMS, VIIRS, last 2
 * days, clustered), and wind from its GET /live-weather (NWS, always live).
 * Contract C still holds: Core never calls NASA or NWS itself.
 *
 * The forecast uses the live NWS wind at the fire but the scenario's fuel
 * and moisture (no fuel map), so every live forecast carries a note saying
 * so. Fires outside NWS coverage (outside the US) get no forecast rather
 * than a made-up wind.
 */
import type { StateHazard } from "../contracts.js";
import type { DataWeather } from "../data/types.js";
import { realScheduler, type Cancel, type Scheduler } from "../lib/scheduler.js";
import type { IncidentStore } from "../state/store.js";
import { computeSpread } from "./forecast.js";

/** Retry delay after a failed refresh. */
const RETRY_MS = 30_000;

/** Weather lookups at once. NWS drops requests when many arrive together. */
const WEATHER_CONCURRENCY = 3;

/**
 * Map over items with at most `limit` running at once, keeping order.
 *
 * Args:
 *     items (T[]): The inputs.
 *     limit (number): Most calls in flight at once.
 *     fn ((item: T) => Promise<R>): The async work. Should not reject.
 *
 * Returns:
 *     Promise<R[]>: Results in the same order as items.
 */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Settings for the live fire feed.
 *
 * Attributes:
 *     store (IncidentStore): Where the live fires are shown.
 *     baseUrl (string): The map server, e.g. http://localhost:8080.
 *     fetchImpl (typeof fetch | undefined): For tests.
 *     scheduler (Scheduler | undefined): For tests.
 *     log ((msg: string) => void | undefined): Defaults to console.error.
 *     timeoutMs (number | undefined): Per request. Defaults to 15000.
 */
export interface LiveFireOptions {
  store: IncidentStore;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  scheduler?: Scheduler;
  log?: (msg: string) => void;
  timeoutMs?: number;
}

/**
 * The live fire feed.
 *
 * Attributes:
 *     refresh (() => Promise<number>): Fetch now. Resolves to how many live
 *         fires are shown. Never rejects.
 *     start (() => void): Refresh now and then every refresh_minutes.
 *     stop (() => void): Stop refreshing.
 */
export interface LiveFireFeed {
  refresh(): Promise<number>;
  start(): void;
  stop(): void;
}

/**
 * Create the live fire feed.
 *
 * Args:
 *     options (LiveFireOptions): Store, map server URL, and test hooks.
 *
 * Returns:
 *     LiveFireFeed: The feed. Nothing runs until start() or refresh().
 */
export function createLiveFireFeed(options: LiveFireOptions): LiveFireFeed {
  const { store } = options;
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const scheduler = options.scheduler ?? realScheduler;
  const log = options.log ?? ((m: string) => console.error(m));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const settings = store.scenario.live_fires;
  let cancelNext: Cancel = () => {};
  let running = false;
  let lastError = "";

  /**
   * GET a JSON body from the map server.
   *
   * Args:
   *     path (string): Path and query.
   *
   * Returns:
   *     Promise<unknown>: The body.
   *
   * Raises:
   *     Error: On a non-200 answer or a network failure.
   */
  const getJson = async (path: string): Promise<unknown> => {
    const res = await doFetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${path.split("?")[0]} answered ${res.status}`);
    return res.json();
  };

  /** The areas to search. None configured means 50 km around the incident. */
  const areas = () =>
    settings.areas.length > 0
      ? settings.areas
      : [{ name: "Near the incident", ...store.scenario.incident.center, radius_km: 50 }];

  const refresh = async (): Promise<number> => {
    try {
      const found = new Map<string, StateHazard>();
      for (const area of areas()) {
        const q = `lat=${area.lat}&lng=${area.lng}&radius_km=${area.radius_km}`;
        const rows = await getJson(`/firms?${q}`);
        if (!Array.isArray(rows)) continue;
        for (const r of rows as StateHazard[]) {
          if (r?.kind !== "fire" || typeof r.lat !== "number" || typeof r.lng !== "number" || found.has(r.id)) continue;
          found.set(r.id, { ...r, source: "firms", area: area.name });
        }
      }
      const now = new Date().toISOString();
      const withForecast = async (fire: StateHazard): Promise<StateHazard> => {
        const path = `/live-weather?lat=${fire.lat}&lng=${fire.lng}`;
        let weather: DataWeather | null = null;
        // One retry: NWS sometimes fails a request it answers a moment later.
        for (let attempt = 0; attempt < 2 && !weather; attempt++) {
          try {
            weather = (await getJson(path)) as DataWeather;
          } catch {
            weather = null;
          }
        }
        // No NWS forecast here (outside the US, or NWS down): show the fire
        // without a forecast rather than guess the wind.
        if (!weather) return fire;
        const spread = computeSpread(fire, weather, store.scenario, now);
        if (!spread) return fire;
        const fb = store.scenario.fire_behavior;
        spread.note = `Live NASA detection with live NWS wind. Fuel and moisture are assumed (${fb.fuel_model}, ${fb.moisture_scenario}), with no fuel map.`;
        return { ...fire, spread };
      };
      const fires = await mapLimited([...found.values()], WEATHER_CONCURRENCY, withForecast);
      store.setLiveFires(fires);
      lastError = "";
      return fires.length;
    } catch (err) {
      // Keep the last good list on the map. Log a repeated failure once.
      const msg = String(err);
      if (msg !== lastError) log(`[live-fires] refresh failed, keeping the last list: ${msg}`);
      lastError = msg;
      return store.listLiveFires().length;
    }
  };

  /**
   * Refresh, then schedule the next one while running. After a failure
   * (e.g. the map server is not up yet) try again in 30 s instead of
   * waiting the full refresh interval.
   */
  const tick = (): void => {
    void refresh().finally(() => {
      const wait = lastError ? RETRY_MS : settings.refresh_minutes * 60_000;
      if (running) cancelNext = scheduler.schedule(tick, wait);
    });
  };

  return {
    refresh,
    start() {
      if (running || !settings.enabled) return;
      running = true;
      tick();
    },
    stop() {
      running = false;
      cancelNext();
    },
  };
}
