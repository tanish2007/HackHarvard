/**
 * Tests for distanceKm, which ranks shelters and will decide who is inside
 * the alert radius.
 */
import { describe, expect, it } from "vitest";
import { distanceKm } from "../src/lib/geo.js";

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
