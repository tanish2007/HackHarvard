/**
 * The speech endpoint ElevenLabs calls as its custom LLM.
 *
 * ElevenLabs transcribes the caller and POSTs the conversation here in the
 * OpenAI chat completions format. Relay forwards the caller's words to Core
 * as a Contract A event and streams back whatever Core says. If Core says
 * nothing, as it does for radio chatter, the agent is told to skip its turn.
 *
 * The URL carries a secret path segment because ElevenLabs sends no
 * authentication and the server sits behind a public tunnel.
 */
import { timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import { asyncHandler } from "./asyncHandler.js";
import { lastUserText, parseCallContext, type ChatMessage } from "./llmRequest.js";
import type { CallPlacer, CallSession } from "./ports.js";
import { continuationStream, openingChunk, silenceStream, speechStream } from "./sse.js";
import { handleUtterance, type UtteranceDeps } from "./utterance.js";

/** What a voice caller hears if Core cannot be reached. */
export const FALLBACK_SPEECH = "Sorry, I lost my connection for a moment. Please say that again.";

/** What a phone caller hears while Core is still thinking. The trailing space matters to the voice. */
export const FILLER_SPEECH = "One moment... ";

/** How long Core can take before the caller hears the filler, in milliseconds. */
export const FILLER_DELAY_MS = 1500;

/** Model name that marks the always-open radio call. Anything else is a phone call. */
export const RADIO_MODEL = "relay-radio";

/** Dependencies for {@link createLlmRouter}. */
export interface LlmRouterDeps {
  /** Secret path segment. Requests with any other value get 404. */
  secret: string;
  /** Base URL of Core. */
  coreUrl: string;
  /** Places calls if Core asks for one in its reply. */
  placer: CallPlacer;
  /** Fetch implementation for Core, injectable for tests. */
  fetchImpl?: typeof fetch;
  /** How long to wait for Core before a phone caller hears the filler. Defaults to FILLER_DELAY_MS. */
  fillerDelayMs?: number;
  /** How long to wait for Core's answer in total. Defaults to the Core client's own default. */
  coreTimeoutMs?: number;
  /** Logger. Defaults to console.warn. */
  log?: (msg: string) => void;
}

/**
 * Compare two strings without leaking where they differ.
 *
 * Args:
 *   a: The value from the request.
 *   b: The expected secret.
 *
 * Returns:
 *   True if they are equal.
 */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Build the router that serves the custom LLM endpoint.
 *
 * Args:
 *   deps: The secret, Core's URL and the call placer.
 *
 * Returns:
 *   An Express router with POST /llm/:secret/v1/chat/completions.
 */
export function createLlmRouter(deps: LlmRouterDeps): Router {
  const router = Router();
  const log = deps.log ?? ((m: string) => console.warn(m));

  router.post(
    "/llm/:secret/v1/chat/completions",
    express.json({ limit: "2mb" }),
    asyncHandler(async (req, res) => {
      if (!sameSecret(String(req.params.secret), deps.secret)) {
        res.sendStatus(404);
        return;
      }

      const body = (req.body ?? {}) as { messages?: ChatMessage[]; model?: string; tools?: unknown };
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const model = typeof body.model === "string" && body.model ? body.model : "relay";
      const channel = model === RADIO_MODEL ? "radio" : "voice";
      const canSkip =
        Array.isArray(body.tools) &&
        body.tools.some((t) => (t as { function?: { name?: string } })?.function?.name === "skip_turn");

      // Stay silent, or send an empty reply if the agent has no skip_turn tool.
      const quiet = (reason: string): string =>
        canSkip ? silenceStream(model, reason) : speechStream(model, "");

      const said: string[] = [];
      const session: CallSession = {
        async speak(text) {
          said.push(text);
        },
      };

      const context = parseCallContext(messages);
      const utteranceDeps: UtteranceDeps = {
        coreUrl: deps.coreUrl,
        placer: deps.placer,
        resolvePerson: () => null,
        fetchImpl: deps.fetchImpl,
        coreTimeoutMs: deps.coreTimeoutMs,
        log,
      };

      const text = lastUserText(messages);
      // ElevenLabs sends "..." while the caller is silent. That is not speech,
      // so it must not reach Core or get an answer.
      const silent = !/[\p{L}\p{N}]/u.test(text);

      // A phone caller hears a filler if Core is slow. Radio never does, since
      // Relay must stay quiet there unless it was addressed.
      let fillerSent = false;
      const setHeaders = (): void => {
        res.status(200);
        res.set("content-type", "text/event-stream");
        res.set("cache-control", "no-cache");
      };
      const timer =
        channel === "voice" && !silent
          ? setTimeout(() => {
              fillerSent = true;
              setHeaders();
              res.flushHeaders();
              res.write(openingChunk(model, FILLER_SPEECH));
            }, deps.fillerDelayMs ?? FILLER_DELAY_MS)
          : undefined;

      let spoken: string | null = null;
      try {
        if (!silent) {
          await handleUtterance(
            {
              channel,
              from: context.callerNumber ?? "unknown",
              personId: context.personId,
              text,
              session,
            },
            utteranceDeps,
          );
          // A phone caller never gets dead air. Radio stays quiet on chatter.
          if (said.length > 0) spoken = said.join(" ");
          else if (channel === "voice") spoken = FALLBACK_SPEECH;
        }
      } finally {
        clearTimeout(timer);
      }

      if (fillerSent) {
        res.write(continuationStream(model, spoken ?? ""));
        res.end();
        return;
      }
      setHeaders();
      res.send(spoken !== null ? speechStream(model, spoken) : quiet(silent ? "nothing said" : "radio chatter"));
    }),
  );

  return router;
}
