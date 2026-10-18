/**
 * Reads what Relay needs out of an OpenAI-style chat completion request.
 */

/** One message in the request. */
export interface ChatMessage {
  role: string;
  content?: unknown;
}

/** Who the call is about, read from the agent's system prompt. */
export interface CallContext {
  /** The person id from the place_call that started the call, if any. */
  personId: string | null;
  /** The number of the person on the call, if known. */
  callerNumber: string | null;
}

/**
 * Turn a message's content into plain text.
 *
 * Args:
 *   content: A string, or an array of parts with `text` fields.
 *
 * Returns:
 *   The text, or an empty string if there is none.
 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "object" && p !== null ? String((p as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

/**
 * Find what the caller just said.
 *
 * Args:
 *   messages: The request's messages.
 *
 * Returns:
 *   The text of the last user message, trimmed, or an empty string.
 */
export function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") return textOf(messages[i].content).trim();
  }
  return "";
}

/**
 * Read the call context from the system prompt.
 *
 * The agent's prompt must contain one line, which ElevenLabs fills in with
 * the call's dynamic variables:
 *   RELAY_CALL person_id={{person_id}} caller_number={{caller_number}}
 * A value that was never filled in (still in braces) counts as missing.
 *
 * Args:
 *   messages: The request's messages.
 *
 * Returns:
 *   The person id and caller number, each null if absent.
 */
export function parseCallContext(messages: ChatMessage[]): CallContext {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .join("\n");
  const pick = (key: string): string | null => {
    const m = new RegExp(String.raw`RELAY_CALL[^\n]*\b${key}=(\S+)`).exec(system);
    const v = m?.[1];
    return v && !v.includes("{{") ? v : null;
  };
  return { personId: pick("person_id"), callerNumber: pick("caller_number") };
}
