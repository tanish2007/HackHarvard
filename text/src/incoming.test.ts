/**
 * Tests for classifying the content of an incoming message.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { interpretContent } from "./incoming.js";

const PIN = { lat: 40.7, lng: -74.0 };
const CARD = "BEGIN:VCARD\nVERSION:3.0\nitem1.URL:http://maps.apple.com/?ll=40.7,-74.0&q=Pin\nEND:VCARD";

test("text is passed through", async () => {
  assert.deepEqual(await interpretContent({ type: "text", text: "hello" }), {
    kind: "message",
    text: "hello",
    location: null,
  });
});

test("a link is treated as text, so a Maps link keeps its coordinates", async () => {
  const url = "https://maps.apple.com/?ll=40.7,-74.0";
  assert.deepEqual(await interpretContent({ type: "richlink", url }), { kind: "message", text: url, location: null });
});

test("a location card attachment becomes an empty message with the location", async () => {
  const result = await interpretContent({
    type: "attachment",
    name: "Current Location.loc.vcf",
    mimeType: "text/vcard",
    read: async () => Buffer.from(CARD),
  });
  assert.deepEqual(result, { kind: "message", text: "", location: PIN });
});

test("a card with no coordinates, or one that cannot be read, is an unreadable location", async () => {
  const empty = { type: "attachment", name: "x.vcf", mimeType: "text/vcard" };
  assert.deepEqual(await interpretContent({ ...empty, read: async () => Buffer.from("BEGIN:VCARD\nEND:VCARD") }), {
    kind: "unreadable_location",
  });
  assert.deepEqual(
    await interpretContent({
      ...empty,
      read: async () => {
        throw new Error("gone");
      },
    }),
    { kind: "unreadable_location" },
  );
});

test("a photo or other attachment is ignored for now", async () => {
  const photo = { type: "attachment", name: "IMG_1.jpg", mimeType: "image/jpeg", read: async () => Buffer.from("x") };
  assert.deepEqual(await interpretContent(photo), { kind: "ignore" });
});

test("Apple's own location share arrives as an unsupported message", async () => {
  const content = { type: "custom", raw: { imessage_type: "unsupported-message" } };
  assert.deepEqual(await interpretContent(content), { kind: "unreadable_location" });
});

test("other custom content, receipts and reactions are ignored", async () => {
  assert.deepEqual(await interpretContent({ type: "custom", raw: { imessage_type: "other" } }), { kind: "ignore" });
  assert.deepEqual(await interpretContent({ type: "read" }), { kind: "ignore" });
  assert.deepEqual(await interpretContent({ type: "reaction" }), { kind: "ignore" });
});
