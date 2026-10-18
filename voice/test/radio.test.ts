/** Tests for starting the radio call. */
import { describe, expect, it, vi } from "vitest";
import { startRadioCall } from "../src/radio.js";

const config = (fetchImpl: typeof fetch) => ({
  apiKey: "key",
  radioAgentId: "agent_radio",
  phoneNumberId: "phnum_1",
  to: "+15550002222",
  fetchImpl,
});

describe("startRadioCall", () => {
  it("calls the radio phone with the radio agent and no conversation overrides", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ conversation_id: "conv_9" }), { status: 200 }));
    expect(await startRadioCall(config(f as unknown as typeof fetch))).toBe("conv_9");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("key");
    expect(JSON.parse(init.body as string)).toEqual({
      agent_id: "agent_radio",
      agent_phone_number_id: "phnum_1",
      to_number: "+15550002222",
    });
  });

  it("returns null when the answer has no conversation id", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await startRadioCall(config(f as unknown as typeof fetch))).toBeNull();
  });

  it("throws with the status when ElevenLabs rejects the call", async () => {
    const f = vi.fn(async () => new Response("bad agent", { status: 422 }));
    await expect(startRadioCall(config(f as unknown as typeof fetch))).rejects.toThrow("422");
  });
});
