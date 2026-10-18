/**
 * Wrapper that sends errors from async Express handlers to the error handler.
 *
 * Express 4 does not catch errors thrown in async handlers. Without this, a
 * dropped network call can crash the server and leave the request without an
 * answer. Wrap every async route in it.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wrap an async route handler so a rejection becomes a normal Express error.
 *
 * Args:
 *   fn: The async handler.
 *
 * Returns:
 *   A handler that forwards any rejection to `next`.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
