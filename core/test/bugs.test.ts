/**
 * Tests that fail on the current code. Each one pins a bug found in review.
 *
 * Kept in their own file so they can be committed, reviewed, or held back
 * separately. When a fix lands, move the test into the matching file.
 */
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoreRouter } from "../src/app.js";
import { errorMessage, loadEdited, makeStore, type ScenarioJson } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("duplicate ids in scenario.json", () => {
  it("rejects a named person whose id collides with a generated sim_ id", () => {
    const edit = (f: ScenarioJson) => f.people.push({ ...f.people[0], person_id: "sim_001", name: "Collider" });
    expect(errorMessage(() => loadEdited(edit))).toMatch(/Duplicate person_id "sim_001"/);
  });

  const dupes: [string, (f: ScenarioJson) => void, RegExp][] = [
    ["shelter", (f) => f.shelters.push({ ...f.shelters[0], name: "Copy" }), /sh_a/],
    ["zone", (f) => f.zones.push({ ...f.zones[0], name: "Copy" }), /zone_1/],
    ["unit", (f) => f.units.push({ ...f.units[0], name: "Copy" }), /u_4/],
    ["agent", (f) => f.agents.push({ ...f.agents[0] }), /gov_county/],
    ["person and unit sharing one", (f) => (f.units[0].unit_id = "p_amit"), /p_amit/],
  ];

  it.each(dupes)("rejects a duplicate %s id", (_label, edit, id) => {
    expect(errorMessage(() => loadEdited(edit))).toMatch(id);
  });
});

describe("Core's JSON parser stays on Core's routes", () => {
  /**
   * Mount Core, then a route owned by another lane that needs the raw body.
   *
   * Returns:
   *     express.Express: The app.
   */
  function appWithTextRoute(): express.Express {
    const { store } = makeStore();
    const app = express();
    app.use(createCoreRouter({ scenario: store.scenario, store }));
    app.post("/text/webhook", express.raw({ type: "*/*" }), (req, res) => {
      res.json({ raw: Buffer.isBuffer(req.body) });
    });
    return app;
  }

  it("leaves the raw body for a route mounted after Core", async () => {
    const res = await request(appWithTextRoute()).post("/text/webhook").send({ hello: "photon" });
    expect(res.body).toEqual({ raw: true });
  });

  it("does not answer another lane's malformed JSON with Core's 400", async () => {
    const res = await request(appWithTextRoute())
      .post("/text/webhook")
      .set("content-type", "application/json")
      .send("{bad");
    expect(res.status).toBe(200);
  });
});

describe("oversized bodies", () => {
  it("answer 413, not 500, since the caller sent too much", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { store } = makeStore();
    const app = express();
    app.use(createCoreRouter({ scenario: store.scenario, store }));
    const res = await request(app)
      .post("/state")
      .set("content-type", "application/json")
      .send(JSON.stringify({ text: "a".repeat(1_100_000) }));
    expect(res.status).toBe(413);
  });
});
