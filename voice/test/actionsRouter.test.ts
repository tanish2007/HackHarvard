/** Tests for the POST /actions endpoint Core pushes to. */
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createActionsRouter } from "../src/actionsRouter.js";
import { actionsErrorHandler } from "../src/errors.js";

const build = (placeCall = vi.fn(async () => {})) => {
  const log = vi.fn();
  const app = express();
  app.use(createActionsRouter({ placer: { placeCall }, log }));
  app.use(actionsErrorHandler);
  return { app, placeCall, log };
};

describe("POST /actions", () => {
  it("places the call Core asks for and answers 200", async () => {
    const { app, placeCall } = build();
    const res = await request(app)
      .post("/actions")
      .send({
        actions: [
          { type: "place_call", person_id: "p_amit", to: "+15550001111", script: "Are you okay?", reason: "missed_checkin" },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, received: 1 });
    expect(placeCall).toHaveBeenCalledWith("p_amit", "Are you okay?", "missed_checkin", "+15550001111");
  });

  it("answers 200 and skips send_text meant for the text lane", async () => {
    const { app, placeCall, log } = build();
    const res = await request(app)
      .post("/actions")
      .send({ actions: [{ type: "send_text", person_id: "p", to: null, text: "x", map_url: null }] });
    expect(res.status).toBe(200);
    expect(placeCall).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it("answers 502 when a call fails, so Core never reports a false delivery", async () => {
    const { app } = build(vi.fn(async () => { throw new Error("elevenlabs down"); }));
    const res = await request(app)
      .post("/actions")
      .send({ actions: [{ type: "place_call", person_id: "p", to: "+15550001111", script: "s", reason: "r" }] });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, received: 1, failed: 1 });
  });

  it("treats a body with no actions as an empty batch", async () => {
    const { app } = build();
    const res = await request(app).post("/actions").send({});
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(0);
  });

  it("answers 400 for malformed JSON", async () => {
    const { app } = build();
    const res = await request(app).post("/actions").set("content-type", "application/json").send("{nope");
    expect(res.status).toBe(400);
  });

  it.each(["cf-connecting-ip", "x-forwarded-for", "cf-ray"])("refuses a request that came through the tunnel (%s)", async (header) => {
    const { app, placeCall } = build();
    const res = await request(app)
      .post("/actions")
      .set(header, "203.0.113.9")
      .send({ actions: [{ type: "place_call", person_id: "p", to: "+15550001111", script: "s", reason: "r" }] });
    expect(res.status).toBe(403);
    expect(placeCall).not.toHaveBeenCalled();
  });

  it("serves a health check", async () => {
    const { app } = build();
    expect((await request(app).get("/health")).body).toEqual({ status: "ok", lane: "voice" });
  });
});
