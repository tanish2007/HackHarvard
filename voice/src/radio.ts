/**
 * Starts the always-open radio call.
 *
 * A spare phone sits on speaker next to the GMRS radio. Relay calls it with
 * the radio agent, and the call stays open. Everything said on the radio
 * reaches Core, which only answers when it hears the wake phrase.
 *
 * The radio agent has no opening line and no first-message override, so this
 * sends a plain outbound call request with no conversation overrides.
 */

const OUTBOUND_PATH = "/v1/convai/sip-trunk/outbound-call";

/** Settings for {@link startRadioCall}. */
export interface RadioCallConfig {
  /** ElevenLabs API key. */
  apiKey: string;
  /** Id of the radio agent, the one with the `relay-radio` model and skip_turn. */
  radioAgentId: string;
  /** Id of the imported Photon number in ElevenLabs. */
  phoneNumberId: string;
  /** The phone next to the radio, in E.164 form. */
  to: string;
  /** API host. Defaults to https://api.elevenlabs.io. */
  baseUrl?: string;
  /** Fetch implementation, injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
}

/**
 * Call the radio phone with the radio agent.
 *
 * Args:
 *   config: Credentials, the radio agent and the phone to call.
 *
 * Returns:
 *   The ElevenLabs conversation id, or null if the answer did not include one.
 *
 * Raises:
 *   Error: If ElevenLabs rejects the request.
 */
export async function startRadioCall(config: RadioCallConfig): Promise<string | null> {
  const doFetch = config.fetchImpl ?? fetch;
  const res = await doFetch(`${config.baseUrl ?? "https://api.elevenlabs.io"}${OUTBOUND_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "xi-api-key": config.apiKey },
    body: JSON.stringify({
      agent_id: config.radioAgentId,
      agent_phone_number_id: config.phoneNumberId,
      to_number: config.to,
    }),
    signal: AbortSignal.timeout(config.timeoutMs ?? 30000),
  });
  if (!res.ok) throw new Error(`elevenlabs radio call failed: ${res.status} ${await res.text()}`);
  const body = (await res.json().catch(() => ({}))) as { conversation_id?: unknown };
  return typeof body.conversation_id === "string" ? body.conversation_id : null;
}
