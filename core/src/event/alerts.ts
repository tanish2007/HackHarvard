/**
 * Outbound alerts that more than one part of Core sends.
 */
import type { RelayAction } from "../contracts.js";
import type { IncidentStore, TrackedPerson } from "../state/store.js";
import { replies } from "./replies.js";

/**
 * Text the family contact about an SOS, if they have a phone.
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
      text: replies.familySos(person.name, store.scenario.incident.name),
      map_url: null,
    },
  ];
}
