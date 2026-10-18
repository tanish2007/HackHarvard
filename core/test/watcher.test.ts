/**
 * Tests for the hazard watcher, which puts hazards on the map and texts
 * residents near a fire, then starts their check-in chain.
 */
import { describe, expect, it } from "vitest";
import { createHazardWatcher } from "../src/alerts/watcher.js";
import type { SendTextAction } from "../src/contracts.js";
import { createStubData } from "../src/data/stub.js";
import type { DataTools } from "../src/data/types.js";
import { fakeScheduler, flush, makeStore, PHONES, recordingDispatcher } from "./helpers.js";

/**
 * A watcher on the committed scenario with the stub data.
 *
 * Args:
 *     data (Partial<DataTools>): Data functions to replace.
 *
 * Returns:
 *     The store, watcher, recorded pushes, started check-ins, and the fake scheduler.
 */
function setup(data: Partial<DataTools> = {}) {
  const { store } = makeStore();
  const { dispatcher, pushed } = recordingDispatcher();
  const started: string[] = [];
  const sched = fakeScheduler();
  const watcher = createHazardWatcher({
    store,
    data: { ...createStubData(store.scenario), ...data },
    dispatcher,
    checkins: { start: (id) => (started.push(id), true) },
    scheduler: sched.scheduler,
    log: () => {},
  });
  return { store, watcher, pushed, started, sched };
}

describe("runOnce", () => {
  it("texts reachable residents near the fire and starts their check-ins", async () => {
    const { watcher, pushed, started } = setup();
    expect(await watcher.runOnce()).toEqual({ alerted: 2, person_ids: ["p_amit", "p_priya"], hazards: 1 });
    expect(pushed.map((a) => (a as SendTextAction).to)).toEqual([PHONES.amit, PHONES.priya]);
    expect((pushed[0] as SendTextAction).text).toMatch(/Shelter/);
    expect(started).toEqual(["p_amit", "p_priya"]);
  });

  it("skips volunteers, simulated people, and people far from the fire", async () => {
    const { store, watcher } = setup();
    store.recordContact("p_priya", { lat: 38.6, lng: -122.2 });
    const { person_ids } = await watcher.runOnce();
    expect(person_ids).toEqual(["p_amit"]);
  });

  it("alerts each person once per fire, even if runs overlap, until reset", async () => {
    const { watcher, pushed } = setup();
    const [a, b] = await Promise.all([watcher.runOnce(), watcher.runOnce()]);
    expect(a.alerted + b.alerted).toBe(2);
    expect((await watcher.runOnce()).alerted).toBe(0);
    watcher.reset();
    expect((await watcher.runOnce()).alerted).toBe(2);
    expect(pushed).toHaveLength(4);
  });

  it("puts the hazards on /state", async () => {
    const { store, watcher } = setup();
    await watcher.runOnce();
    expect(store.snapshot().hazards).toEqual([expect.objectContaining({ id: "hz_scenario_fire", source: "fake" })]);
  });

  it("keeps the last hazards and never throws when get_hazards fails", async () => {
    const { store, watcher } = setup({
      async getHazards() {
        throw new Error("FIRMS down");
      },
    });
    const before = store.snapshot().hazards;
    expect(await watcher.runOnce()).toEqual({ alerted: 0, person_ids: [], hazards: 1 });
    expect(store.snapshot().hazards).toEqual(before);
  });

  it("still sends the alert when the shelter lookup fails", async () => {
    const { watcher } = setup({
      async getShelters() {
        throw new Error("down");
      },
    });
    expect((await watcher.runOnce()).alerted).toBe(2);
  });
});

describe("polling", () => {
  it("runs now, then every hazard_poll_sec, until stopped", async () => {
    let runs = 0;
    const { store, watcher, sched } = setup({
      async getHazards() {
        runs++;
        return [];
      },
    });
    watcher.start();
    await flush();
    expect(runs).toBe(1);
    await sched.advance(store.scenario.settings.hazard_poll_sec);
    expect(runs).toBe(2);
    watcher.stop();
    await sched.advance(600);
    expect(runs).toBe(2);
  });
});
