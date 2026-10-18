/**
 * Record of who has opted in to Relay texts.
 *
 * People are keyed by phone number in E.164 format, for example
 * "+14155550123". If a file path is given, the record is saved to it on every
 * change and loaded when the bot starts, so a restart does not make everyone
 * sign up again.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Whether a phone number is currently signed up, signed out, or unknown. */
export type Status = "opted_in" | "opted_out" | "unknown";

/** Tracks opt-in state for every phone number that has texted Relay. */
export class Registry {
  private readonly people = new Map<string, boolean>();

  /**
   * Create a registry.
   *
   * Args:
   *     file: Where to save the record. Omit to keep it in memory only. If the
   *         file exists but cannot be read, the registry starts empty and the
   *         file is replaced on the next change.
   */
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, boolean>;
        for (const [phone, optedIn] of Object.entries(saved)) this.people.set(phone, optedIn === true);
      } catch (err) {
        console.warn(`[registry] could not read ${file}, starting empty: ${String(err)}`);
      }
    }
  }

  /**
   * Look up a phone number.
   *
   * Args:
   *     phone: The sender's phone number.
   *
   * Returns:
   *     Status: "opted_in", "opted_out", or "unknown" if they never texted.
   */
  status(phone: string): Status {
    const optedIn = this.people.get(phone);
    if (optedIn === undefined) return "unknown";
    return optedIn ? "opted_in" : "opted_out";
  }

  /**
   * Sign a phone number up for texts.
   *
   * Args:
   *     phone: The sender's phone number.
   */
  optIn(phone: string): void {
    this.people.set(phone, true);
    this.save();
  }

  /**
   * Remove a phone number from texts. They stay recorded as opted out, so
   * Relay does not sign them back up by accident.
   *
   * Args:
   *     phone: The sender's phone number.
   */
  optOut(phone: string): void {
    this.people.set(phone, false);
    this.save();
  }

  /**
   * List everyone currently signed up.
   *
   * Returns:
   *     string[]: Phone numbers that are opted in.
   */
  optedInNumbers(): string[] {
    return [...this.people].filter(([, optedIn]) => optedIn).map(([phone]) => phone);
  }

  /** Write the record to the file, if there is one. A failure is logged, never thrown. */
  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.people), null, 2));
    } catch (err) {
      console.warn(`[registry] could not save ${this.file}: ${String(err)}`);
    }
  }
}
