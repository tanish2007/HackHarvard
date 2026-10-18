/**
 * Shapes Core hands to other lanes.
 *
 * Contract D is the GET /state body the dashboard polls every two seconds.
 * Do not rename fields here without agreeing it in the group chat and
 * updating the PRD first.
 */
import type { PersonStatus } from "./scenario/schema.js";

/** Contract C hazard shape, reused as-is in /state. */
export interface Hazard {
  id: string;
  kind: "fire" | "weather";
  lat: number;
  lng: number;
  radius_km: number;
  severity: string;
  source: string;
  updated_at: string;
}

/** Contract C shelter shape, reused as-is in /state. */
export interface Shelter {
  id: string;
  name: string;
  lat: number;
  lng: number;
  distance_km: number;
  capacity_note: string;
}

/** A resident on the map. */
export interface StatePerson {
  person_id: string;
  name: string;
  lat: number;
  lng: number;
  status: PersonStatus;
  last_contact: string | null;
  language: string;
}

/** A volunteer on the map. Proposed shape, pending group okay. */
export interface StateVolunteer {
  volunteer_id: string;
  name: string;
  lat: number;
  lng: number;
  capacity_note: string;
  status: string;
}

/** A field report such as a blocked road. Proposed shape, pending group okay. */
export interface StateReport {
  id: string;
  kind: "road_blocked" | "fire_sighting" | "other";
  lat: number;
  lng: number;
  text: string;
  media_url: string | null;
  reported_by: string;
  at: string;
}

/** A responder unit. Proposed shape, pending group okay. */
export interface StateUnit {
  unit_id: string;
  name: string;
  last_heard: string | null;
}

/** One line in the incident timeline. */
export interface TimelineEntry {
  at: string;
  channel: string;
  who: string;
  text: string;
}

/** Status counts. `en_route` is a proposed addition, pending group okay. */
export interface StateCounts {
  safe: number;
  unconfirmed: number;
  sos: number;
  en_route: number;
}

/**
 * Contract D: the full live picture.
 *
 * Every list is always present. Empty lists are [], never missing or null.
 */
export interface StateResponse {
  incident: { name: string; updated_at: string };
  hazards: Hazard[];
  shelters: Shelter[];
  people: StatePerson[];
  volunteers: StateVolunteer[];
  reports: StateReport[];
  units: StateUnit[];
  timeline: TimelineEntry[];
  counts: StateCounts;
}
