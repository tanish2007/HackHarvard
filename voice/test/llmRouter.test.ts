/** Tests for the custom LLM endpoint ElevenLabs calls. */
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actionsErrorHandler } from "../src/errors.js";
import { createLlmRouter, FALLBACK_SPEECH, RADIO_MODEL } from "../src/llmRouter.js";

const PATH = "/llm/s3cret/v1/chat/completions";
const SKIP_TOOL = { type: "function", function: { name: "skip_turn" } };

const build = (core: unknown = { actions: [] }, coreStatus = 200) => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(core), { status: coreStatus }));
  const placeCall = vi.fn(async () => {});
  const app = express();
  app.use(
    createLlmRouter({
      secret: "s3cret",
      coreUrl: "http://core",
      placer: { placeCall },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
    }),
  );
  app.use(actionsErrorHandler);
  return { app, fetchImpl, placeCall };
};

const body = (text: string, extra: Record<string, unknown> = {}) => ({
  model: "relay",
  messages: [
    { role: "system", content: "RELAY_CALL person_id=p_amit caller_number=+15550001111" },
    { role: "user", content: text },
  ],
  stream: true,
  ...extra,
});

const sentEvent = (f: ReturnType<typeof vi.fn>) =>
  JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);

describe("custom LLM endpoint", () => {
  it("404s a wrong secret and never reaches Core", async () => {
    const { app, fetchImpl } = build();
    const res = await request(app).post("/llm/wrong/v1/chat/completions").send(body("hi"));
    expect(res.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends a check-in answer to Core with the call's person and number", async () => {
    const { app, fetchImpl } = build({ actions: [{ type: "say", text: "Glad you are safe." }] });
    const res = await request(app).post(PATH).send(body("I am okay"));
    expect(sentEvent(fetchImpl)).toMatchObject({
      channel: "voice",
      person_id: "p_amit",
      from: "+15550001111",
      text: "I am okay",
    });
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain("Glad you are safe.");
    expect(res.text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("uses the radio channel for the radio model", async () => {
    const { app, fetchImpl } = build();
    await request(app).post(PATH).send(body("Relay, route to Pine", { model: RADIO_MODEL }));
    expect(sentEvent(fetchImpl).channel).toBe("radio");
  });

  it("stays silent on radio chatter by calling skip_turn", async () => {
    const { app } = build({ actions: [] });
    const res = await request(app).post(PATH).send(body("copy that", { model: RADIO_MODEL, tools: [SKIP_TOOL] }));
    expect(res.text).toContain("skip_turn");
    expect(res.text).not.toContain(FALLBACK_SPEECH);
  });

  it("sends an empty reply on radio when the agent has no skip_turn tool", async () => {
    const { app } = build({ actions: [] });
    const res = await request(app).post(PATH).send(body("copy that", { model: RADIO_MODEL }));
    expect(res.text).not.toContain("skip_turn");
    expect(res.text).toContain('"content":""');
  });

  it("gives a phone caller a fallback line when Core is down", async () => {
    const { app } = build({}, 500);
    const res = await request(app).post(PATH).send(body("hello"));
    expect(res.text).toContain(FALLBACK_SPEECH);
  });

  it("forwards an unknown caller with a null person_id", async () => {
    const { app, fetchImpl } = build();
    await request(app)
      .post(PATH)
      .send({ model: "relay", messages: [{ role: "system", content: "no context" }, { role: "user", content: "help" }] });
    expect(sentEvent(fetchImpl).person_id).toBeNull();
  });

  it("does not call Core when nothing was said", async () => {
    const { app, fetchImpl } = build();
    await request(app).post(PATH).send({ model: "relay", messages: [{ role: "system", content: "x" }] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
