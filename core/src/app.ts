/**
 * Core's HTTP routes, as one Express router the root server mounts.
 *
 * POST /event (Contract A in, Contract B out), GET /state (Contract D),
 * GET /health, POST /escalations/:person_id/confirm (the dashboard's "call
 * 911" button), and the local demo controls POST /admin/alert and
 * POST /admin/reset.
 */
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { HazardWatcher } from "./alerts/watcher.js";
import type { EscalationEngine } from "./escalation/engine.js";
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
 *         own to Text and Voice. Used by alerts, timers, admin routes, and
 *         /event for actions meant for someone other than the sender.
 *     watcher (HazardWatcher | undefined): Sends fire alerts. Without it,
 *         POST /admin/alert answers 503.
 *     escalation (EscalationEngine | undefined): Runs check-in chains and the
 *         confirmed 911 call. Without it, no chains run and confirm answers 503.
 *     adminToken (string | undefined): If set, /admin routes and the 911
 *         confirm need it in the x-relay-admin header. Unset leaves them
 *         open, for a laptop demo.
 */
export interface CoreDeps {
  scenario: Scenario;
  store: IncidentStore;
  agent?: Agent;
  dispatcher?: Dispatcher;
  watcher?: HazardWatcher;
  escalation?: EscalationEngine;
  adminToken?: string;
}

/** Body of POST /escalations/:person_id/confirm. Every field is optional. */
const confirmBodySchema = z.object({
  confirmed_by: z
    .string()
    .trim()
    .max(80)
    // It goes on the timeline, which must never show a phone number.
    .refine((s) => !/(\d[\s().+-]*){7,}/.test(s), "confirmed_by must not contain a phone number")
    .optional(),
});

/**
 * Let the dashboard call a route from its own dev server.
 *
 * Args:
 *     res (Response): The response to add CORS headers to.
 */
function allowCors(res: Response): void {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "content-type, x-relay-admin");
}

/**
 * Answer a CORS preflight.
 *
 * Args:
 *     _req (Request): The OPTIONS request.
 *     res (Response): The response.
 */
function preflight(_req: Request, res: Response): void {
  allowCors(res);
  res.sendStatus(204);
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

  /**
   * Refuse a request without the admin token, if one is set.
   *
   * Guards the demo controls and the 911 confirm, so neither can be
   * triggered by anyone who finds the server through a tunnel.
   *
   * Args:
   *     req (Request): The request.
   *     res (Response): The response. Gets CORS headers either way.
   *     next (NextFunction): Continues to the route.
   */
  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    allowCors(res);
    if (deps.adminToken && req.get("x-relay-admin") !== deps.adminToken) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    next();
  };

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
      res.json(
        await handleEvent(parsed.event, { store: deps.store, agent: deps.agent, escalation: deps.escalation, dispatcher: deps.dispatcher }),
      );
    }),
  );

  // The dashboard's button for a person in SOS. Relay never calls 911 on its
  // own: this is the only way the emergency contact gets a call.
  router.options("/escalations/:person_id/confirm", preflight);
  router.post(
    "/escalations/:person_id/confirm",
    requireAdmin,
    jsonBody,
    asyncHandler(async (req, res) => {
      if (!deps.escalation) {
        res.status(503).json({ error: "escalation_off" });
        return;
      }
      const body = confirmBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: "invalid_body", issues: body.error.issues.map((i) => i.message) });
        return;
      }
      const personId = req.params.person_id;
      const result = await deps.escalation.confirm(personId, body.data.confirmed_by);
      if (!result.ok) {
        res.status(result.error === "unknown_person" ? 404 : 409).json({ error: result.error });
        return;
      }
      // No phone number in the answer: the dashboard only needs to know it went.
      res.json({ ok: true, person_id: personId, delivered: result.results.every((r) => r.ok) });
    }),
  );

  // Local demo controls. Optional token, in case the server is ever tunnelled.
  router.options("/admin/:action", preflight);
  router.use("/admin", requireAdmin);

  router.post(
    "/admin/alert",
    asyncHandler(async (_req, res) => {
      if (!deps.watcher) {
        res.status(503).json({ error: "watcher_off" });
        return;
      }
      res.json(await deps.watcher.runOnce());
    }),
  );

  // Back to the scenario's starting state, so the demo can run twice in a row.
  router.post("/admin/reset", (_req, res) => {
    deps.watcher?.reset();
    deps.escalation?.reset();
    deps.store.reset();
    res.json({ ok: true });
  });

  router.use(jsonErrorHandler);
  return router;
}
