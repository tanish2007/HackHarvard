/**
 * Manual smoke test: place one real outbound call from code.
 *
 * Usage (from voice/):
 *   npm run ring
 *
 * Reads credentials from .env and rings TEST_CALL_TO. Set RING_PERSON_ID to
 * tie the call to a person in scenario.json, for example p_amit. Set
 * RING_SCRIPT to change the opening line.
 */
import { ElevenLabsPlacer } from "../src/elevenlabs.js";

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

const to = need("TEST_CALL_TO");
const placer = new ElevenLabsPlacer({
  apiKey: need("ELEVENLABS_API_KEY"),
  agentId: need("ELEVENLABS_AGENT_ID"),
  phoneNumberId: need("ELEVENLABS_PHONE_NUMBER_ID"),
  resolveNumber: () => to,
  timeoutMs: 30000,
});

await placer.placeCall(
  process.env.RING_PERSON_ID ?? "p_test",
  process.env.RING_SCRIPT ?? "This is Relay. Are you okay?",
  "smoke_test",
  null,
);
console.log(`call requested to ${to}`);
