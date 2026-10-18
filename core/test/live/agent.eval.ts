/**
 * Live tool-selection checks: the seven demo questions against real Gemini.
 *
 * Run on demand with `npm run test:live`, never in `npm test`, because they
 * need GEMINI_API_KEY in .env and use quota. They check the agent calls the
 * right tools in the right order and answers before Core's time limit,
 * not the exact wording.
 *
 * Gemini's free tier allows only a few requests a minute. A 429 shows up as
 * a fallback reply and fails the case, so rerun after a minute.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createGeminiClient, DEFAULT_GEMINI_MODEL } from "../../src/agent/gemini.js";
import type { LlmClient } from "../../src/agent/llm.js";
import { createAgent } from "../../src/agent/loop.js";
import type { Channel, RelayAction } from "../../src/contracts.js";
import { createStubData } from "../../src/data/stub.js";
import { handleEvent } from "../../src/event/handle.js";
import { replies } from "../../src/event/replies.js";
import { makeEvent, makeStore, PHONES } from "../helpers.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

/**
 * One demo question and the tools it must call, in order.
 *
 * Attributes:
 *     text (string): What the sender says.
 *     channel (Channel): Where it comes from.
 *     tools (string[]): Tool names that must appear in this order. Other
 *         calls in between are allowed.
 */
interface DemoCase {
  text: string;
  channel: Channel;
  tools: string[];
}

const CASES: DemoCase[] = [
  { text: "Relay, fastest route to Oak St avoiding the fire line?", channel: "radio", tools: ["get_hazards", "plan_route"] },
  { text: "Relay, how many residents still unaccounted for in Zone 3?", channel: "radio", tools: ["get_people_status"] },
  { text: "Relay, wind forecast next 2 hours?", channel: "radio", tools: ["get_weather"] },
  { text: "where is the nearest shelter?", channel: "imessage", tools: ["get_shelters"] },
  { text: "I have a truck and can carry 4 people", channel: "imessage", tools: ["register_volunteer", "match_volunteer"] },
  { text: "looking for my mom, Priya", channel: "imessage", tools: ["find_person"] },
];

/**
 * Wrap the Gemini client so every tool call it asks for is recorded.
 *
 * Returns:
 *     { llm: LlmClient, calls: string[] }: The client and the tool names, in order.
 */
function recordingGemini() {
  const base = createGeminiClient({ apiKey: apiKey!, model });
  const calls: string[] = [];
  const llm: LlmClient = {
    async generate(request) {
      const res = await base.generate(request);
      calls.push(...res.calls.map((c) => c.name));
      return res;
    },
  };
  return { llm, calls };
}

/**
 * Check that `expected` appears in `actual` in order.
 *
 * Args:
 *     actual (string[]): Tool names called.
 *     expected (string[]): Tool names that must appear, in this order.
 *
 * Returns:
 *     boolean: True if every expected name is found after the previous one.
 */
function inOrder(actual: string[], expected: string[]): boolean {
  let i = 0;
  for (const name of actual) if (name === expected[i]) i++;
  return i === expected.length;
}

/**
 * The text of the reply, whichever action type carries it.
 *
 * Args:
 *     actions (RelayAction[]): Core's reply.
 *
 * Returns:
 *     string: The first reply text, or "".
 */
function replyText(actions: RelayAction[]): string {
  const a = actions[0];
  return a ? (a.type === "place_call" ? a.script : a.text) : "";
}

describe.skipIf(!apiKey)(`demo questions against ${model}`, () => {
  for (const c of CASES) {
    it(`"${c.text}" calls ${c.tools.join(" then ")}`, async () => {
      const { store } = makeStore();
      const { llm, calls } = recordingGemini();
      const agent = createAgent({ store, data: createStubData(store.scenario), llm });
      const event = makeEvent({ text: c.text, channel: c.channel, from: c.channel === "radio" ? PHONES.unit4 : PHONES.amit });
      const { actions } = await handleEvent(event, { store, agent });

      const fallbacks = [replies.fallback(store.scenario.incident.name, "text"), replies.fallback("", "radio")];
      expect(fallbacks, "got the fallback reply: the agent timed out or hit a quota limit").not.toContain(replyText(actions));
      expect(inOrder(calls, c.tools), `tools called: ${calls.join(", ") || "none"}`).toBe(true);
    }, 15_000);
  }

  it('"my car won\'t start, I need help" is an SOS without waiting on the model', async () => {
    const { store } = makeStore();
    const { llm, calls } = recordingGemini();
    const agent = createAgent({ store, data: createStubData(store.scenario), llm });
    const { actions } = await handleEvent(makeEvent({ text: "my car won't start, I need help" }), { store, agent });
    expect(calls).toEqual([]);
    expect(store.getPerson("p_amit")?.status).toBe("sos");
    expect(actions).toContainEqual(expect.objectContaining({ type: "send_text", person_id: "p_priya" }));
  });
});
