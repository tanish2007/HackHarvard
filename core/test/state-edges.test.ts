/**
 * Edge cases for the incident store and the Contract D body.
 *
 * Covers exact field values, empty scenarios, SOS ordering, the timeline cap
 * boundary, reset for back-to-back demo runs, and copy isolation for every
 * list, not just people and timeline.
 */
import { describe, expect, it } from "vitest";
import { distanceKm } from "../src/lib/geo.js";
import { loadEdited, makeStore, T0, type ScenarioJson } from "./helpers.js";

const LISTS = ["hazards", "shelters", "people", "volunteers", "reports", "units", "timeline"] as const;

describe("Contract D values", () => {
  it("survives a JSON round trip unchanged, so no field is ever undefined", () => {
    const s = makeStore().store.snapshot();
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it("starts with the scenario fire as the only hazard", () => {
    expect(makeStore().store.snapshot().hazards).toEqual([
      {
        id: "hz_scenario_fire",
        kind: "fire",
        lat: 37.872,
        lng: -122.205,
        radius_km: 1.2,
        severity: "high",
        source: "scenario",
        updated_at: T0,
      },
    ]);
  });

  it("lists shelters in scenario order with distance from the incident center", () => {
    const { shelters } = makeStore().store.snapshot();
    expect(shelters.map((s) => s.id)).toEqual(["sh_a", "sh_b", "sh_c"]);
    for (const s of shelters) {
      expect(s.distance_km).toBe(distanceKm(37.86, -122.225, s.lat, s.lng));
      expect(s.distance_km).toBeGreaterThan(0);
    }
    expect(shelters[2].capacity_note).toBe("Medical staff on site");
  });

  it("shows units with no last_heard and no phone number", () => {
    expect(makeStore().store.snapshot().units).toEqual([{ unit_id: "u_4", name: "Unit 4", last_heard: null }]);
  });

  it("gives volunteers exactly the proposed volunteer fields", () => {
    expect(makeStore().store.snapshot().volunteers).toEqual([
      { volunteer_id: "v_sam", name: "Sam", lat: 37.865, lng: -122.25, capacity_note: "", status: "available" },
    ]);
  });

  it("starts with no reports and no timeline", () => {
    const s = makeStore().store.snapshot();
    expect(s.reports).toEqual([]);
    expect(s.timeline).toEqual([]);
  });

  it("carries named residents' location and language from the scenario", () => {
    const people = makeStore().store.snapshot().people;
    expect(people.find((p) => p.person_id === "p_amit")).toEqual({
      person_id: "p_amit",
      name: "Amit",
      lat: 37.851,
      lng: -122.224,
      status: "unconfirmed",
      last_contact: null,
      language: "en",
    });
    expect(people.find((p) => p.person_id === "p_priya")?.language).toBe("gu");
  });

  it("never exposes a phone number or the emergency contact", () => {
    const body = JSON.stringify(makeStore().store.snapshot());
    expect(body).not.toMatch(/\+\d{7,}/);
    expect(body).not.toMatch(/emergency|911/i);
  });
});

describe("empty scenario", () => {
  it("still returns every list as [] and all counts as 0", () => {
    const scenario = loadEdited((f: ScenarioJson) => {
      Object.assign(f, { zones: [], shelters: [], people: [], units: [], agents: [] });
      Object.assign(f.simulated_population, { count: 0, sos: 0, unconfirmed: 0 });
    });
    const s = makeStore(scenario).store.snapshot();
    for (const key of LISTS.filter((k) => k !== "hazards")) expect(s[key]).toEqual([]);
    expect(s.hazards).toHaveLength(1);
    expect(s.counts).toEqual({ safe: 0, unconfirmed: 0, sos: 0, en_route: 0 });
  });
});

describe("counts and ordering", () => {
  it("puts sos residents first and keeps everyone else in scenario order", () => {
    const scenario = loadEdited((f) => Object.assign(f.simulated_population, { sos: 2, unconfirmed: 1 }));
    const s = makeStore(scenario).store.snapshot();
    expect(s.people.slice(0, 2).map((p) => p.person_id)).toEqual(["sim_001", "sim_002"]);
    expect(s.people.slice(0, 2).every((p) => p.status === "sos")).toBe(true);
    expect(s.people.slice(2, 5).map((p) => p.person_id)).toEqual(["p_amit", "p_priya", "sim_003"]);
    expect(s.counts).toEqual({ safe: 45, unconfirmed: 3, sos: 2, en_route: 0 });
  });

  it("counts en_route residents", () => {
    const scenario = loadEdited((f) => (f.people[0].initial_status = "en_route"));
    expect(makeStore(scenario).store.snapshot().counts).toEqual({ safe: 45, unconfirmed: 4, sos: 0, en_route: 1 });
  });

  it("does not count volunteers", () => {
    const scenario = loadEdited((f) => (f.people[2].initial_status = "unconfirmed"));
    expect(makeStore(scenario).store.snapshot().counts.unconfirmed).toBe(5);
  });

  it("adds up to the number of residents on the map when everyone has a location", () => {
    const scenario = loadEdited((f) => Object.assign(f.simulated_population, { count: 30, sos: 4, unconfirmed: 7 }));
    const { counts, people } = makeStore(scenario).store.snapshot();
    expect(counts.safe + counts.unconfirmed + counts.sos + counts.en_route).toBe(people.length);
    expect(people).toHaveLength(32);
  });
});

describe("timeline", () => {
  it("keeps entry 0 at exactly 200 entries and drops it at 201", () => {
    const { store } = makeStore();
    for (let i = 0; i < 200; i++) store.addTimeline({ channel: "system", who: "Relay", text: `entry ${i}` });
    expect(store.snapshot().timeline[0].text).toBe("entry 0");
    store.addTimeline({ channel: "system", who: "Relay", text: "entry 200" });
    const { timeline } = store.snapshot();
    expect(timeline).toHaveLength(200);
    expect(timeline[0].text).toBe("entry 1");
    expect(timeline[199].text).toBe("entry 200");
  });

  it("keeps entries oldest first with their own timestamps", () => {
    const { store, advance } = makeStore();
    store.addTimeline({ channel: "imessage", who: "Amit", text: "first" });
    advance(5);
    store.addTimeline({ channel: "radio", who: "Unit 4", text: "second" });
    expect(store.snapshot().timeline.map((t) => [t.at, t.text])).toEqual([
      [T0, "first"],
      ["2026-10-17T14:00:05.000Z", "second"],
    ]);
  });

  it("returns the stored entry with its timestamp", () => {
    const { store, advance } = makeStore();
    advance(12);
    expect(store.addTimeline({ channel: "voice", who: "Amit", text: "I'm ok" })).toEqual({
      at: "2026-10-17T14:00:12.000Z",
      channel: "voice",
      who: "Amit",
      text: "I'm ok",
    });
  });

  it("does not move updated_at just because someone read the state", () => {
    const { store, advance } = makeStore();
    advance(60);
    expect(store.snapshot().incident.updated_at).toBe(T0);
  });
});

describe("reset", () => {
  it("restamps updated_at and the scenario hazard with the reset time", () => {
    const { store, advance } = makeStore();
    advance(90);
    store.reset();
    const s = store.snapshot();
    expect(s.incident.updated_at).toBe("2026-10-17T14:01:30.000Z");
    expect(s.hazards[0].updated_at).toBe("2026-10-17T14:01:30.000Z");
  });

  it("gives the same state as a fresh store, so two demo runs match", () => {
    const first = makeStore();
    for (let i = 0; i < 10; i++) first.store.addTimeline({ channel: "system", who: "Relay", text: `run 1, ${i}` });
    first.store.reset();
    expect(first.store.snapshot()).toEqual(makeStore().store.snapshot());
  });

  it("can run twice in a row", () => {
    const { store } = makeStore();
    store.reset();
    const once = store.snapshot();
    store.reset();
    expect(store.snapshot()).toEqual(once);
  });
});

describe("snapshot isolation", () => {
  it("does not let a caller change hazards, shelters, units, volunteers, counts, or incident", () => {
    const { store } = makeStore();
    const before = store.snapshot();
    const s = store.snapshot();
    s.hazards[0].radius_km = 99;
    s.shelters[0].name = "changed";
    s.units[0].last_heard = "now";
    s.volunteers[0].status = "busy";
    s.counts.safe = 0;
    s.incident.name = "changed";
    s.people.push({ ...s.people[0], person_id: "p_extra" });
    expect(store.snapshot()).toEqual(before);
  });

  it("does not let a caller change the scenario through a snapshot", () => {
    const { store } = makeStore();
    store.snapshot().people[0].name = "changed";
    expect(store.scenario.people.find((p) => p.person_id === "p_amit")?.name).toBe("Amit");
  });
});
