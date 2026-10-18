/**
 * Loads scenario.json, merges real phone numbers from scenario.local.json, and
 * generates the simulated population.
 *
 * This is the only place that reads the scenario files. Everything else gets
 * names, numbers, and coordinates from the Scenario this returns.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  localOverrideSchema,
  PLACEHOLDER_PHONE,
  scenarioFileSchema,
  type LocalOverride,
  type PersonStatus,
  type Scenario,
  type ScenarioFile,
  type ScenarioPerson,
} from "./schema.js";

export const SCENARIO_FILE = "scenario.json";
export const LOCAL_OVERRIDE_FILE = "scenario.local.json";

/** Key in the override `phones` map that targets the emergency contact. */
const EMERGENCY_KEY = "emergency_contact";

/**
 * Options for loading a scenario.
 *
 * Attributes:
 *     dir (string): Folder holding scenario.json. Defaults to the working directory.
 *     useLocal (boolean): Merge scenario.local.json if it exists. Defaults to true.
 */
export interface LoadOptions {
  dir?: string;
  useLocal?: boolean;
}

/**
 * Load and validate the scenario.
 *
 * Args:
 *     options (LoadOptions): Where to read from and whether to merge real numbers.
 *
 * Returns:
 *     Scenario: The validated scenario with simulated people appended to `people`.
 *
 * Raises:
 *     Error: If a file is missing or invalid, or an id does not resolve.
 */
export function loadScenario(options: LoadOptions = {}): Scenario {
  const dir = options.dir ?? process.cwd();
  const file = scenarioFileSchema.parse(readJson(join(dir, SCENARIO_FILE)));

  const localPath = join(dir, LOCAL_OVERRIDE_FILE);
  if (options.useLocal !== false && existsSync(localPath)) {
    applyOverride(file, localOverrideSchema.parse(readJson(localPath)));
  }

  checkSimulatedPopulation(file);
  const people = [...file.people, ...generateSimulated(file)];
  checkReferences(file, people);

  const { _readme, simulated_population, ...rest } = file;
  return { ...rest, people };
}

/**
 * List the ids that still use a placeholder number, so the demo can warn.
 *
 * Args:
 *     scenario (Scenario): A loaded scenario.
 *
 * Returns:
 *     string[]: Ids of real-device personas, units, lines, and the emergency
 *         contact whose phone is still a fictional placeholder.
 */
export function placeholderIds(scenario: Scenario): string[] {
  const ids: string[] = [];
  for (const p of scenario.people) {
    if (!p.simulated && p.phone && PLACEHOLDER_PHONE.test(p.phone)) ids.push(p.person_id);
  }
  for (const u of scenario.units) if (PLACEHOLDER_PHONE.test(u.phone)) ids.push(u.unit_id);
  if (PLACEHOLDER_PHONE.test(scenario.emergency_contact.phone)) ids.push(EMERGENCY_KEY);
  for (const [line, phone] of Object.entries(scenario.relay_lines)) {
    if (PLACEHOLDER_PHONE.test(phone)) ids.push(`relay_lines.${line}`);
  }
  return ids;
}

/**
 * Read and parse a JSON file.
 *
 * Args:
 *     path (string): File to read.
 *
 * Returns:
 *     unknown: The parsed JSON.
 *
 * Raises:
 *     Error: If the file cannot be read or is not valid JSON.
 */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Could not read ${path}: ${(err as Error).message}`);
  }
}

/**
 * Replace placeholder numbers with real ones, in place.
 *
 * Args:
 *     file (ScenarioFile): The parsed scenario.json.
 *     override (LocalOverride): The parsed scenario.local.json.
 *
 * Raises:
 *     Error: If the override names an id that is not in scenario.json.
 */
function applyOverride(file: ScenarioFile, override: LocalOverride): void {
  Object.assign(file.relay_lines, override.relay_lines ?? {});

  for (const [id, phone] of Object.entries(override.phones ?? {})) {
    const person = file.people.find((p) => p.person_id === id);
    const unit = file.units.find((u) => u.unit_id === id);
    if (person) person.phone = phone;
    else if (unit) unit.phone = phone;
    else if (id === EMERGENCY_KEY) file.emergency_contact.phone = phone;
    else throw new Error(`${LOCAL_OVERRIDE_FILE}: unknown id "${id}"`);
  }
}

/**
 * Check the simulated population settings before generating people from them.
 *
 * Args:
 *     file (ScenarioFile): The parsed scenario.
 *
 * Raises:
 *     Error: If sos + unconfirmed is more than count, or there are no zones
 *         to place simulated people in.
 */
function checkSimulatedPopulation(file: ScenarioFile): void {
  const sim = file.simulated_population;
  if (sim.sos + sim.unconfirmed > sim.count) {
    throw new Error("simulated_population: sos + unconfirmed is more than count");
  }
  if (sim.count > 0 && file.zones.length === 0) {
    throw new Error("simulated_population needs at least one zone");
  }
}

/**
 * Check that ids are unique and every reference points at something real.
 *
 * People and units share one id space, because scenario.local.json targets
 * either by id. "emergency_contact" is reserved for the same reason.
 *
 * Args:
 *     file (ScenarioFile): The parsed scenario.
 *     people (ScenarioPerson[]): Named and generated people together, so a
 *         named id cannot collide with a generated sim_ id.
 *
 * Raises:
 *     Error: On a duplicate id or a dangling zone, family, or agent reference.
 */
function checkReferences(file: ScenarioFile, people: ScenarioPerson[]): void {
  assertUnique("person_id", people.map((p) => p.person_id));
  assertUnique("zone id", file.zones.map((z) => z.id));
  assertUnique("shelter id", file.shelters.map((s) => s.id));
  assertUnique("unit_id", file.units.map((u) => u.unit_id));
  assertUnique("agent_id", file.agents.map((a) => a.agent_id));
  assertUnique("person or unit id", [...people.map((p) => p.person_id), ...file.units.map((u) => u.unit_id), EMERGENCY_KEY]);

  const personIds = new Set(people.map((p) => p.person_id));
  const zoneIds = new Set(file.zones.map((z) => z.id));
  const agentIds = new Set(file.agents.map((a) => a.agent_id));

  for (const p of people) {
    if (p.zone && !zoneIds.has(p.zone)) throw new Error(`${p.person_id}: unknown zone "${p.zone}"`);
    if (p.family_contact && !personIds.has(p.family_contact)) {
      throw new Error(`${p.person_id}: unknown family_contact "${p.family_contact}"`);
    }
  }
  for (const a of file.agents) {
    for (const t of a.trusts) {
      if (!agentIds.has(t)) throw new Error(`${a.agent_id}: trusts unknown agent "${t}"`);
    }
  }
}

/**
 * Throw on the first id that appears twice.
 *
 * Args:
 *     label (string): What kind of id this is, for the error message.
 *     ids (string[]): The ids to check.
 *
 * Raises:
 *     Error: Naming the label and the duplicated id.
 */
function assertUnique(label: string, ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`Duplicate ${label} "${id}"`);
    seen.add(id);
  }
}

/**
 * Generate the simulated residents. Same seed, same people, every run.
 *
 * Args:
 *     file (ScenarioFile): The parsed scenario.
 *
 * Returns:
 *     ScenarioPerson[]: Simulated residents spread across the zones. The first
 *         `sos` are sos, the next `unconfirmed` are unconfirmed, the rest safe.
 */
function generateSimulated(file: ScenarioFile): ScenarioPerson[] {
  const sim = file.simulated_population;
  const rand = mulberry32(sim.seed);
  const people: ScenarioPerson[] = [];

  for (let i = 0; i < sim.count; i++) {
    const zone = file.zones[i % file.zones.length];
    const lats = zone.polygon.map(([lat]) => lat);
    const lngs = zone.polygon.map(([, lng]) => lng);
    const round = Math.floor(i / sim.names.length);
    const suffix = round === 0 ? "" : ` ${String.fromCharCode(65 + ((round - 1) % 26))}.`;

    let status: PersonStatus = "safe";
    if (i < sim.sos) status = "sos";
    else if (i < sim.sos + sim.unconfirmed) status = "unconfirmed";

    people.push({
      person_id: `sim_${String(i + 1).padStart(3, "0")}`,
      name: `${sim.names[i % sim.names.length]}${suffix}`,
      role: "resident",
      phone: null,
      lat: between(rand(), Math.min(...lats), Math.max(...lats)),
      lng: between(rand(), Math.min(...lngs), Math.max(...lngs)),
      language: sim.languages[i % sim.languages.length],
      zone: zone.id,
      household_id: null,
      family_contact: null,
      initial_status: status,
      simulated: true,
    });
  }
  return people;
}

/**
 * Map a 0 to 1 value onto a range, rounded to 5 decimal places.
 *
 * Args:
 *     t (number): Value in [0, 1).
 *     min (number): Range start.
 *     max (number): Range end.
 *
 * Returns:
 *     number: A value in [min, max).
 */
function between(t: number, min: number, max: number): number {
  return Math.round((min + t * (max - min)) * 1e5) / 1e5;
}

/**
 * Small seeded random number generator, so simulated people are stable.
 *
 * Args:
 *     seed (number): Any integer.
 *
 * Returns:
 *     () => number: A function returning values in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
