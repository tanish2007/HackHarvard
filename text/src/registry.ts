/**
 * In-memory record of who has opted in to Relay texts.
 *
 * State is lost on restart, which is fine for the demo. People are keyed by
 * phone number in E.164 format, for example "+14155550123".
 */

/** Whether a phone number is currently signed up, signed out, or unknown. */
export type Status = "opted_in" | "opted_out" | "unknown";

/** Tracks opt-in state for every phone number that has texted Relay. */
export class Registry {
  private readonly people = new Map<string, boolean>();

  /**
   * Look up a phone number.
   *
   * @param phone - The sender's phone number.
   * @returns "opted_in", "opted_out", or "unknown" if they never texted.
   */
  status(phone: string): Status {
    const optedIn = this.people.get(phone);
    if (optedIn === undefined) return "unknown";
    return optedIn ? "opted_in" : "opted_out";
  }

  /**
   * Sign a phone number up for texts.
   *
   * @param phone - The sender's phone number.
   */
  optIn(phone: string): void {
    this.people.set(phone, true);
  }

  /**
   * Remove a phone number from texts. They stay recorded as opted out, so
   * Relay does not sign them back up by accident.
   *
   * @param phone - The sender's phone number.
   */
  optOut(phone: string): void {
    this.people.set(phone, false);
  }

  /**
   * List everyone currently signed up.
   *
   * @returns Phone numbers that are opted in.
   */
  optedInNumbers(): string[] {
    return [...this.people].filter(([, optedIn]) => optedIn).map(([phone]) => phone);
  }
}
