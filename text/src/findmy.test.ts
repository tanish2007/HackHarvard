/**
 * Tests for remembering Find My locations from a live feed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { FindMyTracker, type LocationSource, type LocationUpdate } from "./findmy.js";

const AMIT = "+14134727634";
const POINT = { lat: 37.851, lng: -122.224 };

/** A fake feed you can push updates into and end on demand. */
function fakeSource(options: { get?: (address: string) => Promise<LocationUpdate | null> } = {}) {
  const queue: LocationUpdate[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  let closed = false;
  const gets: string[] = [];

  const source: LocationSource = {
    async *watch() {
      while (!ended) {
        const next = queue.shift();
        if (next) yield next;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    },
    async get(address) {
      gets.push(address);
      return options.get ? options.get(address) : null;
    },
    close() {
      closed = true;
      ended = true;
      wake?.();
    },
  };
  return {
    source,
    gets,
    isClosed: () => closed,
    push(update: LocationUpdate) {
      queue.push(update);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
  };
}

/** Let the background loop run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A tracker over one fake feed. */
function trackerFor(fake: ReturnType<typeof fakeSource>, extra: { now?: () => number; staleMs?: number } = {}) {
  const tracker = new FindMyTracker({ open: async () => fake.source, log: () => {}, retryMs: 5, ...extra });
  tracker.start();
  return tracker;
}

test("a location from the feed is remembered and found by phone number", async () => {
  const fake = fakeSource();
  const tracker = trackerFor(fake);
  fake.push({ address: AMIT, latitude: POINT.lat, longitude: POINT.lng });
  await tick();
  assert.deepEqual(await tracker.latest(AMIT), POINT);
  assert.deepEqual(fake.gets, [], "no direct request needed when the feed already has it");
  await tracker.stop();
});

test("the address is matched however it is written", async () => {
  const fake = fakeSource();
  const tracker = trackerFor(fake);
  fake.push({ address: "(413) 472-7634", latitude: POINT.lat, longitude: POINT.lng });
  fake.push({ address: "Sam@Example.com", latitude: 40.7, longitude: -74.0 });
  await tick();
  assert.deepEqual(await tracker.latest("+14134727634"), POINT);
  assert.deepEqual(await tracker.latest("sam@example.com"), { lat: 40.7, lng: -74.0 });
  await tracker.stop();
});

test("the newest update wins", async () => {
  const fake = fakeSource();
  const tracker = trackerFor(fake);
  fake.push({ address: AMIT, latitude: 1, longitude: 2 });
  fake.push({ address: AMIT, latitude: POINT.lat, longitude: POINT.lng });
  await tick();
  assert.deepEqual(await tracker.latest(AMIT), POINT);
  await tracker.stop();
});

test("updates still locating, or out of range, are ignored", async () => {
  const fake = fakeSource();
  const tracker = trackerFor(fake);
  fake.push({ address: AMIT });
  fake.push({ address: AMIT, latitude: 123, longitude: 5 });
  await tick();
  assert.equal(await tracker.latest(AMIT), null);
  await tracker.stop();
});

test("a stale location is looked up again", async () => {
  let clock = 0;
  const fake = fakeSource({ get: async () => ({ address: AMIT, latitude: 2, longitude: 3 }) });
  const tracker = trackerFor(fake, { now: () => clock, staleMs: 1000 });
  fake.push({ address: AMIT, latitude: POINT.lat, longitude: POINT.lng });
  await tick();
  clock = 5000;
  assert.deepEqual(await tracker.latest(AMIT), { lat: 2, lng: 3 });
  assert.equal(fake.gets.length, 1);
  await tracker.stop();
});

test("someone never seen is asked for directly", async () => {
  const fake = fakeSource({ get: async () => ({ address: AMIT, latitude: POINT.lat, longitude: POINT.lng }) });
  const tracker = trackerFor(fake);
  await tick();
  assert.deepEqual(await tracker.latest(AMIT), POINT);
  assert.deepEqual(fake.gets, [AMIT]);
  await tracker.stop();
});

test("someone who is not sharing gives null", async () => {
  const fake = fakeSource({ get: async () => null });
  const tracker = trackerFor(fake);
  await tick();
  assert.equal(await tracker.latest(AMIT), null);
  await tracker.stop();
});

test("a lookup that fails or is too slow gives the old location, or null, and never throws", async () => {
  const fake = fakeSource({ get: () => new Promise(() => {}) });
  let clock = 0;
  const tracker = trackerFor(fake, { now: () => clock, staleMs: 1000 });
  await tick();
  assert.equal(await tracker.latest(AMIT, 30), null);

  fake.push({ address: AMIT, latitude: POINT.lat, longitude: POINT.lng });
  await tick();
  clock = 5000;
  assert.deepEqual(await tracker.latest(AMIT, 30), POINT, "falls back to what it remembered");
  await tracker.stop();
});

test("before the feed connects, the answer is null and nothing is requested", async () => {
  const tracker = new FindMyTracker({ open: async () => fakeSource().source, log: () => {} });
  assert.equal(await tracker.latest(AMIT), null);
});

test("when the feed drops it reconnects", async () => {
  let opened = 0;
  const feeds: ReturnType<typeof fakeSource>[] = [];
  const tracker = new FindMyTracker({
    open: async () => {
      opened += 1;
      const fake = fakeSource();
      feeds.push(fake);
      return fake.source;
    },
    log: () => {},
    retryMs: 5,
  });
  tracker.start();
  await tick();
  feeds[0]!.end();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(opened >= 2, true);
  feeds.at(-1)!.push({ address: AMIT, latitude: POINT.lat, longitude: POINT.lng });
  await tick();
  assert.deepEqual(await tracker.latest(AMIT), POINT);
  await tracker.stop();
});

test("a failure to connect is retried, not thrown", async () => {
  let tries = 0;
  const fake = fakeSource();
  const tracker = new FindMyTracker({
    open: async () => {
      tries += 1;
      if (tries < 3) throw new Error("no network");
      return fake.source;
    },
    log: () => {},
    retryMs: 5,
  });
  tracker.start();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(tries, 3);
  await tracker.stop();
  assert.equal(fake.isClosed(), true);
});
