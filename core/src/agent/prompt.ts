/**
 * The system prompt and the per-message context the agent sees.
 *
 * Names, places, and the incident all come from the scenario. Phone numbers
 * and the emergency contact are never included.
 */
import type { Scenario } from "../scenario/schema.js";
import type { AgentContext } from "../event/handle.js";
import { languageName } from "../lang/languages.js";
import { knownPlaceNames } from "./places.js";

/**
 * Build the system instruction.
 *
 * Args:
 *     scenario (Scenario): The loaded scenario.
 *     nowIso (string): Current time, so "next 2 hours" makes sense.
 *
 * Returns:
 *     string: The system prompt.
 */
export function systemPrompt(scenario: Scenario, nowIso: string): string {
  return [
    `You are Relay, the AI coordinator for the ${scenario.incident.name} wildfire evacuation.`,
    "You talk to residents and volunteers by text message, and to fire responders over GMRS radio and phone calls.",
    `The time is ${nowIso}.`,
    `Known places: ${knownPlaceNames(scenario).join(", ")}.`,
    "",
    "Rules:",
    "- Use a tool for every fact about fires, routes, shelters, weather, or people. Never guess or invent numbers, places, or names.",
    "- Radio and voice: one or two short sentences, under 35 words, plain spoken words, no lists, no symbols. Lead with the answer.",
    "- Text: under 320 characters, plain text, no markdown.",
    "- Reply in the sender's language, given as a code and a name, e.g. es (Spanish). If none is given, reply in the language of their message.",
    "- In every language, write the keywords SOS, SAFE, and STOP in Latin capitals, since those are what people reply with.",
    "- If someone describes danger, being stuck, or needing help, call set_status with sos for them, then tell them help is being alerted.",
    "- For a route that must avoid the fire (the fire line, the fire area, danger), call get_hazards first, then plan_route.",
    "- On a phone call with a resident near a fire, say which compass direction leads directly away from it (move_away_toward from get_hazards), e.g. 'head southwest, away from the fire'.",
    "- If someone offers help, a vehicle, or seats, call register_volunteer, then match_volunteer, then plan_route to the person matched. Tell them who and where, and to follow responders' instructions.",
    "- Never say you called 911 or emergency services. A human responder decides that.",
    "- If a tool fails or finds nothing, say what you do know and what to do next.",
    "- Never mention phone numbers, person ids, or tool names.",
  ].join("\n");
}

/**
 * Describe the sender and their message for the model.
 *
 * Args:
 *     ctx (AgentContext): The message and who sent it.
 *     zoneName (string | null): The sender's zone name, if known.
 *
 * Returns:
 *     string: The user turn for the conversation.
 */
export function userTurn(ctx: AgentContext, zoneName: string | null): string {
  const { event, person, unit } = ctx;
  const channel =
    event.channel === "radio"
      ? "radio (spoken over GMRS, keep it very short)"
      : event.channel === "voice"
        ? "phone call (spoken, keep it short)"
        : "text message";

  let from: string;
  if (unit) from = `${unit.name}, a fire responder.`;
  else if (person) {
    from =
      `${person.name} (person_id ${person.person_id}), ${person.role}, status ${person.status}, ` +
      `zone ${zoneName ?? "unknown"}, language ${describeLanguage(person.language)}, ` +
      `location ${person.lat !== null ? "known" : "not shared yet"}.`;
  } else if (event.channel === "radio") from = "A responder on the radio.";
  else from = "An unknown caller.";

  return `Channel: ${channel}\nFrom: ${from}\nMessage: ${ctx.text}`;
}

/**
 * A person's language as the model sees it: the code plus its name.
 *
 * Args:
 *     code (string): The person's language code, e.g. "gu".
 *
 * Returns:
 *     string: E.g. "gu (Gujarati)", or just the code if Relay does not know
 *         its name, so the model can still try.
 */
export function describeLanguage(code: string): string {
  const name = languageName(code);
  return name ? `${code} (${name})` : code;
}
