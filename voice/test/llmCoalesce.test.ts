/** Tests for sharing one answer between repeats of the same request. */
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actionsErrorHandler } from "../src/errors.js";
import { createLlmRouter, RADIO_MODEL } from "../src/llmRouter.js";

const PATH = "/llm/s3cret/v1/chat/completions";

/** A fake Core that answers after `delayMs` and counts how often it was asked. */
const countingCore = (delayMs: number, text: string) =>
  vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response(JSON.stringify({ actions: [{ type: "say", text }] }), { status: 200 })), delayMs);
      }),
  ) as unknown as typeof fetch;

const build = (fetchImpl: typeof fetch, duplicateWindowMs = 5000) => {
  const app = express();
  app.use(
    createLlmRouter({
      secret: "s3cret",
      coreUrl: "http://core",
      placer: { placeCall: vi.fn(async () => {}) },
      fetchImpl,
      fillerDelayMs: 10_000,
      duplicateWindowMs,
      log: () => {},
    }),
  );
  app.use(actionsErrorHandler);
  return app;
};

const ask = (app: express.Express, text: string, model = RADIO_MODEL) =>
  request(app)
    .post(PATH)
    .send({
      model,
      messages: [
        { role: "system", content: "RELAY_CALL person_id=none caller_number=+15550002222" },
        { role: "user", content: text },
      ],
    });

describe("repeated requests", () => {
  it("asks Core once when the same request arrives three times at once, and answers all three", async () => {
    const core = countingCore(60, "Shelter B is closest.");
    const app = build(core);
    const results = await Promise.all([
      ask(app, "Relay, where is the nearest shelter?"),
      ask(app, "Relay, where is the nearest shelter?"),
      ask(app, "Relay, where is the nearest shelter?"),
    ]);
    expect(core).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r.text).toContain("Shelter B is closest.");
  });

  it("shares the answer with a repeat that arrives just after the first one finished", async () => {
    const core = countingCore(5, "Shelter B is closest.");
    const app = build(core);
    await ask(app, "Relay, where is the nearest shelter?");
    const repeat = await ask(app, "Relay, where is the nearest shelter?");
    expect(core).toHaveBeenCalledTimes(1);
    expect(repeat.text).toContain("Shelter B is closest.");
  });

  it("asks Core separately for different questions", async () => {
    const core = countingCore(20, "An answer.");
    const app = build(core);
    await Promise.all([ask(app, "Relay, where is the nearest shelter?"), ask(app, "Relay, is it safe to drive north?")]);
    expect(core).toHaveBeenCalledTimes(2);
  });

  it("asks Core again once the window has passed", async () => {
    const core = countingCore(5, "An answer.");
    const app = build(core, 30);
    await ask(app, "Relay, where is the nearest shelter?");
    await new Promise((r) => setTimeout(r, 80));
    await ask(app, "Relay, where is the nearest shelter?");
    expect(core).toHaveBeenCalledTimes(2);
  });

  it("does not mix up the same words from different callers", async () => {
    const core = countingCore(20, "An answer.");
    const app = build(core);
    const other = (text: string) =>
      request(app)
        .post(PATH)
        .send({
          model: RADIO_MODEL,
          messages: [
            { role: "system", content: "RELAY_CALL person_id=none caller_number=+15559990000" },
            { role: "user", content: text },
          ],
        });
    await Promise.all([ask(app, "Relay, status?"), other("Relay, status?")]);
    expect(core).toHaveBeenCalledTimes(2);
  });
});
