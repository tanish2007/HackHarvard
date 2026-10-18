/**
 * Gemini, behind the LlmClient interface.
 *
 * Uses the @google/genai SDK with function calling. Google Search grounding is
 * deliberately not enabled: every hazard fact must come from Contract C tools,
 * never from the web.
 */
import { FunctionCallingConfigMode, GoogleGenAI, type Content, type GenerateContentConfig, type ThinkingLevel } from "@google/genai";
import type { LlmClient, LlmContent, LlmRequest, LlmResult } from "./llm.js";
import { withFailover } from "./retry.js";

/** Fast and cheap by default. Override with GEMINI_MODEL. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

/**
 * Settings for the Gemini client.
 *
 * Attributes:
 *     apiKey (string): Gemini API key from Google AI Studio.
 *     model (string): Model id, e.g. "gemini-3.5-flash-lite".
 *     thinkingLevel (string | undefined): Optional thinking level, e.g.
 *         "low". Unset leaves the model's default.
 *     fallbackModels (string[] | undefined): Other models to try, in order,
 *         when the main one is rate limited, overloaded, or too slow. Each
 *         model has its own limit, so these add capacity.
 *     attemptTimeoutMs (number | undefined): How long one model gets before
 *         the next is tried. Unset means no limit.
 */
export interface GeminiOptions {
  apiKey: string;
  model: string;
  thinkingLevel?: string;
  fallbackModels?: string[];
  attemptTimeoutMs?: number;
}

/**
 * Create an LlmClient backed by Gemini.
 *
 * Args:
 *     options (GeminiOptions): API key, model, and optional thinking level.
 *
 * Returns:
 *     LlmClient: A client whose generate() calls Gemini, retrying a brief
 *         overload and moving to a fallback model on a rate limit.
 */
export function createGeminiClient(options: GeminiOptions): LlmClient {
  const ai = new GoogleGenAI({ apiKey: options.apiKey });

  return {
    async generate(req: LlmRequest): Promise<LlmResult> {
      const config: GenerateContentConfig = {
        systemInstruction: req.system,
        temperature: 0.2,
        maxOutputTokens: 400,
        tools: [
          {
            functionDeclarations: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parametersJsonSchema: t.parameters,
            })),
          },
        ],
        toolConfig: {
          functionCallingConfig: {
            mode: req.toolMode === "none" ? FunctionCallingConfigMode.NONE : FunctionCallingConfigMode.AUTO,
          },
        },
        abortSignal: req.signal,
      };
      if (options.thinkingLevel) config.thinkingConfig = { thinkingLevel: options.thinkingLevel as ThinkingLevel };

      // A model can answer 503 "high demand" for a moment, or 429 when its own
      // per-minute limit is used up. Retry a 503 quickly, and on a 429 or a
      // second failure move on to the next model.
      const res = await withFailover(
        [options.model, ...(options.fallbackModels ?? [])],
        (model, signal) =>
          ai.models.generateContent({
            model,
            contents: req.contents as Content[],
            config: { ...config, abortSignal: signal },
          }),
        { signal: req.signal, retries: 1, attemptTimeoutMs: options.attemptTimeoutMs },
      );

      const content = (res.candidates?.[0]?.content ?? { role: "model", parts: [] }) as LlmContent;
      // Read text from the parts directly: res.text warns when tool calls are
      // present, and thought parts must not be spoken to anyone.
      const text = (content.parts ?? [])
        .filter((p) => typeof p.text === "string" && !p.thought)
        .map((p) => p.text as string)
        .join("")
        .trim();
      const calls = (res.functionCalls ?? []).map((c) => ({ id: c.id, name: c.name ?? "", args: c.args ?? {} }));
      return { text, calls, content: { role: "model", parts: content.parts ?? [] } };
    },
  };
}
