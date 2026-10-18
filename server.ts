/**
 * Relay server entry point. Runs locally on one laptop.
 *
 * Loads .env and the scenario, then mounts each lane's router. Core is mounted
 * now. Text, Voice, and the dashboard mount here as their lanes land.
 */
import { existsSync } from "node:fs";
import express from "express";
import { createGeminiClient, DEFAULT_GEMINI_MODEL } from "./core/src/agent/gemini.js";
import { createAgent } from "./core/src/agent/loop.js";
import { createHazardWatcher } from "./core/src/alerts/watcher.js";
import { createCoreRouter } from "./core/src/app.js";
import { createHttpData } from "./core/src/data/http.js";
import { createStubData } from "./core/src/data/stub.js";
import { createHttpDispatcher } from "./core/src/dispatch/outbound.js";
import { createEscalationEngine } from "./core/src/escalation/engine.js";
import type { Agent } from "./core/src/event/handle.js";
import { jsonErrorHandler } from "./core/src/lib/asyncHandler.js";
import { loadScenario, placeholderIds } from "./core/src/scenario/load.js";
import { IncidentStore } from "./core/src/state/store.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const scenario = loadScenario();
const placeholders = placeholderIds(scenario);
if (placeholders.length > 0) {
  console.warn(
    `[scenario] Placeholder numbers still in use for: ${placeholders.join(", ")}. ` +
      "Put real numbers in scenario.local.json before the demo.",
  );
}

const store = new IncidentStore(scenario);
// Rudra's Contract C functions are Python, served by the map server. With
// DATA_URL set, Core asks them over HTTP, so "nearest shelter" can be a real
// shelter near where the person is. Without it, or when a call fails, the
// agent uses a TypeScript stub with the same shapes, built from the scenario.
const stub = createStubData(scenario);
const dataUrl = process.env.DATA_URL || undefined;
const data = dataUrl ? createHttpData({ baseUrl: dataUrl, fallback: stub }) : stub;
console.log(dataUrl ? `[core] data: ${dataUrl}, the scenario is the fallback` : "[core] data: scenario only (set DATA_URL for real data)");
// Pushes actions Core starts on its own (alerts, timers) to Text and Voice.
const dispatcher = createHttpDispatcher({
  textUrl: process.env.TEXT_ACTIONS_URL || undefined,
  voiceUrl: process.env.VOICE_ACTIONS_URL || undefined,
});

let agent: Agent | undefined;
if (process.env.GEMINI_API_KEY) {
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const llm = createGeminiClient({ apiKey: process.env.GEMINI_API_KEY, model, thinkingLevel: process.env.GEMINI_THINKING_LEVEL || undefined });
  agent = createAgent({ store, data, llm, log: process.env.RELAY_DEBUG ? console.log : undefined });
  console.log(`[core] agent on: Gemini ${model}`);
} else {
  console.warn("[core] agent off: set GEMINI_API_KEY in .env. Keyword rules still work.");
}

// Check-in chains after an alert. It never calls 911: only the dashboard's
// confirm button does, after a human decides.
const escalation = createEscalationEngine({ store, dispatcher });
const watcher = createHazardWatcher({ store, data, dispatcher, checkins: escalation });

const app = express();
app.use(
  createCoreRouter({
    scenario,
    store,
    agent,
    dispatcher,
    watcher,
    escalation,
    adminToken: process.env.RELAY_ADMIN_TOKEN || undefined,
  }),
);
app.use(jsonErrorHandler);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`[relay] ${scenario.incident.name} running on http://localhost:${port}`);
  if (scenario.settings.alerts === "auto") {
    watcher.start();
    console.log(`[core] fire alerts: auto, polling hazards every ${scenario.settings.hazard_poll_sec}s`);
  } else {
    console.log("[core] fire alerts: manual, POST /admin/alert to send them");
  }
});
