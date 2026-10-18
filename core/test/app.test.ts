/**
 * Tests for Core's router and the async error handling it relies on.
 */
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createCoreRouter } from "../src/app.js";
import { asyncHandler, jsonErrorHandler } from "../src/lib/asyncHandler.js";
import { loadScenario } from "../src/scenario/load.js";
import { IncidentStore } from "../src/state/store.js";

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * Build an app with Core mounted on the committed scenario.
 *
 * Returns:
 *     express.Express: The test app.
 */
function coreApp(): express.Express {
  const app = express();
  const scenario = loadScenario({ dir: ROOT, useLocal: false });
  app.use(createCoreRouter({ scenario, store: new IncidentStore(scenario) }));
  return app;
}

describe("GET /state", () => {
  it("serves Contract D, open to other origins and never cached", async () => {
    const res = await request(coreApp()).get("/state");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.incident.name).toBe("Oak Ridge Fire");
    expect(Array.isArray(res.body.people)).toBe(true);
  });
});

describe("GET /health", () => {
  it("returns ok and the incident name", async () => {
    const res = await request(coreApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", incident: "Oak Ridge Fire" });
  });
});

describe("asyncHandler", () => {
  it("turns an async error into a 500 and keeps serving", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = express();
    app.get("/boom", asyncHandler(async () => {
      throw new Error("upstream API dropped");
    }));
    app.get("/fine", asyncHandler(async (_req, res) => {
      res.json({ ok: true });
    }));
    app.use(jsonErrorHandler);

    const boom = await request(app).get("/boom");
    expect(boom.status).toBe(500);
    expect(boom.body).toEqual({ error: "internal_error" });

    const fine = await request(app).get("/fine");
    expect(fine.status).toBe(200);
  });

  it("answers malformed JSON with a 400", async () => {
    const app = express();
    app.use(express.json());
    app.post("/echo", (req, res) => {
      res.json(req.body);
    });
    app.use(jsonErrorHandler);

    const res = await request(app).post("/echo").set("content-type", "application/json").send("{bad");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_json" });
  });
});
