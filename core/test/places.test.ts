/**
 * Tests for resolvePlace, which turns a spoken place ("route to Oak St",
 * "nearest shelter") into coordinates from scenario.json.
 */
import { describe, expect, it } from "vitest";
import { resolvePlace, type Point } from "../src/agent/places.js";
import { makeStore } from "./helpers.js";

const { store } = makeStore();
const AMIT: Point = { name: "the sender's location", lat: 37.851, lng: -122.224 };
const CP: Point = { name: "Command Post", lat: 37.8605, lng: -122.255 };

/**
 * Resolve a query against the committed scenario.
 *
 * Args:
 *     query (string | undefined): The spoken place.
 *     origin (Point): Where "me" and "nearest" are measured from.
 *
 * Returns:
 *     string | null: The resolved place name, or null.
 */
function nameOf(query: string | undefined, origin: Point = AMIT): string | null {
  return resolvePlace(query, origin, store.scenario, store.listPeople())?.name ?? null;
}

describe("resolvePlace", () => {
  it.each([
    [undefined, "the sender's location"],
    ["here", "the sender's location"],
    ["Shelter C", "Shelter C"],
    ["oak street", "Oak St"],
    ["hwy 24", "Route 24"],
    ["Zone 3", "Zone 3"],
    ["Priya", "Priya"],
    ["nearest shelter", "Shelter C"],
    ["Mars", null],
    ["oak stadium", null],
  ])("resolves %j to %j", (query, expected) => {
    expect(nameOf(query)).toBe(expected);
  });

  it("checks shelter, then place, then zone, then person", () => {
    expect(nameOf("Shelter A by Oak St")).toBe("Shelter A");
    expect(nameOf("Oak St in Zone 3")).toBe("Oak St");
    expect(nameOf("Amit in Zone 2")).toBe("Zone 2");
  });

  it("measures the nearest shelter from the origin", () => {
    expect(nameOf("nearest shelter", CP)).toBe("Shelter B");
  });
});
