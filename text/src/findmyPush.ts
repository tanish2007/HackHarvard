/**
 * Sends a Find My location to Core without waiting for a text.
 *
 * The feed remembers points on its own. Core only hears about one when an
 * event is posted. This posts that event for people already in the scenario,
 * and only again when the point changes, so the map follows a live share.
 */
import { randomUUID } from "node:crypto";

import type { Location } from "./contracts.js";
import type { RelayDeps } from "./relay.js";

const sent = new Map<string, string>();

/**
 * Post one remembered location to Core when it is new.
 *
 * The reply Core would send is dropped. This is not a conversation, so the
 * person is not texted "thanks" for a background update.
 *
 * Args:
 *     deps: The phone lookup, the override switch, and the Core poster.
 *     phone: The person's phone number.
 *     location: The Find My point.
 *
 * Returns:
 *     boolean: True when an event was posted.
 */
export async function publishFindMyLocation(deps: RelayDeps, phone: string, location: Location): Promise<boolean> {
  if (!deps.findMyOverridesScenario) return false;
  const who = deps.directory.resolve(phone);
  if (!who.known) return false;
  // About one meter. A coarser key was hiding a person walking down the block.
  const key = `${location.lat.toFixed(5)},${location.lng.toFixed(5)}`;
  if (sent.get(who.person_id) === key) return false;
  sent.set(who.person_id, key);
  await deps.postEvent({
    event_id: `evt_${randomUUID()}`,
    channel: "imessage",
    person_id: who.person_id,
    from: phone,
    text: "",
    location,
    media_url: null,
    timestamp: new Date().toISOString(),
  });
  console.log(`[findmy] sent ${who.person_id} to core at ${key}`);
  return true;
}

/**
 * Ask the live feed again for every scenario phone and send Core any point
 * it does not have yet. A fresh ask is used so a recent memory does not
 * hide a move.
 *
 * Args:
 *     deps: The tracker, the directory, and the Core poster.
 */
export async function sweepFindMy(deps: RelayDeps): Promise<void> {
  if (!deps.findMy || !deps.findMyOverridesScenario) return;
  for (const phone of deps.directory.phones()) {
    const location = await (deps.findMy.ask ?? deps.findMy.latest).call(deps.findMy, phone, 5000);
    // Forget the last send so a restarted Core, which lost the live point,
    // hears this fix again. publishFindMyLocation still skips a point it
    // just posted from the live feed.
    if (location) {
      const who = deps.directory.resolve(phone);
      if (who.known) sent.delete(who.person_id);
      await publishFindMyLocation(deps, phone, location);
    }
  }
}
