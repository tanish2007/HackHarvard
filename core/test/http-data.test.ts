import { describe, expect, it } from "vitest";
import { createHttpData } from "../src/data/http.js";
import type { DataRoute, DataShelter, DataTools, DataWeather } from "../src/data/types.js";

const REAL_SHELTER: DataShelter = {
  id: "osm_1",
  name: "Newton Community Center",
  lat: 42.3,
  lng: -71.2,
  distance_km: 1.2,
  capacity_note: "",
  source: "overpass",
};
const FAKE_SHELTER: DataShelter = { ...REAL_SHELTER, id: "sh_c", name: "Shelter C", source: "fake" };
const ROUTE: DataRoute = { distance_km: 3, duration_min: 5, steps: ["Go"], polyline: [{ lat: 1, lng: 2 }], avoided_hazards: [], source: "osrm" };
const WEATHER: DataWeather = { summary: "Clear", wind_mph: 5, wind_dir: "N", temp_f: 60, next_2h: "same", source: "nws" };

/** A fallback that answers from fixed fake data. */
const stub: DataTools = {
  getHazards: async () => [],
  getRoute: async () => ({ ...ROUTE, source: "fake" }),
  getShelters: async () => [FAKE_SHELTER],
  getWeather: async () => ({ ...WEATHER, source: "fake" }),
};

/** A fetch that answers with a fixed status and JSON body, recording the URLs asked. */
function server(status: number, body: unknown, seen: string[] = []): typeof fetch {
  return (async (url: string) => {
    seen.push(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

/** Build the client over a fake fetch. */
function client(fetchImpl: typeof fetch) {
  return createHttpData({ baseUrl: "http://data:8080/", fallback: stub, fetchImpl, log: () => {} });
}

describe("createHttpData", () => {
  it("asks the shelters endpoint with the person's coordinates and returns the real rows", async () => {
    const seen: string[] = [];
    const rows = await client(server(200, [REAL_SHELTER], seen)).getShelters(42.294, -71.191);
    expect(rows).toEqual([REAL_SHELTER]);
    expect(seen).toEqual(["http://data:8080/shelters?lat=42.294&lng=-71.191"]);
  });

  it("asks for a route, hazards and weather with the contract's parameter names", async () => {
    const seen: string[] = [];
    const data = client(server(200, ROUTE, seen));
    await data.getRoute(1, 2, 3, 4);
    expect(seen[0]).toBe("http://data:8080/route?from_lat=1&from_lng=2&to_lat=3&to_lng=4");

    const hazards = client(server(200, [], seen));
    expect(await hazards.getHazards(1, 2, 25)).toEqual([]);
    expect(seen[1]).toBe("http://data:8080/hazards?lat=1&lng=2&radius_km=25");

    const weather = client(server(200, WEATHER, seen));
    expect(await weather.getWeather(1, 2)).toEqual(WEATHER);
    expect(seen[2]).toBe("http://data:8080/weather?lat=1&lng=2");
  });

  it("falls back to the scenario, marked as a fallback, when the server errors", async () => {
    const rows = await client(server(500, { error: "boom" })).getShelters(1, 2);
    expect(rows).toEqual([{ ...FAKE_SHELTER, source: "fallback" }]);
  });

  it("falls back when the request fails or times out, and never rejects", async () => {
    const down = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const data = client(down);
    expect((await data.getShelters(1, 2))[0]!.source).toBe("fallback");
    expect((await data.getRoute(1, 2, 3, 4)).source).toBe("fallback");
    expect((await data.getWeather(1, 2)).source).toBe("fallback");
    expect(await data.getHazards(1, 2, 3)).toEqual([]);
  });

  it("falls back when the server's answer is not the shape Core expects", async () => {
    expect((await client(server(200, { nope: true })).getShelters(1, 2))[0]!.source).toBe("fallback");
    expect((await client(server(200, "text")).getRoute(1, 2, 3, 4)).source).toBe("fallback");
    expect((await client(server(200, [{ name: "x" }])).getShelters(1, 2))[0]!.source).toBe("fallback");
  });

  it("treats an empty shelter list as no answer, since there is always somewhere to go", async () => {
    expect((await client(server(200, [])).getShelters(1, 2))[0]!.source).toBe("fallback");
  });

  it("times out a slow server instead of waiting for it", async () => {
    const slow = ((_: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const data = createHttpData({ baseUrl: "http://data", fallback: stub, fetchImpl: slow, timeoutMs: 20, log: () => {} });
    expect((await data.getShelters(1, 2))[0]!.source).toBe("fallback");
  });

  it("logs why it fell back", async () => {
    const logs: string[] = [];
    const data = createHttpData({ baseUrl: "http://data", fallback: stub, fetchImpl: server(503, {}), log: (m) => logs.push(m) });
    await data.getShelters(1, 2);
    expect(logs[0]).toMatch(/\/shelters failed.*status 503/);
  });
});
