/** Tests for utterance handling. */
import { describe, expect, it, vi } from "vitest";
import { handleUtterance } from "../src/utterance.js";

const setup = (coreBody: unknown = { actions: [] }) => {
  const session = { speak: vi.fn(async () => {}) };
  const placer = { placeCall: vi.fn(async () => {}) };
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(coreBody), { status: 200 }));
  const deps = {
    coreUrl: "http://core",
    placer,
    resolvePerson: (from: string) => (from === "+15551234567" ? "p_unit4" : null),
    now: () => new Date("2026-10-17T14:02:00Z"),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    log: vi.fn(),
  };
  return { session, placer, fetchImpl, deps };
};

describe("handleUtterance", () => {
  it("sends a contract A radio event with null location and media", async () => {
    const { session, deps, fetchImpl } = setup();
    const event = await handleUtterance(
      { channel: "radio", from: "+15551234567", text: " Relay, route to Pine Ave ", session },
      deps,
    );
    expect(event).toMatchObject({
      channel: "radio",
      person_id: "p_unit4",
      from: "+15551234567",
      text: "Relay, route to Pine Ave",
      location: null,
      media_url: null,
      timestamp: "2026-10-17T14:02:00.000Z",
    });
    expect(event?.event_id).toMatch(/^evt_/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("stays silent when Core returns no actions", async () => {
    const { session, deps } = setup({ actions: [] });
    await handleUtterance({ channel: "radio", from: "+15551234567", text: "copy that", session }, deps);
    expect(session.speak).not.toHaveBeenCalled();
  });

  it("speaks when Core returns a say action", async () => {
    const { session, deps } = setup({ actions: [{ type: "say", text: "Take Oak Road." }] });
    await handleUtterance({ channel: "radio", from: "+15551234567", text: "Relay, route", session }, deps);
    expect(session.speak).toHaveBeenCalledWith("Take Oak Road.");
  });

  it("ignores empty text", async () => {
    const { session, deps, fetchImpl } = setup();
    const event = await handleUtterance({ channel: "voice", from: "+15551234567", text: "   ", session }, deps);
    expect(event).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ignores unknown numbers", async () => {
    const { session, deps, fetchImpl } = setup();
    const event = await handleUtterance({ channel: "voice", from: "+19998887777", text: "hello", session }, deps);
    expect(event).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalled();
  });
});
