/**
 * Tests for keyword parsing and the opt-in and STOP flow.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCommand } from "./commands.js";
import { ACKNOWLEDGED, GOODBYE, NOT_SIGNED_UP, WELCOME, handleText } from "./handler.js";
import { Registry } from "./registry.js";

const PHONE = "+14155550123";

test("parseCommand recognises STOP in any case and with punctuation", () => {
  for (const text of ["STOP", "stop", "  Stop. ", "unsubscribe", "Cancel!"]) {
    assert.equal(parseCommand(text), "stop", text);
  }
});

test("parseCommand recognises JOIN", () => {
  for (const text of ["JOIN", "join", "Yes", "start"]) {
    assert.equal(parseCommand(text), "join", text);
  }
});

test("parseCommand ignores keywords inside longer sentences", () => {
  for (const text of ["stop the fire", "my car won't start", "SOS", ""]) {
    assert.equal(parseCommand(text), "other", text);
  }
});

test("a first text signs the sender up", () => {
  const registry = new Registry();
  assert.equal(handleText(registry, PHONE, "hello"), WELCOME);
  assert.equal(registry.status(PHONE), "opted_in");
});

test("free text from a signed-up sender is acknowledged", () => {
  const registry = new Registry();
  handleText(registry, PHONE, "hello");
  assert.equal(handleText(registry, PHONE, "where is the shelter"), ACKNOWLEDGED);
});

test("STOP removes the sender and confirms", () => {
  const registry = new Registry();
  handleText(registry, PHONE, "hello");
  assert.equal(handleText(registry, PHONE, "STOP"), GOODBYE);
  assert.equal(registry.status(PHONE), "opted_out");
  assert.deepEqual(registry.optedInNumbers(), []);
});

test("an opted-out sender is not signed back up by free text", () => {
  const registry = new Registry();
  handleText(registry, PHONE, "hello");
  handleText(registry, PHONE, "STOP");
  assert.equal(handleText(registry, PHONE, "hello again"), NOT_SIGNED_UP);
  assert.equal(registry.status(PHONE), "opted_out");
});

test("JOIN signs an opted-out sender back up", () => {
  const registry = new Registry();
  handleText(registry, PHONE, "hello");
  handleText(registry, PHONE, "STOP");
  assert.equal(handleText(registry, PHONE, "JOIN"), WELCOME);
  assert.equal(registry.status(PHONE), "opted_in");
});

test("STOP from someone who never texted still records them as out", () => {
  const registry = new Registry();
  assert.equal(handleText(registry, PHONE, "STOP"), GOODBYE);
  assert.equal(registry.status(PHONE), "opted_out");
});
