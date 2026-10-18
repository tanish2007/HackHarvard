/**
 * The in-memory incident state store.
 *
 * Holds everyone's status, the timeline, hazards, and reports for the one
 * incident Relay runs. It starts from the scenario and is wiped on restart or
 * reset. GET /state is a snapshot of this store.
 */
import type {
  Hazard,
  Shelter,
  StateCounts,
  StatePerson,
  StateReport,
  StateResponse,
  StateUnit,
  StateVolunteer,
  TimelineEntry,
} from "../contracts.js";
import { distanceKm } from "../lib/geo.js";
import type { PersonStatus, Scenario, ScenarioPerson } from "../scenario/schema.js";

/** Oldest timeline entries are dropped past this, so /state stays small. */
const MAX_TIMELINE = 200;

/**
 * A person as Core tracks them. Superset of what /state shows.
 *
 * Attributes:
 *     seed (ScenarioPerson): The person as written in the scenario.
 *     status (PersonStatus): Current status.
 *     lat (number): Last known latitude.
 *     lng (number): Last known longitude.
 *     language (string): Language to talk to them in.
 *     last_contact (string | null): ISO time of their last message, or null.
 */
export interface TrackedPerson {
  seed: ScenarioPerson;
  status: PersonStatus;
  lat: number;
  lng: number;
  language: string;
  last_contact: string | null;
}

/**
 * In-memory state for the incident.
 *
 * Attributes:
 *     scenario (Scenario): The loaded scenario this store started from.
 */
export class IncidentStore {
  readonly scenario: Scenario;
  private readonly now: () => Date;
  private people = new Map<string, TrackedPerson>();
  private hazards: Hazard[] = [];
  private reports: StateReport[] = [];
  private units: StateUnit[] = [];
  private timeline: TimelineEntry[] = [];
  private updatedAt = "";

  /**
   * Create a store and fill it from the scenario.
   *
   * Args:
   *     scenario (Scenario): The loaded scenario.
   *     now (() => Date): Clock, injectable for tests. Defaults to real time.
   */
  constructor(scenario: Scenario, now: () => Date = () => new Date()) {
    this.scenario = scenario;
    this.now = now;
    this.reset();
  }

  /**
   * Throw away all live state and start again from the scenario.
   *
   * Used on startup and by the demo reset, so two runs in a row match.
   */
  reset(): void {
    const at = this.now().toISOString();
    this.people = new Map(
      this.scenario.people.map((seed) => [
        seed.person_id,
        { seed, status: seed.initial_status, lat: seed.lat, lng: seed.lng, language: seed.language, last_contact: null },
      ]),
    );
    const fire = this.scenario.fire_area;
    // Placeholder until the hazard watcher pulls Rudra's get_hazards.
    this.hazards = [
      {
        id: "hz_scenario_fire",
        kind: "fire",
        lat: fire.lat,
        lng: fire.lng,
        radius_km: fire.radius_km,
        severity: "high",
        source: "scenario",
        updated_at: at,
      },
    ];
    this.reports = [];
    this.units = this.scenario.units.map((u) => ({ unit_id: u.unit_id, name: u.name, last_heard: null }));
    this.timeline = [];
    this.updatedAt = at;
  }

  /**
   * Add a line to the incident timeline.
   *
   * Args:
   *     entry (Omit<TimelineEntry, "at">): Channel, who, and text.
   *
   * Returns:
   *     TimelineEntry: A copy of the stored entry, stamped with the current
   *         time. Changing it does not change the store.
   */
  addTimeline(entry: Omit<TimelineEntry, "at">): TimelineEntry {
    const stored = { at: this.now().toISOString(), ...entry };
    this.timeline.push(stored);
    if (this.timeline.length > MAX_TIMELINE) this.timeline.shift();
    this.touch();
    return { ...stored };
  }

  /**
   * Build the Contract D body for GET /state.
   *
   * Returns:
   *     StateResponse: A fresh copy. Every list is present, [] when empty.
   */
  snapshot(): StateResponse {
    const residents: StatePerson[] = [];
    const volunteers: StateVolunteer[] = [];

    for (const p of this.people.values()) {
      if (p.seed.role === "volunteer") {
        volunteers.push({
          volunteer_id: p.seed.person_id,
          name: p.seed.name,
          lat: p.lat,
          lng: p.lng,
          capacity_note: "",
          status: "available",
        });
      } else {
        residents.push({
          person_id: p.seed.person_id,
          name: p.seed.name,
          lat: p.lat,
          lng: p.lng,
          status: p.status,
          last_contact: p.last_contact,
          language: p.language,
        });
      }
    }

    // SOS first, so the dashboard and responders see the priority cases on top.
    residents.sort((a, b) => Number(b.status === "sos") - Number(a.status === "sos"));

    return {
      incident: { name: this.scenario.incident.name, updated_at: this.updatedAt },
      hazards: this.hazards.map((h) => ({ ...h })),
      shelters: this.shelters(),
      people: residents,
      volunteers,
      reports: this.reports.map((r) => ({ ...r })),
      units: this.units.map((u) => ({ ...u })),
      timeline: this.timeline.map((t) => ({ ...t })),
      counts: countStatuses(residents),
    };
  }

  /**
   * Shelters in the Contract C shape.
   *
   * Returns:
   *     Shelter[]: Each shelter, with distance_km measured from the incident
   *         center (the map has no single "you are here").
   */
  private shelters(): Shelter[] {
    const c = this.scenario.incident.center;
    return this.scenario.shelters.map((s) => ({
      id: s.id,
      name: s.name,
      lat: s.lat,
      lng: s.lng,
      distance_km: distanceKm(c.lat, c.lng, s.lat, s.lng),
      capacity_note: s.capacity_note,
    }));
  }

  /** Mark the incident as changed now. */
  private touch(): void {
    this.updatedAt = this.now().toISOString();
  }
}

/**
 * Count residents by status.
 *
 * Args:
 *     people (StatePerson[]): Residents on the map.
 *
 * Returns:
 *     StateCounts: How many are in each status.
 */
function countStatuses(people: StatePerson[]): StateCounts {
  const counts: StateCounts = { safe: 0, unconfirmed: 0, sos: 0, en_route: 0 };
  for (const p of people) counts[p.status]++;
  return counts;
}
