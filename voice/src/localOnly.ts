/**
 * Keeps internal routes off the public tunnel.
 *
 * The voice server is exposed to the internet through a tunnel so ElevenLabs
 * can reach the speech endpoint. Core calls /actions directly on localhost
 * and cannot send a secret, and /actions can place a call to any number. So
 * these routes refuse anything that came through the tunnel, which can be
 * recognized by the headers a proxy adds.
 */
import type { NextFunction, Request, Response } from "express";

/** Headers that a tunnel or proxy adds and a direct local request never has. */
const PROXY_HEADERS = ["cf-connecting-ip", "x-forwarded-for", "forwarded", "cf-ray"];

/**
 * Refuse a request that arrived through a proxy or tunnel.
 *
 * Args:
 *   req: The request.
 *   res: The response. Gets a 403 if the request came through a proxy.
 *   next: Continues to the route for a direct request.
 */
export function localOnly(req: Request, res: Response, next: NextFunction): void {
  if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}
