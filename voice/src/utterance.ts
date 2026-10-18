/**
 * Turns one thing a caller said into a Contract A event and acts on the reply.
 *
 * The radio is one long open call, so every utterance is forwarded as a
 * `radio` event. Core logs all of them and only answers when it hears
 * "Relay". If Core returns no actions, Relay stays silent.
 */
import { randomUUID } from "node:crypto";
import type { Channel, Location, RelayEvent } from "./contracts.js";
import { postEvent } from "./coreClient.js";
import { executeActions } from "./executor.js";
import type { CallPlacer, CallSession } from "./ports.js";

/** Dependencies for {@link handleUtterance}. */
export interface UtteranceDeps {
  /** Base URL of Core. */
  coreUrl: string;
  /** Outbound call placer, used if Core asks for a place_call. */
  placer: CallPlacer;
  /**
   * Map a phone number to a Contract E person id.
   *
   * Returns null when the number is unknown.
   */
  resolvePerson: (from: string) => string | null;
  /** Clock, injectable for tests. Defaults to the current time. */
  now?: () => Date;
  /** Fetch implementation, injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Logger. Defaults to console.warn. */
  log?: (msg: string) => void;
}

/** One transcribed utterance from a call. */
export interface Utterance {
  /** `voice` for a normal call, `radio` for the radio patch. */
  channel: Extract<Channel, "voice" | "radio">;
  /** Caller phone number in E.164 form. */
  from: string;
  /** Transcribed text. */
  text: string;
  /** The open call to answer on. */
  session: CallSession;
  /** Caller location if known. */
  location?: Location | null;
}

/**
 * Forward an utterance to Core and carry out whatever it asks for.
 *
 * Empty or whitespace-only text is ignored. Callers whose number cannot be
 * resolved to a person are logged and ignored, because Contract A requires a
 * resolved person_id.
 *
 * Args:
 *   u: The utterance and the call it came from.
 *   deps: Core URL, call placer and person lookup.
 *
 * Returns:
 *   The event that was sent, or null if the utterance was ignored.
 */
export async function handleUtterance(
  u: Utterance,
  deps: UtteranceDeps,
): Promise<RelayEvent | null> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const text = u.text.trim();
  if (!text) return null;

  const personId = deps.resolvePerson(u.from);
  if (!personId) {
    log(`utterance from unknown number ${u.from} ignored`);
    return null;
  }

  const event: RelayEvent = {
    event_id: `evt_${randomUUID()}`,
    channel: u.channel,
    person_id: personId,
    from: u.from,
    text,
    location: u.location ?? null,
    media_url: null,
    timestamp: (deps.now?.() ?? new Date()).toISOString(),
  };

  const { actions } = await postEvent(event, {
    coreUrl: deps.coreUrl,
    fetchImpl: deps.fetchImpl,
    log,
  });
  await executeActions(actions, { session: u.session, placer: deps.placer, log });
  return event;
}
