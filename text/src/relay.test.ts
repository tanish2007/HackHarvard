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

const SEND_AMIT = { type: "send_text" as const, person_id: "p_amit", to: null, text: "Go to Shelter B.", map_url: null };

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

test("a reply is accepted when Core's person_id differs but `to` is the sender", async () => {
  // Core may already know this number under another id. The number decides.
  const other = { ...SEND_AMIT, person_id: "p_core_made_up", to: "(617) 555-0101" };
  const { deps } = makeDeps({ actions: [other] });
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
  const call = { type: "place_call" as const, person_id: "p_amit", to: null, script: "hi", reason: "x" };
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

test("SOS goes to Core, and Core's quick reply is the only reply", async () => {
  const { deps, events } = makeDeps({ actions: [SEND_AMIT] });
  await run(deps, AMIT, "hello");
  assert.deepEqual(await run(deps, AMIT, "SOS my house is on fire"), ["Go to Shelter B."]);
  assert.equal(events[0]!.text, "SOS my house is on fire");
});

test("a slow Core gets our SOS acknowledgement first, then its own reply", async () => {
  let release: (r: CoreResponse) => void = () => {};
  const slowCore = () => new Promise<CoreResponse>((resolve) => (release = resolve));
  const { deps } = makeDeps({ actions: [] }, slowCore);
  deps.sosAckDelayMs = 10;
  await run(deps, AMIT, "hello");

  const sent: string[] = [];
  const done = processText(deps, AMIT, "SOS", async (reply) => {
    sent.push(reply);
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(sent, [SOS_RECEIVED]);

  release({ actions: [SEND_AMIT] });
  await done;
  assert.deepEqual(sent, [SOS_RECEIVED, "Go to Shelter B."]);
});

test("a slow Core that then says nothing still gets exactly one acknowledgement", async () => {
  const slowEmpty = () => new Promise<CoreResponse>((resolve) => setTimeout(() => resolve({ actions: [] }), 40));
  const { deps } = makeDeps({ actions: [] }, slowEmpty);
  deps.sosAckDelayMs = 10;
  await run(deps, AMIT, "hello");
  assert.deepEqual(await run(deps, AMIT, "SOS"), [SOS_RECEIVED]);
});

test("a quick Core that says nothing still gets one acknowledgement", async () => {
  const { deps } = makeDeps({ actions: [] });
  await run(deps, AMIT, "hello");
  assert.deepEqual(await run(deps, AMIT, "SOS"), [SOS_RECEIVED]);
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

const PIN = { lat: 40.7, lng: -74.0 };

/** Run one text with a shared location and return every reply that was sent. */
async function runShared(deps: RelayDeps, phone: string, text: string, location: typeof PIN): Promise<string[]> {
  const sent: string[] = [];
  await processText(deps, phone, text, async (reply) => void sent.push(reply), { location });
  return sent;
}

test("a shared location goes to Core with empty text, and Core's reply comes back", async () => {
  const thanks = { ...SEND_AMIT, text: "Thanks, got your location." };
  const { deps, events } = makeDeps({ actions: [thanks] });
  await run(deps, AMIT, "hello");
  assert.deepEqual(await runShared(deps, AMIT, "", PIN), ["Thanks, got your location."]);
  assert.equal(events[0]!.text, "");
  assert.deepEqual(events[0]!.location, PIN);
});

test("a shared location replaces the scenario location", async () => {
  const { deps, events } = makeDeps({ actions: [] });
  await run(deps, AMIT, "hello");
  await runShared(deps, AMIT, "", PIN);
  assert.deepEqual(events[0]!.location, PIN);
});

test("a location sent with a first message signs them up and still reaches Core", async () => {
  const { deps, events } = makeDeps({ actions: [] });
  assert.deepEqual(await runShared(deps, "+14134727634", "", PIN), [WELCOME]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.location, PIN);
  assert.equal(events[0]!.person_id, "p_7634");
});

test("someone who sent STOP does not have a shared location passed on", async () => {
  const { deps, events } = makeDeps({ actions: [] });
  await run(deps, AMIT, "hello");
  await run(deps, AMIT, "STOP");
  const before = events.length;
  await runShared(deps, AMIT, "", PIN);
  assert.equal(events.length, before);
});

test("a Maps link in the text gives Core the coordinates and keeps the text", async () => {
  const { deps, events } = makeDeps({ actions: [] });
  await run(deps, AMIT, "hello");
  const link = "https://maps.apple.com/?ll=40.7,-74.0&q=Dropped%20Pin";
  await run(deps, AMIT, link);
  assert.equal(events[0]!.text, link);
  assert.deepEqual(events[0]!.location, PIN);
});

test("typed coordinates reach Core as the location", async () => {
  const { deps, events } = makeDeps({ actions: [] });
  await run(deps, "+14134727634", "hello");
  await run(deps, "+14134727634", "I'm at 40.700, -74.000 near the bridge");
  assert.deepEqual(events[0]!.location, PIN);
});

/** A fake Find My feed that records how it was asked. */
function fakeFindMy(where: typeof PIN | null) {
  const asked: { handle: string; timeoutMs?: number }[] = [];
  return {
    asked,
    findMy: {
      latest: async (handle: string, timeoutMs?: number) => {
        asked.push({ handle, timeoutMs });
        return where;
      },
    },
  };
}

test("a new sign-up's Find My location goes to Core", async () => {
  const { deps, events } = makeDeps({ actions: [] });
  const fake = fakeFindMy(PIN);
  deps.findMy = fake.findMy;
  await run(deps, "+14134727634", "hello");
  await run(deps, "+14134727634", "where is the shelter");
  assert.deepEqual(events[0]!.location, PIN);
  assert.equal(fake.asked[0]!.handle, "+14134727634");
});

test("a scenario person keeps their scenario location, not Find My", async () => {
  const { deps, events } = makeDeps({ actions: [] });
  const fake = fakeFindMy(PIN);
  deps.findMy = fake.findMy;
  await run(deps, AMIT, "hello");
  await run(deps, AMIT, "where is the shelter");
  assert.deepEqual(events[0]!.location, { lat: 37.851, lng: -122.224 });
  assert.equal(fake.asked.length, 0);
});

test("Find My can be switched on for scenario people too", async () => {
  const { deps, events } = makeDeps({ actions: [] });
  deps.findMy = fakeFindMy(PIN).findMy;
  deps.findMyOverridesScenario = true;
  await run(deps, AMIT, "hello");
  await run(deps, AMIT, "where is the shelter");
  assert.deepEqual(events[0]!.location, PIN);
});

test("a location in the message beats Find My", async () => {
  const { deps, events } = makeDeps({ actions: [] });
  const fake = fakeFindMy({ lat: 1, lng: 2 });
  deps.findMy = fake.findMy;
  await run(deps, "+14134727634", "hello");
  await run(deps, "+14134727634", "I'm at 40.700, -74.000");
  assert.deepEqual(events[0]!.location, PIN);
  assert.equal(fake.asked.length, 0);
});

test("someone not sharing Find My is sent with no location", async () => {
  const { deps, events } = makeDeps({ actions: [] });
  deps.findMy = fakeFindMy(null).findMy;
  await run(deps, "+14134727634", "hello");
  await run(deps, "+14134727634", "where is the shelter");
  assert.equal(events[0]!.location, null);
});

test("a call for help waits only briefly for Find My", async () => {
  const { deps } = makeDeps({ actions: [] });
  const fake = fakeFindMy(PIN);
  deps.findMy = fake.findMy;
  await run(deps, "+14134727634", "hello");
  await run(deps, "+14134727634", "SOS");
  await run(deps, "+14134727634", "where is the shelter");
  assert.deepEqual(fake.asked.map((a) => a.timeoutMs), [400, 1500]);
});
