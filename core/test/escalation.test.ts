/**
 * Tests for the check-in chain and the human-confirmed emergency call.
 *
 * The hard rule from the PRD: Relay never calls the emergency contact on its
 * own. The chain ends at a dashboard SOS flag, and only confirm() places the
 * call. Time is moved by hand with a fake scheduler.
 */
import { describe, expect, it } from "vitest";
import type { PlaceCallAction } from "../src/contracts.js";
import { createStubData } from "../src/data/stub.js";
import { createEscalationEngine, EMERGENCY_PERSON_ID } from "../src/escalation/engine.js";
import { handleEvent } from "../src/event/handle.js";
import { fakeScheduler, makeEvent, makeStore, PHONES, recordingDispatcher } from "./helpers.js";

/**
 * An engine on the committed scenario (check-in, then the family step).
 *
 * Args:
 *     ok (boolean): Whether Voice accepts the pushed calls. Defaults to true.
 *
 * Returns:
 *     The store, engine, recorded pushes, and a function to move time.
 */
function setup(ok = true, withRoute = false) {
  const { store, advance: advanceClock } = makeStore();
  const { scheduler, advance, pending } = fakeScheduler();
  const { dispatcher, pushed } = recordingDispatcher(ok);
  const engine = createEscalationEngine({
    store,
    dispatcher,
    scheduler,
    data: withRoute ? createStubData(store.scenario) : undefined,
    log: () => {},
  });
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
    const checkin = store.scenario.settings.checkin_timeout_sec;
    const step = store.scenario.settings.escalation_timeout_sec;

    await wait(checkin - 1);
    expect(calls(pushed)).toEqual([]);
    await wait(1);
    expect(calls(pushed)).toEqual([["p_amit", "missed_checkin"]]);
    expect(pushed[0]).toMatchObject({ to: PHONES.amit });

    await wait(step);
    expect(calls(pushed)).toEqual([["p_amit", "missed_checkin"], ["p_priya", "escalation"]]);
    expect(engine.stageOf("p_amit")).toBe("responder");

    engine.callEnded("p_priya");
    await wait(step - 1);
    expect(calls(pushed)).toEqual([["p_amit", "missed_checkin"], ["p_priya", "escalation"]]);
    await wait(1);
    expect(calls(pushed)).toEqual([
      ["p_amit", "missed_checkin"],
      ["p_priya", "escalation"],
      ["u_4", "responder"],
    ]);
    expect(pushed.at(-1)).toMatchObject({ to: PHONES.unit4 });
    expect(store.getPerson("p_amit")?.status).toBe("sos");
    expect(store.snapshot().timeline.map((t) => t.text)).toContain("Amit unreachable after check-in, family call, and firefighter call, needs human confirmation");
    expect(engine.stageOf("p_amit")).toBeNull();

    await wait(600);
    expect(calls(pushed).some(([id]) => id === EMERGENCY_PERSON_ID)).toBe(false);
  });

  it.each([0, 1, 2])("stops if the person texts at step %s", async (stepIndex) => {
    const { store, engine, pushed, wait } = setup();
    const checkin = store.scenario.settings.checkin_timeout_sec;
    const step = store.scenario.settings.escalation_timeout_sec;
    const after = [0, checkin + 1, checkin + step + 1][stepIndex];
    engine.start("p_amit");
    await wait(after);
    const before = pushed.length;
    await handleEvent(makeEvent({ text: "hi" }), { store, escalation: engine });
    await wait(600);
    expect(pushed.length).toBe(before);
    expect(store.getPerson("p_amit")?.status).toBe("unconfirmed");
  });

  it("does not call the family contact while the check-in call is still connected", async () => {
    const { store, engine, pushed, wait } = setup();
    const checkin = store.scenario.settings.checkin_timeout_sec;
    const step = store.scenario.settings.escalation_timeout_sec;
    engine.start("p_amit");
    expect(engine.noteCallLive("p_amit")).toBe(false);
    await wait(checkin);
    expect(calls(pushed)).toEqual([["p_amit", "missed_checkin"]]);
    expect(engine.noteCallLive("p_amit")).toBe(true);
    await wait(step - 1);
    expect(engine.noteCallLive("p_amit")).toBe(true);
    await wait(step - 1);
    expect(calls(pushed)).toEqual([["p_amit", "missed_checkin"]]);
    await handleEvent(makeEvent({ channel: "voice", text: "I need a way out" }), { store, escalation: engine });
    await wait(600);
    expect(calls(pushed)).toEqual([["p_amit", "missed_checkin"]]);
    expect(store.snapshot().timeline.map((t) => t.text)).toContain("Amit picked up the check-in call");
  });

  it("does not call Priya after Amit picks up, even if the call then ends", async () => {
    const { store, engine, pushed, wait } = setup();
    const { checkin_timeout_sec: checkin, escalation_timeout_sec: step } = store.scenario.settings;
    engine.start("p_amit");
    await wait(checkin);
    engine.noteCallLive("p_amit");
    engine.callEnded("p_amit");
    await wait(step + 30);
    expect(calls(pushed)).toEqual([["p_amit", "missed_checkin"]]);
    expect(store.snapshot().timeline.map((t) => t.text)).toContain("Amit picked up the check-in call");
  });

  it("calls Priya 10 seconds after the check-in call ends without a pickup", async () => {
    const { store, engine, pushed, wait } = setup();
    const { checkin_timeout_sec: checkin, escalation_timeout_sec: step } = store.scenario.settings;
    engine.start("p_amit");
    await wait(checkin);
    engine.callEnded("p_amit");
    await wait(step - 1);
    expect(calls(pushed)).toEqual([["p_amit", "missed_checkin"]]);
    await wait(1);
    expect(calls(pushed)).toEqual([
      ["p_amit", "missed_checkin"],
      ["p_priya", "escalation"],
    ]);
  });

  it("cancels Priya if Amit picks up after a premature end", async () => {
    const { store, engine, pushed, wait } = setup();
    const { checkin_timeout_sec: checkin, escalation_timeout_sec: step } = store.scenario.settings;
    engine.start("p_amit");
    await wait(checkin);
    engine.callEnded("p_amit");
    expect(engine.noteCallLive("p_amit")).toBe(true);
    await wait(step + 5);
    expect(calls(pushed)).toEqual([["p_amit", "missed_checkin"]]);
  });

  it("tells Amit the walk from his exact coordinates when it calls him", async () => {
    const { store, engine, pushed, wait } = setup(true, true);
    const amit = store.getPerson("p_amit");
    engine.start("p_amit");
    await wait(store.scenario.settings.checkin_timeout_sec);
    const script = String((pushed[0] as { script?: string }).script);
    expect(amit?.lat).toBe(42.374);
    expect(amit?.lng).toBe(-71.1175);
    expect(script).toContain("Hemenway Gym");
    expect(script).toContain("Walk to");
  });

  it("calls the firefighter 10 seconds after Priya's call is cut off or goes to voicemail", async () => {
    const { store, engine, pushed, wait } = setup();
    const step = store.scenario.settings.escalation_timeout_sec;
    engine.start("p_amit");
    await wait(store.scenario.settings.checkin_timeout_sec + step);
    expect(engine.stageOf("p_amit")).toBe("responder");
    await handleEvent(makeEvent({ channel: "voice", person_id: "p_priya", from: PHONES.priya, text: "Please leave a message after the tone." }), {
      store,
      escalation: engine,
    });
    await wait(step - 1);
    expect(calls(pushed).map((row) => row[1])).toEqual(["missed_checkin", "escalation"]);
    await wait(1);
    expect(calls(pushed)).toEqual([
      ["p_amit", "missed_checkin"],
      ["p_priya", "escalation"],
      ["u_4", "responder"],
    ]);
    expect(String((pushed.at(-1) as { script?: string }).script)).toContain("cut off or went to voicemail");
    expect(store.getPerson("p_amit")?.status).toBe("sos");
  });

  it("does not call the firefighter when Priya answers", async () => {
    const { store, engine, pushed, wait } = setup();
    const step = store.scenario.settings.escalation_timeout_sec;
    engine.start("p_amit");
    await wait(store.scenario.settings.checkin_timeout_sec + step);
    await handleEvent(makeEvent({ channel: "voice", person_id: "p_priya", from: PHONES.priya, text: "I will call Amit" }), {
      store,
      escalation: engine,
    });
    engine.callEnded("p_priya");
    await wait(600);
    expect(calls(pushed).some(([, reason]) => reason === "responder")).toBe(false);
    expect(store.getPerson("p_amit")?.status).toBe("unconfirmed");
  });

  it("calls the family contact 10 seconds after the check-in call is voicemail", async () => {
    const { store, engine, pushed, wait } = setup();
    const step = store.scenario.settings.escalation_timeout_sec;
    engine.start("p_amit");
    await wait(store.scenario.settings.checkin_timeout_sec);
    engine.noteCallLive("p_amit");
    await handleEvent(makeEvent({ channel: "voice", text: "Please leave a message after the tone." }), { store, escalation: engine });
    await wait(step - 1);
    expect(calls(pushed)).toEqual([["p_amit", "missed_checkin"]]);
    await wait(1);
    expect(calls(pushed)).toEqual([
      ["p_amit", "missed_checkin"],
      ["p_priya", "escalation"],
    ]);
  });

  it("keeps going when the call is voicemail or cut off", async () => {
    const { store, engine, pushed, wait } = setup();
    engine.start("p_amit");
    await handleEvent(makeEvent({ channel: "voice", text: "Please leave a message after the tone." }), { store, escalation: engine });
    await handleEvent(makeEvent({ channel: "voice", text: "The call has ended." }), { store, escalation: engine });
    await wait(store.scenario.settings.checkin_timeout_sec);
    expect(calls(pushed)).toEqual([["p_amit", "missed_checkin"]]);
    expect(engine.stageOf("p_amit")).toBe("family");
  });

  it("keeps going when the only news is a location", async () => {
    const { store, engine, pushed, wait } = setup();
    engine.start("p_amit");
    await handleEvent(makeEvent({ text: "", location: { lat: 42.2943, lng: -71.1919 } }), { store, escalation: engine });
    await wait(store.scenario.settings.checkin_timeout_sec);
    expect(calls(pushed)).toEqual([["p_amit", "missed_checkin"]]);
    expect(engine.stageOf("p_amit")).toBe("family");
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
    const { checkin_timeout_sec: checkin, escalation_timeout_sec: step } = store.scenario.settings;
    await wait(checkin + step + step);
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
    expect(call.script).toContain("Zone 1");
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
