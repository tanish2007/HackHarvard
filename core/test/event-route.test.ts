/**
 * Tests for POST /event over HTTP.
 *
 * Channels rely on two promises: a malformed event is a 400 with issues, and
 * everything else is a 200 with an actions list, even when the agent fails.
 */
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/event/handle.js";
import { coreApp, makeEvent, PHONES } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /event", () => {
  it("answers a valid event with 200 and an actions list", async () => {
    const res = await request(coreApp().app).post("/event").send(makeEvent({ text: "I'm safe" }));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(Object.keys(res.body)).toEqual(["actions"]);
    expect(res.body.actions).toEqual([expect.objectContaining({ type: "send_text", person_id: "p_amit" })]);
  });

  it("answers radio chatter with 200 and an empty list", async () => {
    const res = await request(coreApp().app)
      .post("/event")
      .send(makeEvent({ channel: "radio", from: PHONES.unit4, text: "copy that" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ actions: [] });
  });

  it("updates /state right away", async () => {
    const { app } = coreApp();
    await request(app).post("/event").send(makeEvent({ text: "SOS" }));
    const state = await request(app).get("/state");
    expect(state.body.people[0]).toMatchObject({ person_id: "p_amit", status: "sos" });
    expect(state.body.counts.sos).toBe(1);
  });

  it("replays a duplicate event_id with the same body", async () => {
    const { app, store } = coreApp();
    const event = makeEvent({ text: "SOS" });
    const first = await request(app).post("/event").send(event);
    const length = store.snapshot().timeline.length;
    const second = await request(app).post("/event").send(event);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(store.snapshot().timeline).toHaveLength(length);
  });

  it("answers 200 with the fallback when the agent throws, and keeps serving", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const agent: Agent = async () => {
      throw new Error("Gemini timed out");
    };
    const { app } = coreApp(agent);
    const res = await request(app).post("/event").send(makeEvent({ text: "where is the nearest shelter?" }));
    expect(res.status).toBe(200);
    expect(res.body.actions[0].text).toContain("Reply SAFE");
    expect((await request(app).get("/health")).status).toBe(200);
  });

  it("uses the agent passed to the router", async () => {
    const agent: Agent = async () => [{ type: "say", text: "Wind is 15 mph from the west." }];
    const res = await request(coreApp(agent).app)
      .post("/event")
      .send(makeEvent({ channel: "radio", from: PHONES.unit4, text: "Relay, wind?" }));
    expect(res.body).toEqual({ actions: [{ type: "say", text: "Wind is 15 mph from the west." }] });
  });
});

describe("POST /event: invalid events", () => {
  it("answers 400 with issues that name the field", async () => {
    const { location: _location, ...noLocation } = makeEvent();
    const res = await request(coreApp().app).post("/event").send(noLocation);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_event", issues: [expect.stringMatching(/^location: /)] });
  });

  it("does not touch the store for an invalid event", async () => {
    const { app, store } = coreApp();
    const before = store.snapshot();
    await request(app).post("/event").send(makeEvent({ channel: "fax" as never, text: "SOS" }));
    expect(store.snapshot()).toEqual(before);
  });

  it("answers 400 for an array body", async () => {
    const res = await request(coreApp().app).post("/event").send([makeEvent()]);
    expect(res.status).toBe(400);
    expect(res.body.issues[0]).toMatch(/^body: /);
  });

  it("answers 400 invalid_event when the body is not JSON at all", async () => {
    const res = await request(coreApp().app).post("/event").set("content-type", "text/plain").send("SOS");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_event");
  });

  it("does not remember an invalid event as seen", async () => {
    const { app } = coreApp();
    const event = makeEvent({ text: "SOS" });
    await request(app).post("/event").send({ ...event, timestamp: "now" });
    const res = await request(app).post("/event").send(event);
    expect(res.body.actions.length).toBeGreaterThan(0);
  });

  it("is POST only", async () => {
    expect((await request(coreApp().app).get("/event")).status).toBe(404);
  });
});

describe("POST /event: body parser errors keep their 4xx status", () => {
  it("answers malformed JSON with 400 invalid_json", async () => {
    const res = await request(coreApp().app).post("/event").set("content-type", "application/json").send('{"event_id": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_json" });
  });

  it("answers a body over 1 MB with 413 payload_too_large, without logging an error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(coreApp().app)
      .post("/event")
      .set("content-type", "application/json")
      .send(JSON.stringify({ ...makeEvent(), text: "a".repeat(1_100_000) }));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "payload_too_large" });
    expect(log).not.toHaveBeenCalled();
  });

  it("accepts a body just under 1 MB", async () => {
    const res = await request(coreApp().app)
      .post("/event")
      .send({ ...makeEvent(), text: "a".repeat(1_000_000) });
    expect(res.status).toBe(200);
  });

  it("answers an unsupported charset with 415", async () => {
    const res = await request(coreApp().app)
      .post("/event")
      .set("content-type", "application/json; charset=iso-8859-1")
      .send(JSON.stringify(makeEvent()));
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: "unsupported_charset" });
  });

  it("answers an unsupported content encoding with 415", async () => {
    const res = await request(coreApp().app)
      .post("/event")
      .set("content-type", "application/json")
      .set("content-encoding", "bogus")
      .send(JSON.stringify(makeEvent()));
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: "unsupported_encoding" });
  });
});
