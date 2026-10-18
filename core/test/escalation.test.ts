/**
 * Tests for the check-in chain and the human-confirmed emergency call.
 *
 * The hard rule from the PRD: Relay never calls the emergency contact on its
 * own. The chain ends at a dashboard SOS flag, and only confirm() places the
 * call. Time is moved by hand with a fake scheduler.
 */
import { describe, expect, it } from "vitest";
import type { PlaceCallAction } from "../src/contracts.js";
import { createEscalationEngine, EMERGENCY_PERSON_ID } from "../src/escalation/engine.js";
import { handleEvent } from "../src/event/handle.js";
import { fakeScheduler, makeEvent, makeStore, PHONES, recordingDispatcher } from "./helpers.js";

/**
 * An engine on the committed scenario (60s check-in, 60s escalation).
 *
 * Args:
 *     ok (boolean): Whether Voice accepts the pushed calls. Defaults to true.
 *
 * Returns:
 *     The store, engine, recorded pushes, and a function to move time.
 */
function setup(ok = true) {
  const { store, advance: advanceClock } = makeStore();
  const { scheduler, advance, pending } = fakeScheduler();
  const { dispatcher, pushed } = recordingDispatcher(ok);
  const engine = createEscalationEngine({ store, dispatcher, scheduler, log: () => {} });
  const wait = async (sec: number) => {
    advanceClock(sec);
    await advance(sec);
  };
  return { store, engine, pushed, wait, pending };
}

/**
 * The calls pushed so far, as [person_id, reason].
 *
 * Args:
 *     pushed (unknown[]): Recorded actions.
 *
 * Returns:
 *     string[][]: One row per place_call.
 */
function calls(pushed: unknown[]): string[][] {
  return (pushed as PlaceCallAction[]).filter((a) => a.type === "place_call").map((a) => [a.person_id, a.reason]);
}

describe("check-in chain", () => {
  it("calls the person, then the family, then flags SOS, and never calls the emergency contact", async () => {
    const { store, engine, pushed, wait } = setup();
    expect(engine.start("p_amit")).toBe(true);

    await wait(59);
    expect(calls(pushed)).toEqual([]);
    await wait(1);
    expect(calls(pushed)).toEqual([["p_amit", "missed_checkin"]]);
    expect(pushed[0]).toMatchObject({ to: PHONES.amit });

    await wait(60);
    expect(calls(pushed)).toEqual([["p_amit", "missed_checkin"], ["p_priya", "escalation"]]);

    await wait(60);
    expect(store.getPerson("p_amit")?.status).toBe("sos");
    expect(store.snapshot().timeline.map((t) => t.text)).toContain("Amit unreachable after check-in and family call, needs human confirmation");
    expect(engine.stageOf("p_amit")).toBeNull();

    await wait(600);
    expect(calls(pushed).some(([id]) => id === EMERGENCY_PERSON_ID)).toBe(false);
  });

  it.each([0, 61, 121])("stops if the person texts in %s seconds after the alert", async (after) => {
    const { store, engine, pushed, wait } = setup();
    engine.start("p_amit");
    await wait(after);
    const before = pushed.length;
    await handleEvent(makeEvent({ text: "hi" }), { store, escalation: engine });
    await wait(600);
    expect(pushed.length).toBe(before);
    expect(store.getPerson("p_amit")?.status).toBe("unconfirmed");
  });

  it("stops if a responder changes their status", async () => {
    const { store, engine, pushed, wait } = setup();
    engine.start("p_amit");
    store.setStatus("p_amit", "safe", { byResponder: true });
    await wait(600);
    expect(pushed).toEqual([]);
  });

  it("does not start for someone already in SOS or unknown", () => {
    const { store, engine } = setup();
    store.setStatus("p_amit", "sos");
    expect(engine.start("p_amit")).toBe(false);
    expect(engine.start("p_ghost")).toBe(false);
  });

  it("skips the calls for someone with no phone but still flags SOS", async () => {
    const { store, engine, pushed, wait } = setup();
    engine.start("sim_004");
    await wait(180);
    expect(pushed).toEqual([]);
    expect(store.getPerson("sim_004")?.status).toBe("sos");
  });

  it("cancels every chain on reset", async () => {
    const { engine, pushed, wait, pending } = setup();
    engine.start("p_amit");
    engine.start("p_priya");
    engine.reset();
    await wait(600);
    expect(pushed).toEqual([]);
    expect(pending()).toBe(0);
  });
});

describe("confirm", () => {
  it("calls the emergency contact with a briefing, once per SOS", async () => {
    const { store, engine, pushed } = setup();
    await handleEvent(makeEvent({ text: "my car won't start, I need help" }), { store, escalation: engine });
    const result = await engine.confirm("p_amit", "Rudra");
    expect(result.ok).toBe(true);
    const call = pushed.find((a) => a.type === "place_call") as PlaceCallAction;
    expect(call).toMatchObject({ person_id: EMERGENCY_PERSON_ID, to: store.scenario.emergency_contact.phone, reason: "human_confirmed" });
    expect(call.script).toContain("Amit");
    expect(call.script).toContain("Zone 3");
    expect(store.snapshot().timeline.map((t) => t.text)).toContain("911 call confirmed by Rudra for Amit");
    expect(await engine.confirm("p_amit")).toEqual({ ok: false, error: "already_confirmed" });
  });

  it("lets the responder retry when the emergency call was not delivered", async () => {
    const { store, engine } = setup(false);
    store.setStatus("p_amit", "sos");
    const first = await engine.confirm("p_amit");
    expect(first.ok && first.results.every((r) => r.ok)).toBe(false);
    expect((await engine.confirm("p_amit")).ok).toBe(true);
  });

  it("refuses someone who is not in SOS, or unknown", async () => {
    const { engine } = setup();
    expect(await engine.confirm("p_amit")).toEqual({ ok: false, error: "not_sos" });
    expect(await engine.confirm("p_ghost")).toEqual({ ok: false, error: "unknown_person" });
  });

  it("allows a new call for a new SOS after the first was cleared", async () => {
    const { store, engine, wait } = setup();
    store.setStatus("p_amit", "sos");
    await engine.confirm("p_amit");
    store.setStatus("p_amit", "safe", { byResponder: true });
    await wait(5);
    store.setStatus("p_amit", "sos");
    expect((await engine.confirm("p_amit")).ok).toBe(true);
  });

  it("names the emergency contact by its label on the timeline, never its number", async () => {
    const { store, engine } = setup();
    store.setStatus("p_amit", "sos");
    await engine.confirm("p_amit");
    const timeline = JSON.stringify(store.snapshot().timeline);
    expect(timeline).toContain(store.scenario.emergency_contact.label);
    expect(timeline).not.toContain(store.scenario.emergency_contact.phone);
  });
});
