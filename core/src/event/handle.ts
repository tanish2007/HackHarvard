/**
 * Turns one Contract A event into Contract B actions.
 *
 * Steps: replay duplicates, work out who sent it, log it, run the fast rules,
 * and only then hand anything left over to the agent. Core never sends
 * anything itself. It only returns actions for the channels to carry out.
 */
import type { CoreResponse, RelayAction, RelayEvent } from "../contracts.js";
import type { Dispatcher } from "../dispatch/outbound.js";
import { detectLanguage } from "../lang/detect.js";
import { resolveLang } from "../lang/languages.js";
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
 *     escalation ({ contactReceived(personId: string): void } | undefined):
 *         Told whenever a person gets in touch, so their check-in chain
 *         stops. Without it, no chains run.
 *     dispatcher (Pick<Dispatcher, "push"> | undefined): Pushes actions
 *         for anyone other than the sender, e.g. the family text after an
 *         SOS, straight to the lane that carries them out. A channel only
 *         answers the person it is talking to, so those actions would be
 *         lost in the reply. Without it, they stay in the reply.
 */
export interface HandlerDeps {
  store: IncidentStore;
  agent?: Agent;
  escalation?: { contactReceived(personId: string): void };
  dispatcher?: Pick<Dispatcher, "push">;
}

/** Who sent an event, after looking them up. */
interface Sender {
  person: TrackedPerson | undefined;
  unit: TrackedUnit | undefined;
  who: string;
  isNew: boolean;
  rejoined: boolean;
}

/**
 * Longest Core waits for the agent before falling back. Voice gives up on
 * /event after 4s, so this leaves time for the rest of the request.
 */
export const AGENT_TIMEOUT_MS = 3200;

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
  if (person) {
    // Switch language only when the message clearly is in another one, so
    // even the first reply to a new Spanish texter is in Spanish.
    const detected = event.channel === "radio" ? null : detectLanguage(event.text);
    if (detected && detected !== resolveLang(person.language)) store.setLanguage(person.person_id, detected);
    store.recordContact(person.person_id, event.location, event.text);
    person = store.getPerson(person.person_id);
  }

  const who = unit?.name ?? person?.name ?? (event.channel === "radio" ? "Radio" : "Unknown caller");
  store.addTimeline({ channel: event.channel, who, text: describeInbound(event) });
  if (isNew) store.addTimeline({ channel: "system", who: "Relay", text: `${who} signed up by text` });
  if (rejoined) store.addTimeline({ channel: "system", who: "Relay", text: `${who} signed up again after STOP` });
  // After the inbound line, so the timeline reads "Amit: ..." then "check-in stopped".
  if (person) deps.escalation?.contactReceived(person.person_id);
  return { person, unit, who, isNew, rejoined };
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
      return [{ type: "send_text", person_id: person.person_id, to: person.handle, text: replies.stopped(incident, person.language), map_url: null }];
    }

    case "sos": {
      if (!person) {
        // No phone number here: the timeline is shown on the dashboard.
        store.addTimeline({ channel: "system", who: "Relay", text: `SOS from ${sender.who}, needs human review` });
        return [reply(replies.sosUnknown(medium, lang))];
      }
      const result = store.setStatus(person.person_id, "sos");
      const actions = [reply(replies.sos(person.name, medium, person.lat !== null, lang))];
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
      const body =
        intent === "safe"
          ? replies.safe(person.name, result.held, medium, lang)
          : replies.enRoute(person.name, result.held, medium, lang);
      return [reply(body)];
    }

    case "agent": {
      // No welcome here: Text owns sign-up and already welcomed them before
      // forwarding anything, so this is a real question and gets an answer.
      if (person && event.location && !event.text.trim()) return [reply(replies.locationThanks(person.name, lang))];
      const channelKind = event.channel === "radio" ? "radio" : medium === "spoken" ? "voice" : "text";
      if (!deps.agent) return [reply(replies.fallback(incident, channelKind, lang))];
      const controller = new AbortController();
      const sideActions: RelayAction[] = [];
      const statusBefore = person?.status;
      try {
        const run = deps.agent({ event, text, person, unit, who: sender.who, signal: controller.signal, sideActions });
        return await withTimeout(run, AGENT_TIMEOUT_MS, controller);
      } catch (err) {
        console.error(`[core] agent failed for ${event.event_id}:`, err);
        // A tool may already have acted, e.g. set_status sos texted the
        // family. Send those, and if the sender is now in SOS, say so.
        const now = person ? store.getPerson(person.person_id) : undefined;
        const body =
          now?.status === "sos" && statusBefore !== "sos"
            ? replies.sos(now.name, medium, now.lat !== null, lang)
            : replies.fallback(incident, channelKind, lang);
        return [reply(body), ...sideActions];
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
