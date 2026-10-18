/**
 * Tests for distanceKm and compassDirection. distanceKm ranks shelters and
 * decides who is inside the alert radius. compassDirection tells people
 * which way the fire is.
 */
import { describe, expect, it } from "vitest";
import { compassDirection, distanceKm, escapeFrom, judgeMove } from "../src/lib/geo.js";
import { replies } from "../src/event/replies.js";

const pairs: [string, number, number, number, number][] = [
  ["two demo shelters", 37.87, -122.27, 37.847, -122.258],
  ["the fire and a resident", 37.872, -122.205, 37.851, -122.224],
  ["across the equator", 10, 20, -10, -20],
  ["across the date line", 0, 179.5, 1, -179.5],
  ["Boston and San Francisco", 42.36, -71.06, 37.77, -122.42],
];

describe("distanceKm", () => {
  it.each(pairs)("is the same both ways for %s", (_label, aLat, aLng, bLat, bLng) => {
    expect(distanceKm(aLat, aLng, bLat, bLng)).toBe(distanceKm(bLat, bLng, aLat, aLng));
  });

  it.each(pairs)("is positive and rounded to 2 decimals for %s", (_label, aLat, aLng, bLat, bLng) => {
    const d = distanceKm(aLat, aLng, bLat, bLng);
    expect(d).toBeGreaterThan(0);
    expect(Math.round(d * 100) / 100).toBe(d);
  });

  it("is about 111.19 km per degree of longitude on the equator", () => {
    expect(distanceKm(0, 0, 0, 1)).toBe(111.19);
  });

  it("is half the earth's circumference between opposite points", () => {
    expect(distanceKm(0, 0, 0, 180)).toBe(20015.09);
    expect(distanceKm(90, 0, -90, 0)).toBe(20015.09);
  });

  it("takes the short way across the date line", () => {
    expect(distanceKm(0, 179.99, 0, -179.99)).toBe(2.22);
  });

  it("is zero between two points on the same pole", () => {
    expect(distanceKm(90, 0, 90, 120)).toBe(0);
  });

  it("shrinks longitude distance with latitude", () => {
    expect(distanceKm(60, 0, 60, 1)).toBeCloseTo(distanceKm(0, 0, 0, 1) / 2, 0);
  });

  it("matches a known real distance within 1%", () => {
    // Boston to San Francisco is about 4,340 km great-circle.
    expect(distanceKm(42.36, -71.06, 37.77, -122.42)).toBeGreaterThan(4300);
    expect(distanceKm(42.36, -71.06, 37.77, -122.42)).toBeLessThan(4385);
  });

  it("obeys the triangle inequality, allowing for rounding", () => {
    const ab = distanceKm(37.87, -122.27, 37.86, -122.225);
    const bc = distanceKm(37.86, -122.225, 37.872, -122.205);
    const ac = distanceKm(37.87, -122.27, 37.872, -122.205);
    expect(ac).toBeLessThanOrEqual(ab + bc + 0.01);
  });
});

describe("compassDirection", () => {
  const C = [37.86, -122.225] as const;

  it.each([
    ["north", 37.9, -122.225],
    ["northeast", 37.9, -122.174],
    ["east", 37.86, -122.18],
    ["southeast", 37.82, -122.174],
    ["south", 37.82, -122.225],
    ["southwest", 37.82, -122.276],
    ["west", 37.86, -122.27],
    ["northwest", 37.9, -122.276],
  ])("points %s", (word, lat, lng) => {
    expect(compassDirection(C[0], C[1], lat, lng)).toBe(word);
  });

  it("gives the opposite word the other way round", () => {
    expect(compassDirection(37.872, -122.205, 37.851, -122.224)).toBe("southwest");
    expect(compassDirection(37.851, -122.224, 37.872, -122.205)).toBe("northeast");
  });

  it("always returns one of the 8 words", () => {
    const words = new Set(["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]);
    for (let deg = 0; deg < 360; deg += 7) {
      const lat = C[0] + 0.05 * Math.cos((deg * Math.PI) / 180);
      const lng = C[1] + 0.05 * Math.sin((deg * Math.PI) / 180);
      expect(words.has(compassDirection(C[0], C[1], lat, lng))).toBe(true);
    }
  });

  it("says north for the same point rather than failing", () => {
    expect(compassDirection(C[0], C[1], C[0], C[1])).toBe("north");
  });
});

describe("escapeFrom", () => {
  // Amit is southwest of the scenario fire, so away is southwest.
  const fire = { lat: 37.872, lng: -122.205, radius_km: 1.2 };

  it("points directly away from the nearest fire", () => {
    expect(escapeFrom(37.851, -122.224, [fire])).toMatchObject({ direction: "northeast", away: "southwest", inside: false });
    expect(escapeFrom(37.851, -122.224, [])).toBeNull();
  });

  it("puts the escape direction in the check-in call, in the person's language", () => {
    const escape = escapeFrom(37.851, -122.224, [fire])!;
    expect(replies.checkinCall("Oak Ridge Fire", "en", escape)).toMatch(/northeast of you\. To get away from the fire, head southwest\. Are you safe/);
    expect(replies.checkinCall("Oak Ridge Fire", "es", escape)).toContain("suroeste");
    expect(replies.checkinCall("Oak Ridge Fire", "en")).not.toMatch(/head/);
  });
});

describe("judgeMove", () => {
  const goal = { lat: 42.3778, lng: -71.1186 };

  it("calls a move toward the shelter the right way", () => {
    expect(judgeMove(42.374, -71.1175, 42.376, -71.118, goal.lat, goal.lng)).toMatchObject({ judgment: "closer", walked: "north" });
  });

  it("calls a move away from the shelter the wrong way", () => {
    expect(judgeMove(42.374, -71.1175, 42.37, -71.1175, goal.lat, goal.lng)).toMatchObject({ judgment: "farther", walked: "south" });
  });

  it("ignores a shift too small to be a real step", () => {
    expect(judgeMove(42.374, -71.1175, 42.37405, -71.1175, goal.lat, goal.lng).judgment).toBe("still");
  });
});
