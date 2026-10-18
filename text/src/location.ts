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

/** Short Google Maps links, which hide the coordinates behind a redirect. */
const SHORT_LINK = /https?:\/\/(?:maps\.app\.goo\.gl\/|goo\.gl\/maps\/)[^\s]+/i;

/** Only follow redirects to Google's own hosts, so a message cannot aim us elsewhere. */
const GOOGLE_HOST = /(^|\.)(google\.com|goo\.gl|g\.co)$/i;

/** Options for {@link resolveShortLink}. */
export interface ResolveOptions {
  /** Fetch implementation, injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Time allowed for each request in milliseconds. Defaults to 3000. */
  timeoutMs?: number;
  /** Most redirects to follow. Defaults to 5. */
  maxHops?: number;
}

/**
 * Find the coordinates behind a short Google Maps link in some text.
 *
 * Google Maps shares a location as a link like https://maps.app.goo.gl/abc123.
 * The coordinates are not in it, but the redirect it leads to has them.
 *
 * Args:
 *     text: A message that may contain a short Maps link.
 *     options: Fetch, timeout and redirect limit.
 *
 * Returns:
 *     Location | null: The coordinates, or null if the text has no short link,
 *         the link leaves Google, or anything goes wrong. Never throws.
 */
export async function resolveShortLink(text: string, options: ResolveOptions = {}): Promise<Location | null> {
  const doFetch = options.fetchImpl ?? fetch;
  let url = SHORT_LINK.exec(text)?.[0];
  if (!url) return null;

  try {
    for (let hop = 0; hop <= (options.maxHops ?? 5); hop++) {
      if (!GOOGLE_HOST.test(new URL(url).hostname)) return null;
      const res = await doFetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
      });
      const next = res.headers.get("location");
      if (!next) {
        // No redirect: the page itself may name the place, for example in a map image URL.
        return parseCoordinates((await res.text()).slice(0, 200_000));
      }
      url = new URL(next, url).toString();
      const found = parseCoordinates(url);
      if (found) return found;
    }
  } catch {
    return null;
  }
  return null;
}
