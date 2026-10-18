/**
 * The standard fire behavior fuel models used by the Rothermel spread model.
 *
 * The 13 original models (Anderson 1982) and the 40 Scott and Burgan (2005)
 * models, RMRS-GTR-153, plus the non-burnable codes. Values match the US
 * Forest Service BehavePlus engine (firelab/behave, fuelModels.cpp), which
 * is public domain.
 *
 * Units, as in the published tables:
 *     depth in ft, moisture of extinction as a fraction, heat content in
 *     Btu/lb, loads in lb/ft^2 (Scott and Burgan list tons/acre, converted
 *     here), surface-area-to-volume ratios in 1/ft.
 */

/**
 * One fuel model.
 *
 * Attributes:
 *     number (number): Standard number, e.g. 102 for GR2.
 *     code (string): Short code, e.g. "GR2".
 *     name (string): Description.
 *     depth (number): Fuel bed depth, ft.
 *     mxDead (number): Dead fuel moisture of extinction, fraction.
 *     heatDead (number): Dead fuel heat content, Btu/lb.
 *     heatLive (number): Live fuel heat content, Btu/lb.
 *     load1h (number): 1-hour dead load, lb/ft^2.
 *     load10h (number): 10-hour dead load, lb/ft^2.
 *     load100h (number): 100-hour dead load, lb/ft^2.
 *     loadHerb (number): Live herbaceous load, lb/ft^2.
 *     loadWoody (number): Live woody load, lb/ft^2.
 *     savr1h (number): 1-hour SAV ratio, 1/ft.
 *     savrHerb (number): Live herbaceous SAV ratio, 1/ft.
 *     savrWoody (number): Live woody SAV ratio, 1/ft.
 *     dynamic (boolean): True if cured herbaceous load moves to dead.
 */
export interface FuelModel {
  number: number;
  code: string;
  name: string;
  depth: number;
  mxDead: number;
  heatDead: number;
  heatLive: number;
  load1h: number;
  load10h: number;
  load100h: number;
  loadHerb: number;
  loadWoody: number;
  savr1h: number;
  savrHerb: number;
  savrWoody: number;
  dynamic: boolean;
}

/** tons/acre to lb/ft^2. */
const T = 2000 / 43560;

type Row = [number, string, string, number, number, number, number, number, number, number, number, number, number, number, number, boolean];

/** number, code, name, depth, mxDead, heatDead, heatLive, 1h, 10h, 100h, herb, woody, savr1h, savrHerb, savrWoody, dynamic */
const ROWS: Row[] = [
  // Anderson (1982) original 13, loads already in lb/ft^2.
  [1, "FM1", "Short grass", 1.0, 0.12, 8000, 8000, 0.034, 0, 0, 0, 0, 3500, 1500, 1500, false],
  [2, "FM2", "Timber grass and understory", 1.0, 0.15, 8000, 8000, 0.092, 0.046, 0.023, 0.023, 0, 3000, 1500, 1500, false],
  [3, "FM3", "Tall grass", 2.5, 0.25, 8000, 8000, 0.138, 0, 0, 0, 0, 1500, 1500, 1500, false],
  [4, "FM4", "Chaparral", 6.0, 0.2, 8000, 8000, 0.23, 0.184, 0.092, 0, 0.23, 2000, 1500, 1500, false],
  [5, "FM5", "Brush", 2.0, 0.2, 8000, 8000, 0.046, 0.023, 0, 0, 0.092, 2000, 1500, 1500, false],
  [6, "FM6", "Dormant brush, hardwood slash", 2.5, 0.25, 8000, 8000, 0.069, 0.115, 0.092, 0, 0, 1750, 1500, 1500, false],
  [7, "FM7", "Southern rough", 2.5, 0.4, 8000, 8000, 0.052, 0.086, 0.069, 0, 0.017, 1750, 1500, 1500, false],
  [8, "FM8", "Short needle litter", 0.2, 0.3, 8000, 8000, 0.069, 0.046, 0.115, 0, 0, 2000, 1500, 1500, false],
  [9, "FM9", "Long needle or hardwood litter", 0.2, 0.25, 8000, 8000, 0.134, 0.019, 0.007, 0, 0, 2500, 1500, 1500, false],
  [10, "FM10", "Timber litter and understory", 1.0, 0.25, 8000, 8000, 0.138, 0.092, 0.23, 0, 0.092, 2000, 1500, 1500, false],
  [11, "FM11", "Light logging slash", 1.0, 0.15, 8000, 8000, 0.069, 0.207, 0.253, 0, 0, 1500, 1500, 1500, false],
  [12, "FM12", "Medium logging slash", 2.3, 0.2, 8000, 8000, 0.184, 0.644, 0.759, 0, 0, 1500, 1500, 1500, false],
  [13, "FM13", "Heavy logging slash", 3.0, 0.25, 8000, 8000, 0.322, 1.058, 1.288, 0, 0, 1500, 1500, 1500, false],
  // Non-burnable (Scott and Burgan 2005).
  [91, "NB1", "Urban, developed", 1.0, 0.1, 8000, 8000, 0, 0, 0, 0, 0, 1500, 1500, 1500, false],
  [92, "NB2", "Snow, ice", 1.0, 0.1, 8000, 8000, 0, 0, 0, 0, 0, 1500, 1500, 1500, false],
  [93, "NB3", "Agricultural", 1.0, 0.1, 8000, 8000, 0, 0, 0, 0, 0, 1500, 1500, 1500, false],
  [98, "NB8", "Open water", 1.0, 0.1, 8000, 8000, 0, 0, 0, 0, 0, 1500, 1500, 1500, false],
  [99, "NB9", "Bare ground", 1.0, 0.1, 8000, 8000, 0, 0, 0, 0, 0, 1500, 1500, 1500, false],
  // Scott and Burgan (2005) 40, loads in tons/acre.
  [101, "GR1", "Short, sparse, dry climate grass", 0.4, 0.15, 8000, 8000, 0.1 * T, 0, 0, 0.3 * T, 0, 2200, 2000, 1500, true],
  [102, "GR2", "Low load, dry climate grass", 1.0, 0.15, 8000, 8000, 0.1 * T, 0, 0, 1.0 * T, 0, 2000, 1800, 1500, true],
  [103, "GR3", "Low load, very coarse, humid climate grass", 2.0, 0.3, 8000, 8000, 0.1 * T, 0.4 * T, 0, 1.5 * T, 0, 1500, 1300, 1500, true],
  [104, "GR4", "Moderate load, dry climate grass", 2.0, 0.15, 8000, 8000, 0.25 * T, 0, 0, 1.9 * T, 0, 2000, 1800, 1500, true],
  [105, "GR5", "Low load, humid climate grass", 1.5, 0.4, 8000, 8000, 0.4 * T, 0, 0, 2.5 * T, 0, 1800, 1600, 1500, true],
  [106, "GR6", "Moderate load, humid climate grass", 1.5, 0.4, 9000, 9000, 0.1 * T, 0, 0, 3.4 * T, 0, 2200, 2000, 1500, true],
  [107, "GR7", "High load, dry climate grass", 3.0, 0.15, 8000, 8000, 1.0 * T, 0, 0, 5.4 * T, 0, 2000, 1800, 1500, true],
  [108, "GR8", "High load, very coarse, humid climate grass", 4.0, 0.3, 8000, 8000, 0.5 * T, 1.0 * T, 0, 7.3 * T, 0, 1500, 1300, 1500, true],
  [109, "GR9", "Very high load, humid climate grass", 5.0, 0.4, 8000, 8000, 1.0 * T, 1.0 * T, 0, 9.0 * T, 0, 1800, 1600, 1500, true],
  [121, "GS1", "Low load, dry climate grass-shrub", 0.9, 0.15, 8000, 8000, 0.2 * T, 0, 0, 0.5 * T, 0.65 * T, 2000, 1800, 1800, true],
  [122, "GS2", "Moderate load, dry climate grass-shrub", 1.5, 0.15, 8000, 8000, 0.5 * T, 0.5 * T, 0, 0.6 * T, 1.0 * T, 2000, 1800, 1800, true],
  [123, "GS3", "Moderate load, humid climate grass-shrub", 1.8, 0.4, 8000, 8000, 0.3 * T, 0.25 * T, 0, 1.45 * T, 1.25 * T, 1800, 1600, 1600, true],
  [124, "GS4", "High load, humid climate grass-shrub", 2.1, 0.4, 8000, 8000, 1.9 * T, 0.3 * T, 0.1 * T, 3.4 * T, 7.1 * T, 1800, 1600, 1600, true],
  [141, "SH1", "Low load, dry climate shrub", 1.0, 0.15, 8000, 8000, 0.25 * T, 0.25 * T, 0, 0.15 * T, 1.3 * T, 2000, 1800, 1600, true],
  [142, "SH2", "Moderate load, dry climate shrub", 1.0, 0.15, 8000, 8000, 1.35 * T, 2.4 * T, 0.75 * T, 0, 3.85 * T, 2000, 1800, 1600, false],
  [143, "SH3", "Moderate load, humid climate shrub", 2.4, 0.4, 8000, 8000, 0.45 * T, 3.0 * T, 0, 0, 6.2 * T, 1600, 1800, 1400, false],
  [144, "SH4", "Low load, humid climate timber-shrub", 3.0, 0.3, 8000, 8000, 0.85 * T, 1.15 * T, 0.2 * T, 0, 2.55 * T, 2000, 1800, 1600, false],
  [145, "SH5", "High load, dry climate shrub", 6.0, 0.15, 8000, 8000, 3.6 * T, 2.1 * T, 0, 0, 2.9 * T, 750, 1800, 1600, false],
  [146, "SH6", "Low load, humid climate shrub", 2.0, 0.3, 8000, 8000, 2.9 * T, 1.45 * T, 0, 0, 1.4 * T, 750, 1800, 1600, false],
  [147, "SH7", "Very high load, dry climate shrub", 6.0, 0.15, 8000, 8000, 3.5 * T, 5.3 * T, 2.2 * T, 0, 3.4 * T, 750, 1800, 1600, false],
  [148, "SH8", "High load, humid climate shrub", 3.0, 0.4, 8000, 8000, 2.05 * T, 3.4 * T, 0.85 * T, 0, 4.35 * T, 750, 1800, 1600, false],
  [149, "SH9", "Very high load, humid climate shrub", 4.4, 0.4, 8000, 8000, 4.5 * T, 2.45 * T, 0, 1.55 * T, 7.0 * T, 750, 1800, 1500, true],
  [161, "TU1", "Light load, dry climate timber-grass-shrub", 0.6, 0.2, 8000, 8000, 0.2 * T, 0.9 * T, 1.5 * T, 0.2 * T, 0.9 * T, 2000, 1800, 1600, true],
  [162, "TU2", "Moderate load, humid climate timber-shrub", 1.0, 0.3, 8000, 8000, 0.95 * T, 1.8 * T, 1.25 * T, 0, 0.2 * T, 2000, 1800, 1600, false],
  [163, "TU3", "Moderate load, humid climate timber-grass-shrub", 1.3, 0.3, 8000, 8000, 1.1 * T, 0.15 * T, 0.25 * T, 0.65 * T, 1.1 * T, 1800, 1600, 1400, true],
  [164, "TU4", "Dwarf conifer understory", 0.5, 0.12, 8000, 8000, 4.5 * T, 0, 0, 0, 2.0 * T, 2300, 1800, 2000, false],
  [165, "TU5", "Very high load, dry climate timber-shrub", 1.0, 0.25, 8000, 8000, 4.0 * T, 4.0 * T, 3.0 * T, 0, 3.0 * T, 1500, 1800, 750, false],
  [181, "TL1", "Low load, compact conifer litter", 0.2, 0.3, 8000, 8000, 1.0 * T, 2.2 * T, 3.6 * T, 0, 0, 2000, 1800, 1600, false],
  [182, "TL2", "Low load broadleaf litter", 0.2, 0.25, 8000, 8000, 1.4 * T, 2.3 * T, 2.2 * T, 0, 0, 2000, 1800, 1600, false],
  [183, "TL3", "Moderate load conifer litter", 0.3, 0.2, 8000, 8000, 0.5 * T, 2.2 * T, 2.8 * T, 0, 0, 2000, 1800, 1600, false],
  [184, "TL4", "Small downed logs", 0.4, 0.25, 8000, 8000, 0.5 * T, 1.5 * T, 4.2 * T, 0, 0, 2000, 1800, 1600, false],
  [185, "TL5", "High load conifer litter", 0.6, 0.25, 8000, 8000, 1.15 * T, 2.5 * T, 4.4 * T, 0, 0, 2000, 1800, 160, false],
  [186, "TL6", "High load broadleaf litter", 0.3, 0.25, 8000, 8000, 2.4 * T, 1.2 * T, 1.2 * T, 0, 0, 2000, 1800, 1600, false],
  [187, "TL7", "Large downed logs", 0.4, 0.25, 8000, 8000, 0.3 * T, 1.4 * T, 8.1 * T, 0, 0, 2000, 1800, 1600, false],
  [188, "TL8", "Long-needle litter", 0.3, 0.35, 8000, 8000, 5.8 * T, 1.4 * T, 1.1 * T, 0, 0, 1800, 1800, 1600, false],
  [189, "TL9", "Very high load broadleaf litter", 0.6, 0.35, 8000, 8000, 6.65 * T, 3.3 * T, 4.15 * T, 0, 0, 1800, 1800, 1600, false],
  [201, "SB1", "Low load activity fuel", 1.0, 0.25, 8000, 8000, 1.5 * T, 3.0 * T, 11.0 * T, 0, 0, 2000, 1800, 1600, false],
  [202, "SB2", "Moderate load activity or low load blowdown", 1.0, 0.25, 8000, 8000, 4.5 * T, 4.25 * T, 4.0 * T, 0, 0, 2000, 1800, 1600, false],
  [203, "SB3", "High load activity fuel or moderate load blowdown", 1.2, 0.25, 8000, 8000, 5.5 * T, 2.75 * T, 3.0 * T, 0, 0, 2000, 1800, 1600, false],
  [204, "SB4", "High load blowdown", 2.7, 0.25, 8000, 8000, 5.25 * T, 3.5 * T, 5.25 * T, 0, 0, 2000, 1800, 1600, false],
];

const BY_CODE = new Map<string, FuelModel>();
const BY_NUMBER = new Map<number, FuelModel>();
for (const r of ROWS) {
  const m: FuelModel = {
    number: r[0], code: r[1], name: r[2], depth: r[3], mxDead: r[4], heatDead: r[5], heatLive: r[6],
    load1h: r[7], load10h: r[8], load100h: r[9], loadHerb: r[10], loadWoody: r[11],
    savr1h: r[12], savrHerb: r[13], savrWoody: r[14], dynamic: r[15],
  };
  BY_CODE.set(m.code, m);
  BY_NUMBER.set(m.number, m);
}

/**
 * Look up a standard fuel model.
 *
 * Args:
 *     key (string | number): Code like "GR2" (any case) or number like 102.
 *
 * Returns:
 *     FuelModel | undefined: The model, or undefined if it is not standard.
 */
export function fuelModel(key: string | number): FuelModel | undefined {
  return typeof key === "number" ? BY_NUMBER.get(key) : BY_CODE.get(key.trim().toUpperCase());
}

/**
 * Standard moisture scenarios (Scott and Burgan 2005), as fractions:
 * 1-hour, 10-hour, 100-hour dead, live herbaceous, live woody.
 */
export const MOISTURE_SCENARIOS: Record<string, [number, number, number, number, number]> = {
  D1L1: [0.03, 0.04, 0.05, 0.3, 0.6],
  D1L2: [0.03, 0.04, 0.05, 0.6, 0.9],
  D1L3: [0.03, 0.04, 0.05, 0.9, 1.2],
  D1L4: [0.03, 0.04, 0.05, 1.2, 1.5],
  D2L1: [0.06, 0.07, 0.08, 0.3, 0.6],
  D2L2: [0.06, 0.07, 0.08, 0.6, 0.9],
  D2L3: [0.06, 0.07, 0.08, 0.9, 1.2],
  D2L4: [0.06, 0.07, 0.08, 1.2, 1.5],
  D3L1: [0.09, 0.1, 0.11, 0.3, 0.6],
  D3L2: [0.09, 0.1, 0.11, 0.6, 0.9],
  D3L3: [0.09, 0.1, 0.11, 0.9, 1.2],
  D3L4: [0.09, 0.1, 0.11, 1.2, 1.5],
  D4L1: [0.12, 0.13, 0.14, 0.3, 0.6],
  D4L2: [0.12, 0.13, 0.14, 0.6, 0.9],
  D4L3: [0.12, 0.13, 0.14, 0.9, 1.2],
  D4L4: [0.12, 0.13, 0.14, 1.2, 1.5],
};
