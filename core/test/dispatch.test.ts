/**
 * Tests for the outbound dispatcher, which POSTs actions Core starts on its
 * own (alerts, timer calls) to each lane's /actions. It must never throw.
 */
import { describe, expect, it, vi } from "vitest";
import type { RelayAction } from "../src/contracts.js";
import { createHttpDispatcher } from "../src/dispatch/outbound.js";

const TEXT: RelayAction = { type: "send_text", person_id: "p_amit", to: "+16175550101", text: "Fire alert", map_url: null };
const CALL: RelayAction = { type: "place_call", person_id: "p_amit", to: "+16175550101", script: "Are you safe?", reason: "missed_checkin" };
const SAY: RelayAction = { type: "say", text: "hello" };

describe("createHttpDispatcher", () => {
  it("sends texts to Text and calls and says to Voice, as Contract B bodies", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 200 }));
    const d = createHttpDispatcher({ textUrl: "http://text/actions", voiceUrl: "http://voice/actions", fetchImpl: fetchImpl as typeof fetch, log: () => {} });
    const results = await d.push([TEXT, CALL, SAY]);
    expect(results).toEqual([
      { lane: "text", count: 1, ok: true },
      { lane: "voice", count: 2, ok: true },
    ]);
    const bodies = Object.fromEntries(fetchImpl.mock.calls.map(([url, init]) => [url, JSON.parse((init as RequestInit).body as string)]));
    expect(bodies["http://text/actions"]).toEqual({ actions: [TEXT] });
    expect(bodies["http://voice/actions"]).toEqual({ actions: [CALL, SAY] });
  });

  it("drops a lane with no URL instead of failing", async () => {
    const fetchImpl = vi.fn();
    const d = createHttpDispatcher({ fetchImpl, log: () => {} });
    expect(await d.push([TEXT])).toEqual([{ lane: "text", count: 1, ok: false, error: "no url" }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a non-2xx answer or a network error without rejecting", async () => {
    const d500 = createHttpDispatcher({ textUrl: "http://t", fetchImpl: async () => new Response("", { status: 500 }), log: () => {} });
    expect(await d500.push([TEXT])).toEqual([{ lane: "text", count: 1, ok: false, error: "status 500" }]);
    const down = createHttpDispatcher({
      voiceUrl: "http://v",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
      log: () => {},
    });
    expect((await down.push([CALL]))[0]).toMatchObject({ lane: "voice", ok: false, error: expect.stringContaining("ECONNREFUSED") });
  });

  it("does nothing for an empty list", async () => {
    const fetchImpl = vi.fn();
    expect(await createHttpDispatcher({ textUrl: "http://t", fetchImpl }).push([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
