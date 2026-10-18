/**
 * Tests for the simulated population the loader generates.
 *
 * These are the ~48 people behind "47 safe, 3 unconfirmed" on the dashboard.
 * They must come out the same on every run, so two demo runs in a row match.
 */
import { describe, expect, it } from "vitest";
import { loadScenario } from "../src/scenario/load.js";
import type { ScenarioPerson } from "../src/scenario/schema.js";
import { loadEdited, ROOT, type ScenarioJson } from "./helpers.js";

/**
 * The simulated people from a scenario.
 *
 * Args:
 *     people (ScenarioPerson[]): Everyone in a loaded scenario.
 *
 * Returns:
 *     ScenarioPerson[]: Only the simulated ones, in generated order.
 */
function simulated(people: ScenarioPerson[]): ScenarioPerson[] {
  return people.filter((p) => p.simulated);
}

/**
 * Load the committed scenario with a different simulated_population.
 *
 * Args:
 *     population (ScenarioJson): Fields to override.
 *
 * Returns:
 *     ScenarioPerson[]: The simulated people that come out.
 */
function simulateWith(population: ScenarioJson): ScenarioPerson[] {
  return simulated(loadEdited((f) => Object.assign(f.simulated_population, population)).people);
}

const committed = loadScenario({ dir: ROOT, useLocal: false });
const reloaded = loadEdited(() => {});

describe("ids and order", () => {
  it("puts named people first, then sim_001 to sim_048", () => {
    const ids = committed.people.map((p) => p.person_id);
    expect(ids.slice(0, 3)).toEqual(["p_amit", "p_priya", "v_sam"]);
    expect(ids.slice(3)).toEqual(Array.from({ length: 48 }, (_, i) => `sim_${String(i + 1).padStart(3, "0")}`));
  });
});

describe("name suffixes", () => {
  it("uses the plain names first, then adds A. once the 24 names run out", () => {
    const names = simulated(committed.people).map((p) => p.name);
    const base = ["Alex", "Bea", "Carlos", "Dana", "Eli", "Fatima", "Grace", "Hiro", "Ines", "Jamal", "Kai", "Lena",
      "Mateo", "Nora", "Omar", "Pia", "Quinn", "Rosa", "Sanjay", "Tess", "Uma", "Victor", "Wen", "Yara"];
    expect(names.slice(0, 24)).toEqual(base);
    expect(names.slice(24)).toEqual(base.map((n) => `${n} A.`));
  });

  it("gives every committed simulated person a different name", () => {
    const names = simulated(committed.people).map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("moves to B., C. and so on with each extra round", () => {
    const names = simulateWith({ count: 7, unconfirmed: 0, names: ["Ann", "Ben"] }).map((p) => p.name);
    expect(names).toEqual(["Ann", "Ben", "Ann A.", "Ben A.", "Ann B.", "Ben B.", "Ann C."]);
  });

  it("reaches Z. on the 27th use of a single name", () => {
    const names = simulateWith({ count: 27, unconfirmed: 0, names: ["Ann"] }).map((p) => p.name);
    expect(names[0]).toBe("Ann");
    expect(names[1]).toBe("Ann A.");
    expect(names[26]).toBe("Ann Z.");
    expect(new Set(names).size).toBe(27);
  });
});

describe("statuses", () => {
  it("makes the first 3 committed people unconfirmed and the rest safe", () => {
    const statuses = simulated(committed.people).map((p) => p.initial_status);
    expect(statuses.slice(0, 3)).toEqual(["unconfirmed", "unconfirmed", "unconfirmed"]);
    expect(statuses.slice(3).every((s) => s === "safe")).toBe(true);
  });

  it("puts sos first, then unconfirmed, then safe", () => {
    const statuses = simulateWith({ count: 6, sos: 2, unconfirmed: 1 }).map((p) => p.initial_status);
    expect(statuses).toEqual(["sos", "sos", "unconfirmed", "safe", "safe", "safe"]);
  });

  it("generates nobody when count is 0", () => {
    expect(simulateWith({ count: 0, sos: 0, unconfirmed: 0 })).toEqual([]);
  });
});

describe("placement and fields", () => {
  it("spreads people across the zones in turn", () => {
    const zones = simulated(committed.people).map((p) => p.zone);
    zones.forEach((zone, i) => expect(zone).toBe(committed.zones[i % 3].id));
  });

  it("places each person inside their zone's bounding box", () => {
    for (const p of simulated(committed.people)) {
      const zone = committed.zones.find((z) => z.id === p.zone)!;
      const lats = zone.polygon.map(([lat]) => lat);
      const lngs = zone.polygon.map(([, lng]) => lng);
      expect(p.lat).toBeGreaterThanOrEqual(Math.min(...lats));
      expect(p.lat).toBeLessThanOrEqual(Math.max(...lats));
      expect(p.lng).toBeGreaterThanOrEqual(Math.min(...lngs));
      expect(p.lng).toBeLessThanOrEqual(Math.max(...lngs));
    }
  });

  it("rounds coordinates to at most 5 decimal places", () => {
    for (const p of simulated(committed.people)) {
      expect(Math.round(p.lat * 1e5) / 1e5).toBe(p.lat);
      expect(Math.round(p.lng * 1e5) / 1e5).toBe(p.lng);
    }
  });

  it("cycles through the language list", () => {
    const langs = simulated(committed.people).map((p) => p.language);
    expect(langs.slice(0, 6)).toEqual(["en", "en", "en", "es", "zh", "gu"]);
    expect(langs.slice(6, 12)).toEqual(["en", "en", "en", "es", "zh", "gu"]);
  });

  it("makes simulated people residents with no phone, household, or family", () => {
    for (const p of simulated(committed.people)) {
      expect(p).toMatchObject({ role: "resident", phone: null, household_id: null, family_contact: null });
    }
  });
});

describe("seed", () => {
  it("gives the same people from a fresh copy of the same file", () => {
    expect(reloaded.people).toEqual(committed.people);
  });

  it("moves people with a different seed but keeps names and statuses", () => {
    const other = simulateWith({ seed: 8 });
    const base = simulated(committed.people);
    expect(other.map((p) => p.name)).toEqual(base.map((p) => p.name));
    expect(other.map((p) => p.initial_status)).toEqual(base.map((p) => p.initial_status));
    expect(other.map((p) => [p.lat, p.lng])).not.toEqual(base.map((p) => [p.lat, p.lng]));
  });
});
