/**
 * Error handling helpers for Express 4 routes.
 *
 * Express 4 does not catch errors thrown by async handlers. Without a wrapper,
 * one failed network call crashes the server and the request never gets an
 * answer. Every async route in Core goes through asyncHandler.
 */
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wrap an async route handler so its errors reach Express's error handler.
 *
 * Args:
 *     fn (function): An async (req, res, next) handler.
 *
 * Returns:
 *     RequestHandler: A handler that forwards any rejection to next(err).
 *
 * Example:
 *     router.post("/event", asyncHandler(async (req, res) => { ... }));
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Final error handler: log the error and answer with a clean JSON 500.
 *
 * Malformed JSON bodies get a 400 instead, since that is the caller's fault.
 *
 * Args:
 *     err (unknown): The error passed to next().
 *     req (Request): The request that failed.
 *     res (Response): The response to send.
 *     next (NextFunction): Unused, but Express needs four arguments to treat
 *         this as an error handler.
 */
export const jsonErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: "invalid_json" });
    return;
  }
  console.error(`[core] ${req.method} ${req.path} failed:`, err);
  res.status(500).json({ error: "internal_error" });
};
