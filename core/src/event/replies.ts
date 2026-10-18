/**
 * Fixed reply texts for the fast rules and fallbacks.
 *
 * These go out without the LLM, so they must be short, calm, and always
 * correct. Names and the incident name come from the scenario, never from
 * here. English only for now; translation comes with the multilingual step.
 */

/** Ways Relay can be talking to someone. Voice and radio are spoken. */
export type Medium = "text" | "spoken";

export const replies = {
  /**
   * Welcome for someone who just signed up by texting Relay.
   *
   * Args:
   *     incident (string): Incident name.
   *     hasLocation (boolean): Whether they already shared a location.
   *
   * Returns:
   *     string: The welcome text.
   */
  welcome(incident: string, hasLocation: boolean): string {
    const ask = hasLocation ? "" : " Please share your location so we can send your personal route.";
    return (
      `Welcome to Relay for the ${incident}. You'll get your evacuation route and nearest shelter here.${ask}` +
      " Reply SOS anytime if you need help, or STOP to opt out."
    );
  },

  /**
   * Confirmation after STOP.
   *
   * Args:
   *     incident (string): Incident name.
   *
   * Returns:
   *     string: The opt-out text.
   */
  stopped(incident: string): string {
    return `You're unsubscribed from Relay alerts for the ${incident}. Text us anytime to sign up again.`;
  },

  /**
   * Reply to someone who sent an SOS.
   *
   * Args:
   *     name (string): Their name.
   *     medium (Medium): Text or spoken.
   *     hasLocation (boolean): Whether Relay knows where they are. If not,
   *         the text asks them to share it so responders can find them.
   *
   * Returns:
   *     string: The SOS acknowledgement.
   */
  sos(name: string, medium: Medium, hasLocation: boolean): string {
    if (medium === "spoken") return `${name}, I've marked you as needing help. Responders are being alerted now.`;
    const where = hasLocation ? "" : "Please share your location so responders can find you. ";
    return (
      `Relay got your SOS, ${name}. Responders are being alerted now. ${where}` +
      "Stay where you are safest and keep your phone on. Reply SAFE once you are out of danger."
    );
  },

  /**
   * Reply to an SOS from a sender Relay does not know, such as a caller.
   *
   * Args:
   *     medium (Medium): Text or spoken.
   *
   * Returns:
   *     string: The acknowledgement.
   */
  sosUnknown(medium: Medium): string {
    if (medium === "spoken") return "I've logged your call for help. Responders are being alerted now.";
    return "Relay got your SOS. Responders are being alerted now.";
  },

  /**
   * Welcome back someone who sent STOP and then texted again.
   *
   * Args:
   *     name (string): Their name.
   *     incident (string): Incident name.
   *
   * Returns:
   *     string: The welcome back text.
   */
  welcomeBack(name: string, incident: string): string {
    return `Welcome back, ${name}. You're signed up again for Relay alerts for the ${incident}. Reply SOS anytime if you need help, or STOP to opt out.`;
  },

  /**
   * Text to a family contact when their person sends an SOS.
   *
   * Args:
   *     name (string): The person who sent the SOS.
   *     incident (string): Incident name.
   *
   * Returns:
   *     string: The family alert.
   */
  familySos(name: string, incident: string): string {
    return `Relay: ${name} sent an SOS during the ${incident}. Responders have been alerted. We'll let you know when they're safe.`;
  },

  /**
   * Reply to someone who said they are safe.
   *
   * Args:
   *     name (string): Their name.
   *     held (boolean): True if they are in SOS, which stays open until a
   *         responder confirms.
   *     medium (Medium): Text or spoken.
   *
   * Returns:
   *     string: The confirmation.
   */
  safe(name: string, held: boolean, medium: Medium): string {
    if (held) return `Thanks, ${name}. Your SOS stays open until a responder confirms you're safe.`;
    if (medium === "spoken") return `Thanks, ${name}. I've marked you safe.`;
    return `Thanks, ${name}. You're marked safe. Reply SOS anytime if that changes.`;
  },

  /**
   * Reply to someone who said they are leaving.
   *
   * Args:
   *     name (string): Their name.
   *     held (boolean): True if they are in SOS.
   *     medium (Medium): Text or spoken.
   *
   * Returns:
   *     string: The confirmation.
   */
  enRoute(name: string, held: boolean, medium: Medium): string {
    if (held) return `Got it, ${name}. Your SOS stays open until a responder confirms you're safe.`;
    if (medium === "spoken") return `Got it, ${name}. I've marked you as on your way. Drive safely.`;
    return `Got it, ${name}. You're marked as on your way. Reply SAFE when you arrive, or SOS if you need help.`;
  },

  /**
   * Reply to a location share with no text.
   *
   * Args:
   *     name (string): Their name.
   *
   * Returns:
   *     string: The confirmation.
   */
  locationThanks(name: string): string {
    return `Thanks, ${name}. We have your location and will text your route and nearest shelter if an alert reaches your area.`;
  },

  /**
   * Fallback when no rule matched and the agent is not available.
   *
   * Args:
   *     incident (string): Incident name.
   *     channel ("text" | "voice" | "radio"): Where the message came from.
   *
   * Returns:
   *     string: A short reply that still tells people what they can do.
   */
  fallback(incident: string, channel: "text" | "voice" | "radio"): string {
    if (channel === "radio") return "Relay copies. I can't answer that right now. Stand by.";
    if (channel === "voice") return "This is Relay. Say safe if you are safe, or help if you need help.";
    return `Relay here for the ${incident}. Reply SAFE if you are safe, SOS if you need help, or STOP to opt out.`;
  },

  /**
   * Fire alert text the hazard watcher sends to someone near a fire.
   *
   * Args:
   *     alert (FireAlert): Who, how far, which way, and the nearest shelter.
   *
   * Returns:
   *     string: The alert text.
   */
  fireAlert(alert: FireAlert): string {
    const where = alert.inside
      ? "you are inside the fire area"
      : `the fire is ${km(alert.fireKm)} km ${alert.direction} of you`;
    let shelter = "";
    if (alert.shelter) {
      const s = alert.shelter;
      const trip = s.minutes === null ? `${km(s.km)} km away` : `${km(s.km)} km, about ${minutes(s.minutes)} min by car`;
      shelter = ` Nearest shelter: ${s.name}, ${trip}.`;
    }
    return (
      `Relay alert for the ${alert.incident}, ${alert.name}: ${where}.${shelter}` +
      " Reply SAFE if you are safe, or SOS if you need help."
    );
  },

  /**
   * Script for the check-in call when someone does not answer an alert.
   *
   * It asks "Are you safe" on purpose: a bare "yes" on a call counts as safe
   * in the fast rules, so the question has to make "yes" mean safe.
   *
   * Args:
   *     incident (string): Incident name.
   *
   * Returns:
   *     string: The spoken script.
   */
  checkinCall(incident: string): string {
    return (
      `This is Relay, the service that just texted you about the ${incident}. ` +
      "Are you safe right now? Say yes if you are safe, or help if you need help."
    );
  },

  /**
   * Script for the call to a family contact when Relay cannot reach someone.
   *
   * It ends by asking whether the family member is safe, so a "yes" or "ok"
   * from them only ever marks themselves safe, never the missing person.
   *
   * Args:
   *     name (string): The person Relay cannot reach.
   *     incident (string): Incident name.
   *
   * Returns:
   *     string: The spoken script.
   */
  familyCall(name: string, incident: string): string {
    return (
      `This is Relay, calling about the ${incident}. We sent ${name} a fire alert and called them, but could not reach them. ` +
      `If you can, please try to reach ${name} and ask them to text Relay back. Responders are being told. ` +
      "Are you safe yourself? Say yes if you are safe, or help if you need help."
    );
  },

  /**
   * Spoken briefing for the emergency call a responder confirmed.
   *
   * Args:
   *     brief (EmergencyBrief): Who needs help, where, and for how long.
   *
   * Returns:
   *     string: The spoken script.
   */
  emergencyBriefing(brief: EmergencyBrief): string {
    const parts = [
      `This is Relay, an automated evacuation service for the ${brief.incident}. A responder confirmed this call.`,
      `${brief.name} needs help.`,
      `Last known location: ${brief.where}.`,
      `They have been flagged as needing help for ${duration(brief.sosMinutes)}.`,
    ];
    if (brief.lastMessage) parts.push(`Their last message was: ${brief.lastMessage}.`);
    return parts.join(" ");
  },
};

/**
 * What goes into a fire alert.
 *
 * Attributes:
 *     name (string): The person being alerted.
 *     incident (string): Incident name.
 *     fireKm (number): Distance from them to the fire's edge, in km.
 *     direction (string): Compass word from them to the fire, e.g. "northeast".
 *     inside (boolean): True if they are inside the fire circle.
 *     shelter ({ name, km, minutes } | null): Nearest shelter. `km` is the
 *         route length (or straight-line distance if routing failed), and
 *         `minutes` the drive time, or null if routing failed.
 */
export interface FireAlert {
  name: string;
  incident: string;
  fireKm: number;
  direction: string;
  inside: boolean;
  shelter: { name: string; km: number; minutes: number | null } | null;
}

/**
 * What goes into the emergency briefing.
 *
 * Attributes:
 *     name (string): The person in SOS.
 *     incident (string): Incident name.
 *     where (string): Spoken location, e.g. "Zone 3, about 0.4 km from Oak St".
 *     sosMinutes (number): How long they have been in SOS.
 *     lastMessage (string | null): Their last message, if any.
 */
export interface EmergencyBrief {
  name: string;
  incident: string;
  where: string;
  sosMinutes: number;
  lastMessage: string | null;
}

/**
 * Format a distance for a text, to one decimal place.
 *
 * Args:
 *     value (number): Kilometres.
 *
 * Returns:
 *     string: e.g. "2.3".
 */
function km(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

/**
 * Format a drive time in whole minutes, never less than one.
 *
 * Args:
 *     value (number): Minutes.
 *
 * Returns:
 *     string: e.g. "6".
 */
function minutes(value: number): string {
  return String(Math.max(1, Math.ceil(value)));
}

/**
 * Say how long something has lasted.
 *
 * Args:
 *     mins (number): Minutes, possibly fractional.
 *
 * Returns:
 *     string: "less than a minute", "1 minute", or "N minutes".
 */
function duration(mins: number): string {
  const whole = Math.floor(mins);
  if (whole < 1) return "less than a minute";
  return whole === 1 ? "1 minute" : `${whole} minutes`;
}
