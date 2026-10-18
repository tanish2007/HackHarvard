/**
 * HTTP client that posts Contract A events to Core and parses Contract B.
 *
 * The voice lane must never crash an open call because Core is slow or
 * returns garbage, so every failure here resolves to an empty action list.
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
 *
 * Returns:
 *   The actions that have a known type. Unknown shapes are dropped.
 */
export function parseActions(body: unknown): RelayAction[] {
  if (typeof body !== "object" || body === null) return [];
  const actions = (body as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return [];
  return actions.filter(
    (a): a is RelayAction =>
      typeof a === "object" &&
      a !== null &&
      KNOWN_TYPES.has((a as { type?: string }).type ?? ""),
  );
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
export async function postEvent(
  event: RelayEvent,
  opts: PostEventOptions,
): Promise<CoreResponse> {
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
    return { actions: parseActions(await res.json()) };
  } catch (err) {
    log(`core call failed for ${event.event_id}: ${String(err)}`);
    return { actions: [] };
  }
}
