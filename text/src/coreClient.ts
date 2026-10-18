/**
 * HTTP client that posts Contract A events to Core and parses Contract B.
 *
 * The text lane must never crash because Core is slow or returns garbage, so
 * every failure here resolves to an empty action list.
 */
import type { CoreResponse, RelayAction, RelayEvent } from "./contracts.js";

/** Options for {@link postEvent}. */
export interface PostEventOptions {
  /** Base URL of Core, for example http://localhost:3000. */
  coreUrl: string;
  /** Request timeout in milliseconds. Defaults to 4000. */
  timeoutMs?: number;
  /** Fetch implementation, injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Logger for failures. Defaults to console.warn. */
  log?: (msg: string) => void;
}

const KNOWN_TYPES = new Set(["send_text", "place_call", "say"]);

/**
 * Keep only well-formed actions from an untrusted Core response body.
 *
 * Args:
 *   body: The parsed JSON body.
 *   log: Called once for each action that is dropped.
 *
 * Returns:
 *   The actions that have a known type. Unknown shapes are dropped and logged,
 *   never thrown on.
 */
export function parseActions(body: unknown, log: (msg: string) => void = () => {}): RelayAction[] {
  if (typeof body !== "object" || body === null) return [];
  const actions = (body as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return [];

  const kept: RelayAction[] = [];
  for (const action of actions) {
    const type = typeof action === "object" && action !== null ? (action as { type?: unknown }).type : undefined;
    if (typeof type === "string" && KNOWN_TYPES.has(type)) kept.push(action as RelayAction);
    else log(`dropping unsupported action: ${JSON.stringify(type)}`);
  }
  return kept;
}

/**
 * Post an event to Core and return the actions it asks for.
 *
 * Args:
 *   event: The Contract A event to send.
 *   opts: Core URL, timeout and test hooks.
 *
 * Returns:
 *   Core's actions, or an empty list if Core is unreachable, times out,
 *   answers with a non-200 status, or returns an unusable body.
 */
export async function postEvent(event: RelayEvent, opts: PostEventOptions): Promise<CoreResponse> {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${opts.coreUrl}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
    });
    if (res.status !== 200) {
      log(`core returned ${res.status} for ${event.event_id}`);
      return { actions: [] };
    }
    return { actions: parseActions(await res.json(), log) };
  } catch (err) {
    log(`core call failed for ${event.event_id}: ${String(err)}`);
    return { actions: [] };
  }
}
