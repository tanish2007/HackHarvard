/**
 * Tests for the Contract C data stub, which stands in for Rudra's fake mode
 * (data/api.py with DATA_MODE=fake). Shapes must match Contract C so the
 * real client can be swapped in without changing agent code.
 */
import { describe, expect, it } from "vitest";
import { createStubData } from "../src/data/stub.js";
import { distanceKm } from "../src/lib/geo.js";
import { loadScenario } from "../src/scenario/load.js";
import { ROOT } from "./helpers.js";

const scenario = loadScenario({ dir: ROOT, useLocal: false });
const data = createStubData(scenario);
const AMIT = { lat: 37.851, lng: -122.224 };

describe("data stub", () => {
  it("returns the fire near the fire and [] when out of range", async () => {
    expect(await data.getHazards(AMIT.lat, AMIT.lng, 5)).toEqual([
      expect.objectContaining({ id: "hz_scenario_fire", kind: "fire", radius_km: 1.2, source: "fake" }),
    ]);
    expect(await data.getHazards(0, 0, 50)).toEqual([]);
  });

  it("returns shelters nearest first with source fake", async () => {
    const shelters = await data.getShelters(AMIT.lat, AMIT.lng);
    expect(shelters.map((s) => s.id)).toEqual(["sh_c", "sh_b", "sh_a"]);
    expect(shelters.every((s) => s.source === "fake")).toBe(true);
  });

  it("returns fake_weather from the scenario", async () => {
    expect(await data.getWeather(AMIT.lat, AMIT.lng)).toEqual({ ...scenario.fake_weather, source: "fake" });
  });

  it("goes straight when the line misses the fire", async () => {
    const r = await data.getRoute(AMIT.lat, AMIT.lng, 37.847, -122.258);
    expect(r.polyline).toHaveLength(2);
    expect(r.avoided_hazards).toEqual([]);
  });

  it("detours around the fire when the line crosses it, and stays outside it", async () => {
    const r = await data.getRoute(37.872, -122.17, 37.872, -122.24);
    expect(r.polyline).toHaveLength(3);
    expect(r.avoided_hazards).toEqual(["hz_scenario_fire"]);
    const w = r.polyline[1];
    expect(distanceKm(w.lat, w.lng, 37.872, -122.205)).toBeGreaterThan(1.2);
    expect(r.distance_km).toBeGreaterThan(distanceKm(37.872, -122.17, 37.872, -122.24));
  });
});
