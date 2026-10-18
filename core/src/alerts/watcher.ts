/**
 * The hazard watcher: pulls hazards from the data layer and alerts people
 * near a fire.
 *
 * Each run asks Contract C's get_hazards for everything around the incident,
 * puts the result on the map, and texts every reachable resident within
 * settings.alert_radius_km of a fire's edge who has not been alerted about
 * that fire yet. Each alert carries the fire's distance and direction and the
 * nearest shelter with a route summary, then starts that person's check-in
 * chain.
 *
 * In "auto" mode the server polls every settings.hazard_poll_sec. In
 * "manual" mode (the default) nothing runs until POST /admin/alert calls
 * runOnce(), so the demo decides when the alert goes out.
 */
import type { Hazard, SendTextAction } from "../contracts.js";
import type { DataTools } from "../data/types.js";
import type { Dispatcher } from "../dispatch/outbound.js";
import { logPushed } from "../event/alerts.js";
import { replies, type FireAlert } from "../event/replies.js";
import { compassDirection, distanceKm } from "../lib/geo.js";
import { realScheduler, type Cancel, type Scheduler } from "../lib/scheduler.js";
import type { IncidentStore, TrackedPerson } from "../state/store.js";

/**
 * Settings for the hazard watcher.
 *
 * Attributes:
 *     store (IncidentStore): The live incident state.
 *     data (DataTools): The Contract C functions.
 *     dispatcher (Dispatcher): Pushes the alert texts to Text.
 *     checkins ({ start(personId: string): boolean } | undefined): Starts a
 *         person's check-in chain after their alert. Usually the escalation
 *         engine. Without it, no chain runs.
 *     scheduler (Scheduler | undefined): Timers for the poll loop. Defaults
 *         to setTimeout.
 *     log ((msg: string) => void | undefined): Error log. Defaults to
 *         console.error.
 */
export interface WatcherOptions {
  store: IncidentStore;
  data: DataTools;
  dispatcher: Dispatcher;
  checkins?: { start(personId: string): boolean };
  scheduler?: Scheduler;
  log?: (msg: string) => void;
}

/**
 * What one run did.
 *
 * Attributes:
 *     alerted (number): How many people were texted.
 *     person_ids (string[]): Who was texted. Ids only, never phone numbers.
 *     hazards (number): How many hazards are on the map after the run.
 */
export interface AlertSummary {
  alerted: number;
  person_ids: string[];
  hazards: number;
}

/** Polls hazards and sends fire alerts. */
export interface HazardWatcher {
  /**
   * Pull hazards once and alert anyone newly in range.
   *
   * Runs one at a time: a call made while another run is going waits for it,
   * so a poll and the admin trigger can never alert the same person twice.
   *
   * Returns:
   *     Promise<AlertSummary>: What the run did. Never rejects.
   */
  runOnce(): Promise<AlertSummary>;

  /** Run now, then every settings.hazard_poll_sec until stop(). */
  start(): void;

  /** Stop the poll loop. A run already going finishes. */
  stop(): void;

  /**
   * Forget who was alerted, for the demo reset. A run already going stops
   * before it sends anything.
   */
  reset(): void;
}

/** A fire a person is close to. */
interface NearFire {
  hazard: Hazard;
  /** Distance to the fire's edge in km. Zero or less means inside it. */
  edgeKm: number;
}

/**
 * Create the hazard watcher.
 *
 * Args:
 *     options (WatcherOptions): Store, data, dispatcher, and test hooks.
 *
 * Returns:
 *     HazardWatcher: The watcher. Nothing runs until runOnce() or start().
 */
export function createHazardWatcher(options: WatcherOptions): HazardWatcher {
  const { store, data, dispatcher } = options;
  const scheduler = options.scheduler ?? realScheduler;
  const log = options.log ?? ((m: string) => console.error(m));
  const { settings, incident } = store.scenario;

  /** "person_id|hazard_id" pairs already alerted. */
  const alerted = new Set<string>();
  /** Bumped by reset(), so a run that started before it sends nothing. */
  let generation = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let polling = false;
  let cancelNext: Cancel = () => {};

  const empty = (): AlertSummary => ({ alerted: 0, person_ids: [], hazards: store.listHazards().length });
  const key = (personId: string, hazardId: string) => `${personId}|${hazardId}`;

  /**
   * How far from the incident centre to ask for hazards: far enough to cover
   * every zone and every located person, plus the alert radius.
   *
   * Returns:
   *     number: Radius in km.
   */
  const pollRadiusKm = (): number => {
    const c = incident.center;
    let far = 0;
    for (const z of store.scenario.zones) for (const [lat, lng] of z.polygon) far = Math.max(far, distanceKm(c.lat, c.lng, lat, lng));
    for (const p of store.listPeople()) {
      if (p.lat !== null && p.lng !== null) far = Math.max(far, distanceKm(c.lat, c.lng, p.lat, p.lng));
    }
    return Math.ceil((far + settings.alert_radius_km) * 10) / 10;
  };

  /**
   * Fires a person should be alerted about and has not been yet, nearest first.
   *
   * Args:
   *     person (TrackedPerson): A located person.
   *     fires (Hazard[]): Current fire hazards.
   *
   * Returns:
   *     NearFire[]: Possibly empty.
   */
  const newFiresNear = (person: TrackedPerson, fires: Hazard[]): NearFire[] => {
    if (person.lat === null || person.lng === null) return [];
    const { lat, lng } = person;
    return fires
      .map((hazard) => ({ hazard, edgeKm: distanceKm(lat, lng, hazard.lat, hazard.lng) - hazard.radius_km }))
      .filter((f) => f.edgeKm <= settings.alert_radius_km && !alerted.has(key(person.person_id, f.hazard.id)))
      .sort((a, b) => a.edgeKm - b.edgeKm);
  };

  /**
   * Build one alert text, with the nearest shelter and a route to it.
   *
   * A failed shelter or route lookup makes the text shorter, never stops it.
   *
   * Args:
   *     person (TrackedPerson): A located person.
   *     fire (NearFire): The nearest fire to tell them about.
   *
   * Returns:
   *     Promise<{ action: SendTextAction; alert: FireAlert }>: The text and
   *         the facts in it, for the timeline.
   */
  const buildAlert = async (person: TrackedPerson, fire: NearFire) => {
    const lat = person.lat as number;
    const lng = person.lng as number;
    let shelter: FireAlert["shelter"] = null;
    try {
      const nearest = (await data.getShelters(lat, lng))[0];
      if (nearest) {
        shelter = { name: nearest.name, km: nearest.distance_km, minutes: null };
        try {
          const route = await data.getRoute(lat, lng, nearest.lat, nearest.lng);
          shelter = { name: nearest.name, km: route.distance_km, minutes: route.duration_min };
        } catch (err) {
          log(`[watcher] route lookup failed for ${person.person_id}: ${String(err)}`);
        }
      }
    } catch (err) {
      log(`[watcher] shelter lookup failed for ${person.person_id}: ${String(err)}`);
    }
    const alert: FireAlert = {
      name: person.name,
      incident: incident.name,
      fireKm: Math.max(0, fire.edgeKm),
      direction: compassDirection(lat, lng, fire.hazard.lat, fire.hazard.lng),
      inside: fire.edgeKm <= 0,
      shelter,
    };
    const action: SendTextAction = {
      type: "send_text",
      person_id: person.person_id,
      to: person.handle,
      text: replies.fireAlert(alert),
      map_url: null,
    };
    return { action, alert };
  };

  /**
   * One run: refresh hazards, then alert everyone newly in range.
   *
   * Returns:
   *     Promise<AlertSummary>: What the run did.
   */
  const run = async (): Promise<AlertSummary> => {
    const gen = generation;
    const c = incident.center;
    let hazards: Hazard[];
    try {
      hazards = await data.getHazards(c.lat, c.lng, pollRadiusKm());
    } catch (err) {
      // Keep the last hazards on the map rather than blanking it.
      log(`[watcher] get_hazards failed: ${String(err)}`);
      return empty();
    }
    if (gen !== generation) return empty();
    store.setHazards(hazards);

    const fires = store.listHazards().filter((h) => h.kind === "fire");
    const targets: { person: TrackedPerson; near: NearFire[] }[] = [];
    for (const person of store.listPeople()) {
      // Simulated people have no handle, so they are skipped here too.
      if (person.role !== "resident" || !person.handle) continue;
      const near = newFiresNear(person, fires);
      if (near.length > 0) targets.push({ person, near });
    }
    if (targets.length === 0) return empty();

    const built = await Promise.all(targets.map((t) => buildAlert(t.person, t.near[0])));
    if (gen !== generation) return empty();

    const sent: SendTextAction[] = [];
    for (let i = 0; i < targets.length; i++) {
      const { person, near } = targets[i];
      // They may have sent STOP while the lookups ran.
      if (!store.getPerson(person.person_id)) continue;
      const { action, alert } = built[i];
      // One alert covers every fire they are near right now.
      for (const f of near) alerted.add(key(person.person_id, f.hazard.id));
      sent.push(action);
      logPushed(store, [action]);
      const where = alert.inside ? "inside the fire area" : `fire ${alert.fireKm.toFixed(1)} km ${alert.direction}`;
      const to = alert.shelter ? `, nearest shelter ${alert.shelter.name}` : "";
      store.addTimeline({ channel: "system", who: "Relay", text: `Fire alert sent to ${person.name} (${where}${to})` });
      options.checkins?.start(person.person_id);
    }
    if (sent.length > 0) await dispatcher.push(sent);
    return { alerted: sent.length, person_ids: sent.map((a) => a.person_id), hazards: store.listHazards().length };
  };

  /** One poll tick: run, then schedule the next tick if still polling. */
  const tick = (): void => {
    watcher.runOnce().finally(() => {
      if (polling) cancelNext = scheduler.schedule(tick, settings.hazard_poll_sec * 1000);
    });
  };

  const watcher: HazardWatcher = {
    runOnce() {
      const result = queue.then(run).catch((err): AlertSummary => {
        log(`[watcher] run failed: ${String(err)}`);
        return empty();
      });
      queue = result;
      return result;
    },

    start() {
      if (polling) return;
      polling = true;
      tick();
    },

    stop() {
      polling = false;
      cancelNext();
    },

    reset() {
      generation++;
      alerted.clear();
    },
  };
  return watcher;
}
