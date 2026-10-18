/**
 * Tests that fail on the current code. Each one pins a bug found in review.
 *
 * Kept in their own file so they can be committed, reviewed, or held back
 * separately. When a fix lands, move the test into the matching file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent } from "../src/agent/loop.js";
import { createStubData } from "../src/data/stub.js";
import { handleEvent } from "../src/event/handle.js";
import { classify } from "../src/rules/fastpath.js";
import { answer, makeEvent, makeStore, PHONES, runTool, scriptedLlm, toolCalls, toolContext } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SOS missed without punctuation", () => {
  // Speech-to-text often drops commas. "No, I need help" works, this does not.
  it("treats 'no I need help' on a check-in call as sos", () => {
    expect(classify("no I need help", "voice", "relay").intent).toBe("sos");
  });
});

describe("agent raises SOS, then fails", () => {
  it("still texts the family when the final answer is empty", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { store } = makeStore();
    const { llm } = scriptedLlm([
      toolCalls({ name: "set_status", args: { person_id: "p_amit", status: "sos", reason: "house on fire" } }),
      answer(""),
    ]);
    const agent = createAgent({ store, data: createStubData(store.scenario), llm });
    const { actions } = await handleEvent(makeEvent({ text: "my house is on fire what do I do" }), { store, agent });
    expect(store.getPerson("p_amit")?.status).toBe("sos");
    expect(actions).toContainEqual(expect.objectContaining({ type: "send_text", person_id: "p_priya" }));
  });
});

describe("plan_route", () => {
  it("throws when no destination is given, instead of routing to the start", async () => {
    const { store } = makeStore();
    await expect(runTool("plan_route", {}, toolContext(store))).rejects.toMatchObject({ message: expect.stringMatching(/destination/i) });
  });
});

describe("person_id from the channel", () => {
  // Text makes up "p_<last 4 digits>" for unknown numbers, so two strangers
  // with the same last 4 digits get the same id.
  it("does not merge two strangers who share the last 4 digits", async () => {
    const { store } = makeStore();
    await handleEvent(makeEvent({ from: PHONES.stranger, person_id: "p_0150", text: "hi" }), { store });
    await handleEvent(makeEvent({ from: "+14155550150", person_id: "p_0150", text: "I'm safe" }), { store });
    expect(store.getPerson("p_0150")?.status).toBe("unconfirmed");
    expect(store.findPersonByHandle("+14155550150")).toBeDefined();
  });
});
