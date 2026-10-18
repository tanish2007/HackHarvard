/**
 * Tests for finding coordinates in links, cards and typed text.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCoordinates } from "./location.js";

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
