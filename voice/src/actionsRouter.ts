/**
 * The voice lane's POST /actions endpoint.
 *
 * Core calls this when it acts on its own, for example a missed check-in or
 * the human-confirmed escalation call. The body is a Contract B list. Core
 * reports "delivered" from a 2xx answer, so this answers 502 when any call
 * failed. A 200 must mean every call was really requested.
 */
import express, { Router } from "express";
import { asyncHandler } from "./asyncHandler.js";
import { parseActions } from "./coreClient.js";
import { executeActions } from "./executor.js";
import type { CallPlacer } from "./ports.js";

/** Dependencies for {@link createActionsRouter}. */
export interface ActionsRouterDeps {
  /** Places the outbound calls Core asks for. */
  placer: CallPlacer;
  /** Logger. Defaults to console.warn. */
  log?: (msg: string) => void;
}

/**
 * Build the router that accepts pushed actions from Core.
 *
 * Args:
 *   deps: The call placer and a logger.
 *
 * Returns:
 *   An Express router with POST /actions and GET /health.
 */
export function createActionsRouter(deps: ActionsRouterDeps): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", lane: "voice" });
  });

  router.post(
    "/actions",
    express.json({ limit: "1mb" }),
    asyncHandler(async (req, res) => {
      const actions = parseActions(req.body);
      // Pushed actions have no open call, so `say` is skipped and logged.
      const failed = await executeActions(actions, { placer: deps.placer, log: deps.log });
      if (failed > 0) {
        res.status(502).json({ ok: false, received: actions.length, failed });
        return;
      }
      res.json({ ok: true, received: actions.length });
    }),
  );

  return router;
}
