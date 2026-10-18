/**
 * Finds coordinates in the things people send when they share where they are.
 *
 * Photon cannot read Apple's built-in "Send My Current Location" (it arrives
 * as an unsupported message), so locations come from what can be read: a Maps
 * link, a location card attachment, or typed coordinates.
 */
import type { Location } from "./contracts.js";

const NUMBER = String.raw`-?\d{1,3}(?:\.\d+)?`;

/** Patterns that carry a latitude and longitude, most specific first. */
const PATTERNS: RegExp[] = [
  // Apple Maps and others: ?ll=37.85,-122.22 &q=37.85,-122.22 &sll= &center= &coordinate=
  new RegExp(String.raw`[?&](?:ll|q|sll|center|coordinate|daddr|saddr)=(${NUMBER})(?:,|%2C)\s*(${NUMBER})`, "i"),
  // Google Maps place pages: @37.85,-122.22,15z
  new RegExp(String.raw`@(${NUMBER}),(${NUMBER})`),
  // Google Maps data blobs: !3d37.85!4d-122.22
  new RegExp(String.raw`!3d(${NUMBER})!4d(${NUMBER})`),
  // geo:37.85,-122.22
  new RegExp(String.raw`geo:(${NUMBER}),(${NUMBER})`, "i"),
  // Typed by hand: "37.851, -122.224". Needs decimals, so "12, 34" is not a place.
  new RegExp(String.raw`(?<![\d.])(-?\d{1,3}\.\d{3,})\s*[, ]\s*(-?\d{1,3}\.\d{3,})(?![\d.])`),
];

/**
 * Pull a latitude and longitude out of some text.
 *
 * Args:
 *     text: A message, a URL, or the text of a location card.
 *
 * Returns:
 *     Location | null: The first valid coordinate pair found, or null. A pair
 *         outside the valid range (latitude within 90, longitude within 180) is
 *         ignored.
 */
export function parseCoordinates(text: string): Location | null {
  for (const pattern of PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng };
    }
  }
  return null;
}
