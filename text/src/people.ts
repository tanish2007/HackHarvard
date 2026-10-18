/**
 * Maps a sender's phone number to a person_id and starting location.
 *
 * Names, numbers and coordinates come from scenario.json, with real phone
 * numbers merged in from the gitignored scenario.local.json (Contract E).
 * Nothing about a person is hardcoded in this lane.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Location } from "./contracts.js";

/** One person from the scenario who has a phone number. */
export interface KnownPerson {
  person_id: string;
  phone: string;
  location: Location | null;
}

/** Who a phone number belongs to. */
export interface Resolved {
  person_id: string;
  location: Location | null;
  /** True if the number is in the scenario, false for a stranger. */
  known: boolean;
}

/**
 * Reduce a phone number to digits with a leading plus, so formats compare equal.
 *
 * Args:
 *     phone: A phone number in any common format.
 *
 * Returns:
 *     string: For example "+14155550123".
 */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

/** Lookup of people by phone number. */
export class PeopleDirectory {
  private readonly byPhone = new Map<string, KnownPerson>();
  private readonly byId = new Map<string, KnownPerson>();

  /**
   * Build the directory.
   *
   * Args:
   *     people: Everyone in the scenario who has a phone number.
   */
  constructor(people: KnownPerson[]) {
    for (const person of people) {
      this.byPhone.set(normalizePhone(person.phone), person);
      this.byId.set(person.person_id, person);
    }
  }

  /**
   * Find the phone number for a person, to text them first.
   *
   * Args:
   *     personId: A person_id from the scenario, such as "p_amit".
   *
   * Returns:
   *     string | null: Their phone number, or null if the scenario has no
   *         number for them (for example a simulated resident).
   */
  phoneFor(personId: string): string | null {
    const person = this.byId.get(personId);
    return person ? normalizePhone(person.phone) : null;
  }

  /**
   * Find who a phone number belongs to.
   *
   * Args:
   *     phone: The sender's phone number.
   *
   * Returns:
   *     Resolved: The scenario person, or a made-up id "p_<last 4 digits>" with
   *         no location for a number the scenario does not list.
   */
  resolve(phone: string): Resolved {
    const normalized = normalizePhone(phone);
    const person = this.byPhone.get(normalized);
    if (person) return { person_id: person.person_id, location: person.location, known: true };
    return { person_id: `p_${normalized.slice(-4)}`, location: null, known: false };
  }
}

/**
 * Load the directory from scenario.json and scenario.local.json.
 *
 * Args:
 *     dir: Folder holding the scenario files. Defaults to the repo root.
 *
 * Returns:
 *     PeopleDirectory: Everyone in the scenario who has a phone number.
 *
 * Raises:
 *     Error: If scenario.json is missing or is not valid JSON.
 */
export function loadDirectory(dir: string = repoRoot()): PeopleDirectory {
  const scenario = readJson(join(dir, "scenario.json")) as {
    people?: { person_id: string; phone: string | null; lat: number; lng: number }[];
  };
  const localPath = join(dir, "scenario.local.json");
  const phones = existsSync(localPath)
    ? ((readJson(localPath) as { phones?: Record<string, string> }).phones ?? {})
    : {};

  const people: KnownPerson[] = [];
  for (const p of scenario.people ?? []) {
    const phone = phones[p.person_id] ?? p.phone;
    if (!phone) continue;
    people.push({ person_id: p.person_id, phone, location: { lat: p.lat, lng: p.lng } });
  }
  return new PeopleDirectory(people);
}

/** The repo root, found from this file so the working directory does not matter. */
function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Read and parse a JSON file.
 *
 * Args:
 *     path: File to read.
 *
 * Returns:
 *     unknown: The parsed JSON.
 *
 * Raises:
 *     Error: If the file cannot be read or is not valid JSON.
 */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Could not read ${path}: ${(err as Error).message}`);
  }
}
