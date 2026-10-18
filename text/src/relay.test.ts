/**
 * Tests for how incoming texts become events for Core and replies for people.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { CoreResponse, RelayEvent } from "./contracts.js";
import { ACKNOWLEDGED, GOODBYE, SOS_RECEIVED, WELCOME } from "./handler.js";
import { PeopleDirectory } from "./people.js";
import { Registry } from "./registry.js";
import { processText, type RelayDeps } from "./relay.js";

const AMIT = "+16175550101";
const NOW = new Date("2026-10-17T14:02:00Z");

/** Build deps with a fake Core that records the events it receives. */
function makeDeps(
  response: CoreResponse,
  postEvent?: RelayDeps["postEvent"],
): { deps: RelayDeps; events: RelayEvent[]; logs: string[] } {
  const events: RelayEvent[] = [];
  const logs: string[] = [];
  const deps: RelayDeps = {
    registry: new Registry(),
    directory: new PeopleDirectory([
      { person_id: "p_amit", phone: AMIT, location: { lat: 37.851, lng: -122.224 } },
    ]),
    postEvent:
      postEvent ??
      (async (event) => {
        events.push(event);
        return response;
      }),
    log: (m) => logs.push(m),
    now: () => NOW,
  };
  return { deps, events, logs };
}

/** Run one text through the relay and return every reply that was sent. */
async function run(deps: RelayDeps, phone: string, text: string): Promise<string[]> {
  const sent: string[] = [];
  await processText(deps, phone, text, async (reply) => {
    sent.push(reply);
  });
  return sent;
}

const SEND_AMIT = { type: "send_text" as const, person_id: "p_amit", text: "Go to Shelter B.", map_url: null };

test("the first text signs up and does not go to Core", async () => {
  const { deps, events } = makeDeps({ actions: [] });
  assert.deepEqual(await run(deps, AMIT, "hello"), [WELCOME]);
  assert.equal(events.length, 0);
});

test("STOP is answered here, and Core is told as well", async () => {
  const { deps, events } = makeDeps({ actions: [] });
  await run(deps, AMIT, "hello");
  assert.deepEqual(await run(deps, AMIT, "STOP"), [GOODBYE]);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.text, "STOP");
  assert.equal(events[0]!.person_id, "p_amit");
  assert.equal(events[0]!.from, AMIT);
});

test("the goodbye is sent before Core hears about STOP", async () => {
  const order: string[] = [];
  const { deps } = makeDeps({ actions: [] }, async () => {
    order.push("core");
    return { actions: [] };
  });
  await run(deps, AMIT, "hello");
  await processText(deps, AMIT, "STOP", async () => {
    order.push("goodbye");
  });
  assert.deepEqual(order, ["goodbye", "core"]);
});

test("STOP still gets its goodbye when Core is down, and Core's answer is ignored", async () => {
  const send_text = { ...SEND_AMIT, text: "should never be sent" };
  const { deps } = makeDeps({ actions: [send_text] });
  await run(deps, AMIT, "hello");
  assert.deepEqual(await run(deps, AMIT, "STOP"), [GOODBYE]);
});

test("STOP from someone who never texted is also passed to Core", async () => {
  const { deps, events } = makeDeps({ actions: [] });
  assert.deepEqual(await run(deps, AMIT, "stop"), [GOODBYE]);
  assert.equal(events.length, 1);
});

test("free text goes to Core as a full Contract A event", async () => {
  const { deps, events } = makeDeps({ actions: [SEND_AMIT] });
  await run(deps, AMIT, "hello");
  await run(deps, AMIT, "where is the nearest shelter");

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
      text: "where is the nearest shelter",
      location: { lat: 37.851, lng: -122.224 },
      media_url: null,
      timestamp: "2026-10-17T14:02:00.000Z",
    },
  );
});

test("Core's send_text for the sender becomes the reply", async () => {
  const { deps } = makeDeps({ actions: [SEND_AMIT] });
  await run(deps, AMIT, "hello");
  assert.deepEqual(await run(deps, AMIT, "where do I go"), ["Go to Shelter B."]);
});

test("several send_text actions become several replies in order", async () => {
  const second = { ...SEND_AMIT, text: "Take Oak Road." };
  const { deps } = makeDeps({ actions: [SEND_AMIT, second] });
  await run(deps, AMIT, "hello");
  assert.deepEqual(await run(deps, AMIT, "where do I go"), ["Go to Shelter B.", "Take Oak Road."]);
});

test("when Core has nothing to say the sender still gets a reply", async () => {
  const { deps } = makeDeps({ actions: [] });
  await run(deps, AMIT, "hello");
  assert.deepEqual(await run(deps, AMIT, "anyone there"), [ACKNOWLEDGED]);
});

test("actions for other people or other channels are logged and skipped", async () => {
  const other = { ...SEND_AMIT, person_id: "p_priya", text: "for Priya" };
  const call = { type: "place_call" as const, person_id: "p_amit", script: "hi", reason: "x" };
  const { deps, logs } = makeDeps({ actions: [other, call, SEND_AMIT] });
  await run(deps, AMIT, "hello");
  assert.deepEqual(await run(deps, AMIT, "where do I go"), ["Go to Shelter B."]);
  assert.equal(logs.length, 2);
});

test("an unknown number is sent to Core with a made-up id and no location", async () => {
  const { deps, events } = makeDeps({ actions: [] });
  await run(deps, "+14134727634", "hello");
  await run(deps, "+14134727634", "where do I go");
  assert.equal(events[0]!.person_id, "p_7634");
  assert.equal(events[0]!.location, null);
});

test("SOS is acknowledged and sent to Core, then Core's reply follows", async () => {
  const { deps, events } = makeDeps({ actions: [SEND_AMIT] });
  await run(deps, AMIT, "hello");
  assert.deepEqual(await run(deps, AMIT, "SOS my house is on fire"), [SOS_RECEIVED, "Go to Shelter B."]);
  assert.equal(events[0]!.text, "SOS my house is on fire");
});

test("the SOS acknowledgement goes out before Core answers", async () => {
  let release: (r: CoreResponse) => void = () => {};
  const slowCore = () => new Promise<CoreResponse>((resolve) => (release = resolve));
  const { deps } = makeDeps({ actions: [] }, slowCore);
  await run(deps, AMIT, "hello");

  const sent: string[] = [];
  const done = processText(deps, AMIT, "SOS", async (reply) => {
    sent.push(reply);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [SOS_RECEIVED]);

  release({ actions: [SEND_AMIT] });
  await done;
  assert.deepEqual(sent, [SOS_RECEIVED, "Go to Shelter B."]);
});

test("SOS from someone who never texted signs them up and goes to Core", async () => {
  const { deps, events } = makeDeps({ actions: [] });
  assert.deepEqual(await run(deps, AMIT, "SOS"), [SOS_RECEIVED]);
  assert.equal(deps.registry.status(AMIT), "opted_in");
  assert.equal(events.length, 1);
});

test("SOS from someone who sent STOP still goes to Core and does not sign them back in", async () => {
  const { deps, events } = makeDeps({ actions: [] });
  await run(deps, AMIT, "hello");
  await run(deps, AMIT, "STOP");
  assert.deepEqual(await run(deps, AMIT, "I need help"), [SOS_RECEIVED]);
  assert.deepEqual(events.map((e) => e.text), ["STOP", "I need help"]);
  assert.equal(deps.registry.status(AMIT), "opted_out");
});

test("SOS still gets exactly one reply when Core is down", async () => {
  const { deps } = makeDeps({ actions: [] });
  await run(deps, AMIT, "hello");
  assert.deepEqual(await run(deps, AMIT, "SOS"), [SOS_RECEIVED]);
});
