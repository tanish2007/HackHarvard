/**
 * Keyword rules that run before the LLM.
 *
 * STOP, SOS, "safe", and "leaving" must work instantly and even when the LLM
 * is down or rate limited, so they are plain string rules. Radio chatter
 * without the wake phrase is logged but never answered.
 *
 * The rules are deliberately cautious. A false SOS texts the family and can
 * only be cleared by a responder, and a false "safe" stops the check-in chain.
 * So a keyword only counts when it is not negated in its own clause ("nobody
 * is hurt") and the clause is not a question ("Is Route 24 safe?"). Anything
 * unclear goes to the agent instead.
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

/** Short answers that mean "safe" only on a check-in call ("Are you safe?"). */
const SPOKEN_YES = new Set(["yes", "yeah", "yep", "yes i am", "ok", "okay", "fine", "i'm fine", "i am fine"]);

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
  /\bwe are (ok|okay|fine|good|safe)\b/,
  /\ball good\b/,
  /\bat (the )?shelter\b/,
  /\bmade it\b/,
  /\bestoy bien\b/,
  /\ba salvo\b/,
];
const EN_ROUTE = [/\bleaving\b/, /\bon (my|our) way\b/, /\bevacuating\b/, /\bheading (out|to)\b/, /\ben route\b/, /\bdriving to\b/];

/** Words that negate a keyword right after them: "not injured", "no emergency". */
const NEGATORS = new Set([
  "no", "not", "nobody", "none", "never", "without", "nothing", "noone", "nadie", "sin", "ni",
  // Contractions typed without the apostrophe.
  "dont", "doesnt", "didnt", "isnt", "arent", "wasnt", "werent", "wont", "havent", "hasnt",
]);

/** First words that make a clause a question. */
const QUESTION_WORDS = new Set([
  "can", "could", "would", "will", "is", "are", "am", "do", "does", "did", "where", "what", "when",
  "how", "which", "who", "why", "should", "may", "any", "anyone", "anybody",
]);

/** How many words before a keyword are checked for a negator. */
const NEGATION_WINDOW = 3;

/**
 * Lowercase, straighten quotes, and drop punctuation that does not matter.
 *
 * Args:
 *     text (string): Raw text.
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
 * One clause of a message: the normalized words and whether it asks something.
 *
 * Attributes:
 *     text (string): Normalized clause text.
 *     question (boolean): True if it ends in "?" or starts with a question word.
 */
interface Clause {
  text: string;
  question: boolean;
}

/**
 * Split a message into clauses at , . ; ! ? and new lines.
 *
 * Args:
 *     raw (string): Raw message text.
 *
 * Returns:
 *     Clause[]: Non-empty clauses in order.
 */
function clauses(raw: string): Clause[] {
  return raw
    .split(/(?<=[,.;!?\n])/)
    .map((piece) => {
      const text = normalize(piece);
      const first = text.split(" ")[0] ?? "";
      return { text, question: /\?\s*$/.test(piece) || QUESTION_WORDS.has(first) };
    })
    .filter((c) => c.text.length > 0);
}

/**
 * Check whether a word negates what follows it.
 *
 * Args:
 *     word (string): A normalized word.
 *
 * Returns:
 *     boolean: True for "no", "not", "nobody", and words like "isn't".
 */
function isNegator(word: string): boolean {
  return NEGATORS.has(word) || word.endsWith("n't");
}

/**
 * Find a keyword in a clause that is not negated.
 *
 * A match counts unless one of the few words right before it is a negator,
 * so "nobody is hurt" and "No necesito ayuda" do not count.
 *
 * Args:
 *     clause (string): Normalized clause text.
 *     patterns (RegExp[]): Keyword patterns.
 *
 * Returns:
 *     boolean: True if any pattern matches without a negator before it.
 */
function hasUnnegated(clause: string, patterns: RegExp[]): boolean {
  for (const pattern of patterns) {
    for (const m of clause.matchAll(new RegExp(pattern.source, "g"))) {
      const before = clause.slice(0, m.index).trim().split(" ").filter(Boolean).slice(-NEGATION_WINDOW);
      if (!before.some(isNegator)) return true;
    }
  }
  return false;
}

/**
 * Find the wake phrase near the start of a radio message.
 *
 * Accepts "Relay, ..." and "Unit 4 to Relay, ...", and multi-word phrases
 * like "hey relay". The phrase must start within the first five words, so
 * "tell Relay later" deep in a sentence does not trigger it.
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
  const plain = words.map(normalize);
  const wake = normalize(wakePhrase).split(" ").filter(Boolean);
  if (wake.length === 0) return null;

  for (let i = 0; i < 5 && i + wake.length <= words.length; i++) {
    if (wake.every((w, j) => plain[i + j] === w)) {
      return words.slice(i + wake.length).join(" ").replace(/^[,.:;!?\s-]+/, "");
    }
  }
  return null;
}

/**
 * Classify a message with the fast rules.
 *
 * Order: STOP, then SOS, then safe, then leaving. In a question, only the
 * word "SOS" counts. A bare "yes" or "ok" means safe only on a voice call,
 * where Relay just asked "Are you safe?". On text it could mean anything.
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

  const whole = normalize(text);
  if (STOP_WORDS.has(whole)) return { intent: "stop", text };

  const parts = clauses(text);
  const statements = parts.filter((c) => !c.question);
  if (parts.some((c) => hasUnnegated(c.text, [/\bsos\b/]))) return { intent: "sos", text };
  if (statements.some((c) => hasUnnegated(c.text, SOS))) return { intent: "sos", text };
  if (channel === "voice" && SPOKEN_YES.has(whole)) return { intent: "safe", text };
  if (statements.some((c) => hasUnnegated(c.text, SAFE))) return { intent: "safe", text };
  if (statements.some((c) => hasUnnegated(c.text, EN_ROUTE))) return { intent: "en_route", text };
  return { intent: "agent", text };
}
