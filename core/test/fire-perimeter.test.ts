/**
 * Geometry checks for the projected fire perimeter and arrival times.
 *
 * The ellipse itself is validated against BehavePlus in
 * fire-rothermel.test.ts. These check the map geometry built on it.
 */
import { describe, expect, it } from "vitest";
import { distanceKm } from "../src/lib/geo.js";
import { arrivalMinutes, perimeterAt, type SpreadEllipse } from "../src/fire/perimeter.js";

const C = { lat: 42.365, lng: -71.122 };
// Head 30 m/min to the south-west (225), back 3, flank 8.
const E: SpreadEllipse = { headRate: 30, backRate: 3, flankRate: 8, headDirectionDeg: 225 };

/**
 * A point some metres from the centre in a compass direction.
 *
 * Args:
 *     deg (number): Direction, degrees from north.
 *     m (number): Distance, metres.
 *
 * Returns:
 *     { lat: number, lng: number }: The point.
 */
function at(deg: number, m: number) {
  const r = (deg * Math.PI) / 180;
  const k = Math.cos((C.lat * Math.PI) / 180);
  return { lat: C.lat + (m * Math.cos(r)) / 111_320, lng: C.lng + (m * Math.sin(r)) / (111_320 * k) };
}

describe("projected perimeter", () => {
  it("from a point ignition is the BehavePlus ellipse: head, back and flank distances", () => {
    const poly = perimeterAt(C, 0, E, 60, 360);
    const far = (deg: number) => Math.max(...poly.map((p) => (distanceKm(C.lat, C.lng, p.lat, p.lng) * 1000) * Math.cos(bearingDiff(p, deg))));
    expect(far(225)).toBeCloseTo(30 * 60, -1); // head 1800 m
    expect(far(45)).toBeCloseTo(3 * 60, -1); // back 180 m
  });

  it("grows the current fire circle outward, never inside it", () => {
    const poly = perimeterAt(C, 1000, E, 30);
    for (const p of poly) expect(distanceKm(C.lat, C.lng, p.lat, p.lng) * 1000).toBeGreaterThanOrEqual(1000 + 3 * 30 - 15);
  });
});

describe("arrival time", () => {
  it("is distance over the head rate straight downwind, and over the back rate upwind", () => {
    expect(arrivalMinutes(C, 1000, E, at(225, 1000 + 30 * 20))).toBeCloseTo(20, 1);
    expect(arrivalMinutes(C, 1000, E, at(45, 1000 + 3 * 20))).toBeCloseTo(20, 1);
  });

  it("is 0 inside the fire and Infinity when nothing spreads", () => {
    expect(arrivalMinutes(C, 1000, E, at(0, 500))).toBe(0);
    expect(arrivalMinutes(C, 1000, { ...E, headRate: 0, backRate: 0, flankRate: 0 }, at(0, 2000))).toBe(Infinity);
  });

  it("matches the perimeter: a vertex at t minutes is reached at about t", () => {
    for (const p of perimeterAt(C, 1000, E, 45, 24)) expect(arrivalMinutes(C, 1000, E, p)).toBeCloseTo(45, 0);
  });
});

/**
 * Angle between the bearing from the centre to p and a direction, radians.
 *
 * Args:
 *     p ({ lat: number, lng: number }): The point.
 *     deg (number): The direction, degrees from north.
 *
 * Returns:
 *     number: The angle.
 */
function bearingDiff(p: { lat: number; lng: number }, deg: number): number {
  const k = Math.cos((C.lat * Math.PI) / 180);
  const b = Math.atan2((p.lng - C.lng) * k, p.lat - C.lat);
  return b - (deg * Math.PI) / 180;
}
