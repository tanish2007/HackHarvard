/**
 * Pushing actions to the channels when Core acts on its own.
 *
 * Most actions go back as the reply to POST /event. But a fire alert or a
 * missed check-in has no incoming event to reply to, so Core POSTs a
 * Contract B body to the channel's own /actions endpoint instead:
 *     send_text  -> Text  (TEXT_ACTIONS_URL)
 *     place_call -> Voice (VOICE_ACTIONS_URL)
 *     say        -> Voice
 * Pushing never throws. A channel that is down is logged and skipped, so a
 * timer or alert never crashes the server.
 */
import type { RelayAction } from "../contracts.js";

/** How long to wait for a channel before giving up on one push. */
export const PUSH_TIMEOUT_MS = 4000;

/**
 * What happened to one lane's batch.
 *
 * Attributes:
 *     lane ("text" | "voice"): Which channel.
 *     count (number): How many actions were in the batch.
 *     ok (boolean): True if the channel answered 2xx.
 *     error (string | undefined): Why it failed, if it did.
 */
export interface PushResult {
  lane: "text" | "voice";
  count: number;
  ok: boolean;
  error?: string;
}

/** Sends actions Core started on its own. */
export interface Dispatcher {
  /**
   * Push actions to the channels that carry them out.
   *
   * Args:
   *     actions (RelayAction[]): The actions, any mix of types.
   *
   * Returns:
   *     Promise<PushResult[]>: One result per lane that had actions. Never rejects.
   */
  push(actions: RelayAction[]): Promise<PushResult[]>;
}

/**
 * Settings for the HTTP dispatcher.
 *
 * Attributes:
 *     textUrl (string | undefined): Text's /actions URL. Unset drops texts
 *         with a warning, so Core still runs without the text lane.
 *     voiceUrl (string | undefined): Voice's /actions URL.
 *     timeoutMs (number | undefined): Per-request timeout. Defaults to 4000.
 *     fetchImpl (typeof fetch | undefined): Injectable for tests.
 *     log ((msg: string) => void | undefined): Defaults to console.warn.
 */
export interface HttpDispatcherOptions {
  textUrl?: string;
  voiceUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

/**
 * Which lane carries an action.
 *
 * Args:
 *     action (RelayAction): The action.
 *
 * Returns:
 *     "text" | "voice": The lane.
 */
export function laneFor(action: RelayAction): "text" | "voice" {
  return action.type === "send_text" ? "text" : "voice";
}

/**
 * Create a dispatcher that POSTs { actions } to each lane's /actions URL.
 *
 * Args:
 *     options (HttpDispatcherOptions): URLs, timeout, and test hooks.
 *
 * Returns:
 *     Dispatcher: Pushes per lane, in parallel.
 */
export function createHttpDispatcher(options: HttpDispatcherOptions): Dispatcher {
  const log = options.log ?? ((m: string) => console.warn(m));
  const doFetch = options.fetchImpl ?? fetch;
  const urls = { text: options.textUrl, voice: options.voiceUrl };

  return {
    async push(actions) {
      const byLane = new Map<"text" | "voice", RelayAction[]>();
      for (const a of actions) byLane.set(laneFor(a), [...(byLane.get(laneFor(a)) ?? []), a]);

      return Promise.all(
        [...byLane].map(async ([lane, batch]): Promise<PushResult> => {
          const url = urls[lane];
          if (!url) {
            log(`[dispatch] no ${lane.toUpperCase()}_ACTIONS_URL set, dropped ${batch.length} action(s)`);
            return { lane, count: batch.length, ok: false, error: "no url" };
          }
          try {
            const res = await doFetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ actions: batch }),
              signal: AbortSignal.timeout(options.timeoutMs ?? PUSH_TIMEOUT_MS),
            });
            if (!res.ok) {
              log(`[dispatch] ${lane} answered ${res.status} for ${batch.length} action(s)`);
              return { lane, count: batch.length, ok: false, error: `status ${res.status}` };
            }
            return { lane, count: batch.length, ok: true };
          } catch (err) {
            log(`[dispatch] ${lane} push failed: ${String(err)}`);
            return { lane, count: batch.length, ok: false, error: String(err) };
          }
        }),
      );
    },
  };
}
