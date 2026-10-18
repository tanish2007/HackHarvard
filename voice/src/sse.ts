/**
 * Builders for OpenAI-style streaming chunks.
 *
 * ElevenLabs requires a custom LLM to answer in server-sent events: a series
 * of `data: {chunk}` lines ending with `data: [DONE]`.
 */

/**
 * Format one chat completion chunk as an SSE `data:` line.
 *
 * Args:
 *   model: The model name echoed back to the caller.
 *   delta: The delta object for the single choice.
 *   finishReason: Why the stream ends, or null for a middle chunk.
 *
 * Returns:
 *   The `data: ...` line, including the blank line that ends the event.
 */
function chunk(
  model: string,
  delta: Record<string, unknown>,
  finishReason: "stop" | "tool_calls" | null,
): string {
  const body = {
    id: "chatcmpl-relay",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(body)}\n\n`;
}

/**
 * Build the stream for a spoken reply.
 *
 * Args:
 *   model: The model name to echo.
 *   text: What the agent should say.
 *
 * Returns:
 *   The full SSE body: the text, a stop chunk and `[DONE]`.
 */
export function speechStream(model: string, text: string): string {
  return (
    chunk(model, { role: "assistant", content: text }, null) +
    chunk(model, {}, "stop") +
    "data: [DONE]\n\n"
  );
}

/**
 * Build the stream that makes the agent stay silent.
 *
 * It asks ElevenLabs to run its `skip_turn` tool, which keeps the agent
 * quiet until the caller speaks again.
 *
 * Args:
 *   model: The model name to echo.
 *   reason: A short reason, passed to the tool.
 *
 * Returns:
 *   The full SSE body: a skip_turn tool call and `[DONE]`.
 */
export function silenceStream(model: string, reason: string): string {
  const toolCall = {
    index: 0,
    id: "call_skip_turn",
    type: "function",
    function: { name: "skip_turn", arguments: JSON.stringify({ reason }) },
  };
  return (
    chunk(model, { role: "assistant", tool_calls: [toolCall] }, null) +
    chunk(model, {}, "tool_calls") +
    "data: [DONE]\n\n"
  );
}

/**
 * Build the start of a stream that will be finished later.
 *
 * Used for a spoken filler such as "One moment... " while Core is still
 * thinking. The stream stays open, and {@link continuationStream} finishes it.
 * Text that ends with an ellipsis and a space is spoken smoothly by
 * ElevenLabs, per its guidance on slow custom LLMs.
 *
 * Args:
 *   model: The model name to echo.
 *   text: The filler to speak now.
 *
 * Returns:
 *   One SSE chunk with no stop and no `[DONE]`.
 */
export function openingChunk(model: string, text: string): string {
  return chunk(model, { role: "assistant", content: text }, null);
}

/**
 * Build the end of a stream that {@link openingChunk} started.
 *
 * Args:
 *   model: The model name to echo.
 *   text: The rest of what the agent should say.
 *
 * Returns:
 *   The text chunk, a stop chunk and `[DONE]`.
 */
export function continuationStream(model: string, text: string): string {
  return chunk(model, { content: text }, null) + chunk(model, {}, "stop") + "data: [DONE]\n\n";
}
