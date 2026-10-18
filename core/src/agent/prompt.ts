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
    "- Radio: one or two short sentences, under 35 words, plain spoken words, no lists, no symbols. Lead with the answer.",
    "- Voice: one or two short sentences, under 35 words, plain spoken words, no lists, no symbols, except when giving directions. For directions, say the place, how many minutes the walk is, and the first street, in plain speech, under 60 words.",
    "- Text: under 320 characters, plain text, no markdown.",
    "- Reply in the sender's language, given as a code and a name, e.g. es (Spanish). If none is given, reply in the language of their message.",
    "- In every language, write the keywords SOS, SAFE, and STOP in Latin capitals, since those are what people reply with.",
    "- If someone describes danger, being stuck, or needing help, call set_status with sos for them, then tell them help is being alerted.",
    "- If they ask for help or a shelter and you know where they are, call plan_route with destination \"nearest shelter\" and no origin. Tell them that shelter's name, how far it is, and the walking steps from their current location. If you do not know where they are, ask them to share their location.",
    "- For a route that must avoid the fire (the fire line, the fire area, danger), call get_hazards first, then plan_route.",
    "- On a phone call with a resident, guide them out from their current location on every reply. Call plan_route with destination \"nearest shelter\" and no origin. If they have moved since the last direction, say first whether that move got them closer to the shelter or was the wrong way, and name the direction they actually walked. Then say the shelter name, the direction to go now, the walking minutes, and the first step. Do not reply with only a compass word such as \"move north\". Do this even when they only say they are okay. If they name a different place, route there instead. If their location is not known, ask them to share it and do not invent a path.",
    "- On a phone call with a resident near a fire, say which compass direction leads directly away from it (move_away_toward from get_hazards), e.g. 'head southwest, away from the fire'.",
    "- For questions about real or live fires right now, use get_live_fires and say they are live NASA satellite detections, separate from this incident.",
    "- If get_hazards gives estimated_minutes_until_it_reaches_here, say it as an estimate ('the fire could reach you in about 40 minutes'), and where it is heading. Never promise it will not reach someone.",
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
      `location ${person.lat !== null && person.lng !== null ? `${person.lat.toFixed(6)}, ${person.lng.toFixed(6)}` : "not shared yet"}.`;
  } else if (event.channel === "radio") from = "A responder on the radio.";
  else from = "An unknown caller.";

  const guide =
    event.channel === "voice" && person && person.lat !== null
      ? "\nThey are on the phone. Their coordinates above are the exact point to route from. If they have moved since you last directed them, say whether that move was toward the shelter or the wrong way before you give the next direction. Then say the shelter, the direction, the minutes, and the first step. Do not read the coordinates aloud."
      : "";
  return `Channel: ${channel}\nFrom: ${from}\nMessage: ${ctx.text}${guide}`;
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
