/**
 * Tests for the scenario loader, including the privacy guard that keeps real
 * phone numbers out of the public repo.
 */
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenario, placeholderIds } from "../src/scenario/load.js";
import { PLACEHOLDER_PHONE } from "../src/scenario/schema.js";

const ROOT = join(import.meta.dirname, "..", "..");
const COMMITTED_FILES = ["scenario.json", "scenario.local.example.json"];

/**
 * Collect every string in a JSON value that looks like a phone number.
 *
 * Args:
 *     value (unknown): Parsed JSON.
 *
 * Returns:
 *     string[]: All strings shaped like E.164 numbers.
 */
function phonesIn(value: unknown): string[] {
  if (typeof value === "string") return /^\+?\d[\d\s().-]{6,}$/.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(phonesIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(phonesIn);
  return [];
}

/**
 * Make a temp folder holding a copy of the committed scenario.json.
 *
 * Returns:
 *     string: Path of the temp folder.
 */
function tempScenarioDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-scenario-"));
  copyFileSync(join(ROOT, "scenario.json"), join(dir, "scenario.json"));
  return dir;
}

describe("privacy guard", () => {
  it.each(COMMITTED_FILES)("%s only contains fictional 555-01xx numbers", (file) => {
    const phones = phonesIn(JSON.parse(readFileSync(join(ROOT, file), "utf8")));
    expect(phones.length).toBeGreaterThan(0);
    for (const phone of phones) expect(phone).toMatch(PLACEHOLDER_PHONE);
  });
});

describe("loadScenario", () => {
  it("loads the committed scenario", () => {
    const s = loadScenario({ dir: ROOT, useLocal: false });
    expect(s.incident.name).toBe("Oak Ridge Fire");
    expect(s.shelters.length).toBeGreaterThan(0);
  });

  it("generates the simulated population the same way every time", () => {
    const a = loadScenario({ dir: ROOT, useLocal: false });
    const b = loadScenario({ dir: ROOT, useLocal: false });
    const sim = a.people.filter((p) => p.simulated);
    expect(sim).toHaveLength(48);
    expect(sim.filter((p) => p.initial_status === "unconfirmed")).toHaveLength(3);
    expect(sim.every((p) => p.phone === null)).toBe(true);
    expect(a.people).toEqual(b.people);
  });

  it("reports every placeholder when no local file is used", () => {
    const ids = placeholderIds(loadScenario({ dir: ROOT, useLocal: false }));
    expect(ids).toEqual(expect.arrayContaining(["p_amit", "u_4", "emergency_contact", "relay_lines.voice"]));
  });

  it("merges real numbers from scenario.local.json", () => {
    const dir = tempScenarioDir();
    writeFileSync(
      join(dir, "scenario.local.json"),
      JSON.stringify({
        relay_lines: { voice: "+14155559000" },
        phones: { p_amit: "+14155559001", u_4: "+14155559002", emergency_contact: "+14155559003" },
      }),
    );
    const s = loadScenario({ dir });
    expect(s.people.find((p) => p.person_id === "p_amit")?.phone).toBe("+14155559001");
    expect(s.units[0].phone).toBe("+14155559002");
    expect(s.emergency_contact.phone).toBe("+14155559003");
    expect(s.relay_lines.voice).toBe("+14155559000");
    expect(s.relay_lines.messaging).toBe("+16175550100");
  });

  it("rejects an override for an id that does not exist", () => {
    const dir = tempScenarioDir();
    writeFileSync(join(dir, "scenario.local.json"), JSON.stringify({ phones: { p_nobody: "+14155559001" } }));
    expect(() => loadScenario({ dir })).toThrow(/unknown id "p_nobody"/);
  });

  it("rejects anything other than phone numbers in the override", () => {
    const dir = tempScenarioDir();
    writeFileSync(join(dir, "scenario.local.json"), JSON.stringify({ incident: { name: "x" } }));
    expect(() => loadScenario({ dir })).toThrow();
  });
});
