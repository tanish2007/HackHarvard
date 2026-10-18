/**
 * The agent loop: LLM with tool calling.
 *
 * Each round, the model either calls tools (Core runs them and sends the
 * results back) or answers. The last round forces a text answer, so the loop
 * always ends. The handler wraps this in a time limit and falls back to a
 * fixed reply if the agent throws or runs too long.
 */
import type { RelayAction } from "../contracts.js";
import type { DataTools } from "../data/types.js";
import type { Agent } from "../event/handle.js";
import type { IncidentStore } from "../state/store.js";
import type { LlmClient, LlmContent } from "./llm.js";
import { systemPrompt, userTurn } from "./prompt.js";
import { TOOLS, type ToolContext } from "./tools.js";

/** Rounds per message: up to three of tool calls, then a forced answer. */
export const DEFAULT_MAX_ROUNDS = 4;

/**
 * What the agent needs.
 *
 * Attributes:
 *     store (IncidentStore): The live incident state.
 *     data (DataTools): The Contract C functions.
 *     llm (LlmClient): The model.
 *     maxRounds (number | undefined): Rounds per message. Defaults to 4.
 *     log ((msg: string) => void | undefined): Debug logger for tool calls.
 */
export interface AgentDeps {
  store: IncidentStore;
  data: DataTools;
  llm: LlmClient;
  maxRounds?: number;
  log?: (msg: string) => void;
}

/**
 * Build the agent the event handler calls.
 *
 * Args:
 *     deps (AgentDeps): Store, data tools, and the LLM.
 *
 * Returns:
 *     Agent: A function from one message to the actions to send.
 */
export function createAgent(deps: AgentDeps): Agent {
  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const declarations = TOOLS.map((t) => t.declaration);
  const byName = new Map(TOOLS.map((t) => [t.declaration.name, t]));

  return async (ctx) => {
    const { store } = deps;
    const scenario = store.scenario;
    const commandPost = scenario.places.find((p) => p.id === scenario.settings.command_post)!;
    const origin =
      ctx.person && ctx.person.lat !== null && ctx.person.lng !== null
        ? { name: "the sender's location", lat: ctx.person.lat, lng: ctx.person.lng }
        : { name: commandPost.name, lat: commandPost.lat, lng: commandPost.lng };

    const toolCtx: ToolContext = {
      store,
      data: deps.data,
      person: ctx.person,
      unit: ctx.unit,
      who: ctx.who,
      isResponder: Boolean(ctx.unit) || ctx.event.channel === "radio",
      origin,
      extraActions: [],
    };

    const zone = scenario.zones.find((z) => z.id === ctx.person?.zone)?.name ?? null;
    const system = systemPrompt(scenario, new Date().toISOString());
    const contents: LlmContent[] = [{ role: "user", parts: [{ text: userTurn(ctx, zone) }] }];

    let text = "";
    for (let round = 0; round < maxRounds; round++) {
      const last = round === maxRounds - 1;
      const res = await deps.llm.generate({ system, contents, tools: declarations, toolMode: last ? "none" : "auto", signal: ctx.signal });
      if (res.calls.length === 0 || last) {
        text = res.text;
        break;
      }

      contents.push(res.content);
      const parts = await Promise.all(
        res.calls.map(async (call) => {
          const tool = byName.get(call.name);
          let response: Record<string, unknown>;
          try {
            response = tool ? { output: await tool.run(call.args, toolCtx) } : { error: `No tool named "${call.name}".` };
          } catch (err) {
            response = { error: (err as Error).message };
          }
          deps.log?.(`[agent] ${call.name}(${JSON.stringify(call.args)}) -> ${JSON.stringify(response).slice(0, 200)}`);
          return { functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response } };
        }),
      );
      contents.push({ role: "user", parts });
    }

    if (!text) throw new Error("agent finished without an answer");
    return [replyAction(ctx, text), ...toolCtx.extraActions];
  };
}

/**
 * Turn the agent's answer into a reply on the sender's channel.
 *
 * Args:
 *     ctx (Parameters<Agent>[0]): The message context.
 *     text (string): The answer.
 *
 * Returns:
 *     RelayAction: say for voice and radio, send_text for texts.
 */
function replyAction(ctx: Parameters<Agent>[0], text: string): RelayAction {
  const spoken = ctx.event.channel === "voice" || ctx.event.channel === "radio";
  const target = ctx.person
    ? { id: ctx.person.person_id, handle: ctx.person.handle }
    : ctx.unit
      ? { id: ctx.unit.unit_id, handle: ctx.unit.handle }
      : undefined;
  if (spoken || !target) return { type: "say", text };
  return { type: "send_text", person_id: target.id, to: target.handle, text, map_url: null };
}
