/**
 * The in-memory incident state store.
 *
 * Holds everyone's status, the timeline, hazards, and reports for the one
 * incident Relay runs. It starts from the scenario and is wiped on restart or
 * reset. GET /state is a snapshot of this store.
 *
 * Every method returns copies, so callers cannot change the store by accident.
 */
import type {
  CoreResponse,
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
import { handleKey } from "../lib/phone.js";
import type { PersonStatus, Scenario } from "../scenario/schema.js";

/** Oldest timeline entries are dropped past this, so /state stays small. */
const MAX_TIMELINE = 200;

/** How many recent event ids are remembered for duplicate deliveries. */
const MAX_SEEN_EVENTS = 500;

/**
 * A person as Core tracks them. Superset of what /state shows.
 *
 * Attributes:
 *     person_id (string): Stable id.
 *     name (string): Display name.
 *     role ("resident" | "volunteer"): What they do in the incident.
 *     handle (string | null): Normalized phone number or iMessage email.
 *     status (PersonStatus): Current status.
 *     lat (number | null): Last known latitude. Null until they share one.
 *     lng (number | null): Last known longitude.
 *     language (string): Language to talk to them in.
 *     zone (string | null): Zone id, if known.
 *     household_id (string | null): Household, for family and agent links.
 *     family_contact (string | null): person_id of their family contact.
 *     simulated (boolean): True for generated personas.
 *     last_contact (string | null): ISO time of their last message, or null.
 */
export interface TrackedPerson {
  person_id: string;
  name: string;
  role: "resident" | "volunteer";
  handle: string | null;
  status: PersonStatus;
  lat: number | null;
  lng: number | null;
  language: string;
  zone: string | null;
  household_id: string | null;
  family_contact: string | null;
  simulated: boolean;
  last_contact: string | null;
}

/**
 * A responder unit as Core tracks it.
 *
 * Attributes:
 *     unit_id (string): Stable id.
 *     name (string): Call sign, e.g. "Unit 4".
 *     handle (string): Normalized phone number.
 *     last_heard (string | null): ISO time Relay last heard from them.
 */
export interface TrackedUnit {
  unit_id: string;
  name: string;
  handle: string;
  last_heard: string | null;
}

/**
 * Result of a status change request.
 *
 * Attributes:
 *     changed (boolean): Whether the status actually changed.
 *     previous (PersonStatus): The status before the request.
 *     held (boolean): True when an SOS was kept because only a responder
 *         can clear it.
 */
export interface StatusResult {
  changed: boolean;
  previous: PersonStatus;
  held: boolean;
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
  private units = new Map<string, TrackedUnit>();
  private hazards: Hazard[] = [];
  private reports: StateReport[] = [];
  private timeline: TimelineEntry[] = [];
  private seenEvents = new Map<string, CoreResponse>();
  private optedOut = new Map<string, TrackedPerson>();
  private newPeopleCount = 0;
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
    const at = this.nowIso();
    this.people = new Map(
      this.scenario.people.map((p) => [
        p.person_id,
        {
          person_id: p.person_id,
          name: p.name,
          role: p.role,
          handle: p.phone ? handleKey(p.phone) : null,
          status: p.initial_status,
          lat: p.lat,
          lng: p.lng,
          language: p.language,
          zone: p.zone,
          household_id: p.household_id,
          family_contact: p.family_contact,
          simulated: p.simulated,
          last_contact: null,
        },
      ]),
    );
    this.units = new Map(
      this.scenario.units.map((u) => [
        u.unit_id,
        { unit_id: u.unit_id, name: u.name, handle: handleKey(u.phone) ?? u.phone, last_heard: null },
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
    this.timeline = [];
    this.seenEvents = new Map();
    this.optedOut = new Map();
    this.newPeopleCount = 0;
    this.updatedAt = at;
  }

  /**
   * Look up a person by id.
   *
   * Args:
   *     personId (string): The person_id.
   *
   * Returns:
   *     TrackedPerson | undefined: A copy, or undefined if unknown.
   */
  getPerson(personId: string): TrackedPerson | undefined {
    const p = this.people.get(personId);
    return p ? { ...p } : undefined;
  }

  /**
   * Everyone currently tracked, for the agent's people lookups.
   *
   * Returns:
   *     TrackedPerson[]: Copies, in scenario order.
   */
  listPeople(): TrackedPerson[] {
    return [...this.people.values()].map((p) => ({ ...p }));
  }

  /**
   * Look up a person by phone number or iMessage email.
   *
   * Args:
   *     handle (string): The handle in any format, e.g. "(617) 555-0101".
   *
   * Returns:
   *     TrackedPerson | undefined: A copy, or undefined if nobody matches.
   */
  findPersonByHandle(handle: string): TrackedPerson | undefined {
    const h = handleKey(handle);
    if (!h) return undefined;
    for (const p of this.people.values()) if (p.handle === h) return { ...p };
    return undefined;
  }

  /**
   * Look up a responder unit by phone number.
   *
   * Args:
   *     handle (string): The handle in any format.
   *
   * Returns:
   *     TrackedUnit | undefined: A copy, or undefined if no unit matches.
   */
  findUnitByHandle(handle: string): TrackedUnit | undefined {
    const h = handleKey(handle);
    if (!h) return undefined;
    for (const u of this.units.values()) if (u.handle === h) return { ...u };
    return undefined;
  }

  /**
   * Add a resident who signed up by texting Relay.
   *
   * Args:
   *     handle (string): Their phone number or iMessage email.
   *     location ({ lat: number, lng: number } | null): Where they are, if shared.
   *     preferredId (string | undefined): The person_id the channel already
   *         uses for them (Text makes one up for numbers not in the
   *         scenario). Used when free, so Core's replies carry the id the
   *         channel expects. Otherwise Core picks "p_new_N".
   *
   * Returns:
   *     TrackedPerson: A copy of the new person, status unconfirmed.
   */
  addPerson(handle: string, location: { lat: number; lng: number } | null, preferredId?: string): TrackedPerson {
    this.newPeopleCount++;
    let id = `p_new_${this.newPeopleCount}`;
    while (this.people.has(id)) id = `p_new_${++this.newPeopleCount}`;
    const taken = (candidate: string) =>
      this.people.has(candidate) || this.optedOut.has(candidate) || this.units.has(candidate);
    if (preferredId && !taken(preferredId)) id = preferredId;
    const person: TrackedPerson = {
      person_id: id,
      name: `New resident ${this.newPeopleCount}`,
      role: "resident",
      handle: handleKey(handle) ?? handle,
      status: "unconfirmed",
      lat: location?.lat ?? null,
      lng: location?.lng ?? null,
      language: "en",
      zone: null,
      household_id: null,
      family_contact: null,
      simulated: false,
      last_contact: null,
    };
    this.people.set(id, person);
    this.touch();
    return { ...person };
  }

  /**
   * Remove a person, for STOP.
   *
   * They are kept aside, so if they text again they come back with their
   * name, household, and family contact instead of as a stranger.
   *
   * Args:
   *     personId (string): Who to remove.
   *
   * Returns:
   *     boolean: True if they were there.
   */
  removePerson(personId: string): boolean {
    const person = this.people.get(personId);
    if (!person) return false;
    this.people.delete(personId);
    this.optedOut.set(personId, person);
    this.touch();
    return true;
  }

  /**
   * Bring back someone who sent STOP and then texted again.
   *
   * Args:
   *     handle (string): The handle they are texting from.
   *
   * Returns:
   *     TrackedPerson | undefined: A copy of the restored person, status
   *         unconfirmed, or undefined if nobody with that handle opted out.
   */
  restoreByHandle(handle: string): TrackedPerson | undefined {
    const h = handleKey(handle);
    if (!h) return undefined;
    for (const [id, p] of this.optedOut) {
      if (p.handle !== h) continue;
      this.optedOut.delete(id);
      const restored = { ...p, status: p.status === "sos" ? p.status : ("unconfirmed" as PersonStatus) };
      this.people.set(id, restored);
      this.touch();
      return { ...restored };
    }
    return undefined;
  }

  /**
   * Record that a person just got in touch, and where they are if known.
   *
   * Args:
   *     personId (string): Who got in touch.
   *     location ({ lat: number, lng: number } | null): New location, or null
   *         to keep the last known one.
   */
  recordContact(personId: string, location: { lat: number; lng: number } | null): void {
    const p = this.people.get(personId);
    if (!p) return;
    p.last_contact = this.nowIso();
    if (location) {
      p.lat = location.lat;
      p.lng = location.lng;
    }
    this.touch();
  }

  /**
   * Change a person's status.
   *
   * An SOS is never cleared automatically. Only a responder can clear it, so
   * a request to move someone out of sos is held unless `byResponder` is set.
   *
   * Args:
   *     personId (string): Who to update.
   *     status (PersonStatus): The new status.
   *     options ({ byResponder?: boolean }): Set byResponder when a human
   *         responder confirmed the change.
   *
   * Returns:
   *     StatusResult: Whether it changed, the previous status, and whether an
   *         SOS was held.
   *
   * Raises:
   *     Error: If the person does not exist.
   */
  setStatus(personId: string, status: PersonStatus, options: { byResponder?: boolean } = {}): StatusResult {
    const p = this.people.get(personId);
    if (!p) throw new Error(`Unknown person "${personId}"`);
    const previous = p.status;
    if (previous === "sos" && status !== "sos" && !options.byResponder) {
      return { changed: false, previous, held: true };
    }
    if (previous === status) return { changed: false, previous, held: false };
    p.status = status;
    this.touch();
    return { changed: true, previous, held: false };
  }

  /**
   * Record that a responder unit was just heard on the radio or phone.
   *
   * Args:
   *     unitId (string): The unit.
   */
  markUnitHeard(unitId: string): void {
    const u = this.units.get(unitId);
    if (!u) return;
    u.last_heard = this.nowIso();
    this.touch();
  }

  /**
   * Get the response already sent for an event id, for duplicate deliveries.
   *
   * Args:
   *     eventId (string): The event_id.
   *
   * Returns:
   *     CoreResponse | undefined: A copy of the earlier response, if any.
   */
  seenResponse(eventId: string): CoreResponse | undefined {
    const r = this.seenEvents.get(eventId);
    return r ? structuredClone(r) : undefined;
  }

  /**
   * Remember the response for an event id.
   *
   * Args:
   *     eventId (string): The event_id.
   *     response (CoreResponse): What Core answered.
   */
  rememberResponse(eventId: string, response: CoreResponse): void {
    this.seenEvents.set(eventId, structuredClone(response));
    if (this.seenEvents.size > MAX_SEEN_EVENTS) {
      this.seenEvents.delete(this.seenEvents.keys().next().value as string);
    }
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
    const stored = { at: this.nowIso(), ...entry };
    this.timeline.push(stored);
    if (this.timeline.length > MAX_TIMELINE) this.timeline.shift();
    this.touch();
    return { ...stored };
  }

  /**
   * Build the Contract D body for GET /state.
   *
   * People without a known location are left off the map (a marker needs
   * coordinates) but still counted, so an SOS from someone who has not
   * shared a location still shows in counts.sos. A volunteer in SOS is
   * counted and shown as a person in SOS, not as an available volunteer.
   *
   * Returns:
   *     StateResponse: A fresh copy. Every list is present, [] when empty.
   */
  snapshot(): StateResponse {
    const residents: StatePerson[] = [];
    const volunteers: StateVolunteer[] = [];
    const counts: StateCounts = { safe: 0, unconfirmed: 0, sos: 0, en_route: 0 };

    for (const p of this.people.values()) {
      const asVolunteer = p.role === "volunteer" && p.status !== "sos";
      if (!asVolunteer) counts[p.status]++;
      if (p.lat === null || p.lng === null) continue;
      if (asVolunteer) {
        volunteers.push({
          volunteer_id: p.person_id,
          name: p.name,
          lat: p.lat,
          lng: p.lng,
          capacity_note: "",
          status: "available",
        });
      } else {
        residents.push({
          person_id: p.person_id,
          name: p.name,
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
      units: [...this.units.values()].map((u): StateUnit => ({ unit_id: u.unit_id, name: u.name, last_heard: u.last_heard })),
      timeline: this.timeline.map((t) => ({ ...t })),
      counts,
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

  /**
   * Current time as an ISO string.
   *
   * Returns:
   *     string: The injected clock's time.
   */
  private nowIso(): string {
    return this.now().toISOString();
  }

  /** Mark the incident as changed now. */
  private touch(): void {
    this.updatedAt = this.nowIso();
  }
}
