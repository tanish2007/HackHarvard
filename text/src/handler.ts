/**
 * Decides how Relay replies to one incoming text.
 *
 * This module has no Photon code in it, so it can be tested on its own.
 */

import { isDistress, parseCommand } from "./commands.js";
import type { Registry } from "./registry.js";

export const WELCOME =
  "You're signed up for Relay wildfire alerts. I'll text you if there is a fire near you. " +
  "Reply SOS if you need help, or STOP to leave.";
export const GOODBYE = "You've been removed from Relay. Text JOIN to sign up again.";
export const NOT_SIGNED_UP = "You're not signed up for Relay. Text JOIN to get wildfire alerts.";
export const ACKNOWLEDGED = "Relay got your message.";
export const SOS_RECEIVED =
  "SOS received. I'm flagging this for responders now. " +
  "If you are in immediate danger, call 911.";

/**
 * Work out the reply for one incoming text and update the registry.
 *
 * A first-time sender is signed up automatically. Someone who sent STOP stays
 * out until they text JOIN, except that a call for help always goes through:
 * it is passed on to Core even from someone who is signed out, and it does not
 * sign them back in.
 *
 * @param registry - Who has opted in so far.
 * @param phone - The sender's phone number in E.164 format.
 * @param text - The message text.
 * @returns The reply to send back to the sender, or null when the text is free
 *   text from a signed-up sender and should be passed on to Core.
 */
export function handleText(registry: Registry, phone: string, text: string): string | null {
  const command = parseCommand(text);
  const status = registry.status(phone);

  if (command === "stop") {
    registry.optOut(phone);
    return GOODBYE;
  }

  if (command !== "join" && isDistress(text)) {
    if (status === "unknown") registry.optIn(phone);
    return null;
  }

  if (command === "join" || status === "unknown") {
    const alreadyIn = status === "opted_in";
    registry.optIn(phone);
    return alreadyIn ? ACKNOWLEDGED : WELCOME;
  }

  if (status === "opted_out") return NOT_SIGNED_UP;

  // Opted in and sent free text: the caller forwards it to Core.
  return null;
}
