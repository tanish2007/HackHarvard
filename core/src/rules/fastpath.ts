/**
 * Keyword rules that run before the LLM.
 *
 * STOP, SOS, "safe", and "leaving" must work instantly and even when the LLM
 * is down or rate limited, so they are plain string rules. Radio chatter
 * without the wake phrase is logged but never answered.
 */
import type { Channel } from "../contracts.js";

/**
 * What a message means, as far as the fast rules can tell.
 *
 * `agent` means no rule matched and the message goes to the LLM agent.
 * `radio_chatter` means radio traffic not addressed to Relay.
 */
export type Intent = "stop" | "sos" | "safe" | "en_route" | "radio_chatter" | "agent";

/**
 * Result of classifying one message.
 *
 * Attributes:
 *     intent (Intent): What the message means.
 *     text (string): The text to pass on. For radio this has the wake phrase
 *         removed, so the agent sees only the question.
 */
export interface Classification {
  intent: Intent;
  text: string;
}

const STOP_WORDS = new Set(["stop", "stop alerts", "unsubscribe", "cancel", "quit", "end"]);

const NOT_SOS = [/\b(don'?t|do not|no longer) need help\b/, /\bno help needed\b/, /\bi can help\b/];
const SOS = [
  /\bsos\b/,
  /^help$/,
  /\bhelp me\b/,
  /\bneed help\b/,
  /\bneed (an )?(ambulance|rescue)\b/,
  /\btrapped\b/,
  /\binjured\b/,
  /\bhurt\b/,
  /\bcan'?t (get out|leave|breathe|move)\b/,
  /\bemergency\b/,
  /\bnot safe\b/,
  /\bunsafe\b/,
  /\bayuda\b/,
  /\bsocorro\b/,
];
const SAFE = [
  /\bsafe\b/,
  /\bi'?m (ok|okay|fine|good)\b/,
  /\bi am (ok|okay|fine|good)\b/,
  /\bwe'?re (ok|okay|fine|good|safe)\b/,
  /^(ok|okay|fine|yes|yeah|yep)$/,
  /\ball good\b/,
  /\bat (the )?shelter\b/,
  /\bmade it\b/,
  /\bestoy bien\b/,
  /\ba salvo\b/,
];
const EN_ROUTE = [/\bleaving\b/, /\bon (my|our) way\b/, /\bevacuating\b/, /\bheading (out|to)\b/, /\ben route\b/, /\bdriving to\b/];

/**
 * Lowercase, straighten quotes, and drop punctuation that does not matter.
 *
 * Args:
 *     text (string): Raw message text.
 *
 * Returns:
 *     string: Normalized text with single spaces.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find the wake phrase near the start of a radio message.
 *
 * Accepts "Relay, ..." and "Unit 4 to Relay, ...". Only the first five words
 * are checked, so "tell Relay later" mid-sentence does not trigger it.
 *
 * Args:
 *     text (string): Raw radio text.
 *     wakePhrase (string): The wake phrase from the scenario, e.g. "relay".
 *
 * Returns:
 *     string | null: The text after the wake phrase, or null if it is not
 *         addressed to Relay.
 */
export function stripWakePhrase(text: string, wakePhrase: string): string | null {
  const words = text.trim().split(/\s+/);
  const wake = normalize(wakePhrase);
  const at = words.slice(0, 5).findIndex((w) => normalize(w) === wake);
  if (at === -1) return null;
  return words.slice(at + 1).join(" ").replace(/^[,.:;!?\s-]+/, "");
}

/**
 * Classify a message with the fast rules.
 *
 * Order matters: STOP, then SOS, then safe, then leaving. "I'm not safe" is
 * SOS, never safe.
 *
 * Args:
 *     text (string): Raw message text.
 *     channel (Channel): Where it came from. Radio is handled differently.
 *     wakePhrase (string): The scenario's wake phrase.
 *
 * Returns:
 *     Classification: The intent and the text to pass on.
 */
export function classify(text: string, channel: Channel, wakePhrase: string): Classification {
  if (channel === "radio") {
    const question = stripWakePhrase(text, wakePhrase);
    return question === null ? { intent: "radio_chatter", text } : { intent: "agent", text: question };
  }

  const t = normalize(text);
  if (STOP_WORDS.has(t)) return { intent: "stop", text };
  if (!NOT_SOS.some((r) => r.test(t)) && SOS.some((r) => r.test(t))) return { intent: "sos", text };
  if (SAFE.some((r) => r.test(t))) return { intent: "safe", text };
  if (EN_ROUTE.some((r) => r.test(t))) return { intent: "en_route", text };
  return { intent: "agent", text };
}
