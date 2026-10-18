/**
 * Manual start of the radio call from the command line.
 *
 * Usage (from voice/):
 *   npm run radio
 *
 * Calls RADIO_PHONE, or TEST_CALL_TO if that is not set, with the radio agent.
 * The call stays open until someone hangs up.
 */
import { startRadioCall } from "../src/radio.js";

/**
 * Read a required environment variable.
 *
 * Args:
 *   name: The variable name.
 *
 * Returns:
 *   The variable's value.
 *
 * Raises:
 *   Error: If the variable is missing or empty.
 */
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} in .env`);
  return v;
}

const to = process.env.RADIO_PHONE || need("TEST_CALL_TO");
const conversationId = await startRadioCall({
  apiKey: need("ELEVENLABS_API_KEY"),
  radioAgentId: need("ELEVENLABS_RADIO_AGENT_ID"),
  phoneNumberId: need("ELEVENLABS_PHONE_NUMBER_ID"),
  to,
});
console.log(`radio call requested to ${to} (conversation ${conversationId ?? "unknown"})`);
