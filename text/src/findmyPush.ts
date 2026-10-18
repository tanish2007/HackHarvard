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
  const key = `${location.lat.toFixed(4)},${location.lng.toFixed(4)}`;
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
 * Look up every scenario phone on the live feed and send the points Core
 * does not have yet.
 *
 * Args:
 *     deps: The tracker, the directory, and the Core poster.
 */
export async function sweepFindMy(deps: RelayDeps): Promise<void> {
  if (!deps.findMy || !deps.findMyOverridesScenario) return;
  for (const phone of deps.directory.phones()) {
    const location = await deps.findMy.latest(phone, 5000);
    if (location) await publishFindMyLocation(deps, phone, location);
  }
}
