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
  shelters: z.array(shelterSchema),
  people: z.array(personSchema),
  simulated_population: simulatedPopulationSchema,
  units: z.array(unitSchema),
  emergency_contact: z.object({ label: z.string().min(1), phone: phoneSchema }),
  agents: z.array(agentSchema),
  settings: settingsSchema,
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
export type PersonStatus = z.infer<typeof statusSchema>;

/** A fully loaded scenario: real numbers merged in, simulated people generated. */
export type Scenario = Omit<ScenarioFile, "_readme" | "simulated_population">;
