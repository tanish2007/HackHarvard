/**
 * Tests for the phone number to person lookup.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PeopleDirectory, loadDirectory, normalizePhone } from "./people.js";

const SCENARIO = {
  people: [
    { person_id: "p_amit", phone: "+16175550101", lat: 37.851, lng: -122.224 },
    { person_id: "sim_001", phone: null, lat: 37.86, lng: -122.23 },
  ],
};

/** Write scenario files into a fresh temp folder and return its path. */
function scenarioDir(local?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-scenario-"));
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(SCENARIO));
  if (local) writeFileSync(join(dir, "scenario.local.json"), JSON.stringify(local));
  return dir;
}

test("normalizePhone makes formats compare equal", () => {
  assert.equal(normalizePhone("(617) 555-0101"), "+16175550101");
  assert.equal(normalizePhone("+1 617 555 0101"), "+16175550101");
  assert.equal(normalizePhone(""), "");
});

test("normalizePhone keeps an iMessage email, in lowercase", () => {
  assert.equal(normalizePhone(" Amit@Example.COM "), "amit@example.com");
});

test("an unknown email gets a made-up id from the part before the @", () => {
  const directory = new PeopleDirectory([]);
  assert.deepEqual(directory.resolve("Sam.Lee@example.com"), {
    person_id: "p_samlee",
    location: null,
    known: false,
  });
});

test("a scenario number resolves to its person and location", () => {
  const directory = loadDirectory(scenarioDir());
  assert.deepEqual(directory.resolve("+16175550101"), {
    person_id: "p_amit",
    location: { lat: 37.851, lng: -122.224 },
    known: true,
  });
});

test("people without a phone are left out", () => {
  const directory = loadDirectory(scenarioDir());
  assert.equal(directory.resolve("+16175559999").known, false);
});

test("an unknown number gets a made-up id and no location", () => {
  const directory = new PeopleDirectory([]);
  assert.deepEqual(directory.resolve("+14134727634"), {
    person_id: "p_7634",
    location: null,
    known: false,
  });
});

test("scenario.local.json replaces the placeholder number", () => {
  const directory = loadDirectory(scenarioDir({ phones: { p_amit: "+14134727634" } }));
  assert.equal(directory.resolve("+14134727634").person_id, "p_amit");
  assert.equal(directory.resolve("+16175550101").known, false);
});

test("phoneFor finds a number by person_id, and null for people without one", () => {
  const directory = loadDirectory(scenarioDir({ phones: { p_amit: "+14134727634" } }));
  assert.equal(directory.phoneFor("p_amit"), "+14134727634");
  assert.equal(directory.phoneFor("sim_001"), null);
  assert.equal(directory.phoneFor("nobody"), null);
});

test("a missing scenario.json is a clear error", () => {
  const empty = mkdtempSync(join(tmpdir(), "relay-empty-"));
  assert.throws(() => loadDirectory(empty), /Could not read/);
});
