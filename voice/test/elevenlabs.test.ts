/** Tests for the ElevenLabs call placer. */
import { describe, expect, it, vi } from "vitest";
import { ElevenLabsPlacer } from "../src/elevenlabs.js";

const make = (fetchImpl: typeof fetch, known = true) =>
  new ElevenLabsPlacer({
    apiKey: "key",
    agentId: "agent_1",
    phoneNumberId: "phnum_1",
    resolveNumber: (id) => (known && id === "p_amit" ? "+15550001111" : null),
    fetchImpl,
  });

describe("ElevenLabsPlacer", () => {
  it("posts the outbound call request", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    await make(f as unknown as typeof fetch).placeCall("p_amit", "Are you okay?", "missed_checkin", null);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("key");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      agent_id: "agent_1",
      agent_phone_number_id: "phnum_1",
      to_number: "+15550001111",
    });
    expect(body.conversation_initiation_client_data.conversation_config_override.agent.first_message).toBe("Are you okay?");
    expect(body.conversation_initiation_client_data.dynamic_variables).toEqual({
      person_id: "p_amit",
      caller_number: "+15550001111",
      reason: "missed_checkin",
    });
  });

  it("dials the number Core supplied instead of the lookup", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    await make(f as unknown as typeof fetch, false).placeCall("p_new", "hi", "r", "+15559998888");
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).to_number).toBe("+15559998888");
  });

  it("sets the call language when the person has one", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    const placer = new ElevenLabsPlacer({
      apiKey: "key",
      agentId: "agent_1",
      phoneNumberId: "phnum_1",
      resolveNumber: () => "+15550001111",
      languageOf: async () => "hi",
      fetchImpl: f as unknown as typeof fetch,
    });
    await placer.placeCall("p_amit", "यह Relay है", "missed_checkin", null);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const override = JSON.parse(init.body as string).conversation_initiation_client_data.conversation_config_override;
    expect(override.agent).toEqual({ first_message: "यह Relay है", language: "hi" });
  });

  it("leaves the language out when there is none", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    const placer = new ElevenLabsPlacer({
      apiKey: "key",
      agentId: "agent_1",
      phoneNumberId: "phnum_1",
      resolveNumber: () => "+15550001111",
      languageOf: async () => null,
      fetchImpl: f as unknown as typeof fetch,
    });
    await placer.placeCall("p_amit", "hi", "r", null);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const agent = JSON.parse(init.body as string).conversation_initiation_client_data.conversation_config_override.agent;
    expect(agent).toEqual({ first_message: "hi" });
  });

  it("throws when the person has no number", async () => {
    const f = vi.fn();
    await expect(
      make(f as unknown as typeof fetch, false).placeCall("p_amit", "hi", "r", null),
    ).rejects.toThrow("no phone number");
    expect(f).not.toHaveBeenCalled();
  });

  it("throws with the status when ElevenLabs rejects", async () => {
    const f = vi.fn(async () => new Response("bad agent", { status: 422 }));
    await expect(
      make(f as unknown as typeof fetch).placeCall("p_amit", "hi", "r", null),
    ).rejects.toThrow("422");
  });
});
