/**
 * Schemas for scenario.json (Contract E) and its local phone override file.
 *
 * scenario.json is committed and holds only fictional placeholder numbers.
 * scenario.local.json is gitignored and replaces those numbers with real ones.
 */
import { z } from "zod";

/** E.164 phone number, e.g. +16175550101. */
export const phoneSchema = z.string().regex(/^\+[1-9]\d{6,14}$/, "phone must be E.164, like +16175550101");

/** Fictional US range 555-0100 to 555-0199. Safe to commit. */
export const PLACEHOLDER_PHONE = /^\+1\d{3}55501\d{2}$/;

export const statusSchema = z.enum(["safe", "unconfirmed", "sos", "en_route"]);

const zoneSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  polygon: z.array(z.tuple([z.number(), z.number()])).min(3),
});

const shelterSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  lat: z.number(),
  lng: z.number(),
  capacity_note: z.string(),
});

const personSchema = z.object({
  person_id: z.string().min(1),
  name: z.string().min(1),
  role: z.enum(["resident", "volunteer"]),
  phone: phoneSchema.nullable(),
  lat: z.number(),
  lng: z.number(),
  language: z.string().min(2),
  zone: z.string().nullable(),
  household_id: z.string().nullable(),
  family_contact: z.string().nullable(),
  initial_status: statusSchema,
  simulated: z.boolean(),
});

const simulatedPopulationSchema = z.object({
  count: z.number().int().min(0),
  sos: z.number().int().min(0),
  unconfirmed: z.number().int().min(0),
  seed: z.number().int(),
  names: z.array(z.string().min(1)).min(1),
  languages: z.array(z.string().min(2)).min(1),
});

const unitSchema = z.object({
  unit_id: z.string().min(1),
  name: z.string().min(1),
  phone: phoneSchema,
});

const agentSchema = z.object({
  agent_id: z.string().min(1),
  kind: z.enum(["government", "household", "volunteer_group"]),
  household_id: z.string().nullable(),
  trusts: z.array(z.string()),
});

const settingsSchema = z.object({
  checkin_timeout_sec: z.number().positive(),
  escalation_timeout_sec: z.number().positive(),
  hazard_poll_sec: z.number().positive(),
  alert_radius_km: z.number().positive(),
  wake_phrase: z.string().min(1),
  /** Place id responders route from when they do not say where they are. */
  command_post: z.string().min(1),
  /**
   * "auto" polls hazards and sends fire alerts on its own. "manual" waits
   * for POST /admin/alert, so the demo picks the moment. Defaults to manual.
   */
  alerts: z.enum(["manual", "auto"]).default("manual"),
});

/**
 * Inputs for the fire spread model (core/src/fire/). Every field has a
 * default, so the whole block is optional.
 */
const fireBehaviorSchema = z.object({
  _readme: z.string().optional(),
  /** Standard fuel model code (Anderson 13 or Scott and Burgan 40), e.g. "GR2". */
  fuel_model: z.string().min(1).default("GR2"),
  /** Scott and Burgan moisture scenario, e.g. "D1L1" (very dry, cured grass). */
  moisture_scenario: z.string().min(1).default("D1L1"),
  /** Height the weather wind is measured at. NWS forecasts are 10 m. */
  wind_height: z.enum(["10m", "20ft", "midflame"]).default("10m"),
  /** Slope steepness in percent, and the direction the slope faces. 0 = flat. */
  slope_percent: z.number().min(0).default(0),
  aspect_deg: z.number().min(0).max(360).default(0),
  /** How far ahead to project the perimeter, in minutes. */
  forecast_minutes: z.array(z.number().positive()).min(1).default([30, 60, 120]),
});

/** A named spot people say out loud: "route to Oak St". */
const placeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  lat: z.number(),
  lng: z.number(),
});

/** Forecast the data stub returns until live NWS weather is wired in. */
const fakeWeatherSchema = z.object({
  summary: z.string(),
  wind_mph: z.number(),
  wind_dir: z.string(),
  temp_f: z.number(),
  next_2h: z.string(),
});

export const scenarioFileSchema = z.object({
  _readme: z.string().optional(),
  incident: z.object({
    name: z.string().min(1),
    center: z.object({ lat: z.number(), lng: z.number() }),
  }),
  relay_lines: z.object({ messaging: phoneSchema, voice: phoneSchema }),
  zones: z.array(zoneSchema),
  fire_area: z.object({ lat: z.number(), lng: z.number(), radius_km: z.number().positive() }),
  places: z.array(placeSchema),
  fake_weather: fakeWeatherSchema,
  shelters: z.array(shelterSchema),
  people: z.array(personSchema),
  simulated_population: simulatedPopulationSchema,
  units: z.array(unitSchema),
  emergency_contact: z.object({ label: z.string().min(1), phone: phoneSchema }),
  agents: z.array(agentSchema),
  settings: settingsSchema,
  fire_behavior: fireBehaviorSchema.default(() => fireBehaviorSchema.parse({})),
});

export const localOverrideSchema = z
  .object({
    _readme: z.string().optional(),
    relay_lines: z.object({ messaging: phoneSchema, voice: phoneSchema }).partial().optional(),
    phones: z.record(z.string(), phoneSchema).optional(),
  })
  .strict();

export type ScenarioFile = z.infer<typeof scenarioFileSchema>;
export type LocalOverride = z.infer<typeof localOverrideSchema>;
export type ScenarioPerson = z.infer<typeof personSchema>;
export type ScenarioPlace = z.infer<typeof placeSchema>;
export type PersonStatus = z.infer<typeof statusSchema>;

/** A fully loaded scenario: real numbers merged in, simulated people generated. */
export type Scenario = Omit<ScenarioFile, "_readme" | "simulated_population">;
