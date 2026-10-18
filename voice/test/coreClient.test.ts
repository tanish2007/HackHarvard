/** Tests for the Core client. */
import { describe, expect, it, vi } from "vitest";
import { parseActions, postEvent } from "../src/coreClient.js";
import type { RelayEvent } from "../src/contracts.js";

const event: RelayEvent = {
  event_id: "evt_1",
  channel: "voice",
  person_id: "p_amit",
  from: "+15550000000",
  text: "I am okay",
  location: null,
  media_url: null,
  timestamp: "2026-10-17T14:02:00Z",
};

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("parseActions", () => {
  it("keeps known actions and drops unknown ones", () => {
    const out = parseActions({
      actions: [{ type: "say", text: "hi" }, { type: "dance" }, null, 7],
    });
    expect(out).toEqual([{ type: "say", text: "hi" }]);
  });

  it("returns empty for malformed bodies", () => {
    expect(parseActions(null)).toEqual([]);
    expect(parseActions({})).toEqual([]);
    expect(parseActions({ actions: "x" })).toEqual([]);
  });
});

describe("postEvent", () => {
  it("posts to /event and returns actions", async () => {
    const f = reply(200, { actions: [{ type: "say", text: "stay calm" }] });
    const res = await postEvent(event, { coreUrl: "http://core", fetchImpl: f });
    expect(res.actions).toEqual([{ type: "say", text: "stay calm" }]);
    expect(f).toHaveBeenCalledWith("http://core/event", expect.objectContaining({ method: "POST" }));
  });

  it("returns no actions on a non-200 status", async () => {
    const log = vi.fn();
    const res = await postEvent(event, {
      coreUrl: "http://core",
      fetchImpl: reply(500, {}),
      log,
    });
    expect(res.actions).toEqual([]);
    expect(log).toHaveBeenCalled();
  });

  it("returns no actions when the request throws", async () => {
    const res = await postEvent(event, {
      coreUrl: "http://core",
      fetchImpl: vi.fn(async () => {
        throw new Error("down");
      }),
      log: () => {},
    });
    expect(res.actions).toEqual([]);
  });
});
