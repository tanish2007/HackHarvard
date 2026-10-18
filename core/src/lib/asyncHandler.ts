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

/** Error codes for body parser failures that are the caller's fault. */
const CLIENT_ERROR_CODES: Record<string, string> = {
  "entity.parse.failed": "invalid_json",
  "entity.too.large": "payload_too_large",
  "encoding.unsupported": "unsupported_encoding",
  "charset.unsupported": "unsupported_charset",
};

/**
 * Final error handler: answer with clean JSON and keep the server running.
 *
 * Client errors (any 4xx, such as malformed JSON or a body over the limit)
 * keep their status and get a short code. Everything else is logged and
 * becomes a 500.
 *
 * Args:
 *     err (unknown): The error passed to next().
 *     req (Request): The request that failed.
 *     res (Response): The response to send.
 *     next (NextFunction): Used only when headers were already sent. Express
 *         needs four arguments to treat this as an error handler.
 */
export const jsonErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err?.status ?? err?.statusCode);
  if (status >= 400 && status < 500) {
    res.status(status).json({ error: CLIENT_ERROR_CODES[err?.type] ?? "bad_request" });
    return;
  }
  console.error(`[core] ${req.method} ${req.path} failed:`, err);
  res.status(500).json({ error: "internal_error" });
};
