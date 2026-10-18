/**
 * Turns one incoming text into the replies to send back.
 *
 * Keywords such as STOP are answered here. Anything else is sent to Core as a
 * Contract A event, and Core's send_text actions become the replies. This
 * module has no Photon code in it, so it can be tested on its own.
 */
import { randomUUID } from "node:crypto";

import { isDistress } from "./commands.js";
import type { CoreResponse, RelayEvent } from "./contracts.js";
import { ACKNOWLEDGED, SOS_RECEIVED, handleText } from "./handler.js";
import type { PeopleDirectory } from "./people.js";
import type { Registry } from "./registry.js";

/** What {@link processText} needs to run. */
export interface RelayDeps {
  registry: Registry;
  directory: PeopleDirectory;
  /** Posts an event to Core. Never throws. */
  postEvent: (event: RelayEvent) => Promise<CoreResponse>;
  /** Logger for actions this lane cannot carry out. Defaults to console.warn. */
  log?: (msg: string) => void;
  /** Clock, injectable for tests. Defaults to the current time. */
  now?: () => Date;
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
 *     text: The message text.
 *     send: Sends one text back to the sender.
 */
export async function processText(
  deps: RelayDeps,
  phone: string,
  text: string,
  send: (reply: string) => Promise<void>,
): Promise<void> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const reply = handleText(deps.registry, phone, text);
  if (reply !== null) {
    await send(reply);
    return;
  }

  const who = deps.directory.resolve(phone);
  const event: RelayEvent = {
    event_id: `evt_${randomUUID()}`,
    channel: "imessage",
    person_id: who.person_id,
    from: phone,
    text,
    location: who.location,
    media_url: null,
    timestamp: (deps.now?.() ?? new Date()).toISOString(),
  };

  // Start the Core call first, then acknowledge while it is in flight.
  const pending = deps.postEvent(event);
  if (isDistress(text)) await send(SOS_RECEIVED);
  const { actions } = await pending;

  let sent = 0;
  for (const action of actions) {
    if (action.type !== "send_text") {
      log(`ignoring ${action.type} action, not a text action`);
    } else if (action.person_id !== who.person_id) {
      log(`send_text for ${action.person_id} not sent yet, sender is ${who.person_id}`);
    } else {
      await send(action.text);
      sent += 1;
    }
  }

  // Nobody is left without a reply, even if Core is down or has nothing to say.
  if (sent === 0 && !isDistress(text)) await send(ACKNOWLEDGED);
}
