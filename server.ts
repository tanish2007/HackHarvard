/**
 * Relay server entry point. Runs locally on one laptop.
 *
 * Loads .env and the scenario, then mounts each lane's router. Core is mounted
 * now. Text, Voice, and the dashboard mount here as their lanes land.
 */
import { existsSync } from "node:fs";
import express from "express";
import { createCoreRouter } from "./core/src/app.js";
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

const app = express();
app.use(createCoreRouter({ scenario, store: new IncidentStore(scenario) }));
app.use(jsonErrorHandler);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`[relay] ${scenario.incident.name} running on http://localhost:${port}`);
});
