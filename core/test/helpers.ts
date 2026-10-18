/**
 * Shared helpers for Core tests.
 *
 * Scenario variants are written to temp folders as edited copies of the
 * committed scenario.json, so a test can break one field and watch the loader
 * react. Nothing here reads the repo's scenario.local.json, so real phone
 * numbers never reach a test.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { LlmCall, LlmClient, LlmRequest, LlmResult } from "../src/agent/llm.js";
import { TOOLS, type ToolContext } from "../src/agent/tools.js";
import { createCoreRouter } from "../src/app.js";
import type { RelayEvent } from "../src/contracts.js";
import { createStubData } from "../src/data/stub.js";
import type { Agent } from "../src/event/handle.js";
import { loadScenario } from "../src/scenario/load.js";
import type { Scenario } from "../src/scenario/schema.js";
import { IncidentStore } from "../src/state/store.js";

/** Repo root, where the committed scenario.json lives. */
export const ROOT = join(import.meta.dirname, "..", "..");

/** Start time for every test clock. */
export const T0 = "2026-10-17T14:00:00.000Z";

/** scenario.json as loose JSON, so tests can put wrong types in it. */
export type ScenarioJson = Record<string, any>;

/**
 * Read the committed scenario.json as plain JSON.
 *
 * Returns:
 *     ScenarioJson: A fresh copy, safe to edit.
 */
export function committedScenario(): ScenarioJson {
  return JSON.parse(readFileSync(join(ROOT, "scenario.json"), "utf8"));
}

/**
 * Write an edited copy of scenario.json, and optionally a local override, to a
 * new temp folder.
 *
 * Args:
 *     edit ((file: ScenarioJson) => void): Changes the copy in place. Optional.
 *     local (unknown): Contents of scenario.local.json. A string is written as
 *         is (for broken JSON), anything else is JSON-encoded. Omit for no file.
 *
 * Returns:
 *     string: Path of the temp folder.
 */
export function writeScenarioDir(edit?: (file: ScenarioJson) => void, local?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-scenario-"));
  const file = committedScenario();
  edit?.(file);
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(file));
  if (local !== undefined) {
    const body = typeof local === "string" ? local : JSON.stringify(local);
    writeFileSync(join(dir, "scenario.local.json"), body);
  }
  return dir;
}

/**
 * Load an edited copy of the committed scenario.
 *
 * Args:
 *     edit ((file: ScenarioJson) => void): Changes the copy in place.
 *     local (unknown): Optional scenario.local.json contents, merged if given.
 *
 * Returns:
 *     Scenario: The loaded scenario.
 *
 * Raises:
 *     Error: Whatever loadScenario throws for the edited file.
 */
export function loadEdited(edit: (file: ScenarioJson) => void, local?: unknown): Scenario {
  return loadScenario({ dir: writeScenarioDir(edit, local), useLocal: local !== undefined });
}

/**
 * Run a function that should throw and return the error message.
 *
 * Follows CLAUDE.md rule 7: catch the error and check its message, instead of
 * relying on toThrow() recognizing the error type.
 *
 * Args:
 *     fn (() => unknown): The call expected to throw.
 *
 * Returns:
 *     string: The thrown error's message.
 *
 * Raises:
 *     Error: If fn returns without throwing.
 */
export function errorMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the call to throw, but it returned normally");
}

/** Fictional numbers from the committed scenario, plus one nobody owns. */
export const PHONES = {
  amit: "+16175550101",
  priya: "+16175550102",
  sam: "+16175550103",
  unit4: "+16175550104",
  stranger: "+16175550150",
  stranger2: "+16175550151",
} as const;

let eventCounter = 0;

/**
 * Build a valid Contract A event, from Amit by iMessage unless overridden.
 *
 * Each call gets a new event_id, so events are never duplicates by accident.
 *
 * Args:
 *     overrides (Partial<RelayEvent>): Fields to change.
 *
 * Returns:
 *     RelayEvent: The event.
 */
export function makeEvent(overrides: Partial<RelayEvent> = {}): RelayEvent {
  eventCounter++;
  return {
    event_id: `evt_test_${eventCounter}`,
    channel: "imessage",
    person_id: null,
    from: PHONES.amit,
    text: "hello",
    location: null,
    media_url: null,
    timestamp: "2026-10-17T14:02:00Z",
    ...overrides,
  };
}

/**
 * Mount Core on a fresh app with a store and clock the test controls.
 *
 * Args:
 *     agent (Agent | undefined): Optional agent stub.
 *
 * Returns:
 *     { app: express.Express, store: IncidentStore, advance: (sec: number) => void }:
 *         The app, its store, and a function that moves the clock forward.
 */
export function coreApp(agent?: Agent) {
  const { store, advance } = makeStore();
  const app = express();
  app.use(createCoreRouter({ scenario: store.scenario, store, agent }));
  return { app, store, advance };
}

/** One scripted model turn: a fixed result, or a function of the request. */
export type ScriptStep = LlmResult | ((req: LlmRequest) => Promise<LlmResult>);

/**
 * A model turn that calls tools.
 *
 * Args:
 *     calls (LlmCall[]): The tool calls, each { name, args, id? }.
 *
 * Returns:
 *     LlmResult: A result with no text and those calls.
 */
export function toolCalls(...calls: LlmCall[]): LlmResult {
  return { text: "", calls, content: { role: "model", parts: calls.map((c) => ({ functionCall: c })) } };
}

/**
 * A model turn that answers in text.
 *
 * Args:
 *     text (string): The answer.
 *
 * Returns:
 *     LlmResult: A result with that text and no calls.
 */
export function answer(text: string): LlmResult {
  return { text, calls: [], content: { role: "model", parts: [{ text }] } };
}

/**
 * A fake LlmClient that plays back a script and records every request.
 *
 * Never talks to Gemini. Runs out loudly if the loop asks for more turns
 * than scripted.
 *
 * Args:
 *     steps (ScriptStep[]): One entry per generate() call, in order.
 *
 * Returns:
 *     { llm: LlmClient, requests: LlmRequest[] }: The client and a log of the
 *         requests it got, with contents copied at the time of the call.
 */
export function scriptedLlm(steps: ScriptStep[]) {
  const requests: LlmRequest[] = [];
  const queue = [...steps];
  const llm: LlmClient = {
    async generate(req) {
      requests.push({ ...req, contents: structuredClone(req.contents) });
      const step = queue.shift();
      if (!step) throw new Error("scripted LLM ran out of turns");
      return typeof step === "function" ? step(req) : step;
    },
  };
  return { llm, requests };
}

/**
 * A ToolContext for running a tool directly, as a person or as a unit.
 *
 * Args:
 *     store (IncidentStore): The store.
 *     as ({ personId?: string, unitId?: string, responder?: boolean }): Who
 *         is asking. Defaults to Amit as a resident.
 *
 * Returns:
 *     ToolContext: The context, with origin at the sender or the command post.
 */
export function toolContext(
  store: IncidentStore,
  as: { personId?: string; unitId?: string; responder?: boolean } = { personId: "p_amit" },
): ToolContext {
  const person = as.personId ? store.getPerson(as.personId) : undefined;
  const unit = as.unitId ? store.findUnitByHandle(store.scenario.units.find((u) => u.unit_id === as.unitId)!.phone) : undefined;
  const cp = store.scenario.places.find((p) => p.id === store.scenario.settings.command_post)!;
  const origin =
    person && person.lat !== null && person.lng !== null
      ? { name: "the sender's location", lat: person.lat, lng: person.lng }
      : { name: cp.name, lat: cp.lat, lng: cp.lng };
  return {
    store,
    data: createStubData(store.scenario),
    person,
    unit,
    who: unit?.name ?? person?.name ?? "Radio",
    isResponder: as.responder ?? Boolean(unit),
    origin,
    extraActions: [],
  };
}

/**
 * Run one agent tool by name.
 *
 * Args:
 *     name (string): Tool name.
 *     args (Record<string, unknown>): Arguments, as the model would pass them.
 *     ctx (ToolContext): The context.
 *
 * Returns:
 *     Promise<any>: The tool's output.
 */
export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<any> {
  const tool = TOOLS.find((t) => t.declaration.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool.run(args, ctx);
}

/**
 * Build a store with a clock the test controls.
 *
 * Args:
 *     scenario (Scenario): Scenario to start from. Defaults to the committed one.
 *
 * Returns:
 *     { store: IncidentStore, advance: (sec: number) => void }: The store and
 *         a function that moves the clock forward.
 */
export function makeStore(scenario: Scenario = loadScenario({ dir: ROOT, useLocal: false })) {
  let t = Date.parse(T0);
  const store = new IncidentStore(scenario, () => new Date(t));
  return { store, advance: (sec: number) => (t += sec * 1000) };
}
