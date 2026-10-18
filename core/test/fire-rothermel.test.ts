/**
 * Validation of the Rothermel spread model against the US Forest Service
 * BehavePlus engine. Every expected value here is copied from its test
 * suite (firelab/behave, src/testBehave/testBehave.cpp), at the same
 * tolerance of 1e-6.
 *
 * The shared scenario is BehavePlus's "GS4 low moisture": fuel model GS4,
 * moisture 6/7/8% dead and 60/90% live, 5 mph 20 ft wind, 30% slope, 50%
 * canopy cover, 30 ft canopy, crown ratio 0.5.
 */
import { describe, expect, it } from "vitest";
import { fuelModel, MOISTURE_SCENARIOS, type FuelModel } from "../src/fire/fuelModels.js";
import {
  spreadRateFromIgnition,
  surfaceFire,
  surfaceFireNorth,
  type FuelMoisture,
  type SurfaceInput,
} from "../src/fire/rothermel.js";

/** BehavePlus test tolerance. */
const TOL = 1e-6;

/** ft/min to chains/hour (1 chain = 66 ft). */
const chPerHour = (ftPerMin: number) => (ftPerMin * 60) / 66;

/**
 * Check a value to BehavePlus's tolerance after rounding to 6 decimals, as
 * its tests do.
 *
 * Args:
 *     observed (number): Our value.
 *     expected (number): BehavePlus's value.
 */
function near(observed: number, expected: number): void {
  expect(Math.abs(Math.round(observed * 1e6) / 1e6 - expected)).toBeLessThanOrEqual(TOL);
}

const LOW_MOISTURE: FuelMoisture = { oneHour: 0.06, tenHour: 0.07, hundredHour: 0.08, liveHerb: 0.6, liveWoody: 0.9 };
const CANOPY = { cover: 0.5, heightFt: 30, crownRatio: 0.5 };
const GS4 = fuelModel("GS4")!;

/**
 * The GS4 low moisture scenario, oriented relative to upslope.
 *
 * Args:
 *     changes (Partial<SurfaceInput>): Fields to change.
 *
 * Returns:
 *     SurfaceInput: The inputs.
 */
function gs4(changes: Partial<SurfaceInput> = {}): SurfaceInput {
  return {
    fuel: GS4,
    moisture: LOW_MOISTURE,
    wind: { speedMph: 5, height: "20ft" },
    windToUpslopeDeg: 0,
    slopeTan: 0.3,
    canopy: CANOPY,
    ...changes,
  };
}

/**
 * The same scenario, oriented relative to north.
 *
 * Args:
 *     windFrom (number): Wind source direction, degrees from north.
 *     aspect (number): Slope aspect, degrees.
 *     slopeTan (number): Slope as rise over run.
 *     fuel (FuelModel): Fuel model. Defaults to GS4.
 *
 * Returns:
 *     ReturnType<typeof surfaceFireNorth>: The result.
 */
function north(windFrom: number, aspect: number, slopeTan: number, fuel: FuelModel = GS4) {
  const { windToUpslopeDeg: _, ...rest } = gs4({ slopeTan, fuel });
  return surfaceFireNorth(rest, windFrom, aspect);
}

const tan30deg = Math.tan((30 * Math.PI) / 180);

describe("Rothermel spread rate, against BehavePlus", () => {
  it("upslope wind on a 30% slope: head, backing, flanking, 2 hour distance", () => {
    const f = surfaceFire(gs4());
    near(chPerHour(f.spreadRate), 8.876216);
    near(chPerHour(f.backingRate), 2.91614659);
    near(chPerHour(f.flankingRate), 5.08766627);
    near((f.spreadRate * 120) / 66, 17.7524327);
  });

  it("45 degree wind, 95 degree aspect, 30 degree slope: rate and fuel bed values", () => {
    const f = north(45, 95, tan30deg);
    near(chPerHour(f.spreadRate), 19.677584);
    near(f.characteristicSavr, 1631.128734);
    near(f.liveMoistureOfExtinction * 100, 137.968551);
    near(f.liveMoisture * 100, 85.874007);
    near(f.deadMoisture * 100, 6.005463);
    near(f.heatSource, 5177.248579);
  });

  it("heat source on flat ground with a north wind", () => {
    near(north(0, 0, 0).heatSource, 1164.267376);
  });

  it("wind across the slope and from different directions", () => {
    near(chPerHour(surfaceFire(gs4({ windToUpslopeDeg: 90 })).spreadRate), 7.091665);
    near(chPerHour(north(0, 0, 0.3).spreadRate), 8.876216);
    near(chPerHour(north(45, 215, 0.3).spreadRate), 4.113265);
    near(chPerHour(north(45, 5, 0.3).spreadRate), 8.50396);
  });

  it("fuel model 4 (chaparral) under 40% canopy, 90 degree wind, 30 degree slope", () => {
    const { windToUpslopeDeg: _, ...rest } = gs4({ fuel: fuelModel(4)!, slopeTan: tan30deg, canopy: { ...CANOPY, cover: 0.4 } });
    near(chPerHour(surfaceFireNorth(rest, 90, 0).spreadRate), 46.631688);
  });

  it("standard moisture scenarios D1L1 and D2L3", () => {
    const scenario = (name: string): FuelMoisture => {
      const [oneHour, tenHour, hundredHour, liveHerb, liveWoody] = MOISTURE_SCENARIOS[name];
      return { oneHour, tenHour, hundredHour, liveHerb, liveWoody };
    };
    near(chPerHour(surfaceFire(gs4({ moisture: scenario("D1L1") })).spreadRate), 15.023945);
    near(chPerHour(surfaceFire(gs4({ moisture: scenario("D2L3") })).spreadRate), 1.97884);
  });

  it("does not spread in non-burnable fuel", () => {
    expect(surfaceFire(gs4({ fuel: fuelModel("NB1")! })).spreadRate).toBe(0);
  });
});

describe("Fire ellipse, against BehavePlus", () => {
  it("length-to-width ratio from the effective wind", () => {
    near(surfaceFire(gs4({ wind: { speedMph: 0, height: "20ft" }, slopeTan: 0 })).lengthToWidthRatio, 1); // no wind
    const midflame5 = surfaceFire(gs4({ wind: { speedMph: 5, height: "midflame" }, slopeTan: 0 }));
    near(midflame5.lengthToWidthRatio, 1.590064);
    near(north(45, 95, tan30deg).lengthToWidthRatio, 1.375624);
    const { windToUpslopeDeg: _, ...rest } = gs4({ slopeTan: tan30deg, wind: { speedMph: 15, height: "20ft" } });
    near(surfaceFireNorth(rest, 45, 95).lengthToWidthRatio, 1.519936);
  });

  it("ellipse axes, head to back ratio, area and perimeter, 5 mph midflame on flat ground", () => {
    const f = surfaceFire(gs4({ wind: { speedMph: 5, height: "midflame" }, slopeTan: 0 }));
    const b = (f.spreadRate + f.backingRate) / 2; // semi-major axis per minute, ft
    const a = b / f.lengthToWidthRatio; // semi-minor
    const c = b - f.backingRate; // centre to ignition
    const t = 3.5869124; // minutes, chosen by BehavePlus so that b = 1 chain
    near((a * t) / 66, 0.628905);
    near((b * t) / 66, 1.0);
    near((c * t) / 66, 0.777482);
    near(f.headToBackRatio, 7.988029);
    const A = a * 60;
    const B = b * 60; // one hour, ft
    // BehavePlus's acre is 43560.002160576107 ft^2 (behaveUnits.cpp).
    near((Math.PI * A * B) / 43560.002160576107, 55.283555); // acres
    const h = (A - B) ** 2 / (A + B) ** 2;
    near((Math.PI * (A + B) * (1 + h / 4 + (h * h) / 64)) / 66, 86.71476); // chains
  });

  it("spread rate in a direction of interest, measured from the ignition point", () => {
    const at = (windFrom: number, aspect: number, dir: number) => {
      const f = north(windFrom, aspect, 0.3);
      return chPerHour(spreadRateFromIgnition(f, f.directionFromNorth - dir));
    };
    near(at(280, 135, 30), 4.180938);
    near(at(0, 45, 90), 3.438243);
    near(at(280, 263, 285), 2.944975);
  });
});
