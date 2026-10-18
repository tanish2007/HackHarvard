/**
 * Places outbound calls through ElevenLabs over the Photon SIP trunk.
 *
 * Photon carries the call over SIP. ElevenLabs runs the voice agent. This
 * file implements the {@link CallPlacer} interface so the rest of the voice
 * lane does not know which platform is behind it.
 */
import type { CallPlacer } from "./ports.js";

const OUTBOUND_PATH = "/v1/convai/sip-trunk/outbound-call";

/** Settings for {@link ElevenLabsPlacer}. */
export interface ElevenLabsConfig {
  /** ElevenLabs API key. Read from the environment, never hardcoded. */
  apiKey: string;
  /** Id of the published agent that speaks on outbound calls. */
  agentId: string;
  /** Id of the imported Photon number in ElevenLabs. */
  phoneNumberId: string;
  /** API host. Defaults to https://api.elevenlabs.io. */
  baseUrl?: string;
  /** Map a Contract E person id to an E.164 phone number, or null. */
  resolveNumber: (personId: string) => string | null;
  /** Fetch implementation, injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Request timeout in milliseconds. Defaults to 10000. */
  timeoutMs?: number;
}

/** Places calls with the ElevenLabs SIP trunk outbound-call API. */
export class ElevenLabsPlacer implements CallPlacer {
  /**
   * Create a placer.
   *
   * Args:
   *   config: API credentials, agent ids and the number lookup.
   */
  constructor(private readonly config: ElevenLabsConfig) {}

  /**
   * Call a person and have the agent open with the given script.
   *
   * Args:
   *   personId: The Contract E person id to call.
   *   script: The first thing the agent says when the call connects.
   *   reason: Why the call is placed, passed to the agent as a dynamic
   *     variable.
   *   toNumber: The number Core supplied, if any. Takes priority over the
   *     scenario lookup.
   *
   * Raises:
   *   Error: If no number is known for the person, or ElevenLabs rejects
   *     the request.
   */
  async placeCall(
    personId: string,
    script: string,
    reason: string,
    toNumber: string | null,
  ): Promise<void> {
    const to = toNumber ?? this.config.resolveNumber(personId);
    if (!to) throw new Error(`no phone number for ${personId}`);

    const doFetch = this.config.fetchImpl ?? fetch;
    const res = await doFetch(`${this.config.baseUrl ?? "https://api.elevenlabs.io"}${OUTBOUND_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": this.config.apiKey },
      body: JSON.stringify({
        agent_id: this.config.agentId,
        agent_phone_number_id: this.config.phoneNumberId,
        to_number: to,
        conversation_initiation_client_data: {
          conversation_config_override: { agent: { first_message: script } },
          dynamic_variables: { person_id: personId, caller_number: to, reason },
        },
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 10000),
    });
    if (!res.ok) {
      throw new Error(`elevenlabs outbound call failed: ${res.status} ${await res.text()}`);
    }
  }
}
