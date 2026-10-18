/**
 * Turns one incoming text into the replies to send back.
 *
 * Keywords such as STOP are answered here. Anything else is sent to Core as a
 * Contract A event, and Core's send_text actions become the replies. This
 * module has no Photon code in it, so it can be tested on its own.
 */
import { randomUUID } from "node:crypto";

import type { CoreResponse, RelayEvent } from "./contracts.js";
import { ACKNOWLEDGED, handleText } from "./handler.js";
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
 * Work out every reply for one incoming text.
 *
 * Args:
 *     deps: The registry, phone lookup and Core client.
 *     phone: The sender's phone number in E.164 format.
 *     text: The message text.
 *
 * Returns:
 *     string[]: Texts to send back to the sender, in order. Never empty, so the
 *         sender is not left without a reply if Core is down.
 */
export async function processText(deps: RelayDeps, phone: string, text: string): Promise<string[]> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const reply = handleText(deps.registry, phone, text);
  if (reply !== null) return [reply];

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

  const { actions } = await deps.postEvent(event);
  const replies: string[] = [];
  for (const action of actions) {
    if (action.type !== "send_text") {
      log(`ignoring ${action.type} action, not a text action`);
    } else if (action.person_id !== who.person_id) {
      log(`send_text for ${action.person_id} not sent yet, sender is ${who.person_id}`);
    } else {
      replies.push(action.text);
    }
  }
  return replies.length > 0 ? replies : [ACKNOWLEDGED];
}
