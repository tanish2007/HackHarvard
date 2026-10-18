/**
 * Tests for the incident store and the Contract D body it produces.
 *
 * A missing key or a null list breaks the map mid-demo, so the shape is
 * checked strictly here.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { distanceKm } from "../src/lib/geo.js";
import { loadScenario } from "../src/scenario/load.js";
import { IncidentStore } from "../src/state/store.js";

const ROOT = join(import.meta.dirname, "..", "..");
const LISTS = ["hazards", "shelters", "people", "volunteers", "reports", "units", "timeline"] as const;
const STATUSES = ["safe", "unconfirmed", "sos", "en_route"];

/**
 * Build a store on the committed scenario with a clock the test controls.
 *
 * Returns:
 *     { store: IncidentStore, advance: (sec: number) => void }: The store and
 *         a function that moves the clock forward.
 */
function makeStore() {
  let t = Date.parse("2026-10-17T14:00:00Z");
  const store = new IncidentStore(loadScenario({ dir: ROOT, useLocal: false }), () => new Date(t));
  return { store, advance: (sec: number) => (t += sec * 1000) };
}

describe("Contract D shape", () => {
  it("has every top-level key, and every list is an array", () => {
    const s = makeStore().store.snapshot();
    expect(Object.keys(s).sort()).toEqual([...LISTS, "counts", "incident"].sort());
    for (const key of LISTS) expect(Array.isArray(s[key])).toBe(true);
    expect(s.incident).toEqual({ name: "Oak Ridge Fire", updated_at: "2026-10-17T14:00:00.000Z" });
  });

  it("gives every person exactly the Contract D fields and a valid status", () => {
    for (const p of makeStore().store.snapshot().people) {
      expect(Object.keys(p).sort()).toEqual(["language", "last_contact", "lat", "lng", "name", "person_id", "status"]);
      expect(STATUSES).toContain(p.status);
      expect(typeof p.lat).toBe("number");
      expect(typeof p.lng).toBe("number");
    }
  });

  it("uses the Contract C shapes for hazards and shelters", () => {
    const s = makeStore().store.snapshot();
    expect(Object.keys(s.hazards[0]).sort()).toEqual(
      ["id", "kind", "lat", "lng", "radius_km", "severity", "source", "updated_at"].sort(),
    );
    expect(Object.keys(s.shelters[0]).sort()).toEqual(
      ["capacity_note", "distance_km", "id", "lat", "lng", "name"].sort(),
    );
  });
});

describe("counts", () => {
  it("match the people list and the scenario", () => {
    const s = makeStore().store.snapshot();
    // 2 named residents (unconfirmed) + 48 simulated (45 safe, 3 unconfirmed).
    expect(s.people).toHaveLength(50);
    expect(s.counts).toEqual({ safe: 45, unconfirmed: 5, sos: 0, en_route: 0 });
    const total = s.counts.safe + s.counts.unconfirmed + s.counts.sos + s.counts.en_route;
    expect(total).toBe(s.people.length);
  });
});

describe("people and volunteers", () => {
  it("lists volunteers separately from residents", () => {
    const s = makeStore().store.snapshot();
    expect(s.volunteers.map((v) => v.volunteer_id)).toEqual(["v_sam"]);
    expect(s.people.some((p) => p.person_id === "v_sam")).toBe(false);
  });

  it("starts everyone with no last contact", () => {
    expect(makeStore().store.snapshot().people.every((p) => p.last_contact === null)).toBe(true);
  });
});

describe("timeline", () => {
  it("stamps entries and moves incident.updated_at", () => {
    const { store, advance } = makeStore();
    advance(30);
    store.addTimeline({ channel: "radio", who: "Unit 4", text: "Relay, wind forecast?" });
    const s = store.snapshot();
    expect(s.timeline).toEqual([
      { at: "2026-10-17T14:00:30.000Z", channel: "radio", who: "Unit 4", text: "Relay, wind forecast?" },
    ]);
    expect(s.incident.updated_at).toBe("2026-10-17T14:00:30.000Z");
  });

  it("keeps only the newest 200 entries", () => {
    const { store } = makeStore();
    for (let i = 0; i < 205; i++) store.addTimeline({ channel: "system", who: "Relay", text: `entry ${i}` });
    const { timeline } = store.snapshot();
    expect(timeline).toHaveLength(200);
    expect(timeline[0].text).toBe("entry 5");
  });
});

describe("reset and isolation", () => {
  it("reset clears live state back to the scenario", () => {
    const { store } = makeStore();
    store.addTimeline({ channel: "system", who: "Relay", text: "x" });
    store.reset();
    expect(store.snapshot().timeline).toEqual([]);
  });

  it("returns a copy, so callers cannot change the store", () => {
    const { store } = makeStore();
    const s = store.snapshot();
    s.people[0].status = "sos";
    s.timeline.push({ at: "", channel: "", who: "", text: "" });
    expect(store.snapshot().counts.sos).toBe(0);
    expect(store.snapshot().timeline).toEqual([]);
  });
});

describe("distanceKm", () => {
  it("is zero for the same point and about 1.11 km per 0.01 degree of latitude", () => {
    expect(distanceKm(37.86, -122.22, 37.86, -122.22)).toBe(0);
    expect(distanceKm(37.86, -122.22, 37.87, -122.22)).toBeCloseTo(1.11, 1);
  });
});
