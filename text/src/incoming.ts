/**
 * Works out what an incoming iMessage is, from the content Photon hands us.
 *
 * Kept apart from the Photon loop so it can be tested with plain objects.
 */
import type { Location } from "./contracts.js";
import { parseCoordinates, resolveShortLink, type ResolveOptions } from "./location.js";

/** The parts of Photon's message content this module looks at. */
export interface IncomingContent {
  type: string;
  text?: string;
  url?: string;
  name?: string;
  mimeType?: string;
  raw?: { imessage_type?: string };
  read?: () => Promise<Buffer>;
}

/** What to do with an incoming message. */
export type Incoming =
  /** Handle it like a text. `location` is a shared pin if the message carried one. */
  | { kind: "message"; text: string; location: Location | null }
  /** A location Photon cannot read, such as Apple's "Send My Current Location". */
  | { kind: "unreadable_location" }
  /** Nothing to do, such as a read receipt or a reaction. */
  | { kind: "ignore" };

/**
 * Classify one incoming message.
 *
 * A text is itself. A link is treated as text, so a Maps link gives its
 * coordinates. A location card attachment becomes an empty message that
 * carries the location. Apple's own location share arrives as an unsupported
 * message with no coordinates in it.
 *
 * Args:
 *     content: The message content from Photon.
 *
 * Returns:
 *     Incoming: What kind of message it is, and its text and location.
 */
export async function interpretContent(content: IncomingContent, options: ResolveOptions = {}): Promise<Incoming> {
  switch (content.type) {
    case "text":
      return withResolvedLink(content.text ?? "", options);

    case "richlink":
      return content.url ? withResolvedLink(content.url, options) : { kind: "ignore" };

    case "attachment": {
      if (!isLocationCard(content) || !content.read) return { kind: "ignore" };
      try {
        const card = (await content.read()).toString("utf8");
        const location = parseCoordinates(card);
        return location ? { kind: "message", text: "", location } : { kind: "unreadable_location" };
      } catch {
        return { kind: "unreadable_location" };
      }
    }

    case "custom":
      return content.raw?.imessage_type === "unsupported-message" ? { kind: "unreadable_location" } : { kind: "ignore" };

    default:
      return { kind: "ignore" };
  }
}

/**
 * Treat some text as a message, finding the place behind a short Google Maps
 * link if it has one. Coordinates already in the text are left for the relay.
 *
 * Args:
 *     text: The message text or link.
 *     options: Fetch, timeout and redirect limit for following the link.
 *
 * Returns:
 *     Incoming: A message with the text unchanged and the location if found.
 */
async function withResolvedLink(text: string, options: ResolveOptions): Promise<Incoming> {
  const location = parseCoordinates(text) ? null : await resolveShortLink(text, options);
  return { kind: "message", text, location };
}

/**
 * Check whether an attachment is a contact or location card.
 *
 * Args:
 *     content: An attachment's content.
 *
 * Returns:
 *     True for a vCard, which is how shared locations are packaged.
 */
function isLocationCard(content: IncomingContent): boolean {
  return /vcard|vcf/i.test(content.mimeType ?? "") || /\.vcf$/i.test(content.name ?? "");
}
