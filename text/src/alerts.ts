/**
 * Sends Contract B actions that Core pushes to us, such as a fire alert.
 *
 * Unlike a reply, these go to people who may never have texted first. The
 * actual iMessage call is injected as `sendTo`, so this module has no Photon
 * code in it and can be tested on its own.
 */
import type { RelayAction } from "./contracts.js";
import { normalizePhone, type PeopleDirectory } from "./people.js";
import type { Registry } from "./registry.js";

/** What {@link deliverActions} needs to run. */
export interface AlertDeps {
  registry: Registry;
  directory: PeopleDirectory;
  /** Texts one phone number, whether or not they have messaged us first. */
  sendTo: (phone: string, text: string) => Promise<void>;
  /** Logger for skipped actions. Defaults to console.warn. */
  log?: (msg: string) => void;
}

/** Someone an action could not be delivered to, and why. */
export interface Skipped {
  person_id: string;
  reason: string;
}

/** What happened to a batch of actions. */
export interface DeliveryReport {
  /** person_ids that were texted. */
  delivered: string[];
  skipped: Skipped[];
}

/**
 * Text everyone named in a batch of actions.
 *
 * Only send_text actions are carried out. Someone is skipped, never texted, if
 * the scenario has no number for them, or if they have not opted in or have
 * sent STOP. A failed send is reported and does not stop the rest.
 *
 * Args:
 *     deps: The registry, phone lookup and sender.
 *     actions: Contract B actions from Core.
 *
 * Returns:
 *     DeliveryReport: Who was texted and who was skipped, with reasons.
 */
export async function deliverActions(deps: AlertDeps, actions: RelayAction[]): Promise<DeliveryReport> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const report: DeliveryReport = { delivered: [], skipped: [] };

  await Promise.all(
    actions.map(async (action) => {
      if (action.type !== "send_text") {
        log(`ignoring ${action.type} action, not a text action`);
        return;
      }
      const skip = (reason: string) => {
        log(`not texting ${action.person_id}: ${reason}`);
        report.skipped.push({ person_id: action.person_id, reason });
      };

      // The scenario first. Core's `to` covers people who signed up by text and
      // are not in scenario.json.
      const phone = deps.directory.phoneFor(action.person_id) ?? (action.to ? normalizePhone(action.to) : null);
      if (!phone) return skip("no phone number in the scenario or on the action");
      if (deps.registry.status(phone) !== "opted_in") return skip("not opted in");

      const text = action.map_url ? `${action.text}\n${action.map_url}` : action.text;
      try {
        await deps.sendTo(phone, text);
        report.delivered.push(action.person_id);
      } catch (err) {
        skip(`send failed: ${String(err)}`);
      }
    }),
  );
  return report;
}
