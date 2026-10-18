/**
 * A tiny timer interface, so code that waits can be tested without waiting.
 *
 * The check-in chain and the hazard poll both run on timers. They take a
 * Scheduler instead of calling setTimeout, so a test can swap in a fake one
 * and move time forward by hand.
 */

/** Cancels a scheduled callback. Safe to call more than once, or after it ran. */
export type Cancel = () => void;

/** Runs callbacks later. */
export interface Scheduler {
  /**
   * Run a callback once after a delay.
   *
   * Args:
   *     fn (() => void): The callback. It should not throw; errors are the
   *         caller's job to catch.
   *     ms (number): Delay in milliseconds.
   *
   * Returns:
   *     Cancel: Stops the callback if it has not run yet.
   */
  schedule(fn: () => void, ms: number): Cancel;
}

/**
 * The real scheduler, on setTimeout.
 *
 * Timers are unref'd, so a pending check-in never keeps a test process or a
 * one-off script alive. The HTTP server keeps the real process running.
 */
export const realScheduler: Scheduler = {
  schedule(fn, ms) {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};
