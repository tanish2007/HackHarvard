/**
 * Tests for pushing actions from Core to people who may never have texted us.
 */

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createActionsServer } from "./actionsServer.js";
import { deliverActions, type AlertDeps } from "./alerts.js";
import type { SendTextAction } from "./contracts.js";
import { PeopleDirectory } from "./people.js";
import { Registry } from "./registry.js";

const AMIT = "+16175550101";
const PRIYA = "+16175550102";

const alert = (person_id: string, text = "Fire near you. Go to Shelter B."): SendTextAction => ({
  type: "send_text",
  person_id,
  to: null,
  text,
  map_url: null,
});

/** Build deps whose sender records every text instead of sending it. */
function makeDeps(): { deps: AlertDeps; sent: { phone: string; text: string }[]; logs: string[] } {
  const sent: { phone: string; text: string }[] = [];
  const logs: string[] = [];
  const registry = new Registry();
  registry.optIn(AMIT);
  registry.optIn(PRIYA);
  const deps: AlertDeps = {
    registry,
    directory: new PeopleDirectory([
      { person_id: "p_amit", phone: AMIT, location: null },
      { person_id: "p_priya", phone: PRIYA, location: null },
    ]),
    sendTo: async (phone, text) => {
      sent.push({ phone, text });
    },
    log: (m) => logs.push(m),
  };
  return { deps, sent, logs };
}

test("an alert is texted to a person by their person_id", async () => {
  const { deps, sent } = makeDeps();
  const report = await deliverActions(deps, [alert("p_amit")]);
  assert.deepEqual(sent, [{ phone: AMIT, text: "Fire near you. Go to Shelter B." }]);
  assert.deepEqual(report, { delivered: ["p_amit"], skipped: [] });
});

test("one batch can alert several people", async () => {
  const { deps, sent } = makeDeps();
  const report = await deliverActions(deps, [alert("p_amit"), alert("p_priya", "Priya, evacuate.")]);
  assert.equal(sent.length, 2);
  assert.deepEqual([...report.delivered].sort(), ["p_amit", "p_priya"]);
});

test("a map link is added on its own line", async () => {
  const { deps, sent } = makeDeps();
  await deliverActions(deps, [{ ...alert("p_amit", "Route:"), map_url: "https://example.com/m" }]);
  assert.equal(sent[0]!.text, "Route:\nhttps://example.com/m");
});

test("someone who sent STOP is never texted", async () => {
  const { deps, sent } = makeDeps();
  deps.registry.optOut(AMIT);
  const report = await deliverActions(deps, [alert("p_amit")]);
  assert.equal(sent.length, 0);
  assert.deepEqual(report.skipped, [{ person_id: "p_amit", reason: "not opted in" }]);
});

test("someone who never opted in is not texted", async () => {
  const { deps, sent } = makeDeps();
  deps.registry = new Registry();
  const report = await deliverActions(deps, [alert("p_amit")]);
  assert.equal(sent.length, 0);
  assert.equal(report.skipped[0]!.reason, "not opted in");
});

test("a person without a phone number is skipped", async () => {
  const { deps, sent } = makeDeps();
  const report = await deliverActions(deps, [alert("sim_001")]);
  assert.equal(sent.length, 0);
  assert.equal(report.skipped[0]!.reason, "no phone number in the scenario or on the action");
});

test("someone who signed up by text is reached through the action's `to`", async () => {
  const { deps, sent } = makeDeps();
  const newcomer = "+14134727634";
  deps.registry.optIn(newcomer);
  const report = await deliverActions(deps, [{ ...alert("p_7634"), to: newcomer }]);
  assert.deepEqual(sent, [{ phone: newcomer, text: "Fire near you. Go to Shelter B." }]);
  assert.deepEqual(report.delivered, ["p_7634"]);
});

test("`to` works as an iMessage email and in any format", async () => {
  const { deps, sent } = makeDeps();
  deps.registry.optIn("sam@example.com");
  deps.registry.optIn("+14134727634");
  await deliverActions(deps, [
    { ...alert("p_sam"), to: "Sam@Example.com" },
    { ...alert("p_7634"), to: "(413) 472-7634" },
  ]);
  assert.deepEqual(sent.map((s) => s.phone).sort(), ["+14134727634", "sam@example.com"]);
});

test("a scenario number wins over `to`", async () => {
  const { deps, sent } = makeDeps();
  await deliverActions(deps, [{ ...alert("p_amit"), to: "+19998887777" }]);
  assert.equal(sent[0]!.phone, AMIT);
});

test("`to` for someone who never opted in is still skipped", async () => {
  const { deps, sent } = makeDeps();
  const report = await deliverActions(deps, [{ ...alert("p_7634"), to: "+14134727634" }]);
  assert.equal(sent.length, 0);
  assert.equal(report.skipped[0]!.reason, "not opted in");
});

test("a failed send is reported and does not stop the others", async () => {
  const { deps, sent } = makeDeps();
  deps.sendTo = async (phone, text) => {
    if (phone === AMIT) throw new Error("line busy");
    sent.push({ phone, text });
  };
  const report = await deliverActions(deps, [alert("p_amit"), alert("p_priya")]);
  assert.deepEqual(report.delivered, ["p_priya"]);
  assert.match(report.skipped[0]!.reason, /send failed: .*line busy/);
});

test("actions that are not send_text are ignored", async () => {
  const { deps, sent, logs } = makeDeps();
  const call = { type: "place_call" as const, person_id: "p_amit", to: null, script: "hi", reason: "x" };
  const report = await deliverActions(deps, [call]);
  assert.equal(sent.length, 0);
  assert.deepEqual(report, { delivered: [], skipped: [] });
  assert.equal(logs.length, 1);
});

/** Start the server on a free port and return helpers for the test. */
async function startServer(deps: AlertDeps) {
  const server = createActionsServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("POST /actions texts the people named and returns a report", async () => {
  const { deps, sent } = makeDeps();
  const { base, close } = await startServer(deps);
  try {
    const res = await fetch(`${base}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actions: [alert("p_amit")] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { delivered: ["p_amit"], skipped: [] });
    assert.equal(sent.length, 1);
  } finally {
    await close();
  }
});

test("POST /actions rejects bad bodies and unknown routes", async () => {
  const { deps, sent } = makeDeps();
  const { base, close } = await startServer(deps);
  try {
    const bad = (body: string) => fetch(`${base}/actions`, { method: "POST", body });
    assert.equal((await bad("not json")).status, 400);
    assert.equal((await bad(JSON.stringify({ hello: 1 }))).status, 400);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/actions`)).status, 404);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal(sent.length, 0);
  } finally {
    await close();
  }
});

test("POST /actions drops unknown action types instead of failing", async () => {
  const { deps, sent } = makeDeps();
  const { base, close } = await startServer(deps);
  try {
    const res = await fetch(`${base}/actions`, {
      method: "POST",
      body: JSON.stringify({ actions: [{ type: "dance" }, alert("p_amit")] }),
    });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
  } finally {
    await close();
  }
});
