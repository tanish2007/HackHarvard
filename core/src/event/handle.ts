/**
 * Turns one Contract A event into Contract B actions.
 *
 * Steps: replay duplicates, work out who sent it, log it, run the fast rules,
 * and only then hand anything left over to the agent. Core never sends
 * anything itself. It only returns actions for the channels to carry out.
 */
import type { CoreResponse, RelayAction, RelayEvent } from "../contracts.js";
import type { DataTools } from "../data/types.js";
import type { Dispatcher } from "../dispatch/outbound.js";
import { detectLanguage } from "../lang/detect.js";
import { resolveLang } from "../lang/languages.js";
import { compassDirection, judgeMove } from "../lib/geo.js";
import { handleKey } from "../lib/phone.js";
import { classify } from "../rules/fastpath.js";
import type { PersonStatus } from "../scenario/schema.js";
import type { IncidentStore, TrackedPerson, TrackedUnit } from "../state/store.js";
import { familyAlert } from "./alerts.js";
import { replies, type Medium } from "./replies.js";

/**
 * What the agent gets when the fast rules do not handle a message.
 *
 * Attributes:
 *     event (RelayEvent): The original event.
 *     text (string): The text to answer. For radio, the wake phrase is removed.
 *     person (TrackedPerson | undefined): The sender, if they are a person.
 *     unit (TrackedUnit | undefined): The sender, if they are a responder unit.
 *     who (string): Display name of the sender for the timeline.
 *     signal (AbortSignal): Aborted when Core stops waiting, so the agent
 *         can cancel its LLM call instead of running on in the background.
 *     sideActions (RelayAction[] | undefined): Where the agent puts actions
 *         its tools add besides the reply, e.g. the family text after an
 *         SOS. The handler owns the list, so it still sends them if the
 *         agent fails or times out after the tool ran.
 */
export interface AgentContext {
  event: RelayEvent;
  text: string;
  person: TrackedPerson | undefined;
  unit: TrackedUnit | undefined;
  who: string;
  signal: AbortSignal;
  sideActions?: RelayAction[];
}

/** The LLM agent, plugged in by the agent step. Returns actions to send. */
export type Agent = (ctx: AgentContext) => Promise<RelayAction[]>;

/**
 * What the handler needs.
 *
 * Attributes:
 *     store (IncidentStore): The live incident state.
 *     agent (Agent | undefined): The LLM agent. Without it, unmatched
 *         messages get a fixed fallback reply.
 *     escalation ({ contactReceived, notAnswered } | undefined): Told
 *         whenever a person gets in touch, so their check-in chain stops.
 *         A voicemail greeting calls notAnswered so the family phone is
 *         still dialed. Without it, no chains run.
 *     dispatcher (Pick<Dispatcher, "push"> | undefined): Pushes actions
 *         for anyone other than the sender, e.g. the family text after an
 *         SOS, straight to the lane that carries them out. A channel only
 *         answers the person it is talking to, so those actions would be
 *         lost in the reply. Without it, they stay in the reply.
 */
export interface HandlerDeps {
  store: IncidentStore;
  agent?: Agent;
  escalation?: { contactReceived(personId: string): void; notAnswered?(personId: string): void };
  dispatcher?: Pick<Dispatcher, "push">;
  data?: DataTools;
}

/** Who sent an event, after looking them up. */
interface Sender {
  person: TrackedPerson | undefined;
  unit: TrackedUnit | undefined;
  who: string;
  isNew: boolean;
  rejoined: boolean;
  /** True when this event repeats the location Core already has. */
  sameLocation: boolean;
}

/**
 * The default for how long Core waits for the agent before falling back.
 *
 * It is 3200 ms, which leaves time inside Voice's 4 s default wait on /event.
 * See agentTimeoutMs() for how to wait longer.
 */
export const AGENT_TIMEOUT_MS = 3200;

/**
 * How long Core waits for the agent before falling back, right now.
 *
 * The Gemini agent can take longer than the default when the model is slow,
 * so AGENT_TIMEOUT_MS in .env raises it. It is read each time, not once at
 * start, because server.ts loads .env after its imports have run. Raise
 * Voice's VOICE_CORE_TIMEOUT_MS above it so Voice does not give up first.
 * Voice says "One moment" on a call while it waits.
 *
 * Returns:
 *     number: The setting in milliseconds, or the 3200 default if it is
 *         missing or not a positive number.
 */
export function agentTimeoutMs(): number {
  const wanted = Number(process.env.AGENT_TIMEOUT_MS);
  return Number.isFinite(wanted) && wanted > 0 ? wanted : AGENT_TIMEOUT_MS;
}

/** Events still being handled, per store, so a redelivery waits for them. */
const inFlight = new WeakMap<IncidentStore, Map<string, Promise<CoreResponse>>>();

/**
 * Handle one event and return the actions for the channels.
 *
 * A repeated event gets the same response again without running twice,
 * because Photon can deliver the same message more than once, most often
 * while Core is slow. That includes a copy that arrives while the first is
 * still being handled. Events are keyed on channel plus event_id, since Text
 * and Voice number their events separately.
 *
 * Args:
 *     event (RelayEvent): A validated Contract A event.
 *     deps (HandlerDeps): The store and the optional agent.
 *
 * Returns:
 *     Promise<CoreResponse>: The actions. Possibly an empty list, never null.
 */
export async function handleEvent(event: RelayEvent, deps: HandlerDeps): Promise<CoreResponse> {
  const key = `${event.channel}:${event.event_id}`;
  const seen = deps.store.seenResponse(key);
  if (seen) return seen;

  let pending = inFlight.get(deps.store);
  if (!pending) inFlight.set(deps.store, (pending = new Map()));
  const running = pending.get(key);
  if (running) return structuredClone(await running);

  const work = (async () => {
    const sender = resolveSender(event, deps);
    const actions = await route(event, sender, deps);
    logActions(deps.store, event, actions, sender);
    const senderId = sender.person?.person_id ?? sender.unit?.unit_id;
    const forOthers = deps.dispatcher ? actions.filter((a) => a.type !== "say" && a.person_id !== senderId) : [];
    const response = { actions: actions.filter((a) => !forOthers.includes(a)) };
    // Remembered before the push, so a redelivered event never pushes twice.
    deps.store.rememberResponse(key, response);
    if (forOthers.length > 0) {
      // Not awaited: the sender's reply must not wait on another lane.
      deps.dispatcher!.push(forOthers).catch((err) => console.error(`[core] push failed for ${event.event_id}:`, err));
    }
    return response;
  })();
  pending.set(key, work);
  try {
    return structuredClone(await work);
  } finally {
    pending.delete(key);
  }
}

/**
 * Work out who sent the event, record the contact, and log the message.
 *
 * A person getting in touch also stops their check-in chain, whatever they
 * said, since Relay has now heard from them.
 *
 * Also switches the person's language when the message is clearly in
 * another one (see lang/detect.ts). Short or mixed messages never do.
 *
 * Args:
 *     event (RelayEvent): The event.
 *     deps (HandlerDeps): The store and the optional escalation engine.
 *
 * Returns:
 *     Sender: The person or unit, a display name, and whether they just
 *         signed up or came back after STOP.
 */
function resolveSender(event: RelayEvent, deps: HandlerDeps): Sender {
  const { store } = deps;
  const unit = store.findUnitByHandle(event.from);
  const isText = event.channel === "imessage" || event.channel === "sms";
  let byId = event.person_id ? store.getPerson(event.person_id) : undefined;
  // Text makes up ids like "p_<last 4 digits>" for unknown numbers, so two
  // strangers can arrive with the same id. On text the number decides.
  // Voice ids come from Core's own place_call, so they are trusted.
  if (byId && isText && byId.handle && byId.handle !== handleKey(event.from)) byId = undefined;
  let person = unit ? undefined : (byId ?? store.findPersonByHandle(event.from));
  let isNew = false;
  let rejoined = false;

  const isStop = classify(event.text, event.channel, "").intent === "stop";
  if (!unit && !person && isText && !isStop) {
    person = store.restoreByHandle(event.from);
    if (person) rejoined = true;
    else {
      person = store.addPerson(event.from, event.location, event.person_id ?? undefined);
      isNew = true;
    }
  }

  if (unit) store.markUnitHeard(unit.unit_id);
  const sameLocation = Boolean(
    person &&
      !isNew &&
      event.location &&
      !event.text.trim() &&
      person.lat !== null &&
      person.lng !== null &&
      Math.abs(person.lat - event.location.lat) < 0.00001 &&
      Math.abs(person.lng - event.location.lng) < 0.00001,
  );
  if (person) {
    // Switch language only when the message clearly is in another one, so
    // even the first reply to a new Spanish texter is in Spanish.
    const detected = event.channel === "radio" ? null : detectLanguage(event.text);
    if (detected && detected !== resolveLang(person.language)) store.setLanguage(person.person_id, detected);
    store.recordContact(person.person_id, event.location, event.text);
    person = store.getPerson(person.person_id);
  }

  const who = unit?.name ?? person?.name ?? (event.channel === "radio" ? "Radio" : "Unknown caller");
  if (!sameLocation) store.addTimeline({ channel: event.channel, who, text: describeInbound(event) });
  if (isNew) store.addTimeline({ channel: "system", who: "Relay", text: `${who} signed up by text` });
  if (rejoined) store.addTimeline({ channel: "system", who: "Relay", text: `${who} signed up again after STOP` });
  // After the inbound line, so the timeline reads "Amit: ..." then "check-in stopped".
  // A location ping, a hang-up, or a voicemail greeting is not a reply, so
  // the next call in the chain is still dialed.
  if (person && countsAsReply(event)) deps.escalation?.contactReceived(person.person_id);
  else if (person && event.channel === "voice" && isMachineLine(event.text)) deps.escalation?.notAnswered?.(person.person_id);
  return { person, unit, who, isNew, rejoined, sameLocation };
}

/**
 * Run the fast rules, then the agent, and build the actions.
 *
 * Args:
 *     event (RelayEvent): The event.
 *     sender (Sender): Who sent it, already resolved and logged.
 *     deps (HandlerDeps): The store and the optional agent.
 *
 * Returns:
 *     Promise<RelayAction[]>: The actions to send back.
 */
async function route(event: RelayEvent, sender: Sender, deps: HandlerDeps): Promise<RelayAction[]> {
  const { store } = deps;
  const incident = store.scenario.incident.name;
  const { person, unit } = sender;
  const { intent, text } = classify(event.text, event.channel, store.scenario.settings.wake_phrase);
  const medium: Medium = event.channel === "voice" || event.channel === "radio" ? "spoken" : "text";
  // Fixed replies go out in the sender's language. Units get English, and an
  // unknown caller gets the language their message is clearly in, if any.
  const lang = person?.language ?? (unit ? "en" : (detectLanguage(event.text) ?? "en"));
  const target = person
    ? { id: person.person_id, handle: person.handle }
    : unit
      ? { id: unit.unit_id, handle: unit.handle }
      : undefined;

  /**
   * Reply to the sender on the channel they used.
   *
   * Args:
   *     body (string): What to say or text.
   *
   * Returns:
   *     RelayAction: A say action for calls, a send_text otherwise.
   */
  const reply = (body: string): RelayAction =>
    medium === "spoken" || !target
      ? { type: "say", text: body }
      : { type: "send_text", person_id: target.id, to: target.handle, text: body, map_url: null };

  switch (intent) {
    case "radio_chatter":
      return [];

    case "stop": {
      if (!person) return [];
      store.removePerson(person.person_id);
      store.addTimeline({ channel: "system", who: "Relay", text: `${person.name} opted out (STOP)` });
      // No reply: Text owns STOP and already confirmed it. Core only takes
      // them off the map, which also ends their check-in chain.
      return [];
    }

    case "sos": {
      if (!person) {
        // No phone number here: the timeline is shown on the dashboard.
        store.addTimeline({ channel: "system", who: "Relay", text: `SOS from ${sender.who}, needs human review` });
        return [reply(replies.sosUnknown(medium, lang))];
      }
      const result = store.setStatus(person.person_id, "sos");
      const guide = await shelterGuide(deps.data, person, lang);
      const body = [replies.sos(person.name, medium, person.lat !== null, lang), guide].filter(Boolean).join(" ");
      const actions = [reply(body)];
      if (result.changed) {
        store.addTimeline({ channel: "system", who: "Relay", text: `${person.name} marked SOS: "${event.text}"` });
        actions.push(...familyAlert(person, store));
      }
      return actions;
    }

    case "safe":
    case "en_route": {
      if (!person) return [reply(replies.fallback(incident, medium === "spoken" ? "voice" : "text", lang))];
      const result = store.setStatus(person.person_id, intent as PersonStatus);
      if (result.changed) store.addTimeline({ channel: "system", who: "Relay", text: `${person.name} marked ${intent}` });
      if (result.held) store.addTimeline({ channel: "system", who: "Relay", text: `${person.name} says ${intent}, SOS kept until a responder confirms` });
      const spoken =
        intent === "safe"
          ? replies.safe(person.name, result.held, medium, lang)
          : replies.enRoute(person.name, result.held, medium, lang);
      return [reply(await appendExit(spoken, event, person, lang, deps))];
    }

    case "agent": {
      // No welcome here: Text owns sign-up and already welcomed them before
      // forwarding anything, so this is a real question and gets an answer.
      if (person && event.location && !event.text.trim()) {
        if (sender.sameLocation) return [];
        return [reply(replies.locationThanks(person.name, lang))];
      }
      // The wake phrase on its own ("Relay.") has no question yet. Say "go ahead"
      // instead of sending the agent an empty request, which it cannot answer.
      if (event.channel === "radio" && !text.trim()) return [reply(replies.radioReady(lang))];
      const channelKind = event.channel === "radio" ? "radio" : medium === "spoken" ? "voice" : "text";
      if (!deps.agent) return [reply(replies.fallback(incident, channelKind, lang))];
      const controller = new AbortController();
      const sideActions: RelayAction[] = [];
      const statusBefore = person?.status;
      try {
        const run = deps.agent({ event, text, person, unit, who: sender.who, signal: controller.signal, sideActions });
        const actions = await withTimeout(run, agentTimeoutMs(), controller);
        return await withExitOnCall(actions, event, person, lang, deps);
      } catch (err) {
        console.error(`[core] agent failed for ${event.event_id}:`, err);
        // A tool may already have acted, e.g. set_status sos texted the
        // family. Send those, and if the sender is now in SOS, say so.
        const now = person ? store.getPerson(person.person_id) : undefined;
        const body =
          now?.status === "sos" && statusBefore !== "sos"
            ? replies.sos(now.name, medium, now.lat !== null, lang)
            : replies.fallback(incident, channelKind, lang);
        return [reply(await appendExit(body, event, now ?? person, lang, deps)), ...sideActions];
      }
    }
  }
}

/**
 * Reject if a promise takes longer than the limit, and abort its work.
 *
 * Args:
 *     promise (Promise<T>): The work to wait for.
 *     ms (number): Time limit in milliseconds.
 *     controller (AbortController): Aborted when the limit passes, so the
 *         work can cancel its network call.
 *
 * Returns:
 *     Promise<T>: The work's result.
 *
 * Raises:
 *     Error: "agent timed out" if the limit passes first.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`agent timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The walk to the nearest shelter from where this person is.
 *
 * Args:
 *     data (DataTools | undefined): Shelter and route lookup. Absent in tests
 *         that only check the SOS acknowledgement.
 *     person (TrackedPerson): The person who asked for help.
 *     lang (string): Their language.
 *
 * Returns:
 *     Promise<string>: One sentence, or "" when their location or a shelter
 *         is unknown.
 */
async function shelterGuide(data: DataTools | undefined, person: TrackedPerson, lang: string): Promise<string> {
  return (await exitGuide(data, person, lang))?.text ?? "";
}

/**
 * The spoken walk out from where this person is.
 *
 * A failed route lookup still names the nearest shelter and the direction.
 * A failed shelter lookup says nothing.
 *
 * Args:
 *     data (DataTools | undefined): Shelter and route lookup.
 *     person (TrackedPerson): The person on the call.
 *     lang (string): Their language.
 *
 *     from ({ lat: number; lng: number } | null | undefined): Where they
 *         were when Relay last gave a direction. When set, the sentence
 *         says whether the move since then was toward the shelter.
 *
 * Returns:
 *     Promise<{ shelter: string; text: string; judged: boolean } | null>:
 *         The shelter name and the sentence, or null when their location
 *         is unknown. `judged` is true when the sentence says if the move
 *         was right or wrong.
 */
export async function exitGuide(
  data: DataTools | undefined,
  person: TrackedPerson,
  lang: string,
  from?: { lat: number; lng: number } | null,
): Promise<{ shelter: string; text: string; judged: boolean } | null> {
  if (!data || person.lat === null || person.lng === null) return null;
  try {
    const shelters = await data.getShelters(person.lat, person.lng);
    const shelter = shelters[0];
    if (!shelter) return null;
    let minutesAway = Math.max(1, Math.round((shelter.distance_km / 5) * 60));
    let step = "";
    try {
      const route = await data.getRoute(person.lat, person.lng, shelter.lat, shelter.lng, "foot");
      minutesAway = route.duration_min;
      step = (route.steps[0] ?? "").replace(/\.$/, "");
    } catch {
      // The shelter name and direction are still worth saying.
    }
    const toward = compassDirection(person.lat, person.lng, shelter.lat, shelter.lng);
    const moved = from ? judgeMove(from.lat, from.lng, person.lat, person.lng, shelter.lat, shelter.lng) : null;
    const text = moved
      ? replies.moveCheck(moved.judgment, moved.walked, shelter.name, shelter.distance_km, toward, minutesAway, step, lang)
      : replies.shelterWalk(shelter.name, shelter.distance_km, toward, minutesAway, step, lang);
    return { shelter: shelter.name, text, judged: moved !== null };
  } catch {
    return null;
  }
}

/**
 * Add the walk out to a phone reply when Relay knows where the person is.
 *
 * Args:
 *     body (string): What Relay was already going to say.
 *     event (RelayEvent): The call or message.
 *     person (TrackedPerson | undefined): The caller.
 *     lang (string): Their language.
 *     deps (HandlerDeps): Shelter and route lookup.
 *
 * Returns:
 *     Promise<string>: The reply, with the walk added on a phone call.
 */
async function appendExit(
  body: string,
  event: RelayEvent,
  person: TrackedPerson | undefined,
  lang: string,
  deps: HandlerDeps,
): Promise<string> {
  return applyExit(body, event, person, lang, deps);
}

/**
 * A reply that is only a compass order, such as "move north".
 *
 * Args:
 *     body (string): What Relay was going to say.
 *
 * Returns:
 *     boolean: True when the line is a short direction and not already a
 *         judgment of the last move.
 */
function directionOnly(body: string): boolean {
  const words = body.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 8) return false;
  if (/right way|wrong way|have not seen you move/i.test(body)) return false;
  return /\b(north|south|east|west|head|move|go)\b/i.test(body);
}

/**
 * Put the walk, and a right-or-wrong check, on a phone reply.
 *
 * The check uses the point Relay last directed them from. Find My updates
 * the live point in between, so the next thing Relay says can tell them if
 * that move was toward the shelter.
 *
 * Args:
 *     body (string): What Relay was already going to say.
 *     event (RelayEvent): The call or message.
 *     person (TrackedPerson | undefined): The caller.
 *     lang (string): Their language.
 *     deps (HandlerDeps): Shelter and route lookup, and the direction anchor.
 *
 * Returns:
 *     Promise<string>: The reply. On a phone call the judgment leads when
 *         there is one, and a bare "move north" is replaced by it.
 */
async function applyExit(
  body: string,
  event: RelayEvent,
  person: TrackedPerson | undefined,
  lang: string,
  deps: HandlerDeps,
): Promise<string> {
  if (event.channel !== "voice" || !person || person.lat === null || person.lng === null) return body;
  const from = deps.store.directionAnchor(person.person_id);
  const guide = await exitGuide(deps.data, person, lang, from);
  deps.store.rememberDirectionAnchor(person.person_id, person.lat, person.lng);
  if (!guide) return body;
  if (directionOnly(body)) return guide.text;
  if (!guide.judged && body.toLowerCase().includes(guide.shelter.toLowerCase())) return body;
  if (!body.trim()) return guide.text;
  if (guide.judged) return `${guide.text} ${body}`;
  return `${body} ${guide.text}`;
}

/**
 * Add the walk out to whatever the agent said on a phone call.
 *
 * Args:
 *     actions (RelayAction[]): The agent's actions.
 *     event (RelayEvent): The call.
 *     person (TrackedPerson | undefined): The caller.
 *     lang (string): Their language.
 *     deps (HandlerDeps): Shelter and route lookup.
 *
 * Returns:
 *     Promise<RelayAction[]>: The same actions, with the walk on the first
 *         spoken line when it is not already there.
 */
async function withExitOnCall(
  actions: RelayAction[],
  event: RelayEvent,
  person: TrackedPerson | undefined,
  lang: string,
  deps: HandlerDeps,
): Promise<RelayAction[]> {
  if (event.channel !== "voice" || !person) return actions;
  let added = false;
  const next: RelayAction[] = [];
  for (const action of actions) {
    if (added || action.type !== "say") {
      next.push(action);
      continue;
    }
    added = true;
    next.push({ ...action, text: await applyExit(action.text, event, person, lang, deps) });
  }
  if (!added && person.lat !== null && person.lng !== null) {
    const text = await applyExit("", event, person, lang, deps);
    if (text.trim()) next.unshift({ type: "say", text });
  }
  return next;
}

/**
 * Whether this event is the person themselves, rather than a machine.
 *
 * A blank message, a voicemail greeting, or a carrier line about the call
 * ending does not count. A text, or a person speaking on the call, does.
 *
 * Args:
 *     event (RelayEvent): The inbound event.
 *
 * Returns:
 *     boolean: True when the check-in chain should stop.
 */
function isMachineLine(text: string): boolean {
  return /voicemail|voice mail|leave (?:a |your )?message|after the tone|at the (?:tone|beep)|not available|unavailable|can(?:not|'t) take your call|mailbox|record your message|please hang up|you(?:'ve| have) reached|the person you(?:'re| are) (?:trying to reach|calling)|call (?:has ended|ended|disconnected)|subscriber you/i.test(
    text,
  );
}

function countsAsReply(event: RelayEvent): boolean {
  const text = event.text.trim();
  if (!text) return false;
  if (event.channel !== "voice") return true;
  return !isMachineLine(text);
}

/**
 * Describe an inbound event for the timeline, even when the text is empty.
 *
 * Args:
 *     event (RelayEvent): The event.
 *
 * Returns:
 *     string: The text, or a short note like "[shared location]".
 */
function describeInbound(event: RelayEvent): string {
  if (event.text.trim()) return event.text;
  if (event.media_url) return "[sent a photo]";
  if (event.location) return "[shared location]";
  return "[empty message]";
}

/**
 * Log what Relay sent back, so every exchange is on the timeline.
 *
 * Args:
 *     store (IncidentStore): The live state.
 *     event (RelayEvent): The event being answered.
 *     actions (RelayAction[]): What Core returned.
 *     sender (Sender): Who sent the event. Used for the name when they are
 *         no longer in the store, e.g. right after STOP.
 */
function logActions(store: IncidentStore, event: RelayEvent, actions: RelayAction[], sender: Sender): void {
  const senderId = sender.person?.person_id ?? sender.unit?.unit_id;
  for (const a of actions) {
    if (a.type === "say") {
      store.addTimeline({ channel: event.channel, who: "Relay", text: a.text });
    } else {
      const name = store.getPerson(a.person_id)?.name ?? (a.person_id === senderId ? sender.who : a.person_id);
      const channel = a.type === "place_call" ? "voice" : "imessage";
      const body = a.type === "place_call" ? `Calling ${name}: ${a.script}` : `To ${name}: ${a.text}`;
      store.addTimeline({ channel, who: "Relay", text: body });
    }
  }
}
