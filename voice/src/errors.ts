/**
 * Error handler for the voice lane's Express app.
 */
import type { NextFunction, Request, Response } from "express";

/**
 * Turn any error into a JSON answer so the server keeps running.
 *
 * A malformed JSON body gets a 400. Everything else gets a 500.
 *
 * Args:
 *   err: The error passed to `next`.
 *   _req: The request.
 *   res: The response.
 *   _next: Unused, required by Express for error handlers.
 */
export function actionsErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const status = (err as { status?: number }).status === 400 ? 400 : 500;
  res.status(status).json({ error: status === 400 ? "invalid_json" : "server_error" });
}
