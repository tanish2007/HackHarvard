/**
 * Rothermel (1972) surface fire spread, with Albini (1976) changes, and the
 * Anderson (1983) fire ellipse. Matches the US Forest Service BehavePlus
 * engine (firelab/behave), and is checked against its published test cases
 * in core/test/fire-rothermel.test.ts.
 *
 * Main references:
 *     Rothermel 1972, INT-115. Albini 1976, INT-30. Anderson 1983, INT-305.
 *     Andrews 2018, RMRS-GTR-371 (all equations in one place).
 *
 * Internal units are the model's own: ft, lb, Btu, minutes. Spread rates
 * are ft/min. Directions are degrees clockwise.
 *
 * What it models: a steady surface fire in a uniform wildland fuel bed under
 * steady wind and slope. It does not model crown fire, spotting, buildings,
 * or changing weather.
 */
import type { FuelModel } from "./fuelModels.js";

/** Dead fuel moisture by size class, and live moisture, as fractions. */
export interface FuelMoisture {
  oneHour: number;
  tenHour: number;
  hundredHour: number;
  liveHerb: number;
  liveWoody: number;
}

/**
 * Wind as measured, and how to bring it down to flame height.
 *
 * Attributes:
 *     speedMph (number): Wind speed in mph.
 *     height ("midflame" | "20ft" | "10m"): Where it was measured. Weather
 *         stations and forecasts report 10 m. 10 m wind is converted to
 *         20 ft by dividing by 1.15, then to midflame by the wind
 *         adjustment factor.
 *     adjustmentFactor (number | undefined): Use this factor instead of
 *         computing it from the canopy and fuel bed.
 */
export interface WindInput {
  speedMph: number;
  height: "midflame" | "20ft" | "10m";
  adjustmentFactor?: number;
}

/**
 * Overstory canopy, for the wind adjustment factor (Albini and Baughman 1979).
 *
 * Attributes:
 *     cover (number): Canopy cover, fraction 0 to 1.
 *     heightFt (number): Canopy height, ft.
 *     crownRatio (number): Crown ratio, fraction 0 to 1.
 */
export interface Canopy {
  cover: number;
  heightFt: number;
  crownRatio: number;
}

/**
 * Inputs for one surface fire calculation, oriented relative to upslope.
 *
 * Attributes:
 *     fuel (FuelModel): The fuel model.
 *     moisture (FuelMoisture): Fuel moisture.
 *     wind (WindInput): Wind speed and height.
 *     windToUpslopeDeg (number): Direction the wind blows TOWARD, degrees
 *         clockwise from upslope. 0 means blowing straight upslope.
 *     slopeTan (number): Slope steepness as rise over run (30% slope = 0.3).
 *     canopy (Canopy | undefined): Overstory, if any. None means unsheltered.
 */
export interface SurfaceInput {
  fuel: FuelModel;
  moisture: FuelMoisture;
  wind: WindInput;
  windToUpslopeDeg: number;
  slopeTan: number;
  canopy?: Canopy;
}

/**
 * Everything the calculation produces.
 *
 * Attributes:
 *     spreadRate (number): Head fire spread rate, ft/min.
 *     backingRate (number): Backing spread rate, ft/min.
 *     flankingRate (number): Flanking spread rate, ft/min (half the
 *         ellipse width per minute).
 *     directionFromUpslope (number): Direction of maximum spread, degrees
 *         clockwise from upslope.
 *     noWindNoSlopeRate (number): R0, ft/min.
 *     reactionIntensity (number): Btu/ft^2/min.
 *     heatSource (number): Btu/ft^2/min.
 *     heatSink (number): Btu/ft^3.
 *     characteristicSavr (number): Sigma, 1/ft.
 *     packingRatio (number): Beta.
 *     relativePackingRatio (number): Beta / beta optimum.
 *     liveMoistureOfExtinction (number): Fraction.
 *     deadMoisture (number): Characteristic dead moisture, fraction.
 *     liveMoisture (number): Characteristic live moisture, fraction.
 *     windAdjustmentFactor (number): 20 ft to midflame factor.
 *     midflameWindMph (number): mph.
 *     effectiveWindMph (number): Wind that alone would give the combined
 *         wind and slope effect, mph.
 *     lengthToWidthRatio (number): Fire ellipse length to width.
 *     eccentricity (number): Fire ellipse eccentricity.
 *     headToBackRatio (number): Head to back spread ratio.
 *     firelineIntensity (number): Head fire, Btu/ft/s.
 *     flameLength (number): Head fire, ft.
 */
export interface SurfaceFire {
  spreadRate: number;
  backingRate: number;
  flankingRate: number;
  directionFromUpslope: number;
  noWindNoSlopeRate: number;
  reactionIntensity: number;
  heatSource: number;
  heatSink: number;
  characteristicSavr: number;
  packingRatio: number;
  relativePackingRatio: number;
  liveMoistureOfExtinction: number;
  deadMoisture: number;
  liveMoisture: number;
  windAdjustmentFactor: number;
  midflameWindMph: number;
  effectiveWindMph: number;
  lengthToWidthRatio: number;
  eccentricity: number;
  headToBackRatio: number;
  firelineIntensity: number;
  flameLength: number;
}

/** Oven-dry particle density, lb/ft^3 (Albini 1976, p. 91). */
const PARTICLE_DENSITY = 32;
/** Total mineral content, fraction. */
const TOTAL_SILICA = 0.0555;
/** Effective mineral content, fraction. */
const EFFECTIVE_SILICA = 0.01;
/** 10-hour and 100-hour SAV ratios, 1/ft (fixed by the fuel model system). */
const SAVR_10H = 109;
const SAVR_100H = 30;
/** ft/min per mph. */
const FT_MIN_PER_MPH = 88;
/** Dead size classes (1h, 10h, 100h, cured herb) and live (herb, woody). */
const DEAD = 4;
const LIVE = 2;

/** One fuel particle class. */
interface Particle {
  load: number;
  savr: number;
  moisture: number;
  heat: number;
}

/**
 * Wind adjustment factor from 20 ft wind to midflame wind.
 *
 * Unsheltered fuel uses the fuel bed depth (Baughman and Albini 1980).
 * Fuel under a canopy uses the canopy (Albini and Baughman 1979), with the
 * crown-filled fraction = crown ratio x cover / 3.
 *
 * Args:
 *     depthFt (number): Fuel bed depth, ft.
 *     canopy (Canopy | undefined): The overstory, if any.
 *
 * Returns:
 *     number: The factor, 0 to 1.
 */
export function windAdjustmentFactor(depthFt: number, canopy?: Canopy): number {
  const crownFraction = canopy ? (canopy.crownRatio * canopy.cover) / 3 : 0;
  const sheltered = canopy && canopy.cover >= 1e-7 && crownFraction >= 0.05 && canopy.heightFt >= 6;
  if (!sheltered) return depthFt > 1e-7 ? 1.83 / Math.log((20 + 0.36 * depthFt) / (0.13 * depthFt)) : 0;
  const h = canopy.heightFt;
  return 0.555 / (Math.sqrt(crownFraction * h) * Math.log((20 + 0.36 * h) / (0.13 * h)));
}

/**
 * Fire ellipse length-to-width ratio from effective midflame wind (Anderson
 * 1983, with the 0.397 correction so no wind gives a circle). Capped at 8.
 *
 * Args:
 *     effectiveWindMph (number): Effective midflame wind, mph.
 *
 * Returns:
 *     number: Length to width ratio, at least 1.
 */
export function lengthToWidthRatio(effectiveWindMph: number): number {
  if (effectiveWindMph <= 1e-7) return 1;
  const lw = 0.936 * Math.exp(0.1147 * effectiveWindMph) + 0.461 * Math.exp(-0.0692 * effectiveWindMph) - 0.397;
  return Math.min(lw, 8);
}

/**
 * Size-class weighting: each particle gets the summed surface-area fraction
 * of all particles in its SAV class (Rothermel 1972, Albini 1976).
 *
 * Args:
 *     savr (number[]): SAV ratio of each particle.
 *     fraction (number[]): Surface area fraction of each particle.
 *
 * Returns:
 *     number[]: The class-summed fraction for each particle.
 */
function sizeSortedFractions(savr: number[], fraction: number[]): number[] {
  const cls = (s: number) => (s >= 1200 ? 0 : s >= 192 ? 1 : s >= 96 ? 2 : s >= 48 ? 3 : s >= 16 ? 4 : -1);
  const sums = [0, 0, 0, 0, 0];
  savr.forEach((s, i) => {
    const c = cls(s);
    if (c >= 0) sums[c] += fraction[i];
  });
  return savr.map((s) => (cls(s) >= 0 ? sums[cls(s)] : 0));
}

/**
 * Moisture damping coefficient (Rothermel 1972, eq. 29).
 *
 * Args:
 *     moisture (number): Characteristic moisture, fraction.
 *     extinction (number): Moisture of extinction, fraction.
 *
 * Returns:
 *     number: 0 to 1. 0 when the fuel is too wet to burn.
 */
function moistureDamping(moisture: number, extinction: number): number {
  if (extinction <= 0 || moisture >= extinction) return 0;
  const r = moisture / extinction;
  return 1 - 2.59 * r + 5.11 * r * r - 3.52 * r * r * r;
}

/**
 * Run the surface fire model in the direction of maximum spread.
 *
 * Args:
 *     input (SurfaceInput): Fuel, moisture, wind, slope, and canopy.
 *
 * Returns:
 *     SurfaceFire: Spread rates, intensities, and the fire ellipse. All zero
 *         for a fuel bed with no load (the non-burnable models).
 */
export function surfaceFire(input: SurfaceInput): SurfaceFire {
  const { fuel, moisture: m } = input;

  // Particles: dead 1h, 10h, 100h, cured herb; live herb, woody.
  const dead: Particle[] = [
    { load: fuel.load1h, savr: fuel.savr1h, moisture: m.oneHour, heat: fuel.heatDead },
    { load: fuel.load10h, savr: SAVR_10H, moisture: m.tenHour, heat: fuel.heatDead },
    { load: fuel.load100h, savr: SAVR_100H, moisture: m.hundredHour, heat: fuel.heatDead },
    { load: 0, savr: fuel.savrHerb, moisture: m.oneHour, heat: fuel.heatDead },
  ];
  const live: Particle[] = [
    { load: fuel.loadHerb, savr: fuel.savrHerb, moisture: m.liveHerb, heat: fuel.heatLive },
    { load: fuel.loadWoody, savr: fuel.savrWoody, moisture: m.liveWoody, heat: fuel.heatLive },
  ];
  // Size classes are counted before the dynamic transfer, as in BehavePlus.
  const hasDead = dead.some((p) => p.load > 0);
  const hasLive = live.some((p) => p.load > 0);
  if (!hasDead && !hasLive) return zeroFire(input);

  // Dynamic models: cured herbaceous load becomes dead fuel (Scott and Burgan 2005).
  if (fuel.dynamic) {
    const herb = live[0];
    if (herb.moisture < 0.3) {
      dead[3].load = herb.load;
      herb.load = 0;
    } else if (herb.moisture <= 1.2) {
      dead[3].load = herb.load * (1.333 - 1.11 * herb.moisture);
      herb.load -= dead[3].load;
    }
  }

  // Surface area weighting.
  const area = (ps: Particle[], counted: boolean) => (counted ? ps.map((p) => (p.load * p.savr) / PARTICLE_DENSITY) : ps.map(() => 0));
  const areaDead = area(dead, hasDead);
  const areaLive = area(live, hasLive);
  const totalDead = areaDead.reduce((a, b) => a + b, 0);
  const totalLive = areaLive.reduce((a, b) => a + b, 0);
  const fracDead = areaDead.map((a) => (totalDead > 1e-7 ? a / totalDead : 0));
  const fracLive = areaLive.map((a) => (totalLive > 1e-7 ? a / totalLive : 0));
  const lifeDead = totalDead / (totalDead + totalLive);
  const lifeLive = 1 - lifeDead;
  const sortedDead = sizeSortedFractions(dead.map((p) => p.savr), fracDead);
  const sortedLive = sizeSortedFractions(live.map((p) => p.savr), fracLive);

  // Moisture of extinction: dead from the model, live from Albini 1976 p. 89.
  const mxDead = fuel.mxDead;
  let mxLive = 0;
  if (hasLive) {
    let fineDead = 0;
    let fineDeadMoisture = 0;
    for (const p of dead) {
      const w = p.savr > 1e-7 ? p.load * Math.exp(-138 / p.savr) : 0;
      fineDead += w;
      fineDeadMoisture += w * p.moisture;
    }
    const mfDead = fineDead > 1e-7 ? fineDeadMoisture / fineDead : 0;
    let fineLive = 0;
    for (const p of live) if (p.savr > 1e-7) fineLive += p.load * Math.exp(-500 / p.savr);
    const ratio = fineLive > 1e-7 ? fineDead / fineLive : 0;
    mxLive = Math.max(2.9 * ratio * (1 - mfDead / mxDead) - 0.226, mxDead);
  }

  // Characteristic values per life state.
  const weigh = (ps: Particle[], frac: number[], sorted: number[]) => {
    let heat = 0, silica = 0, moist = 0, savr = 0, netLoad = 0, load = 0;
    ps.forEach((p, i) => {
      if (p.savr <= 1e-7) return;
      heat += frac[i] * p.heat;
      silica += frac[i] * EFFECTIVE_SILICA;
      moist += frac[i] * p.moisture;
      savr += frac[i] * p.savr;
      load += p.load;
      netLoad += sorted[i] * p.load * (1 - TOTAL_SILICA);
    });
    return { heat, silica, moist, savr, netLoad, load };
  };
  const d = weigh(dead, fracDead, sortedDead);
  const l = weigh(live, fracLive, sortedLive);
  const sigma = lifeDead * d.savr + lifeLive * l.savr;

  // Fuel bed structure.
  const depth = fuel.depth;
  const bulkDensity = (d.load + l.load) / depth;
  let packingRatio = 0;
  for (const p of [...dead, ...live]) packingRatio += p.load / (depth * PARTICLE_DENSITY);
  const optimumPackingRatio = 3.348 / Math.pow(sigma, 0.8189);
  const relativePackingRatio = packingRatio / optimumPackingRatio;

  // Heat sink (Rothermel eq. 77, Albini weighting).
  let heatSink = 0;
  dead.forEach((p, i) => {
    if (p.savr > 1e-7) heatSink += lifeDead * fracDead[i] * (250 + 1116 * p.moisture) * Math.exp(-138 / p.savr);
  });
  live.forEach((p, i) => {
    if (p.savr > 1e-7) heatSink += lifeLive * fracLive[i] * (250 + 1116 * p.moisture) * Math.exp(-138 / p.savr);
  });
  heatSink *= bulkDensity;

  // Propagating flux ratio (eq. 42).
  const propagatingFlux = Math.exp((0.792 + 0.681 * Math.sqrt(sigma)) * (packingRatio + 0.1)) / (192 + 0.2595 * sigma);

  // Reaction intensity (eqs. 27, 36, 38, 39, Albini's A).
  const A = 133 / Math.pow(sigma, 0.7913);
  const s15 = Math.pow(sigma, 1.5);
  const gammaMax = s15 / (495 + 0.0594 * s15);
  const gamma = gammaMax * Math.pow(relativePackingRatio, A) * Math.exp(A * (1 - relativePackingRatio));
  const etaS = (silica: number) => (Math.pow(silica, 0.19) < 1e-6 ? 0 : Math.min(1, 0.174 / Math.pow(silica, 0.19)));
  const reactionIntensity =
    gamma * d.netLoad * d.heat * moistureDamping(d.moist, mxDead) * etaS(d.silica) +
    gamma * l.netLoad * l.heat * moistureDamping(l.moist, mxLive) * etaS(l.silica);

  const noWindNoSlopeRate = heatSink < 1e-7 ? 0 : (reactionIntensity * propagatingFlux) / heatSink;

  // Wind: 10 m to 20 ft, then 20 ft to midflame.
  let speed = input.wind.speedMph * FT_MIN_PER_MPH;
  let waf = 1;
  if (input.wind.height !== "midflame") {
    if (input.wind.height === "10m") speed /= 1.15;
    waf = input.wind.adjustmentFactor ?? windAdjustmentFactor(depth, input.canopy);
  }
  const midflame = waf * speed;

  // Wind and slope factors (eqs. 47 to 53, 51).
  const windC = 7.47 * Math.exp(-0.133 * Math.pow(sigma, 0.55));
  const windB = 0.02526 * Math.pow(sigma, 0.54);
  const windE = 0.715 * Math.exp(-0.000359 * sigma);
  const phiW = midflame < 1e-7 ? 0 : windC * Math.pow(midflame, windB) * Math.pow(relativePackingRatio, -windE);
  let phiS = 5.275 * Math.pow(packingRatio, -0.3) * input.slopeTan * input.slopeTan;
  // Slope factor limit as applied by BehavePlus. The wind speed limit itself
  // is off by default, following Andrews et al. 2013.
  phiS = Math.min(phiS, 0.9 * reactionIntensity);

  // Combine wind and slope as vectors (Rothermel 1983, BehavePlus).
  const wd = (input.windToUpslopeDeg * Math.PI) / 180;
  const slopeRate = noWindNoSlopeRate * phiS;
  const windRate = noWindNoSlopeRate * phiW;
  const x = slopeRate + windRate * Math.cos(wd);
  const y = windRate * Math.sin(wd);
  const spreadRate = noWindNoSlopeRate + Math.sqrt(x * x + y * y);
  let direction = (Math.atan2(y, x) * 180) / Math.PI;
  if (direction < -1e-20) direction += 360;
  if (Math.abs(direction) < 0.5) direction = 0;

  // Effective wind: the wind alone that gives the combined effect.
  const phiE = noWindNoSlopeRate > 0 ? spreadRate / noWindNoSlopeRate - 1 : 0;
  const effectiveWind = phiE > 0 ? Math.pow((phiE * Math.pow(relativePackingRatio, windE)) / windC, 1 / windB) : 0;
  const effectiveWindMph = effectiveWind / FT_MIN_PER_MPH;

  // Fire ellipse (Anderson 1983, Alexander 1985).
  const lw = lengthToWidthRatio(effectiveWindMph);
  const eccentricity = lw > 1 ? Math.sqrt(lw * lw - 1) / lw : 0;
  const backingRate = (spreadRate * (1 - eccentricity)) / (1 + eccentricity);
  const flankingRate = (spreadRate + backingRate) / lw / 2;
  const root = Math.sqrt(lw * lw - 1);
  const headToBackRatio = (lw + root) / (lw - root);

  // Byram 1959 fireline intensity and flame length, Anderson 1969 residence time.
  const residenceTime = sigma < 1e-7 ? 0 : 384 / sigma;
  const firelineIntensity = spreadRate * reactionIntensity * (residenceTime / 60);
  const flameLength = firelineIntensity < 1e-7 ? 0 : 0.45 * Math.pow(firelineIntensity, 0.46);

  return {
    spreadRate,
    backingRate,
    flankingRate,
    directionFromUpslope: direction,
    noWindNoSlopeRate,
    reactionIntensity,
    heatSource: reactionIntensity * propagatingFlux * (1 + phiS + phiW),
    heatSink,
    characteristicSavr: sigma,
    packingRatio,
    relativePackingRatio,
    liveMoistureOfExtinction: mxLive,
    deadMoisture: d.moist,
    liveMoisture: l.moist,
    windAdjustmentFactor: waf,
    midflameWindMph: midflame / FT_MIN_PER_MPH,
    effectiveWindMph,
    lengthToWidthRatio: lw,
    eccentricity,
    headToBackRatio,
    firelineIntensity,
    flameLength,
  };
}

/**
 * Result for a fuel bed that cannot burn.
 *
 * Args:
 *     input (SurfaceInput): The inputs, for the wind adjustment factor.
 *
 * Returns:
 *     SurfaceFire: Zero spread, a circle ellipse.
 */
function zeroFire(input: SurfaceInput): SurfaceFire {
  return {
    spreadRate: 0, backingRate: 0, flankingRate: 0, directionFromUpslope: 0, noWindNoSlopeRate: 0,
    reactionIntensity: 0, heatSource: 0, heatSink: 0, characteristicSavr: 0, packingRatio: 0,
    relativePackingRatio: 0, liveMoistureOfExtinction: 0, deadMoisture: 0, liveMoisture: 0,
    windAdjustmentFactor: input.wind.height === "midflame" ? 1 : windAdjustmentFactor(input.fuel.depth, input.canopy),
    midflameWindMph: 0, effectiveWindMph: 0, lengthToWidthRatio: 1, eccentricity: 0, headToBackRatio: 1,
    firelineIntensity: 0, flameLength: 0,
  };
}

/**
 * Run the model with wind and slope given relative to north, as a map does.
 *
 * Wind direction is where the wind comes FROM, as weather reports give it
 * ("a northeast wind" = 45). Aspect is the direction the slope faces
 * (downslope). The direction of spread comes back relative to north, as
 * the direction the head fire moves TOWARD.
 *
 * Args:
 *     input (Omit<SurfaceInput, "windToUpslopeDeg">): Fuel, moisture, wind, slope, canopy.
 *     windFromDeg (number): Wind source direction, degrees from north.
 *     aspectDeg (number): Slope aspect, degrees from north. Use 0 on flat ground.
 *
 * Returns:
 *     SurfaceFire & { directionFromNorth: number }: The result, plus the
 *         head fire direction in degrees clockwise from north.
 */
export function surfaceFireNorth(
  input: Omit<SurfaceInput, "windToUpslopeDeg">,
  windFromDeg: number,
  aspectDeg: number,
): SurfaceFire & { directionFromNorth: number } {
  // BehavePlus: wind from W relative to north equals blowing toward
  // W - aspect relative to upslope, since upslope = aspect + 180.
  const fire = surfaceFire({ ...input, windToUpslopeDeg: windFromDeg - aspectDeg });
  const directionFromNorth = (((fire.directionFromUpslope + aspectDeg + 180) % 360) + 360) % 360;
  return { ...fire, directionFromNorth };
}

/**
 * Spread rate in any direction, measured from the ignition point (Catchpole
 * et al. 1982 polar form of the ellipse with the ignition at the rear focus).
 *
 * Args:
 *     fire (SurfaceFire): A result from surfaceFire.
 *     angleFromHeadDeg (number): Angle between the head direction and the
 *         direction of interest, degrees.
 *
 * Returns:
 *     number: Spread rate in that direction, ft/min.
 */
export function spreadRateFromIgnition(fire: SurfaceFire, angleFromHeadDeg: number): number {
  const b = (Math.abs(angleFromHeadDeg) * Math.PI) / 180;
  return (fire.spreadRate * (1 - fire.eccentricity)) / (1 - fire.eccentricity * Math.cos(b));
}
