/**
 * Validation for Contract A events arriving at POST /event.
 *
 * `location` and `media_url` may be null but must be present. A missing key
 * means the channel built the event wrong, and it gets a 400 so the bug shows
 * up early instead of on stage.
 */
import { z } from "zod";
import type { RelayEvent } from "../contracts.js";

export const relayEventSchema = z.object({
  event_id: z.string().min(1),
  channel: z.enum(["imessage", "sms", "voice", "radio"]),
  person_id: z.string().min(1).nullable(),
  from: z.string().min(1),
  text: z.string(),
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullable(),
  media_url: z.string().min(1).nullable(),
  timestamp: z.iso.datetime({ offset: true }),
}) satisfies z.ZodType<RelayEvent>;

/**
 * Validate a request body as a Contract A event.
 *
 * Args:
 *     body (unknown): The parsed JSON body.
 *
 * Returns:
 *     { ok: true, event: RelayEvent } | { ok: false, issues: string[] }: The
 *         event, or a list of "field: problem" strings for the 400 response.
 */
export function parseEvent(body: unknown): { ok: true; event: RelayEvent } | { ok: false; issues: string[] } {
  const result = relayEventSchema.safeParse(body);
  if (result.success) return { ok: true, event: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`),
  };
}
