/**
 * Edge cases for Core's router and error handling.
 *
 * GET /state is polled every two seconds, so it must always reflect the live
 * store. Errors must come back as clean JSON and never take the server down.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoreRouter } from "../src/app.js";
import { asyncHandler, jsonErrorHandler } from "../src/lib/asyncHandler.js";
import { makeStore } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Mount Core on a fresh app with a store and clock the test controls.
 *
 * Returns:
 *     { app: express.Express, store: IncidentStore, advance: (sec: number) => void }:
 *         The app, its store, and a function that moves the clock forward.
 */
function coreApp() {
  const { store, advance } = makeStore();
  const app = express();
  app.use(createCoreRouter({ scenario: store.scenario, store }));
  return { app, store, advance };
}

describe("GET /state", () => {
  it("returns JSON equal to the store's snapshot", async () => {
    const { app, store } = coreApp();
    const res = await request(app).get("/state");
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual(store.snapshot());
  });

  it("shows changes on the next poll", async () => {
    const { app, store, advance } = coreApp();
    await request(app).get("/state");
    advance(2);
    store.addTimeline({ channel: "radio", who: "Unit 4", text: "Relay, wind forecast?" });
    const res = await request(app).get("/state");
    expect(res.body.timeline).toHaveLength(1);
    expect(res.body.incident.updated_at).toBe("2026-10-17T14:00:02.000Z");
  });

  it("keeps every list present over HTTP", async () => {
    const res = await request(coreApp().app).get("/state");
    for (const key of ["hazards", "shelters", "people", "volunteers", "reports", "units", "timeline"]) {
      expect(Array.isArray(res.body[key])).toBe(true);
    }
    expect(res.body.counts).toEqual({ safe: 45, unconfirmed: 5, sos: 0, en_route: 0 });
  });
});

describe("Core router errors", () => {
  it("answers malformed JSON with a 400 using only Core's own error handler", async () => {
    const res = await request(coreApp().app).post("/event").set("content-type", "application/json").send("{bad");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_json" });
  });

  it("leaves unknown routes to fall through as 404", async () => {
    expect((await request(coreApp().app).get("/nope")).status).toBe(404);
  });

  it("does not parse bodies on GET /state", async () => {
    const res = await request(coreApp().app).get("/state").set("content-type", "application/json").send("{bad");
    expect(res.status).toBe(200);
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
    const { app } = coreApp();
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

describe("asyncHandler", () => {
  it("turns a thrown non-Error value into a 500 too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = express();
    app.get("/boom", asyncHandler(async () => {
      throw "plain string";
    }));
    app.use(jsonErrorHandler);
    const res = await request(app).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal_error" });
  });

  it("catches a rejection that happens after an await", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = express();
    app.get("/slow", asyncHandler(async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error("timed out");
    }));
    app.use(jsonErrorHandler);
    expect((await request(app).get("/slow")).status).toBe(500);
  });

  it("logs the method and path of the failed request", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = express();
    app.get("/boom", asyncHandler(async () => {
      throw new Error("upstream API dropped");
    }));
    app.use(jsonErrorHandler);
    await request(app).get("/boom");
    expect(log).toHaveBeenCalledWith("[core] GET /boom failed:", expect.objectContaining({ message: "upstream API dropped" }));
  });

  it("passes req, res, and next through to the handler", async () => {
    const app = express();
    app.get("/echo/:id", asyncHandler(async (req, res, next) => {
      res.json({ id: req.params.id, hasNext: typeof next === "function" });
    }));
    expect((await request(app).get("/echo/p_amit")).body).toEqual({ id: "p_amit", hasNext: true });
  });
});

describe("jsonErrorHandler", () => {
  it("hands off to Express when the response has already started", () => {
    const err = new Error("late failure");
    const res = { headersSent: true, status: vi.fn(), json: vi.fn() };
    const next = vi.fn();
    jsonErrorHandler(err, {} as Request, res as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });
});
