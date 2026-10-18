/**
 * Carries out Contract B actions for the voice lane.
 *
 * Core never speaks or dials itself. It returns actions and the channel
 * owner performs them. This file performs the ones that are heard out loud.
 */
import type { RelayAction } from "./contracts.js";
import type { CallPlacer, CallSession } from "./ports.js";

/** Dependencies for {@link executeActions}. */
export interface ExecutorDeps {
  /** The open call, if there is one. `say` needs it. */
  session?: CallSession;
  /** Outbound call placer for `place_call`. */
  placer: CallPlacer;
  /** Logger for skipped or failed actions. Defaults to console.warn. */
  log?: (msg: string) => void;
}

/**
 * Perform each action in order without ever throwing.
 *
 * Unsupported action types (such as send_text) are logged and skipped, and
 * a failure in one action does not stop the rest.
 *
 * Args:
 *   actions: The actions Core returned.
 *   deps: The open call, the call placer and a logger.
 */
export async function executeActions(
  actions: RelayAction[],
  deps: ExecutorDeps,
): Promise<void> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  for (const action of actions) {
    try {
      if (action.type === "say") {
        if (!deps.session) {
          log("say action skipped: no open call");
          continue;
        }
        await deps.session.speak(action.text);
      } else if (action.type === "place_call") {
        await deps.placer.placeCall(action.person_id, action.script, action.reason, action.to);
      } else {
        log(`unsupported action type for voice: ${(action as { type: string }).type}`);
      }
    } catch (err) {
      log(`action ${action.type} failed: ${String(err)}`);
    }
  }
}
