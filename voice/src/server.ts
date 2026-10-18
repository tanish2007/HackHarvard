/**
 * Entry point for the voice lane server.
 *
 * Run from voice/ with `npm start`. Reads .env, builds the ElevenLabs call
 * placer, and serves two things: POST /actions for Core to push calls to (set
 * VOICE_ACTIONS_URL in Core's .env to http://localhost:<VOICE_PORT>/actions),
 * and the custom LLM endpoint ElevenLabs calls for what callers say.
 */
import express from "express";
import { actionsErrorHandler } from "./errors.js";
import { createActionsRouter } from "./actionsRouter.js";
import { ElevenLabsPlacer } from "./elevenlabs.js";
import { fetchPersonLanguage } from "./personLanguage.js";
import { createLlmRouter } from "./llmRouter.js";
import { startRadioCall } from "./radio.js";
import { createRadioRouter } from "./radioRouter.js";

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

const coreUrl = process.env.CORE_URL ?? "http://localhost:3000";
// Languages the ElevenLabs agent has been set up for. A person in any other
// language, and English speakers, get the agent's default language.
const callLanguages = new Set(
  (process.env.ELEVENLABS_LANGUAGES ?? "es,gu,hi").split(",").map((l) => l.trim().toLowerCase()).filter(Boolean),
);

const placer = new ElevenLabsPlacer({
  apiKey: need("ELEVENLABS_API_KEY"),
  agentId: need("ELEVENLABS_AGENT_ID"),
  phoneNumberId: need("ELEVENLABS_PHONE_NUMBER_ID"),
  // Core always supplies `to` for check-in calls. Anyone else is unknown here.
  resolveNumber: () => null,
  languageOf: async (personId) => {
    const lang = (await fetchPersonLanguage(personId, { coreUrl }))?.split(/[-_]/)[0].toLowerCase();
    return lang && callLanguages.has(lang) ? lang : null;
  },
});

const app = express();
app.use(createActionsRouter({ placer }));
app.use(
  createLlmRouter({
    secret: need("VOICE_LLM_SECRET"),
    coreUrl,
    placer,
    // Core's agent can take several seconds when the model is slow. Wait for
    // it, and say "One moment" on the call meanwhile. Keep this above Core's
    // AGENT_TIMEOUT_MS so Voice does not give up first.
    coreTimeoutMs: Number(process.env.VOICE_CORE_TIMEOUT_MS) || 12000,
  }),
);
// Starts the always-open radio call. It needs the radio agent and the phone
// next to the radio, so it is only mounted when both are configured.
const radioAgentId = process.env.ELEVENLABS_RADIO_AGENT_ID;
const radioPhone = process.env.RADIO_PHONE;
if (radioAgentId && radioPhone) {
  app.use(
    createRadioRouter({
      startCall: () =>
        startRadioCall({
          apiKey: need("ELEVENLABS_API_KEY"),
          radioAgentId,
          phoneNumberId: need("ELEVENLABS_PHONE_NUMBER_ID"),
          to: radioPhone,
        }),
    }),
  );
}
app.use(actionsErrorHandler);

const port = Number(process.env.VOICE_PORT ?? 3001);
app.listen(port, () => console.log(`[voice] listening on http://localhost:${port}`));
