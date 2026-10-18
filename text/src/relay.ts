/**
 * Turns one incoming text into the replies to send back.
 *
 * Keywords such as STOP are answered here. Anything else is sent to Core as a
 * Contract A event, and Core's send_text actions become the replies. This
 * module has no Photon code in it, so it can be tested on its own.
 */
import { randomUUID } from "node:crypto";

import { isDistress, parseCommand } from "./commands.js";
import type { CoreResponse, Location, RelayEvent } from "./contracts.js";
import { ACKNOWLEDGED, SOS_RECEIVED, handleText } from "./handler.js";
import { parseCoordinates } from "./location.js";
import { normalizePhone, type PeopleDirectory } from "./people.js";
import type { Registry } from "./registry.js";

/** How long Core gets to answer an SOS before we send our own acknowledgement. */
export const SOS_ACK_DELAY_MS = 2000;

/** What {@link processText} needs to run. */
export interface RelayDeps {
  registry: Registry;
  directory: PeopleDirectory;
  /** Wait for Core's SOS reply this long before acknowledging ourselves. Defaults to 2000. */
  sosAckDelayMs?: number;
  /** Posts an event to Core. Never throws. */
  postEvent: (event: RelayEvent) => Promise<CoreResponse>;
  /** Logger for actions this lane cannot carry out. Defaults to console.warn. */
  log?: (msg: string) => void;
  /** Clock, injectable for tests. Defaults to the current time. */
  now?: () => Date;
}

/**
 * Build the Contract A event for one incoming text.
 *
 * Args:
 *     deps: The phone lookup and clock.
 *     phone: The sender's phone number in E.164 format.
 *     text: The message text.
 *     location: Where the sender said they are, if they did.
 *
 * Returns:
 *     RelayEvent: The event. The location is the one the sender shared, else
 *         their scenario location, else null.
 */
function buildEvent(deps: RelayDeps, phone: string, text: string, location: Location | null = null): RelayEvent {
  const who = deps.directory.resolve(phone);
  return {
    event_id: `evt_${randomUUID()}`,
    channel: "imessage",
    person_id: who.person_id,
    from: phone,
    text,
    location: location ?? who.location,
    media_url: null,
    timestamp: (deps.now?.() ?? new Date()).toISOString(),
  };
}

/**
 * Handle one incoming text and send every reply through `send`.
 *
 * Replies are sent as soon as each is ready. For a call for help, the
 * acknowledgement goes out while the event is already on its way to Core, so a
 * slow Core never delays the first reply.
 *
 * Args:
 *     deps: The registry, phone lookup and Core client.
 *     phone: The sender's phone number in E.164 format.
 *     text: The message text. May be empty for a shared location.
 *     send: Sends one text back to the sender.
 *     shared: A location the sender shared, if the message carried one. A
 *         location found inside the text itself is used too.
 */
export async function processText(
  deps: RelayDeps,
  phone: string,
  text: string,
  send: (reply: string) => Promise<void>,
  shared?: { location?: Location | null },
): Promise<void> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  // Where they say they are: a shared pin, or coordinates and Maps links typed in the text.
  const location = shared?.location ?? parseCoordinates(text);
  const reply = handleText(deps.registry, phone, text);
  let replied = false;
  if (reply !== null) {
    await send(reply);
    // Core must hear about STOP too: it takes the person off the map and ends
    // their check-in calls. It sends no reply, so its answer is ignored.
    if (parseCommand(text) === "stop") await deps.postEvent(buildEvent(deps, phone, text));
    // A location shared with a first message still tells Core where they are,
    // so a new person lands on the map. Anyone signed out stays out.
    if (!location || deps.registry.status(phone) !== "opted_in") return;
    replied = true;
  }

  const who = deps.directory.resolve(phone);
  const event = buildEvent(deps, phone, text, location);

  // Start the Core call first. Core answers a call for help with its own SOS
  // reply, so ours is only a stopgap: it goes out only if Core is still silent
  // after a couple of seconds, so a person is never left waiting.
  const pending = deps.postEvent(event);
  const distress = isDistress(text);
  let acknowledged = false;
  if (distress) {
    const early = await firstOf(pending, deps.sosAckDelayMs ?? SOS_ACK_DELAY_MS);
    if (early === null) {
      await send(SOS_RECEIVED);
      acknowledged = true;
    }
  }
  const { actions } = await pending;

  let sent = 0;
  for (const action of actions) {
    if (action.type !== "send_text") {
      log(`ignoring ${action.type} action, not a text action`);
    } else if (action.person_id !== who.person_id && normalizePhone(action.to ?? "") !== normalizePhone(phone)) {
      log(`send_text for ${action.person_id} not sent yet, sender is ${who.person_id}`);
    } else {
      await send(action.text);
      sent += 1;
    }
  }

  // Nobody is left without a reply, even if Core is down or has nothing to say.
  if (sent === 0 && !acknowledged && !replied) await send(distress ? SOS_RECEIVED : ACKNOWLEDGED);
}

/**
 * Wait for a promise, but only up to a time limit.
 *
 * Args:
 *     promise: The work to wait for.
 *     ms: How long to wait, in milliseconds.
 *
 * Returns:
 *     The promise's result if it finishes in time, otherwise null. The promise
 *     itself keeps running either way.
 */
async function firstOf<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
