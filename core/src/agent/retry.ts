/**
 * Retry and fail over for model calls that fail.
 *
 * Google answers 503 "high demand" when a model is briefly overloaded, and 429
 * when a model's own per-minute limit is used up. Core gives the agent a fixed
 * time to answer, so a retry only helps if it is quick: a short pause, then
 * one more try. A 429 is never retried on the same model, because the retry
 * would use up more of the limit and the limit lasts longer than Core waits.
 * It moves on to the next model instead, since each model has its own limit.
 * Everything stops as soon as Core stops waiting.
 */

/** HTTP statuses that are worth a second try on the same model. */
const TRANSIENT_STATUSES = new Set([500, 503, 504]);

/** HTTP statuses that mean this model cannot answer now but another may. */
const FAILOVER_STATUSES = new Set([429, ...TRANSIENT_STATUSES]);

/**
 * Check whether an error is one that may go away on its own.
 *
 * Args:
 *     err (unknown): Whatever the model call threw.
 *
 * Returns:
 *     boolean: True for a temporary server error. A 429 rate limit is not,
 *         since retrying it would not help in time.
 */
export function isTransient(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && TRANSIENT_STATUSES.has(status);
}

/**
 * Check whether another model may succeed where this one failed.
 *
 * Args:
 *     err (unknown): Whatever the model call threw.
 *
 * Returns:
 *     boolean: True for a 429 rate limit or a temporary server error. False
 *         for a bad key or a bad request, which every model would reject.
 */
export function canFailOver(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && FAILOVER_STATUSES.has(status);
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

/**
 * Try a call on each model in turn until one answers.
 *
 * Each model is tried with withRetry first, so a brief 503 is retried on the
 * same model. A 429 or an exhausted retry moves on to the next model. An error
 * that every model would give, such as a bad key, is thrown at once.
 *
 * Args:
 *     models (string[]): Model ids in the order to try them.
 *     call ((model: string) => Promise<T>): The call to make on one model.
 *     options (RetryOptions): Retries per model, the pause, and when to stop.
 *
 * Returns:
 *     Promise<T>: The first successful result.
 *
 * Raises:
 *     Error: The last error, if no model answered, or at once for an error
 *         that is not worth moving on from.
 */
export async function withFailover<T>(
  models: string[],
  call: (model: string) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  let lastError: unknown = new Error("no models to try");
  for (const model of models) {
    try {
      return await withRetry(() => call(model), options);
    } catch (err) {
      lastError = err;
      if (options.signal?.aborted || !canFailOver(err)) throw err;
    }
  }
  throw lastError;
}
