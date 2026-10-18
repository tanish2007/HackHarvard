/** Tests for the spoken filler while Core is slow. */
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actionsErrorHandler } from "../src/errors.js";
import { FALLBACK_SPEECH, FILLER_SPEECH, createLlmRouter, RADIO_MODEL } from "../src/llmRouter.js";

const PATH = "/llm/s3cret/v1/chat/completions";

/** A fake Core that answers after `delayMs`, and honors the abort signal. */
const slowCore = (delayMs: number, actions: unknown[]) =>
  vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(new Response(JSON.stringify({ actions }), { status: 200 })), delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        });
      }),
  ) as unknown as typeof fetch;

const build = (fetchImpl: typeof fetch, extra: { fillerDelayMs?: number; coreTimeoutMs?: number } = {}) => {
  const app = express();
  app.use(
    createLlmRouter({
      secret: "s3cret",
      coreUrl: "http://core",
      placer: { placeCall: vi.fn(async () => {}) },
      fetchImpl,
      log: () => {},
      ...extra,
    }),
  );
  app.use(actionsErrorHandler);
  return app;
};

const ask = (app: express.Express, text: string, model = "relay") =>
  request(app)
    .post(PATH)
    .send({
      model,
      messages: [
        { role: "system", content: "RELAY_CALL person_id=p_amit caller_number=+15550001111" },
        { role: "user", content: text },
      ],
    });

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("filler while Core is slow", () => {
  it("speaks the filler first, then the answer, and ends the stream once", async () => {
    const app = build(slowCore(120, [{ type: "say", text: "Shelter C is closest." }]), { fillerDelayMs: 20 });
    const res = await ask(app, "Where is the nearest shelter?");
    expect(res.text).toContain(FILLER_SPEECH);
    expect(res.text).toContain("Shelter C is closest.");
    expect(res.text.indexOf(FILLER_SPEECH)).toBeLessThan(res.text.indexOf("Shelter C is closest."));
    expect(count(res.text, "data: [DONE]")).toBe(1);
    expect(count(res.text, '"role":"assistant"')).toBe(1);
  });

  it("adds no filler when Core answers quickly", async () => {
    const app = build(slowCore(5, [{ type: "say", text: "Quick answer." }]), { fillerDelayMs: 300 });
    const res = await ask(app, "Where is the nearest shelter?");
    expect(res.text).not.toContain(FILLER_SPEECH);
    expect(res.text).toContain("Quick answer.");
    expect(count(res.text, "data: [DONE]")).toBe(1);
  });

  it("never adds a filler on the radio", async () => {
    const app = build(slowCore(120, [{ type: "say", text: "Route is clear." }]), { fillerDelayMs: 20 });
    const res = await ask(app, "Relay, route to Pine", RADIO_MODEL);
    expect(res.text).not.toContain(FILLER_SPEECH);
    expect(res.text).toContain("Route is clear.");
  });

  it("does not add a filler for silence markers, which never reach Core", async () => {
    const fetchImpl = slowCore(120, []);
    const res = await ask(build(fetchImpl, { fillerDelayMs: 20 }), "...");
    expect(res.text).not.toContain(FILLER_SPEECH);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("gives up on a Core that is too slow and still ends the stream with the fallback line", async () => {
    const app = build(slowCore(2000, [{ type: "say", text: "Too late." }]), { fillerDelayMs: 20, coreTimeoutMs: 80 });
    const res = await ask(app, "Where is the nearest shelter?");
    expect(res.text).toContain(FILLER_SPEECH);
    expect(res.text).toContain(FALLBACK_SPEECH);
    expect(res.text).not.toContain("Too late.");
    expect(count(res.text, "data: [DONE]")).toBe(1);
  });
});
