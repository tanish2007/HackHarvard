/** Tests for looking up a person's language in Core. */
import { describe, expect, it, vi } from "vitest";
import { fetchPersonLanguage } from "../src/personLanguage.js";

const state = (people: unknown[], status = 200) =>
  vi.fn(async () => new Response(JSON.stringify({ people }), { status })) as unknown as typeof fetch;

describe("fetchPersonLanguage", () => {
  it("returns the language of the person with that id", async () => {
    const f = state([
      { person_id: "p_amit", language: "en" },
      { person_id: "p_priya", language: "gu" },
    ]);
    expect(await fetchPersonLanguage("p_priya", { coreUrl: "http://core", fetchImpl: f })).toBe("gu");
    expect(f).toHaveBeenCalledWith("http://core/state", expect.anything());
  });

  it("returns null for an unknown person", async () => {
    expect(await fetchPersonLanguage("p_nobody", { coreUrl: "http://core", fetchImpl: state([]) })).toBeNull();
  });

  it("returns null when the person has no language", async () => {
    const f = state([{ person_id: "p_amit" }, { person_id: "p_b", language: "" }]);
    expect(await fetchPersonLanguage("p_amit", { coreUrl: "http://core", fetchImpl: f })).toBeNull();
    expect(await fetchPersonLanguage("p_b", { coreUrl: "http://core", fetchImpl: f })).toBeNull();
  });

  it("returns null when Core answers with an error status", async () => {
    expect(await fetchPersonLanguage("p_amit", { coreUrl: "http://core", fetchImpl: state([], 500) })).toBeNull();
  });

  it("returns null instead of throwing when Core is unreachable", async () => {
    const f = vi.fn(async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await fetchPersonLanguage("p_amit", { coreUrl: "http://core", fetchImpl: f })).toBeNull();
  });
});
