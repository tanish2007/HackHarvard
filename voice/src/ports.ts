/**
 * Interfaces the voice lane needs from the telephony layer.
 *
 * The Photon SIP integration implements these. Everything else in this lane
 * depends only on these interfaces, so the real telephony can be swapped in
 * for a fake without changing any other code.
 */

/** An open call that Relay can speak on. */
export interface CallSession {
  /**
   * Speak a sentence on the open call.
   *
   * Args:
   *   text: What Relay should say out loud.
   */
  speak(text: string): Promise<void>;
}

/** Places outbound calls. */
export interface CallPlacer {
  /**
   * Call a person and speak a script when they answer.
   *
   * Args:
   *   personId: The Contract E person id to call.
   *   script: What Relay should say when the call connects.
   *   reason: Why the call is being placed, for example missed_checkin.
   *   to: The number to dial if Core supplied one. When null, the placer
   *     looks the person up itself.
   */
  placeCall(personId: string, script: string, reason: string, to: string | null): Promise<void>;
}
