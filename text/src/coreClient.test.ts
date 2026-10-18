/**
 * Tests for the Core client: it must keep good actions and never throw.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseActions, postEvent } from "./coreClient.js";
import type { RelayEvent } from "./contracts.js";

const EVENT: RelayEvent = {
  event_id: "evt_1",
  channel: "imessage",
  person_id: "p_amit",
  from: "+16175550101",
  text: "help",
  location: null,
  media_url: null,
  timestamp: "2026-10-17T14:02:00Z",
};

const SEND_TEXT = { type: "send_text", person_id: "p_amit", text: "hi", map_url: null };

/** Build a fake fetch that returns a fixed status and JSON body. */
function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

test("parseActions keeps known actions and logs unknown ones", () => {
  const logs: string[] = [];
  const actions = parseActions({ actions: [SEND_TEXT, { type: "dance" }, 7, null] }, (m) => logs.push(m));
  assert.deepEqual(actions, [SEND_TEXT]);
  assert.equal(logs.length, 3);
});

test("parseActions returns an empty list for a bad body", () => {
  for (const body of [null, "x", 5, {}, { actions: "no" }]) {
    assert.deepEqual(parseActions(body), []);
  }
});

test("postEvent returns Core's actions on 200", async () => {
  const res = await postEvent(EVENT, { coreUrl: "http://core", fetchImpl: fakeFetch(200, { actions: [SEND_TEXT] }) });
  assert.deepEqual(res.actions, [SEND_TEXT]);
});

test("postEvent posts Contract A JSON to /event", async () => {
  let seenUrl = "";
  let seenBody = "";
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenBody = String(init.body);
    return new Response(JSON.stringify({ actions: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  await postEvent(EVENT, { coreUrl: "http://core:3000", fetchImpl });
  assert.equal(seenUrl, "http://core:3000/event");
  assert.deepEqual(JSON.parse(seenBody), EVENT);
});

test("postEvent returns no actions on a non-200 status", async () => {
  const logs: string[] = [];
  const res = await postEvent(EVENT, {
    coreUrl: "http://core",
    fetchImpl: fakeFetch(500, {}),
    log: (m) => logs.push(m),
  });
  assert.deepEqual(res.actions, []);
  assert.equal(logs.length, 1);
});

test("postEvent returns no actions when the request throws", async () => {
  const fetchImpl = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  const res = await postEvent(EVENT, { coreUrl: "http://core", fetchImpl, log: () => {} });
  assert.deepEqual(res.actions, []);
});
