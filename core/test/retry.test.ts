/** Tests for retrying model calls that fail for a moment. */
import { describe, expect, it, vi } from "vitest";
import { AttemptTimeoutError, canFailOver, isTransient, withFailover, withRetry } from "../src/agent/retry.js";

const apiError = (status: number) => Object.assign(new Error(`status ${status}`), { status });
const noSleep = vi.fn(async () => {});

describe("isTransient", () => {
  it.each([500, 503, 504])("treats %i as temporary", (status) => {
    expect(isTransient(apiError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 429])("does not retry %i on the same model", (status) => {
    expect(isTransient(apiError(status))).toBe(false);
  });

  it("does not retry errors without a status", () => {
    expect(isTransient(new Error("boom"))).toBe(false);
    expect(isTransient(null)).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns the first result without retrying when the call works", async () => {
    const fn = vi.fn(async () => "ok");
    expect(await withRetry(fn, { sleep: noSleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a 503 and returns the later success", async () => {
    const fn = vi.fn().mockRejectedValueOnce(apiError(503)).mockResolvedValueOnce("ok");
    expect(await withRetry(fn, { sleep: noSleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retries run out and throws the last error", async () => {
    const fn = vi.fn(async () => {
      throw apiError(503);
    });
    await expect(withRetry(fn, { retries: 2, sleep: noSleep })).rejects.toMatchObject({ status: 503 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry an error that will not go away", async () => {
    const fn = vi.fn(async () => {
      throw apiError(400);
    });
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toMatchObject({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("doubles the pause on each retry", async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn().mockRejectedValueOnce(apiError(503)).mockRejectedValueOnce(apiError(503)).mockResolvedValueOnce("ok");
    await withRetry(fn, { delayMs: 100, sleep });
    expect(sleep.mock.calls.map((c) => (c as unknown as number[])[0])).toEqual([100, 200]);
  });

  it("stops retrying once the signal is aborted", async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      controller.abort();
      throw apiError(503);
    });
    await expect(withRetry(fn, { signal: controller.signal, sleep: noSleep })).rejects.toMatchObject({ status: 503 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("canFailOver", () => {
  it.each([429, 500, 503, 504])("lets another model try after %i", (status) => {
    expect(canFailOver(apiError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404])("does not move on after %i, since every model would fail", (status) => {
    expect(canFailOver(apiError(status))).toBe(false);
  });
});

describe("withFailover", () => {
  it("uses the first model when it works", async () => {
    const call = vi.fn(async (model: string) => model);
    expect(await withFailover(["a", "b"], call, { sleep: noSleep })).toBe("a");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("moves to the next model at once on a 429, without retrying the first", async () => {
    const call = vi.fn(async (model: string) => {
      if (model === "a") throw apiError(429);
      return model;
    });
    expect(await withFailover(["a", "b"], call, { sleep: noSleep })).toBe("b");
    expect(call.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  });

  it("retries a 503 on the same model once before moving on", async () => {
    const call = vi.fn(async (model: string) => {
      if (model === "a") throw apiError(503);
      return model;
    });
    expect(await withFailover(["a", "b"], call, { retries: 1, sleep: noSleep })).toBe("b");
    expect(call.mock.calls.map((c) => c[0])).toEqual(["a", "a", "b"]);
  });

  it("walks the whole list and throws the last error when no model answers", async () => {
    const call = vi.fn(async () => {
      throw apiError(429);
    });
    await expect(withFailover(["a", "b", "c"], call, { sleep: noSleep })).rejects.toMatchObject({ status: 429 });
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("stops at once on an error every model would give", async () => {
    const call = vi.fn(async () => {
      throw apiError(400);
    });
    await expect(withFailover(["a", "b"], call, { sleep: noSleep })).rejects.toMatchObject({ status: 400 });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("does not try the next model once Core has stopped waiting", async () => {
    const controller = new AbortController();
    const call = vi.fn(async () => {
      controller.abort();
      throw apiError(429);
    });
    await expect(withFailover(["a", "b"], call, { signal: controller.signal, sleep: noSleep })).rejects.toMatchObject({ status: 429 });
    expect(call).toHaveBeenCalledTimes(1);
  });
});

/** A model call that never answers until it is aborted, like a hung request. */
const hangsUntilAborted = (signal?: AbortSignal) =>
  new Promise<string>((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
  });

describe("withFailover per-attempt time limit", () => {
  it("abandons a model that is too slow and uses the next one", async () => {
    const call = vi.fn(async (model: string, signal?: AbortSignal) => (model === "slow" ? hangsUntilAborted(signal) : model));
    expect(await withFailover(["slow", "fast"], call, { attemptTimeoutMs: 30, sleep: noSleep })).toBe("fast");
    expect(call.mock.calls.map((c) => c[0])).toEqual(["slow", "fast"]);
  });

  it("gives each attempt an abort signal so the request can be cancelled", async () => {
    let seen: AbortSignal | undefined;
    const call = vi.fn(async (model: string, signal?: AbortSignal) => {
      seen = signal;
      return model === "slow" ? hangsUntilAborted(signal) : "ok";
    });
    await withFailover(["slow", "fast"], call, { attemptTimeoutMs: 30, sleep: noSleep });
    expect(call.mock.calls[0][1]?.aborted).toBe(true);
    expect(seen?.aborted).toBe(false);
  });

  it("does not retry a slow model on the same model", async () => {
    const call = vi.fn(async (_model: string, signal?: AbortSignal) => hangsUntilAborted(signal));
    await expect(withFailover(["slow"], call, { attemptTimeoutMs: 20, retries: 2, sleep: noSleep })).rejects.toBeInstanceOf(
      AttemptTimeoutError,
    );
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("throws a timeout error naming the last model when every model is too slow", async () => {
    const call = vi.fn(async (_model: string, signal?: AbortSignal) => hangsUntilAborted(signal));
    await expect(withFailover(["a", "b"], call, { attemptTimeoutMs: 20, sleep: noSleep })).rejects.toMatchObject({
      name: "AttemptTimeoutError",
      model: "b",
    });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("stops the whole chain when Core stops waiting, instead of treating it as a slow model", async () => {
    const controller = new AbortController();
    const call = vi.fn(async (_model: string, signal?: AbortSignal) => {
      setTimeout(() => controller.abort(), 10);
      return hangsUntilAborted(signal);
    });
    const err = await withFailover(["a", "b"], call, { signal: controller.signal, attemptTimeoutMs: 5000, sleep: noSleep }).catch(
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(AttemptTimeoutError);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("makes no limit when attemptTimeoutMs is not set", async () => {
    const call = vi.fn(async (_model: string, signal?: AbortSignal) => {
      expect(signal).toBeUndefined();
      return "ok";
    });
    expect(await withFailover(["a"], call, { sleep: noSleep })).toBe("ok");
  });

  it("still fails over on a 429 within the limit, and on a fast answer does nothing extra", async () => {
    const call = vi.fn(async (model: string) => {
      if (model === "a") throw apiError(429);
      return model;
    });
    expect(await withFailover(["a", "b"], call, { attemptTimeoutMs: 1000, sleep: noSleep })).toBe("b");
  });
});
