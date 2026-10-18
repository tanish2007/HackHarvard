/**
 * The small interface Core's agent loop needs from an LLM.
 *
 * Gemini implements it in gemini.ts. Tests implement it with a scripted fake,
 * so the agent loop and tools can be tested without network or an API key.
 */

/** One turn in the conversation, in Gemini's content format. */
export interface LlmContent {
  role: "user" | "model";
  parts: Record<string, unknown>[];
}

/**
 * A tool the model may call.
 *
 * Attributes:
 *     name (string): Function name, e.g. "plan_route".
 *     description (string): What it does and when to use it. The model reads
 *         this to pick tools, so it matters as much as the code.
 *     parameters (object): JSON Schema for the arguments.
 */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One function call the model asked for. */
export interface LlmCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * One request to the model.
 *
 * Attributes:
 *     system (string): System instruction.
 *     contents (LlmContent[]): The conversation so far.
 *     tools (ToolDeclaration[]): Tools the model may call.
 *     toolMode ("auto" | "none"): "none" forces a text answer, used on the
 *         last round so the loop always ends with something to say.
 *     signal (AbortSignal | undefined): Cancels the request.
 */
export interface LlmRequest {
  system: string;
  contents: LlmContent[];
  tools: ToolDeclaration[];
  toolMode: "auto" | "none";
  signal?: AbortSignal;
}

/**
 * The model's reply.
 *
 * Attributes:
 *     text (string): Its text answer. Empty when it only called tools.
 *     calls (LlmCall[]): Tools it wants called, possibly several at once.
 *     content (LlmContent): The raw model turn. Send it back unchanged in the
 *         next request, because Gemini needs its thought signatures.
 */
export interface LlmResult {
  text: string;
  calls: LlmCall[];
  content: LlmContent;
}

/** Anything that can answer an LlmRequest. */
export interface LlmClient {
  generate(request: LlmRequest): Promise<LlmResult>;
}
