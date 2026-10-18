/**
 * Core's HTTP routes, as one Express router the root server mounts.
 *
 * Endpoints are added here as they are built: /event (Contract A to B) and
 * /state (Contract D) come next.
 */
import express, { Router } from "express";
import { jsonErrorHandler } from "./lib/asyncHandler.js";
import type { Scenario } from "./scenario/schema.js";

/**
 * What Core's routes need to run.
 *
 * Attributes:
 *     scenario (Scenario): The loaded scenario (Contract E).
 */
export interface CoreDeps {
  scenario: Scenario;
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

  router.use(jsonErrorHandler);
  return router;
}
