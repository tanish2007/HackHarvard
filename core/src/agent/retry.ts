/**
 * Retry for model calls that fail for a moment.
 *
 * Google answers 503 "high demand" and 429 when the model is briefly
 * overloaded, and says to try again. Core gives the agent a fixed time to
 * answer, so a retry only helps if it is quick: a short pause, then one more
 * try, and it stops as soon as Core stops waiting.
 */

/** HTTP statuses that are worth a second try. */
const TRANSIENT_STATUSES = new Set([429, 500, 503, 504]);

/**
 * Check whether an error is one that may go away on its own.
 *
 * Args:
 *     err (unknown): Whatever the model call threw.
 *
 * Returns:
 *     boolean: True for a rate limit or a temporary server error.
 */
export function isTransient(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && TRANSIENT_STATUSES.has(status);
}

/**
 * Settings for withRetry.
 *
 * Attributes:
 *     retries (number | undefined): Extra tries after the first. Defaults to 2.
 *     delayMs (number | undefined): Pause before the first retry, doubled for
 *         each one after. Defaults to 300.
 *     signal (AbortSignal | undefined): Stops retrying once aborted.
 *     sleep ((ms: number) => Promise<void> | undefined): Injectable for tests.
 */
export interface RetryOptions {
  retries?: number;
  delayMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run a call, trying again if it fails for a temporary reason.
 *
 * Args:
 *     fn (() => Promise<T>): The call to make.
 *     options (RetryOptions): How many retries, how long to pause, and when to stop.
 *
 * Returns:
 *     Promise<T>: The first successful result.
 *
 * Raises:
 *     Error: The last error, if it is not temporary, the retries run out, or
 *         the signal is aborted.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 2;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let delay = options.delayMs ?? 300;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isTransient(err) || options.signal?.aborted) throw err;
      await sleep(delay);
      if (options.signal?.aborted) throw err;
      delay *= 2;
    }
  }
}
