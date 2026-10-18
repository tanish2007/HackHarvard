/**
 * Tests for finding coordinates in links, cards and typed text.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCoordinates, resolveShortLink } from "./location.js";

const AMIT = { lat: 37.851, lng: -122.224 };

test("an Apple Maps link", () => {
  assert.deepEqual(parseCoordinates("https://maps.apple.com/?ll=37.851,-122.224&q=Dropped%20Pin"), AMIT);
  assert.deepEqual(parseCoordinates("https://maps.apple.com/?q=37.851,-122.224"), AMIT);
  assert.deepEqual(parseCoordinates("https://maps.apple.com/?sll=37.851%2C-122.224"), AMIT);
});

test("a Google Maps link", () => {
  assert.deepEqual(parseCoordinates("https://www.google.com/maps/place/x/@37.851,-122.224,15z"), AMIT);
  assert.deepEqual(parseCoordinates("https://www.google.com/maps/place/x/data=!3d37.851!4d-122.224"), AMIT);
  assert.deepEqual(parseCoordinates("https://maps.google.com/?q=37.851,-122.224"), AMIT);
});

test("a location card (vCard) with a Maps URL line", () => {
  const card = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "N:;Current Location;;;",
    "item1.URL;type=pref:http://maps.apple.com/?ll=37.851,-122.224&q=37.851,-122.224",
    "END:VCARD",
  ].join("\n");
  assert.deepEqual(parseCoordinates(card), AMIT);
});

test("a geo: link", () => {
  assert.deepEqual(parseCoordinates("geo:37.851,-122.224"), AMIT);
});

test("typed coordinates, with a comma or a space", () => {
  assert.deepEqual(parseCoordinates("I'm at 37.851, -122.224 please help"), AMIT);
  assert.deepEqual(parseCoordinates("37.851 -122.224"), AMIT);
});

test("ordinary text and short numbers are not places", () => {
  for (const text of ["hello", "I am at 12, 34 Oak Street", "call 617 555 0101", "route 24, exit 7", ""]) {
    assert.equal(parseCoordinates(text), null, text);
  }
});

test("out-of-range numbers are ignored", () => {
  assert.equal(parseCoordinates("https://maps.apple.com/?ll=137.851,-122.224"), null);
  assert.equal(parseCoordinates("37.851, -222.224"), null);
});

/** Build a fake fetch from a map of url to response. A string value is a redirect target. */
function fakeNetwork(routes: Record<string, string | { body: string }>, seen: string[] = []): typeof fetch {
  return (async (url: string) => {
    seen.push(String(url));
    const route = routes[String(url)];
    if (route === undefined) return new Response("not found", { status: 404 });
    if (typeof route === "string") return new Response(null, { status: 302, headers: { location: route } });
    return new Response(route.body, { status: 200 });
  }) as unknown as typeof fetch;
}

const SHORT = "https://maps.app.goo.gl/AbCd123";

test("a short Google Maps link is followed to the coordinates in its redirect", async () => {
  const fetchImpl = fakeNetwork({
    [SHORT]: "https://www.google.com/maps/place/Oak+Ridge/@37.851,-122.224,17z/data=!3m1",
  });
  assert.deepEqual(await resolveShortLink(`I'm here ${SHORT}`, { fetchImpl }), AMIT);
});

test("several redirects are followed", async () => {
  const fetchImpl = fakeNetwork({
    [SHORT]: "https://goo.gl/maps/step2",
    "https://goo.gl/maps/step2": "https://www.google.com/maps?q=37.851,-122.224",
  });
  assert.deepEqual(await resolveShortLink(SHORT, { fetchImpl }), AMIT);
});

test("with no redirect, the coordinates in the page are used", async () => {
  const fetchImpl = fakeNetwork({
    [SHORT]: { body: '<meta content="https://maps.google.com/maps/api/staticmap?center=37.851%2C-122.224&zoom=15">' },
  });
  assert.deepEqual(await resolveShortLink(SHORT, { fetchImpl }), AMIT);
});

test("a link that leaves Google is never followed", async () => {
  const seen: string[] = [];
  const fetchImpl = fakeNetwork({ [SHORT]: "https://evil.example.com/steal" }, seen);
  assert.equal(await resolveShortLink(SHORT, { fetchImpl }), null);
  assert.deepEqual(seen, [SHORT]);
});

test("text with no short link makes no request", async () => {
  const seen: string[] = [];
  assert.equal(await resolveShortLink("hello https://example.com/x", { fetchImpl: fakeNetwork({}, seen) }), null);
  assert.equal(await resolveShortLink("https://evil.example.com/maps.app.goo.gl/x", { fetchImpl: fakeNetwork({}, seen) }), null);
  assert.deepEqual(seen, []);
});

test("a failure, a loop or a slow answer gives null, never an error", async () => {
  const boom = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  assert.equal(await resolveShortLink(SHORT, { fetchImpl: boom }), null);
  assert.equal(await resolveShortLink(SHORT, { fetchImpl: fakeNetwork({ [SHORT]: SHORT }), maxHops: 3 }), null);
  assert.equal(await resolveShortLink(SHORT, { fetchImpl: fakeNetwork({}) }), null);
});
