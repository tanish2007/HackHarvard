/**
 * Tests that fail on the current code. Each one pins a bug found in review.
 *
 * Kept in their own file so they can be committed, reviewed, or held back
 * separately. When a fix lands, move the test into the matching file.
 */
import { describe, expect, it } from "vitest";
import { handleEvent, type Agent } from "../src/event/handle.js";
import { classify } from "../src/rules/fastpath.js";
import { errorMessage, loadEdited, makeEvent, makeStore, PHONES } from "./helpers.js";

describe("fast rules: negations and questions", () => {
  // A false SOS cannot be cleared without a responder and texts the family.
  // A false safe stops the check-in chain for someone who may be in danger.
  const cases: [string, string][] = [
    ["We're safe, nobody is hurt", "safe"],
    ["I'm ok, not injured", "safe"],
    ["No emergency here, we're fine", "safe"],
    ["Can you help me find a shelter?", "agent"],
    ["No necesito ayuda", "agent"],
    ["Is Route 24 safe?", "agent"],
    ["Is the shelter safe for pets?", "agent"],
    ["We are not leaving", "agent"],
  ];

  it.each(cases)("%j is %s", (text, expected) => {
    expect(classify(text, "imessage", "relay").intent).toBe(expected);
  });
});

describe("fast rules: wake phrase", () => {
  it("matches a wake phrase of more than one word", () => {
    expect(classify("Hey Relay, wind forecast?", "radio", "hey relay")).toEqual({ intent: "agent", text: "wind forecast?" });
  });
});

describe("event handling", () => {
  it("answers a unit that texts SOS by text, not with say", async () => {
    const { store } = makeStore();
    const { actions } = await handleEvent(makeEvent({ from: PHONES.unit4, text: "SOS, firefighter injured" }), { store });
    expect(actions).toEqual([expect.objectContaining({ type: "send_text", person_id: "u_4" })]);
  });

  it("runs a duplicate event once even when both copies arrive while the agent is thinking", async () => {
    const { store } = makeStore();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const agent: Agent = async () => {
      calls++;
      await gate;
      return [{ type: "say", text: "answer" }];
    };
    const event = makeEvent({ text: "what is the wind like?" });
    const both = Promise.all([handleEvent(event, { store, agent }), handleEvent(event, { store, agent })]);
    release();
    await both;
    expect(calls).toBe(1);
    expect(store.snapshot().timeline.filter((t) => t.who === "Amit")).toHaveLength(1);
  });

  it("signs up a sender with an unnormalizable handle only once", async () => {
    const { store } = makeStore();
    await handleEvent(makeEvent({ from: "12345", text: "hi" }), { store });
    await handleEvent(makeEvent({ from: "12345", text: "hi again" }), { store });
    expect(store.getPerson("p_new_2")).toBeUndefined();
  });
});

describe("scenario.json: shared phone numbers", () => {
  // With few demo phones it is easy to reuse one. Then a resident's texts
  // resolve to the unit, and their SOS never sets a status.
  it("rejects a person and a unit with the same phone", () => {
    expect(errorMessage(() => loadEdited((f) => (f.units[0].phone = PHONES.amit)))).toMatch(/phone/i);
  });

  it("rejects two people with the same phone", () => {
    expect(errorMessage(() => loadEdited((f) => (f.people[1].phone = PHONES.amit)))).toMatch(/phone/i);
  });

  it("rejects a shared phone set through scenario.local.json", () => {
    const local = { phones: { p_amit: "+16175550160", u_4: "+16175550160" } };
    expect(errorMessage(() => loadEdited(() => {}, local))).toMatch(/phone/i);
  });
});
