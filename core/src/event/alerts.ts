/**
 * Outbound alerts that more than one part of Core sends.
 */
import type { RelayAction } from "../contracts.js";
import type { IncidentStore, TrackedPerson } from "../state/store.js";
import { replies } from "./replies.js";

/**
 * Log actions Core sent on its own (not as a reply), so they show on the
 * timeline like every other exchange.
 *
 * The emergency contact is named by its scenario label, never its number.
 *
 * Args:
 *     store (IncidentStore): The live state.
 *     actions (RelayAction[]): What was pushed.
 */
export function logPushed(store: IncidentStore, actions: RelayAction[]): void {
  for (const a of actions) {
    if (a.type === "say") continue;
    const name =
      store.getPerson(a.person_id)?.name ??
      (a.person_id === "emergency_contact" ? store.scenario.emergency_contact.label : a.person_id);
    if (a.type === "send_text") store.addTimeline({ channel: "imessage", who: "Relay", text: `To ${name}: ${a.text}` });
    else store.addTimeline({ channel: "voice", who: "Relay", text: `Calling ${name} (${a.reason}): ${a.script}` });
  }
}

/**
 * Text the family contact about an SOS, if they have a phone.
 *
 * The text is in the family contact's own language, not the sender's.
 *
 * Used by the SOS keyword rule and by the agent's set_status tool, so the
 * family hears about an SOS however it was raised.
 *
 * Args:
 *     person (TrackedPerson): The person who is in SOS.
 *     store (IncidentStore): The live state.
 *
 * Returns:
 *     RelayAction[]: One send_text, or nothing if there is no reachable contact.
 */
export function familyAlert(person: TrackedPerson, store: IncidentStore): RelayAction[] {
  const family = person.family_contact ? store.getPerson(person.family_contact) : undefined;
  if (!family?.handle) return [];
  return [
    {
      type: "send_text",
      person_id: family.person_id,
      to: family.handle,
      text: replies.familySos(person.name, store.scenario.incident.name, family.language),
      map_url: null,
    },
  ];
}
