/**
 * Keyword commands that residents can text to Relay.
 *
 * Matching ignores case and surrounding whitespace or punctuation, and only
 * accepts the keyword on its own, so "stop the fire" is not treated as STOP.
 */

/** A recognised keyword, or "other" for any free text. */
export type Command = "join" | "stop" | "other";

const STOP_WORDS = new Set(["stop", "unsubscribe", "cancel", "end", "quit"]);
const JOIN_WORDS = new Set(["join", "start", "yes", "unstop"]);

/**
 * Classify an incoming text as a keyword command.
 *
 * @param text - The raw message text.
 * @returns "stop" for STOP-style words, "join" for JOIN-style words, and
 *   "other" for everything else.
 */
export function parseCommand(text: string): Command {
  const word = text.trim().toLowerCase().replace(/[^a-z]/g, "");
  if (STOP_WORDS.has(word)) return "stop";
  if (JOIN_WORDS.has(word)) return "join";
  return "other";
}
