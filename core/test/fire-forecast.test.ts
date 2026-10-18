/**
 * The fire spread forecast in Core: from Start fire to /state and the agent.
 */
import { describe, expect, it } from "vitest";
import { createHazardWatcher } from "../src/alerts/watcher.js";
import { createStubData } from "../src/data/stub.js";
import { computeSpread, windFromDegrees } from "../src/fire/forecast.js";
import { makeStore, recordingDispatcher, runTool, toolContext } from "./helpers.js";

/**
 * A store with the staged fire turned on, as the Start fire button does.
 *
 * Returns:
 *     Promise<ReturnType<typeof makeStore>>: The store, after the watcher ran.
 */
async function withFire() {
  const made = makeStore();
  const { dispatcher } = recordingDispatcher();
  await createHazardWatcher({ store: made.store, data: createStubData(made.store.scenario), dispatcher, log: () => {} }).runOnce();
  return made;
}

describe("wind direction", () => {
  it("reads compass words and degrees, and gives up on variable winds", () => {
    expect(windFromDegrees("NE")).toBe(45);
    expect(windFromDegrees("SSW")).toBe(202.5);
    expect(windFromDegrees("north-east")).toBe(45);
    expect(windFromDegrees("270")).toBe(270);
    expect(windFromDegrees("Variable")).toBeNull();
  });
});

describe("spread forecast", () => {
  it("puts a forecast on the fire in /state when the fire starts", async () => {
    const { store } = await withFire();
    const fire = store.snapshot().hazards.find((h) => h.kind === "fire");
    expect(fire?.spread).toMatchObject({ fuel_model: "GR2", moisture_scenario: "D1L1", wind_from_deg: 45 });
    // A northeast wind pushes the head fire to the southwest.
    expect(fire?.spread?.head_direction_deg).toBe(225);
    expect(fire?.spread?.forecast.map((f) => f.minutes)).toEqual([30, 60, 120]);
    expect(fire?.spread?.forecast[0].polygon.length).toBe(72);
  });

  it("grows each forecast perimeter beyond the last", async () => {
    const { store } = await withFire();
    const spread = store.snapshot().hazards.find((h) => h.spread)!.spread!;
    const southmost = spread.forecast.map((f) => Math.min(...f.polygon.map((p) => p.lat)));
    expect(southmost[1]).toBeLessThan(southmost[0]);
    expect(southmost[2]).toBeLessThan(southmost[1]);
  });

  it("gives the agent the heading and an arrival estimate", async () => {
    const { store } = await withFire();
    const out = await runTool("get_hazards", {}, toolContext(store));
    expect(out.hazards[0]).toMatchObject({ spread_heading_toward: "southwest" });
    expect(out.hazards[0].spread_km_per_hour).toBeGreaterThan(0);
    // Amit is upwind (north-east) of the fire, so it backs toward him slowly.
    expect(out.hazards[0].estimated_minutes_until_it_reaches_here).toBeGreaterThan(0);
  });

  it("drops the forecast when the fire is cleared, and makes none for fuel that cannot burn", async () => {
    const { store } = await withFire();
    store.setHazards([]);
    expect(store.snapshot().hazards).toEqual([]);
    const fire = { id: "f", kind: "fire" as const, lat: 42.365, lng: -71.122, radius_km: 1, severity: "high", source: "test", updated_at: "" };
    const urban = { ...store.scenario, fire_behavior: { ...store.scenario.fire_behavior, fuel_model: "NB1" } };
    const weather = { summary: "", wind_mph: 20, wind_dir: "NE", temp_f: 90, next_2h: "", source: "test" };
    expect(computeSpread(fire, weather, urban, "")).toBeNull();
  });
});
