/**
 * POST /radio/start: starts the always-open radio call.
 *
 * It places a call to a phone number, so like /actions it refuses requests
 * that came through the public tunnel.
 */
import { Router } from "express";
import { asyncHandler } from "./asyncHandler.js";
import { localOnly } from "./localOnly.js";

/** Dependencies for {@link createRadioRouter}. */
export interface RadioRouterDeps {
  /** Starts the call and returns the conversation id, or null. */
  startCall: () => Promise<string | null>;
}

/**
 * Build the router with the radio start route.
 *
 * Args:
 *   deps: How to start the radio call.
 *
 * Returns:
 *   An Express router with POST /radio/start.
 */
export function createRadioRouter(deps: RadioRouterDeps): Router {
  const router = Router();

  router.post(
    "/radio/start",
    localOnly,
    asyncHandler(async (_req, res) => {
      const conversationId = await deps.startCall();
      res.json({ ok: true, conversation_id: conversationId });
    }),
  );

  return router;
}
