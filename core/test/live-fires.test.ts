/**
 * Live NASA FIRMS fires: shown with a spread forecast, never alerting.
 */
import { describe, expect, it } from "vitest";
import { createHazardWatcher } from "../src/alerts/watcher.js";
import { createStubData } from "../src/data/stub.js";
import { createLiveFireFeed } from "../src/fire/live.js";
import { makeStore, recordingDispatcher, runTool, toolContext } from "./helpers.js";

/** A FIRMS cluster as the map server's /firms returns it. */
const fire = (id: string, lat: number, lng: number) => ({
  id, kind: "fire", lat, lng, radius_km: 1, severity: "extreme", source: "firms", updated_at: "2026-10-18T00:00:00Z",
});

const IDAHO = fire("firms_43.33_-116.37", 43.33, -116.37);
const QUEBEC = fire("firms_45.84_-73.25", 45.84, -73.25);
const NWS = { summary: "Clear", wind_mph: 15, wind_dir: "W", temp_f: 60, next_2h: "", source: "nws" };

/**
 * A fake map server: /firms per area name, /live-weather only for Idaho.
 *
 * Args:
 *     firms (Record<string, unknown[]>): Rows by area name in the query.
 *
 * Returns:
 *     typeof fetch: The fake.
 */
function mapServer(firms: unknown[][]): typeof fetch {
  let call = 0;
  return (async (url: string | URL) => {
    const u = String(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (u.includes("/firms?")) return json(firms[call++ % firms.length]);
    if (u.includes("/live-weather?")) return u.includes("lat=43.33") ? json(NWS) : json({ error: "404" }, 502);
    return json({}, 404);
  }) as typeof fetch;
}

describe("live NASA fires", () => {
  it("shows each fire once with its area, and a forecast only where there is live wind", async () => {
    const { store } = makeStore();
    const feed = createLiveFireFeed({ store, baseUrl: "http://map", fetchImpl: mapServer([[], [QUEBEC], [IDAHO, QUEBEC]]), log: () => {} });
    expect(await feed.refresh()).toBe(2);
    const live = store.snapshot().hazards.filter((h) => h.source === "firms");
    expect(live.map((h) => h.area)).toEqual(["Northeast US", "Western US"]);
    const idaho = live.find((h) => h.id === IDAHO.id)!;
    // A west wind pushes the fire east. The note says what was assumed.
    expect(idaho.spread?.head_direction_deg).toBe(90);
    expect(idaho.spread?.note).toMatch(/assumed/);
    expect(live.find((h) => h.id === QUEBEC.id)?.spread).toBeUndefined();
  });

  it("never triggers alerts, even right next to a resident", async () => {
    const { store } = makeStore();
    const amit = store.getPerson("p_amit")!;
    const feed = createLiveFireFeed({ store, baseUrl: "http://map", fetchImpl: mapServer([[fire("firms_amit", amit.lat!, amit.lng!)]]), log: () => {} });
    await feed.refresh();
    const { dispatcher, pushed } = recordingDispatcher();
    const noIncidentFire = { ...createStubData(store.scenario), getHazards: async () => [] };
    await createHazardWatcher({ store, data: noIncidentFire, dispatcher, log: () => {} }).runOnce();
    expect(pushed).toEqual([]);
    expect(store.listHazards()).toEqual([]);
    expect(store.snapshot().hazards.map((h) => h.id)).toEqual(["firms_amit"]);
  });

  it("keeps the last list when the map server is down", async () => {
    const { store } = makeStore();
    await createLiveFireFeed({ store, baseUrl: "http://map", fetchImpl: mapServer([[IDAHO]]), log: () => {} }).refresh();
    const down = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    await createLiveFireFeed({ store, baseUrl: "http://map", fetchImpl: down, log: () => {} }).refresh();
    expect(store.listLiveFires().map((f) => f.id)).toEqual([IDAHO.id]);
  });

  it("lets the agent answer what NASA sees right now", async () => {
    const { store } = makeStore();
    await createLiveFireFeed({ store, baseUrl: "http://map", fetchImpl: mapServer([[IDAHO]]), log: () => {} }).refresh();
    const out = await runTool("get_live_fires", {}, toolContext(store));
    expect(out.count).toBe(1);
    expect(out.fires[0]).toMatchObject({ direction_from_incident: "west", spread_heading_toward: "east", wind: "15 mph from west" });
  });
});
