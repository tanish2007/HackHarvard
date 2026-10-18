/**
 * Core's HTTP routes, as one Express router the root server mounts.
 *
 * Endpoints are added here as they are built. /event (Contract A to B) comes
 * next.
 */
import express, { Router } from "express";
import { jsonErrorHandler } from "./lib/asyncHandler.js";
import type { Scenario } from "./scenario/schema.js";
import type { IncidentStore } from "./state/store.js";

/**
 * What Core's routes need to run.
 *
 * Attributes:
 *     scenario (Scenario): The loaded scenario (Contract E).
 *     store (IncidentStore): The live incident state.
 */
export interface CoreDeps {
  scenario: Scenario;
  store: IncidentStore;
}

/**
 * Build Core's router.
 *
 * JSON parsing is scoped to this router, not the whole server, because
 * Photon's Express adapter needs the raw request body on Text's routes.
 *
 * Args:
 *     deps (CoreDeps): The scenario and other shared pieces.
 *
 * Returns:
 *     Router: Core's routes, ready to mount with app.use().
 */
export function createCoreRouter(deps: CoreDeps): Router {
  const router = Router();
  router.use(express.json({ limit: "1mb" }));

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", incident: deps.scenario.incident.name });
  });

  // Contract D. Open to any origin so the map can run on its own dev server.
  router.get("/state", (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "no-store");
    res.json(deps.store.snapshot());
  });

  router.use(jsonErrorHandler);
  return router;
}
