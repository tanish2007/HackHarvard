/**
 * Shapes Core shares with other lanes.
 *
 * Contract A is what channels POST to /event. Contract B is what Core sends
 * back. Contract D is the GET /state body the dashboard polls every two
 * seconds. Do not rename fields here without agreeing it in the group chat and
 * updating the PRD first.
 */
import type { PersonStatus } from "./scenario/schema.js";

/** Channels a Contract A event can come from. */
export type Channel = "imessage" | "sms" | "voice" | "radio";

/** Contract A: an event handed from a channel to Core. */
export interface RelayEvent {
  event_id: string;
  channel: Channel;
  /** Proposed: may be null, and Core resolves the person from `from`. */
  person_id: string | null;
  from: string;
  text: string;
  location: { lat: number; lng: number } | null;
  media_url: string | null;
  timestamp: string;
}

/**
 * Contract B: send a text to a person.
 *
 * `to` is a proposed addition: the person's handle, so Text can reach people
 * who signed up through Core and are not in scenario.json.
 */
export interface SendTextAction {
  type: "send_text";
  person_id: string;
  to: string | null;
  text: string;
  map_url: string | null;
}

/** Contract B: place an outbound call. `to` as in SendTextAction. */
export interface PlaceCallAction {
  type: "place_call";
  person_id: string;
  to: string | null;
  script: string;
  reason: string;
}

/** Contract B: speak on the call that is already open. */
export interface SayAction {
  type: "say";
  text: string;
}

/** Any action Core can return. */
export type RelayAction = SendTextAction | PlaceCallAction | SayAction;

/** Contract B: the response body from /event, and what Core pushes. */
export interface CoreResponse {
  actions: RelayAction[];
}

/**
 * Projected spread of one fire, from Core's fire model (core/src/fire/).
 * An optional addition to a fire hazard on /state.
 *
 * Attributes:
 *     model (string): Which model made it, for the map's label.
 *     fuel_model (string): Fuel model code, e.g. "GR2".
 *     fuel_name (string): Its description.
 *     moisture_scenario (string): Fuel moisture used, e.g. "D1L1".
 *     wind_mph (number): Wind used, as reported (not midflame).
 *     wind_from_deg (number): Direction the wind comes from, degrees.
 *     head_direction_deg (number): Direction the head fire moves toward.
 *     head_m_per_min (number): Head fire spread rate.
 *     back_m_per_min (number): Backing spread rate.
 *     flank_m_per_min (number): Flanking spread rate.
 *     length_to_width (number): Fire ellipse length to width ratio.
 *     flame_length_m (number): Head fire flame length.
 *     fireline_intensity_kw_m (number): Head fire intensity.
 *     computed_at (string): ISO time the forecast starts from.
 *     forecast ({ minutes: number, polygon: { lat, lng }[] }[]): Projected
 *         perimeters, nearest time first.
 */
export interface FireSpread {
  model: string;
  fuel_model: string;
  fuel_name: string;
  moisture_scenario: string;
  wind_mph: number;
  wind_from_deg: number;
  head_direction_deg: number;
  head_m_per_min: number;
  back_m_per_min: number;
  flank_m_per_min: number;
  length_to_width: number;
  flame_length_m: number;
  fireline_intensity_kw_m: number;
  computed_at: string;
  forecast: { minutes: number; polygon: { lat: number; lng: number }[] }[];
}

/** A hazard on /state. Fires may carry a projected spread. */
export interface StateHazard extends Hazard {
  spread?: FireSpread;
}

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
  hazards: StateHazard[];
  shelters: Shelter[];
  people: StatePerson[];
  volunteers: StateVolunteer[];
  reports: StateReport[];
  units: StateUnit[];
  timeline: TimelineEntry[];
  counts: StateCounts;
}
