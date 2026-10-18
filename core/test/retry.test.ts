/** Tests for retrying model calls that fail for a moment. */
import { describe, expect, it, vi } from "vitest";
import { isTransient, withRetry } from "../src/agent/retry.js";

const apiError = (status: number) => Object.assign(new Error(`status ${status}`), { status });
const noSleep = vi.fn(async () => {});

describe("isTransient", () => {
  it.each([429, 500, 503, 504])("treats %i as temporary", (status) => {
    expect(isTransient(apiError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404])("does not retry %i", (status) => {
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
