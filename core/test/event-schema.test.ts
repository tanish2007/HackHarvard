/**
 * Tests for Contract A validation (parseEvent).
 *
 * A malformed event from a channel must be rejected with issues that name the
 * field, so the channel owner can fix it before the demo.
 */
import { describe, expect, it } from "vitest";
import { parseEvent } from "../src/event/schema.js";
import { makeEvent } from "./helpers.js";

/**
 * Validate an event with some fields changed or removed.
 *
 * Args:
 *     changes (Record<string, unknown>): Fields to set. A value of undefined
 *         removes the key.
 *
 * Returns:
 *     ReturnType<typeof parseEvent>: The parse result.
 */
function parseWith(changes: Record<string, unknown>) {
  const body: Record<string, unknown> = { ...makeEvent() };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete body[key];
    else body[key] = value;
  }
  return parseEvent(body);
}

/**
 * Get the issues from a parse that should fail.
 *
 * Args:
 *     result (ReturnType<typeof parseEvent>): The parse result.
 *
 * Returns:
 *     string[]: The issues.
 *
 * Raises:
 *     Error: If the parse succeeded.
 */
function issuesOf(result: ReturnType<typeof parseEvent>): string[] {
  if (result.ok) throw new Error("expected the event to be rejected");
  return result.issues;
}

describe("valid events", () => {
  it("accepts the Contract A example", () => {
    const result = parseEvent({
      event_id: "evt_123",
      channel: "imessage",
      person_id: "p_amit",
      from: "+16175550101",
      text: "my car won't start, I need help",
      location: { lat: 37.71, lng: -122.44 },
      media_url: null,
      timestamp: "2026-10-17T14:02:00Z",
    });
    expect(result.ok).toBe(true);
  });

  it.each(["imessage", "sms", "voice", "radio"])("accepts channel %s", (channel) => {
    expect(parseWith({ channel }).ok).toBe(true);
  });

  it("accepts null person_id, location, and media_url", () => {
    expect(parseWith({ person_id: null, location: null, media_url: null }).ok).toBe(true);
  });

  it("accepts empty text, for a location-only update", () => {
    expect(parseWith({ text: "", location: { lat: 37.86, lng: -122.22 } }).ok).toBe(true);
  });

  it("accepts a timestamp with an offset or milliseconds", () => {
    expect(parseWith({ timestamp: "2026-10-17T10:02:00-04:00" }).ok).toBe(true);
    expect(parseWith({ timestamp: "2026-10-17T14:02:00.123Z" }).ok).toBe(true);
  });

  it("accepts coordinates at the edges of the valid range", () => {
    expect(parseWith({ location: { lat: 90, lng: 180 } }).ok).toBe(true);
    expect(parseWith({ location: { lat: -90, lng: -180 } }).ok).toBe(true);
  });

  it("drops unknown extra fields instead of failing", () => {
    const result = parseWith({ extra: "from a newer channel" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event).not.toHaveProperty("extra");
  });

  it("returns the event unchanged otherwise", () => {
    const event = makeEvent({ location: { lat: 37.851, lng: -122.224 }, media_url: "https://example.com/p.jpg" });
    expect(parseEvent(event)).toEqual({ ok: true, event });
  });
});

describe("present but possibly null", () => {
  it.each(["location", "media_url", "person_id"])("rejects an event with %s missing", (key) => {
    expect(issuesOf(parseWith({ [key]: undefined }))).toEqual([expect.stringMatching(new RegExp(`^${key}: `))]);
  });

  it.each(["event_id", "channel", "from", "text", "timestamp"])("rejects an event with %s missing", (key) => {
    expect(issuesOf(parseWith({ [key]: undefined }))[0]).toMatch(new RegExp(`^${key}: `));
  });

  it.each(["event_id", "from", "text", "channel", "timestamp"])("rejects null %s", (key) => {
    expect(issuesOf(parseWith({ [key]: null }))[0]).toMatch(new RegExp(`^${key}: `));
  });
});

describe("bad values", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["an unknown channel", { channel: "whatsapp" }, "channel"],
    ["an empty event_id", { event_id: "" }, "event_id"],
    ["an empty from", { from: "" }, "from"],
    ["an empty person_id", { person_id: "" }, "person_id"],
    ["an empty media_url", { media_url: "" }, "media_url"],
    ["text that is not a string", { text: 42 }, "text"],
    ["a date with no time", { timestamp: "2026-10-17" }, "timestamp"],
    ["a timestamp that is not ISO", { timestamp: "Oct 17 2026 2:02pm" }, "timestamp"],
    ["a timestamp as a number", { timestamp: 1792245720000 }, "timestamp"],
    ["a latitude over 90", { location: { lat: 90.1, lng: 0 } }, "location.lat"],
    ["a latitude under -90", { location: { lat: -91, lng: 0 } }, "location.lat"],
    ["a longitude over 180", { location: { lat: 0, lng: 181 } }, "location.lng"],
    ["a latitude as a string", { location: { lat: "37.8", lng: -122.2 } }, "location.lat"],
    ["a location with no lng", { location: { lat: 37.8 } }, "location.lng"],
    ["a location as a string", { location: "37.8,-122.2" }, "location"],
  ];

  it.each(cases)("rejects %s", (_label, changes, field) => {
    expect(issuesOf(parseWith(changes))[0]).toMatch(new RegExp(`^${field.replace(".", "\\.")}: `));
  });

  it("lists every problem, not just the first", () => {
    const issues = issuesOf(parseWith({ channel: "fax", location: undefined, timestamp: "now" }));
    expect(issues.map((i) => i.split(":")[0]).sort()).toEqual(["channel", "location", "timestamp"]);
  });
});

describe("bodies that are not objects", () => {
  it.each([null, undefined, "SOS", 42, [], [makeEvent()]])("rejects %j with a body issue", (body) => {
    const issues = issuesOf(parseEvent(body));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatch(/^body: /);
  });

  it("rejects an empty object with one issue per required field", () => {
    expect(issuesOf(parseEvent({}))).toHaveLength(8);
  });
});
