/**
 * Tests for the agent loop (createAgent), driven by a scripted fake LlmClient.
 * Never calls Gemini.
 */
import { describe, expect, it, vi } from "vitest";
import type { LlmRequest } from "../src/agent/llm.js";
import { handleEvent } from "../src/event/handle.js";
import { createAgent } from "../src/agent/loop.js";
import type { RelayEvent } from "../src/contracts.js";
import { createStubData } from "../src/data/stub.js";
import type { DataTools } from "../src/data/types.js";
import { answer, makeEvent, makeStore, PHONES, scriptedLlm, toolCalls, type ScriptStep } from "./helpers.js";

/**
 * Run the agent once with a script.
 *
 * Args:
 *     steps (ScriptStep[]): The model's turns.
 *     overrides (Partial<RelayEvent>): Event fields. Defaults to Amit by text.
 *     data (DataTools | undefined): Optional data tools.
 *
 * Returns:
 *     Promise<{ actions, requests, store }>: What the agent returned, what the
 *         model was sent, and the store.
 */
async function run(steps: ScriptStep[], overrides: Partial<RelayEvent> = {}, data?: DataTools) {
  const { store } = makeStore();
  const { llm, requests } = scriptedLlm(steps);
  const agent = createAgent({ store, data: data ?? createStubData(store.scenario), llm });
  const event = makeEvent({ text: "where is the nearest shelter?", ...overrides });
  const unit = store.findUnitByHandle(event.from);
  const person = unit ? undefined : store.findPersonByHandle(event.from);
  const actions = await agent({ event, text: event.text, person, unit, who: "x", signal: new AbortController().signal });
  return { actions, requests, store };
}

/**
 * The function responses in a request's last turn.
 *
 * Args:
 *     req (LlmRequest): A request the model got.
 *
 * Returns:
 *     Record<string, any>[]: The functionResponse objects.
 */
function responsesIn(req: LlmRequest): Record<string, any>[] {
  return req.contents.at(-1)!.parts.map((p) => p.functionResponse as Record<string, any>);
}

describe("agent loop", () => {
  it("texts a direct answer back to the resident", async () => {
    const { actions } = await run([answer("Shelter C is 3 km west.")]);
    expect(actions).toEqual([{ type: "send_text", person_id: "p_amit", to: PHONES.amit, text: "Shelter C is 3 km west.", map_url: null }]);
  });

  it("speaks the answer on radio and voice", async () => {
    expect((await run([answer("Head west.")], { channel: "radio", from: PHONES.unit4 })).actions).toEqual([{ type: "say", text: "Head west." }]);
    expect((await run([answer("Head west.")], { channel: "voice" })).actions).toEqual([{ type: "say", text: "Head west." }]);
  });

  it("runs the tools, sends results back with the call id, then answers", async () => {
    const { requests } = await run([
      toolCalls({ id: "c1", name: "get_weather", args: {} }, { name: "get_shelters", args: {} }),
      answer("ok"),
    ]);
    const [weather, shelters] = responsesIn(requests[1]);
    expect(weather).toMatchObject({ id: "c1", name: "get_weather", response: { output: expect.objectContaining({ wind_mph: 22 }) } });
    expect(shelters).not.toHaveProperty("id");
  });

  it("runs the calls in one turn in parallel", async () => {
    const { store } = makeStore();
    const stub = createStubData(store.scenario);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Weather waits for shelters to start. Run one at a time, this would hang.
    const data: DataTools = {
      ...stub,
      async getWeather(lat, lng) {
        await gate;
        return stub.getWeather(lat, lng);
      },
      async getShelters(lat, lng) {
        release();
        return stub.getShelters(lat, lng);
      },
    };
    const { actions } = await run([toolCalls({ name: "get_weather", args: {} }, { name: "get_shelters", args: {} }), answer("ok")], {}, data);
    expect(actions).toHaveLength(1);
  });

  it("forces a text answer on round 4", async () => {
    const call = toolCalls({ name: "get_weather", args: {} });
    const { actions, requests } = await run([call, call, call, { ...answer("done"), calls: call.calls }]);
    expect(requests.map((r) => r.toolMode)).toEqual(["auto", "auto", "auto", "none"]);
    expect(actions[0]).toMatchObject({ text: "done" });
  });

  it("turns an unknown tool or a failing tool into an error result", async () => {
    const { requests } = await run([
      toolCalls({ name: "launch_drone", args: {} }, { name: "plan_route", args: { destination: "Mars" } }),
      answer("Sorry."),
    ]);
    const [unknown, failing] = responsesIn(requests[1]);
    expect(unknown.response).toEqual({ error: 'No tool named "launch_drone".' });
    expect(failing.response.error).toMatch(/^Unknown place "Mars"/);
  });

  it("throws on an empty final answer, so the handler falls back", async () => {
    await expect(run([answer("")])).rejects.toMatchObject({ message: "agent finished without an answer" });
  });

  it("adds the family text after the reply when a tool raised an SOS", async () => {
    const { actions } = await run([
      toolCalls({ name: "set_status", args: { person_id: "p_amit", status: "sos", reason: "car will not start" } }),
      answer("Help is being alerted."),
    ]);
    expect(actions.map((a) => ("person_id" in a ? a.person_id : a.type))).toEqual(["p_amit", "p_priya"]);
  });

  it("still texts the family through handleEvent when the agent fails after raising an SOS", async () => {
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
    vi.restoreAllMocks();
  });

  it("never sends a phone number to the model", async () => {
    const { requests } = await run([
      toolCalls({ name: "find_person", args: { relation: "family" } }, { name: "get_people_status", args: {} }),
      answer("ok"),
    ]);
    expect(JSON.stringify(requests.map((r) => r.contents)) + requests[0].system).not.toMatch(/\+?\d{10,}/);
  });
});
