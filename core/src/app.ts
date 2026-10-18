/**
 * Core's HTTP routes, as one Express router the root server mounts.
 *
 * POST /event (Contract A in, Contract B out), GET /state (Contract D), and
 * GET /health.
 */
import express, { Router } from "express";
import { handleEvent, type Agent } from "./event/handle.js";
import { parseEvent } from "./event/schema.js";
import type { Dispatcher } from "./dispatch/outbound.js";
import { asyncHandler, jsonErrorHandler } from "./lib/asyncHandler.js";
import type { Scenario } from "./scenario/schema.js";
import type { IncidentStore } from "./state/store.js";

/**
 * What Core's routes need to run.
 *
 * Attributes:
 *     scenario (Scenario): The loaded scenario (Contract E).
 *     store (IncidentStore): The live incident state.
 *     agent (Agent | undefined): The LLM agent. Without it, only the keyword
 *         rules answer.
 *     dispatcher (Dispatcher | undefined): Pushes actions Core starts on its
 *         own to Text and Voice. Used by alerts, timers, and admin routes.
 */
export interface CoreDeps {
  scenario: Scenario;
  store: IncidentStore;
  agent?: Agent;
  dispatcher?: Dispatcher;
}

/**
 * JSON body parser for Core's own POST routes.
 *
 * Attach it per route, never with router.use(). Core's router is mounted at
 * "/", so router.use() would parse every request on the server, and Photon's
 * Express adapter on Text's routes needs the raw body untouched.
 */
export const jsonBody = express.json({ limit: "1mb" });

/**
 * Build Core's router.
 *
 * Args:
 *     deps (CoreDeps): The scenario and other shared pieces.
 *
 * Returns:
 *     Router: Core's routes, ready to mount with app.use().
 */
export function createCoreRouter(deps: CoreDeps): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", incident: deps.scenario.incident.name });
  });

  // Contract D. Open to any origin so the map can run on its own dev server.
  router.get("/state", (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "no-store");
    res.json(deps.store.snapshot());
  });

  // Contract A in, Contract B out. A malformed event is a 400 so channel bugs
  // show up early. Everything else is a 200 with a list, possibly empty.
  router.post(
    "/event",
    jsonBody,
    asyncHandler(async (req, res) => {
      const parsed = parseEvent(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: "invalid_event", issues: parsed.issues });
        return;
      }
      res.json(await handleEvent(parsed.event, { store: deps.store, agent: deps.agent }));
    }),
  );

  router.use(jsonErrorHandler);
  return router;
}
