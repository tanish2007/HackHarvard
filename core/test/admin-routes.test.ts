/**
 * Tests for the confirm button route and the demo admin routes, over HTTP.
 *
 * POST /escalations/:person_id/confirm is the only way the emergency contact
 * gets a call. POST /admin/reset must make two demo runs in a row identical.
 */
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHazardWatcher } from "../src/alerts/watcher.js";
import { createCoreRouter } from "../src/app.js";
import { createStubData } from "../src/data/stub.js";
import { createEscalationEngine } from "../src/escalation/engine.js";
import { fakeScheduler, makeEvent, makeStore, recordingDispatcher } from "./helpers.js";

/**
 * Mount Core with the escalation engine and the watcher.
 *
 * Args:
 *     options ({ adminToken?: string, bare?: boolean }): An admin token, or
 *         bare to leave out the engine and watcher.
 *
 * Returns:
 *     The app, store, and recorded pushes.
 */
function fullApp(options: { adminToken?: string; bare?: boolean } = {}) {
  const { store } = makeStore();
  const { dispatcher, pushed } = recordingDispatcher();
  const { scheduler } = fakeScheduler();
  const escalation = createEscalationEngine({ store, dispatcher, scheduler, log: () => {} });
  const watcher = createHazardWatcher({ store, data: createStubData(store.scenario), dispatcher, checkins: escalation, scheduler, log: () => {} });
  const app = express();
  app.use(
    createCoreRouter(
      options.bare
        ? { scenario: store.scenario, store }
        : { scenario: store.scenario, store, dispatcher, escalation, watcher, adminToken: options.adminToken },
    ),
  );
  return { app, store, pushed };
}

describe("POST /escalations/:person_id/confirm", () => {
  it("places the call for a person in SOS and answers without any phone number", async () => {
    const { app, store, pushed } = fullApp();
    store.setStatus("p_amit", "sos");
    const res = await request(app).post("/escalations/p_amit/confirm").send({ confirmed_by: "Rudra" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, person_id: "p_amit", delivered: true });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(pushed).toEqual([expect.objectContaining({ type: "place_call", reason: "human_confirmed" })]);
  });

  it("answers 409 twice in a row and for someone not in SOS, and 404 for nobody", async () => {
    const { app, store } = fullApp();
    expect((await request(app).post("/escalations/p_amit/confirm")).status).toBe(409);
    store.setStatus("p_amit", "sos");
    await request(app).post("/escalations/p_amit/confirm");
    expect((await request(app).post("/escalations/p_amit/confirm")).body).toEqual({ error: "already_confirmed" });
    expect((await request(app).post("/escalations/p_ghost/confirm")).status).toBe(404);
  });

  it("rejects a confirmed_by that holds a phone number", async () => {
    const { app, store, pushed } = fullApp();
    store.setStatus("p_amit", "sos");
    const res = await request(app).post("/escalations/p_amit/confirm").send({ confirmed_by: "call me 617 555 0150" });
    expect(res.status).toBe(400);
    expect(pushed).toEqual([]);
  });

  it("answers 503 when escalation is off", async () => {
    expect((await request(fullApp({ bare: true }).app).post("/escalations/p_amit/confirm")).status).toBe(503);
  });

  it("answers the CORS preflight", async () => {
    const res = await request(fullApp().app).options("/escalations/p_amit/confirm");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
  });
});

describe("/admin", () => {
  it("POST /admin/alert runs the watcher and returns its summary", async () => {
    const res = await request(fullApp().app).post("/admin/alert");
    expect(res.body).toEqual({ alerted: 2, person_ids: ["p_amit", "p_priya"], hazards: 1 });
  });

  it("POST /admin/alert answers 503 without a watcher", async () => {
    expect((await request(fullApp({ bare: true }).app).post("/admin/alert")).status).toBe(503);
  });

  it("POST /admin/reset makes a second demo run match the first", async () => {
    const { app } = fullApp();
    const run = async () => {
      await request(app).post("/admin/alert");
      await request(app).post("/event").send(makeEvent({ text: "SOS" }));
      const body = (await request(app).get("/state")).body;
      return { counts: body.counts, people: body.people, texts: body.timeline.map((t: { text: string }) => t.text) };
    };
    const first = await run();
    expect((await request(app).post("/admin/reset")).body).toEqual({ ok: true });
    expect(await run()).toEqual(first);
  });

  it("needs the token when one is set", async () => {
    const { app } = fullApp({ adminToken: "demo-token" });
    expect((await request(app).post("/admin/reset")).status).toBe(403);
    expect((await request(app).post("/admin/reset").set("x-relay-admin", "wrong")).status).toBe(403);
    expect((await request(app).post("/admin/reset").set("x-relay-admin", "demo-token")).status).toBe(200);
  });

  it("is open when no token is set", async () => {
    expect((await request(fullApp().app).post("/admin/reset")).status).toBe(200);
  });
});
