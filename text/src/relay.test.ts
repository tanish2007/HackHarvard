/**
 * Tests for how incoming texts become events for Core and replies for people.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { CoreResponse, RelayEvent } from "./contracts.js";
import { ACKNOWLEDGED, GOODBYE, WELCOME } from "./handler.js";
import { PeopleDirectory } from "./people.js";
import { Registry } from "./registry.js";
import { processText, type RelayDeps } from "./relay.js";

const AMIT = "+16175550101";
const NOW = new Date("2026-10-17T14:02:00Z");

/** Build deps with a fake Core that records the events it receives. */
function makeDeps(response: CoreResponse): { deps: RelayDeps; events: RelayEvent[]; logs: string[] } {
  const events: RelayEvent[] = [];
  const logs: string[] = [];
  const deps: RelayDeps = {
    registry: new Registry(),
    directory: new PeopleDirectory([
      { person_id: "p_amit", phone: AMIT, location: { lat: 37.851, lng: -122.224 } },
    ]),
    postEvent: async (event) => {
      events.push(event);
      return response;
    },
    log: (m) => logs.push(m),
    now: () => NOW,
  };
  return { deps, events, logs };
}

const SEND_AMIT = { type: "send_text" as const, person_id: "p_amit", text: "Go to Shelter B.", map_url: null };

test("the first text signs up and does not go to Core", async () => {
  const { deps, events } = makeDeps({ actions: [] });
  assert.deepEqual(await processText(deps, AMIT, "hello"), [WELCOME]);
  assert.equal(events.length, 0);
});

test("STOP is answered here and does not go to Core", async () => {
  const { deps, events } = makeDeps({ actions: [] });
  await processText(deps, AMIT, "hello");
  assert.deepEqual(await processText(deps, AMIT, "STOP"), [GOODBYE]);
  assert.equal(events.length, 0);
});

test("free text goes to Core as a full Contract A event", async () => {
  const { deps, events } = makeDeps({ actions: [SEND_AMIT] });
  await processText(deps, AMIT, "hello");
  await processText(deps, AMIT, "my car won't start, I need help");

  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.match(event.event_id, /^evt_/);
  assert.deepEqual(
    { ...event, event_id: "x" },
    {
      event_id: "x",
      channel: "imessage",
      person_id: "p_amit",
      from: AMIT,
      text: "my car won't start, I need help",
      location: { lat: 37.851, lng: -122.224 },
      media_url: null,
      timestamp: "2026-10-17T14:02:00.000Z",
    },
  );
});

test("Core's send_text for the sender becomes the reply", async () => {
  const { deps } = makeDeps({ actions: [SEND_AMIT] });
  await processText(deps, AMIT, "hello");
  assert.deepEqual(await processText(deps, AMIT, "where do I go"), ["Go to Shelter B."]);
});

test("several send_text actions become several replies in order", async () => {
  const second = { ...SEND_AMIT, text: "Take Oak Road." };
  const { deps } = makeDeps({ actions: [SEND_AMIT, second] });
  await processText(deps, AMIT, "hello");
  assert.deepEqual(await processText(deps, AMIT, "where do I go"), ["Go to Shelter B.", "Take Oak Road."]);
});

test("when Core has nothing to say the sender still gets a reply", async () => {
  const { deps } = makeDeps({ actions: [] });
  await processText(deps, AMIT, "hello");
  assert.deepEqual(await processText(deps, AMIT, "anyone there"), [ACKNOWLEDGED]);
});

test("actions for other people or other channels are logged and skipped", async () => {
  const other = { ...SEND_AMIT, person_id: "p_priya", text: "for Priya" };
  const call = { type: "place_call" as const, person_id: "p_amit", script: "hi", reason: "x" };
  const { deps, logs } = makeDeps({ actions: [other, call, SEND_AMIT] });
  await processText(deps, AMIT, "hello");
  assert.deepEqual(await processText(deps, AMIT, "help"), ["Go to Shelter B."]);
  assert.equal(logs.length, 2);
});

test("an unknown number is sent to Core with a made-up id and no location", async () => {
  const { deps, events } = makeDeps({ actions: [] });
  await processText(deps, "+14134727634", "hello");
  await processText(deps, "+14134727634", "help");
  assert.equal(events[0]!.person_id, "p_7634");
  assert.equal(events[0]!.location, null);
});
