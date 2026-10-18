/** Tests for the radio start route. */
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actionsErrorHandler } from "../src/errors.js";
import { createRadioRouter } from "../src/radioRouter.js";

const build = (startCall = vi.fn(async () => "conv_1" as string | null)) => {
  const app = express();
  app.use(createRadioRouter({ startCall }));
  app.use(actionsErrorHandler);
  return { app, startCall };
};

describe("POST /radio/start", () => {
  it("starts the call and returns the conversation id", async () => {
    const { app, startCall } = build();
    const res = await request(app).post("/radio/start");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversation_id: "conv_1" });
    expect(startCall).toHaveBeenCalledOnce();
  });

  it("refuses a request that came through the tunnel", async () => {
    const { app, startCall } = build();
    const res = await request(app).post("/radio/start").set("cf-connecting-ip", "203.0.113.9");
    expect(res.status).toBe(403);
    expect(startCall).not.toHaveBeenCalled();
  });

  it("answers 500 when the call cannot be started", async () => {
    const { app } = build(
      vi.fn(async () => {
        throw new Error("elevenlabs down");
      }),
    );
    const res = await request(app).post("/radio/start");
    expect(res.status).toBe(500);
  });
});
