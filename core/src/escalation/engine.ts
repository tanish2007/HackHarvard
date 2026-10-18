/**
 * The check-in chain that runs after a fire alert, and the human-confirmed
 * emergency call.
 *
 * After an alert, each person gets a chain of timers:
 *     1. checkin_timeout_sec with no word from them: Relay calls them and
 *        asks if they are safe (reason "missed_checkin").
 *     2. escalation_timeout_sec more: Relay calls their family contact
 *        (reason "escalation").
 *     3. escalation_timeout_sec more: they are flagged SOS on the dashboard,
 *        for a human to confirm.
 * Any event from the person stops the chain at whatever stage it is in.
 *
 * Relay never dials 911 by itself. The chain ends at a dashboard flag. Only
 * confirm(), which a responder triggers from the dashboard, calls the
 * emergency contact.
 */
import type { PlaceCallAction } from "../contracts.js";
import type { Dispatcher, PushResult } from "../dispatch/outbound.js";
import { logPushed } from "../event/alerts.js";
import { replies } from "../event/replies.js";
import { distanceKm } from "../lib/geo.js";
import { realScheduler, type Cancel, type Scheduler } from "../lib/scheduler.js";
import type { PersonStatus } from "../scenario/schema.js";
import type { IncidentStore, TrackedPerson } from "../state/store.js";

/** person_id used on the place_call to the emergency contact. */
export const EMERGENCY_PERSON_ID = "emergency_contact";

/** Within this distance a person is "at" a named place, not "near" it. */
const AT_PLACE_KM = 0.1;

/** Which step a chain will run next. */
export type ChainStage = "checkin" | "family" | "sos";

/**
 * Why a confirm was refused.
 *
 * "unknown_person" means no such person, "not_sos" means they are not in
 * SOS, and "already_confirmed" means this SOS already had its call.
 */
export type ConfirmError = "unknown_person" | "not_sos" | "already_confirmed";

/**
 * Result of a human confirm.
 *
 * Attributes:
 *     ok (boolean): True if the emergency call was pushed.
 *     error (ConfirmError | undefined): Why not, when ok is false.
 *     action (PlaceCallAction | undefined): The call that was pushed.
 *     results (PushResult[] | undefined): What Voice answered.
 */
export type ConfirmResult =
  | { ok: true; action: PlaceCallAction; results: PushResult[] }
  | { ok: false; error: ConfirmError };

/**
 * Settings for the escalation engine.
 *
 * Attributes:
 *     store (IncidentStore): The live incident state.
 *     dispatcher (Dispatcher): Pushes the calls to Voice.
 *     scheduler (Scheduler | undefined): Timers. Defaults to setTimeout, a
 *         fake one lets tests move time by hand.
 *     now (() => Date | undefined): Clock for "how long in SOS". Defaults to
 *         real time. Pass the store's clock in tests.
 *     log ((msg: string) => void | undefined): Error log. Defaults to
 *         console.error.
 */
export interface EscalationOptions {
  store: IncidentStore;
  dispatcher: Dispatcher;
  scheduler?: Scheduler;
  now?: () => Date;
  log?: (msg: string) => void;
}

/** Starts, stops, and confirms escalations. */
export interface EscalationEngine {
  /**
   * Start (or restart) the check-in chain for someone who was just alerted.
   *
   * Args:
   *     personId (string): Who was alerted.
   *
   * Returns:
   *     boolean: False if the person is unknown or already in SOS, since an
   *         SOS is already on the dashboard and needs no chain.
   */
  start(personId: string): boolean;

  /**
   * Stop a person's chain because they just got in touch.
   *
   * Args:
   *     personId (string): Who sent an event.
   */
  contactReceived(personId: string): void;

  /**
   * Which step a person's chain will run next.
   *
   * Args:
   *     personId (string): The person.
   *
   * Returns:
   *     ChainStage | null: The next step, or null if no chain is running.
   */
  stageOf(personId: string): ChainStage | null;

  /**
   * Call the emergency contact for a person in SOS, after a human confirmed.
   *
   * Args:
   *     personId (string): The person in SOS.
   *     confirmedBy (string | undefined): Who confirmed, for the timeline.
   *
   * Returns:
   *     Promise<ConfirmResult>: The pushed call, or why it was refused.
   *         Never rejects.
   */
  confirm(personId: string, confirmedBy?: string): Promise<ConfirmResult>;

  /** Cancel every chain and forget every confirm, for the demo reset. */
  reset(): void;
}

/** One person's running chain. */
interface Chain {
  stage: ChainStage;
  cancel: Cancel;
  /** Status when the chain started. If someone else changes it, the chain stops. */
  startStatus: PersonStatus;
  familyCalled: boolean;
}

/**
 * Create the escalation engine.
 *
 * Args:
 *     options (EscalationOptions): Store, dispatcher, and test hooks.
 *
 * Returns:
 *     EscalationEngine: The engine. Nothing runs until start() is called.
 */
export function createEscalationEngine(options: EscalationOptions): EscalationEngine {
  const { store, dispatcher } = options;
  const scheduler = options.scheduler ?? realScheduler;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((m: string) => console.error(m));
  const settings = store.scenario.settings;
  const incident = store.scenario.incident.name;

  const chains = new Map<string, Chain>();
  /** person_id to the SOS start time that already had its emergency call. */
  const confirmed = new Map<string, string>();

  /**
   * Schedule a chain's next step.
   *
   * Args:
   *     personId (string): Whose chain.
   *     chain (Chain): The chain, with its stage already set.
   *     seconds (number): How long to wait.
   */
  const schedule = (personId: string, chain: Chain, seconds: number): void => {
    chain.cancel = scheduler.schedule(() => {
      step(personId, chain).catch((err) => log(`[escalation] step failed for ${personId}: ${String(err)}`));
    }, seconds * 1000);
  };

  /**
   * Log and push one call Relay starts on its own.
   *
   * Args:
   *     action (PlaceCallAction): The call.
   *
   * Returns:
   *     Promise<PushResult[]>: What Voice answered.
   */
  const pushCall = (action: PlaceCallAction): Promise<PushResult[]> => {
    logPushed(store, [action]);
    return dispatcher.push([action]);
  };

  /**
   * Run the chain's current step, then schedule the next one.
   *
   * Args:
   *     personId (string): Whose chain.
   *     chain (Chain): The chain that was scheduled. If it was cancelled or
   *         replaced since, nothing runs.
   */
  const step = async (personId: string, chain: Chain): Promise<void> => {
    if (chains.get(personId) !== chain) return;
    const person = store.getPerson(personId);
    // Gone (STOP) or someone else updated them, e.g. a responder marked them
    // safe. Either way the chain no longer applies.
    if (!person || person.status !== chain.startStatus) {
      chains.delete(personId);
      return;
    }

    if (chain.stage === "checkin") {
      if (isCallable(person.handle)) {
        await pushCall({
          type: "place_call",
          person_id: person.person_id,
          to: person.handle,
          script: replies.checkinCall(incident, person.language),
          reason: "missed_checkin",
        });
      } else {
        store.addTimeline({ channel: "system", who: "Relay", text: `${person.name} has no phone number to call, skipping the check-in call` });
      }
      if (chains.get(personId) !== chain) return;
      chain.stage = "family";
      schedule(personId, chain, settings.escalation_timeout_sec);
      return;
    }

    if (chain.stage === "family") {
      const family = person.family_contact ? store.getPerson(person.family_contact) : undefined;
      if (family && isCallable(family.handle)) {
        chain.familyCalled = true;
        await pushCall({
          type: "place_call",
          person_id: family.person_id,
          to: family.handle,
          script: replies.familyCall(person.name, incident, family.language),
          reason: "escalation",
        });
      } else {
        store.addTimeline({ channel: "system", who: "Relay", text: `${person.name} has no family contact Relay can call` });
      }
      if (chains.get(personId) !== chain) return;
      chain.stage = "sos";
      schedule(personId, chain, settings.escalation_timeout_sec);
      return;
    }

    chains.delete(personId);
    const result = store.setStatus(personId, "sos");
    if (result.changed) {
      const after = chain.familyCalled ? "check-in and family call" : "check-in";
      store.addTimeline({ channel: "system", who: "Relay", text: `${person.name} unreachable after ${after}, needs human confirmation` });
    }
  };

  return {
    start(personId) {
      const person = store.getPerson(personId);
      if (!person || person.status === "sos") return false;
      chains.get(personId)?.cancel();
      const chain: Chain = { stage: "checkin", cancel: () => {}, startStatus: person.status, familyCalled: false };
      chains.set(personId, chain);
      schedule(personId, chain, settings.checkin_timeout_sec);
      return true;
    },

    contactReceived(personId) {
      const chain = chains.get(personId);
      if (!chain) return;
      chain.cancel();
      chains.delete(personId);
      const name = store.getPerson(personId)?.name ?? personId;
      store.addTimeline({ channel: "system", who: "Relay", text: `${name} got in touch, check-in stopped` });
    },

    stageOf(personId) {
      return chains.get(personId)?.stage ?? null;
    },

    async confirm(personId, confirmedBy) {
      const person = store.getPerson(personId);
      if (!person) return { ok: false, error: "unknown_person" };
      if (person.status !== "sos") return { ok: false, error: "not_sos" };
      const since = store.sosSince(personId) ?? "";
      if (confirmed.get(personId) === since) return { ok: false, error: "already_confirmed" };
      // Claimed before the push, so a double click cannot place two calls.
      confirmed.set(personId, since);

      const sosMinutes = since ? Math.max(0, (now().getTime() - Date.parse(since)) / 60000) : 0;
      const action: PlaceCallAction = {
        type: "place_call",
        person_id: EMERGENCY_PERSON_ID,
        to: store.scenario.emergency_contact.phone,
        script: replies.emergencyBriefing({
          name: person.name,
          incident,
          where: describeWhere(person, store),
          sosMinutes,
          lastMessage: store.lastMessage(personId),
        }),
        reason: "human_confirmed",
      };
      const by = confirmedBy?.trim() || "a responder";
      store.addTimeline({ channel: "system", who: "Relay", text: `911 call confirmed by ${by} for ${person.name}` });
      const results = await pushCall(action);
      return { ok: true, action, results };
    },

    reset() {
      for (const chain of chains.values()) chain.cancel();
      chains.clear();
      confirmed.clear();
    },
  };
}

/**
 * Whether a handle is a phone number Voice can call. iMessage emails are not.
 *
 * Args:
 *     handle (string | null): A normalized handle.
 *
 * Returns:
 *     boolean: True for an E.164 number.
 */
function isCallable(handle: string | null): handle is string {
  return !!handle && /^\+\d{7,15}$/.test(handle);
}

/**
 * Say where a person is, for the spoken briefing.
 *
 * Uses the zone name and the nearest named place or shelter, all from the
 * scenario, so the briefing never reads out raw coordinates.
 *
 * Args:
 *     person (TrackedPerson): The person.
 *     store (IncidentStore): The live state, for the scenario.
 *
 * Returns:
 *     string: e.g. "Zone 3, about 0.6 km from Oak St", or "unknown".
 */
function describeWhere(person: TrackedPerson, store: IncidentStore): string {
  const { scenario } = store;
  const zone = scenario.zones.find((z) => z.id === person.zone)?.name;
  let near: string | undefined;
  if (person.lat !== null && person.lng !== null) {
    const { lat, lng } = person;
    let best: { name: string; d: number } | undefined;
    for (const p of [...scenario.places, ...scenario.shelters]) {
      const d = distanceKm(lat, lng, p.lat, p.lng);
      if (!best || d < best.d) best = { name: p.name, d };
    }
    if (best) near = best.d <= AT_PLACE_KM ? `at ${best.name}` : `about ${best.d.toFixed(1)} km from ${best.name}`;
  }
  const parts = [zone, near].filter((s): s is string => !!s);
  return parts.length > 0 ? parts.join(", ") : "unknown";
}
