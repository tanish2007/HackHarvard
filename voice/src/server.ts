/**
 * Entry point for the voice lane server.
 *
 * Run from voice/ with `npm start`. Reads .env, builds the ElevenLabs call
 * placer, and serves POST /actions for Core to push calls to. Set
 * VOICE_ACTIONS_URL in Core's .env to http://localhost:<VOICE_PORT>/actions.
 */
import express from "express";
import { actionsErrorHandler } from "./errors.js";
import { createActionsRouter } from "./actionsRouter.js";
import { ElevenLabsPlacer } from "./elevenlabs.js";

/**
 * Read a required environment variable.
 *
 * Args:
 *   name: The variable name.
 *
 * Returns:
 *   The variable's value.
 *
 * Raises:
 *   Error: If the variable is missing or empty.
 */
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} in .env`);
  return v;
}

const placer = new ElevenLabsPlacer({
  apiKey: need("ELEVENLABS_API_KEY"),
  agentId: need("ELEVENLABS_AGENT_ID"),
  phoneNumberId: need("ELEVENLABS_PHONE_NUMBER_ID"),
  // Core always supplies `to` for check-in calls. Anyone else is unknown here.
  resolveNumber: () => null,
});

const app = express();
app.use(createActionsRouter({ placer }));
app.use(actionsErrorHandler);

const port = Number(process.env.VOICE_PORT ?? 3001);
app.listen(port, () => console.log(`[voice] listening on http://localhost:${port}`));
