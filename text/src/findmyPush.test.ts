/**
 * Tests for posting a Find My point to Core without a text.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { RelayEvent } from "./contracts.js";
import { publishFindMyLocation } from "./findmyPush.js";
import { PeopleDirectory } from "./people.js";
import type { RelayDeps } from "./relay.js";

const AMIT = "+14134727634";
const POINT = { lat: 42.37, lng: -72.52 };

function deps(overrides: boolean): { deps: RelayDeps; events: RelayEvent[] } {
  const events: RelayEvent[] = [];
  return {
    events,
    deps: {
      registry: { status: () => "opted_in" } as RelayDeps["registry"],
      directory: new PeopleDirectory([{ person_id: "p_amit", phone: AMIT, location: null }]),
      postEvent: async (event) => {
        events.push(event);
        return { actions: [] };
      },
      findMyOverridesScenario: overrides,
    },
  };
}

test("a known phone is posted once, and again only when the point moves", async () => {
  const { deps: d, events } = deps(true);
  assert.equal(await publishFindMyLocation(d, AMIT, POINT), true);
  assert.equal(await publishFindMyLocation(d, AMIT, POINT), false);
  assert.equal(await publishFindMyLocation(d, AMIT, { lat: 42.38, lng: -72.52 }), true);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.person_id, "p_amit");
  assert.equal(events[0]!.text, "");
  assert.deepEqual(events[0]!.location, POINT);
});

test("scenario people are left alone when the override is off", async () => {
  const { deps: d, events } = deps(false);
  assert.equal(await publishFindMyLocation(d, AMIT, POINT), false);
  assert.equal(events.length, 0);
});

test("a number that is not in the scenario is not posted", async () => {
  const { deps: d, events } = deps(true);
  assert.equal(await publishFindMyLocation(d, "+16175550199", POINT), false);
  assert.equal(events.length, 0);
});
