/**
 * Tests for the saved opt-in list.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Registry } from "./registry.js";

const AMIT = "+16175550101";
const PRIYA = "+16175550102";

/** A path inside a fresh temp folder. */
function tempFile(name = "registry.json"): string {
  return join(mkdtempSync(join(tmpdir(), "relay-registry-")), name);
}

test("an in-memory registry works without a file", () => {
  const registry = new Registry();
  registry.optIn(AMIT);
  assert.equal(registry.status(AMIT), "opted_in");
});

test("sign-ups and STOPs survive a restart", () => {
  const file = tempFile();
  const first = new Registry(file);
  first.optIn(AMIT);
  first.optIn(PRIYA);
  first.optOut(PRIYA);

  const restarted = new Registry(file);
  assert.equal(restarted.status(AMIT), "opted_in");
  assert.equal(restarted.status(PRIYA), "opted_out");
  assert.equal(restarted.status("+10000000000"), "unknown");
});

test("the folder is created if it does not exist yet", () => {
  const file = join(mkdtempSync(join(tmpdir(), "relay-registry-")), "data", "registry.json");
  new Registry(file).optIn(AMIT);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { [AMIT]: true });
});

test("a missing file starts empty", () => {
  assert.deepEqual(new Registry(tempFile()).optedInNumbers(), []);
});

test("a corrupt file starts empty and is replaced on the next change", () => {
  const file = tempFile();
  writeFileSync(file, "{ not json");
  const registry = new Registry(file);
  assert.equal(registry.status(AMIT), "unknown");
  registry.optIn(AMIT);
  assert.equal(new Registry(file).status(AMIT), "opted_in");
});

test("a save that fails does not throw", () => {
  const registry = new Registry(join(tempFile(), "nested", "registry.json").replace("registry.json", "\0bad"));
  assert.doesNotThrow(() => registry.optIn(AMIT));
  assert.equal(registry.status(AMIT), "opted_in");
});
