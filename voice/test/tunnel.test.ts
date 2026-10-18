/** Tests for pointing the ElevenLabs agents at the tunnel. */
import { describe, expect, it, vi } from "vitest";
import { extractTunnelUrl, llmBaseUrl, setAgentLlmUrl, waitForTunnel } from "../src/tunnel.js";

describe("extractTunnelUrl", () => {
  it.each([
    ["2026-10-18T06:00:00Z INF |  https://mitchell-nov-earn-essentials.trycloudflare.com  |", "https://mitchell-nov-earn-essentials.trycloudflare.com"],
    ["https://abc-123.trycloudflare.com", "https://abc-123.trycloudflare.com"],
    ["Your quick Tunnel has been created! Visit it at: https://a-b.trycloudflare.com/", "https://a-b.trycloudflare.com"],
  ])("finds the address in %j", (line, url) => {
    expect(extractTunnelUrl(line)).toBe(url);
  });

  it.each(["", "starting tunnel", "https://api.cloudflare.com/tunnel", "http://x.trycloudflare.com"])(
    "returns null for %j",
    (line) => {
      expect(extractTunnelUrl(line)).toBeNull();
    },
  );
});

describe("llmBaseUrl", () => {
  it("adds the secret path and the /v1 that ElevenLabs expects", () => {
    expect(llmBaseUrl("https://x.trycloudflare.com", "s3cret")).toBe("https://x.trycloudflare.com/llm/s3cret/v1");
  });

  it("ignores a trailing slash", () => {
    expect(llmBaseUrl("https://x.trycloudflare.com/", "s")).toBe("https://x.trycloudflare.com/llm/s/v1");
  });
});

describe("waitForTunnel", () => {
  it("is true as soon as /health answers as the voice lane", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ status: "ok", lane: "voice" }), { status: 200 }));
    expect(await waitForTunnel("https://x.trycloudflare.com", f as unknown as typeof fetch, 3, 1)).toBe(true);
    expect(f).toHaveBeenCalledWith("https://x.trycloudflare.com/health", expect.anything());
  });

  it("keeps trying while the address does not resolve yet", async () => {
    const f = vi
      .fn()
      .mockRejectedValueOnce(new Error("ENOTFOUND"))
      .mockRejectedValueOnce(new Error("ENOTFOUND"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ lane: "voice" }), { status: 200 }));
    expect(await waitForTunnel("https://x.trycloudflare.com", f as unknown as typeof fetch, 5, 1)).toBe(true);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("is false when something else answers, such as another server", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ status: "ok", incident: "x" }), { status: 200 }));
    expect(await waitForTunnel("https://x.trycloudflare.com", f as unknown as typeof fetch, 2, 1)).toBe(false);
  });

  it("is false after the tries run out", async () => {
    const f = vi.fn(async () => {
      throw new Error("down");
    });
    expect(await waitForTunnel("https://x.trycloudflare.com", f as unknown as typeof fetch, 3, 1)).toBe(false);
    expect(f).toHaveBeenCalledTimes(3);
  });
});

/** A fake ElevenLabs that remembers the agent's custom LLM and applies PATCHes. */
const fakeApi = (initial: Record<string, unknown> | null, patchStatus = 200, keepPatch = true) => {
  let current = initial;
  const calls: { method: string; body?: unknown }[] = [];
  const f = vi.fn(async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, body });
    if (method === "PATCH") {
      if (patchStatus === 200 && keepPatch) current = body.conversation_config.agent.prompt.custom_llm;
      return new Response("{}", { status: patchStatus });
    }
    return new Response(
      JSON.stringify({ conversation_config: { agent: { prompt: { custom_llm: current } } } }),
      { status: 200 },
    );
  });
  return { f: f as unknown as typeof fetch, calls };
};

const options = (f: typeof fetch) => ({
  apiKey: "key",
  agentId: "agent_1",
  url: "https://new.trycloudflare.com/llm/s3cret/v1",
  fetchImpl: f,
});

describe("setAgentLlmUrl", () => {
  it("replaces only the URL and keeps the other custom LLM fields", async () => {
    const { f, calls } = fakeApi({ url: "https://old.trycloudflare.com/llm/s3cret/v1", model_id: "relay", api_type: "chat_completions" });
    await setAgentLlmUrl(options(f));
    const patch = calls.find((c) => c.method === "PATCH")?.body as {
      conversation_config: { agent: { prompt: Record<string, unknown> } };
    };
    expect(Object.keys(patch.conversation_config.agent.prompt)).toEqual(["custom_llm"]);
    expect(patch.conversation_config.agent.prompt.custom_llm).toEqual({
      url: "https://new.trycloudflare.com/llm/s3cret/v1",
      model_id: "relay",
      api_type: "chat_completions",
    });
  });

  it("refuses an agent that does not use a custom LLM, and changes nothing", async () => {
    const { f, calls } = fakeApi(null);
    await expect(setAgentLlmUrl(options(f))).rejects.toThrow("does not use a custom LLM");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("fails when ElevenLabs rejects the update", async () => {
    const { f } = fakeApi({ url: "old", model_id: "relay" }, 422);
    await expect(setAgentLlmUrl(options(f))).rejects.toThrow("422");
  });

  it("fails when the agent does not show the new URL afterwards", async () => {
    const { f } = fakeApi({ url: "old", model_id: "relay" }, 200, false);
    await expect(setAgentLlmUrl(options(f))).rejects.toThrow("did not keep the new URL");
  });

  it("never puts the URL, which holds the secret, in an error message", async () => {
    for (const [initial, status, keep] of [
      [null, 200, true],
      [{ url: "old" }, 422, true],
      [{ url: "old" }, 200, false],
    ] as const) {
      const { f } = fakeApi(initial as Record<string, unknown> | null, status, keep);
      const err = await setAgentLlmUrl(options(f)).catch((e: Error) => e);
      expect((err as Error).message).not.toContain("s3cret");
      expect((err as Error).message).not.toContain("trycloudflare");
    }
  });
});
