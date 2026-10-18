/**
 * Tests for handleEvent: one Contract A event in, Contract B actions out.
 *
 * Covers finding the sender, sign-up, SOS, safe and leaving, STOP, radio,
 * location-only updates, the agent hand-off, duplicates, and the timeline.
 * Everything here runs offline with no LLM.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelayAction, RelayEvent } from "../src/contracts.js";
import { AGENT_TIMEOUT_MS, agentTimeoutMs, handleEvent, type Agent, type AgentContext } from "../src/event/handle.js";
import type { IncidentStore } from "../src/state/store.js";
import { makeEvent, makeStore, PHONES, recordingDispatcher } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const INCIDENT = "Oak Ridge Fire";
const HERE = { lat: 37.86, lng: -122.22 };

/**
 * Send one event through a store, optionally with an agent.
 *
 * Args:
 *     store (IncidentStore): The store.
 *     overrides (Partial<RelayEvent>): Event fields to change.
 *     agent (Agent | undefined): Optional agent stub.
 *
 * Returns:
 *     Promise<RelayAction[]>: The actions Core returned.
 */
async function send(store: IncidentStore, overrides: Partial<RelayEvent>, agent?: Agent): Promise<RelayAction[]> {
  return (await handleEvent(makeEvent(overrides), { store, agent })).actions;
}

/**
 * The timeline as [channel, who, text] rows, for compact assertions.
 *
 * Args:
 *     store (IncidentStore): The store.
 *
 * Returns:
 *     string[][]: One row per entry, oldest first.
 */
function rows(store: IncidentStore): string[][] {
  return store.snapshot().timeline.map((t) => [t.channel, t.who, t.text]);
}

/**
 * An agent stub that records its calls and answers with one say action.
 *
 * Returns:
 *     { agent: Agent, calls: AgentContext[] }: The stub and its call log.
 */
function recordingAgent() {
  const calls: AgentContext[] = [];
  const agent: Agent = async (ctx) => {
    calls.push(ctx);
    return [{ type: "say", text: "agent answer" }];
  };
  return { agent, calls };
}

describe("finding the sender", () => {
  it("finds a person by phone when person_id is null", async () => {
    const { store } = makeStore();
    const [action] = await send(store, { text: "I'm safe" });
    expect(action).toMatchObject({ type: "send_text", person_id: "p_amit", to: PHONES.amit });
  });

  it("finds a person by phone in any format", async () => {
    const { store } = makeStore();
    await send(store, { from: "(617) 555-0101", text: "I'm safe" });
    expect(store.getPerson("p_amit")?.status).toBe("safe");
  });

  it("trusts person_id on a voice call even when the number is unknown", async () => {
    const { store } = makeStore();
    await send(store, { channel: "voice", person_id: "p_priya", from: PHONES.stranger, text: "I'm safe" });
    expect(store.getPerson("p_priya")?.status).toBe("safe");
    expect(store.findPersonByHandle(PHONES.stranger)).toBeUndefined();
  });

  it("ignores a text person_id whose number does not match the sender", async () => {
    const { store } = makeStore();
    const [action] = await send(store, { person_id: "p_priya", from: PHONES.stranger, text: "I'm safe" });
    expect(store.getPerson("p_priya")?.status).toBe("unconfirmed");
    expect(action).toMatchObject({ to: PHONES.stranger });
    expect(store.findPersonByHandle(PHONES.stranger)).toBeDefined();
  });

  it("does not merge two strangers who share the last 4 digits", async () => {
    const { store } = makeStore();
    await send(store, { from: PHONES.stranger, person_id: "p_0150", text: "hi" });
    await send(store, { from: "+14155550150", person_id: "p_0150", text: "I'm safe" });
    expect(store.getPerson("p_0150")?.status).toBe("unconfirmed");
    expect(store.findPersonByHandle("+14155550150")).toBeDefined();
  });

  it("falls back to the phone when person_id is unknown", async () => {
    const { store } = makeStore();
    await send(store, { person_id: "p_ghost", text: "I'm safe" });
    expect(store.getPerson("p_amit")?.status).toBe("safe");
  });

  it("checks the unit's phone before person_id", async () => {
    const { store } = makeStore();
    const [action] = await send(store, { person_id: "p_amit", from: PHONES.unit4, text: "I'm safe" });
    expect(store.getPerson("p_amit")?.status).toBe("unconfirmed");
    expect(action).toMatchObject({ type: "send_text", person_id: "u_4", to: PHONES.unit4 });
    expect(rows(store)[0]).toEqual(["imessage", "Unit 4", "I'm safe"]);
  });

  it("records the contact time and new location", async () => {
    const { store, advance } = makeStore();
    advance(30);
    await send(store, { text: "hi", location: { lat: 37.9, lng: -122.3 } });
    expect(store.getPerson("p_amit")).toMatchObject({ last_contact: "2026-10-17T14:00:30.000Z", lat: 37.9, lng: -122.3 });
  });

  it("keeps the old location when the event has none", async () => {
    const { store } = makeStore();
    await send(store, { text: "hi" });
    expect(store.getPerson("p_amit")).toMatchObject({ lat: 37.851, lng: -122.224 });
  });

  it("marks a unit as heard", async () => {
    const { store, advance } = makeStore();
    advance(5);
    await send(store, { channel: "radio", from: PHONES.unit4, text: "copy that" });
    expect(store.snapshot().units[0].last_heard).toBe("2026-10-17T14:00:05.000Z");
  });
});

describe("sign-up", () => {
  it("adds an unknown texter and answers them, without a second welcome", async () => {
    // Text owns sign-up and already welcomed them before forwarding anything.
    const { store } = makeStore();
    const actions = await send(store, { from: PHONES.stranger, text: "hi" });
    expect(store.getPerson("p_new_1")).toMatchObject({ handle: PHONES.stranger, status: "unconfirmed" });
    expect(actions).toEqual([
      { type: "send_text", person_id: "p_new_1", to: PHONES.stranger, text: expect.stringContaining(INCIDENT), map_url: null },
    ]);
    expect(actions[0].type === "send_text" && actions[0].text).not.toMatch(/Welcome/);
    expect(rows(store).slice(0, 2)).toEqual([
      ["imessage", "New resident 1", "hi"],
      ["system", "Relay", "New resident 1 signed up by text"],
    ]);
  });

  it("does not ask for a location they already shared, and puts them on the map", async () => {
    const { store } = makeStore();
    const [action] = await send(store, { from: PHONES.stranger, text: "", location: HERE });
    expect(action.type === "send_text" && action.text).not.toContain("share your location");
    expect(store.snapshot().people.find((p) => p.person_id === "p_new_1")).toMatchObject(HERE);
  });

  it("signs up SMS senders too", async () => {
    const { store } = makeStore();
    await send(store, { channel: "sms", from: PHONES.stranger, text: "hi" });
    expect(store.getPerson("p_new_1")).toBeDefined();
  });

  it("sends a new texter's first question to the agent", async () => {
    const { store } = makeStore();
    const { agent, calls } = recordingAgent();
    const actions = await send(store, { from: PHONES.stranger, text: "where is the nearest shelter?" }, agent);
    expect(calls).toHaveLength(1);
    expect(actions).toEqual([{ type: "say", text: "agent answer" }]);
  });

  it("knows them on the second message", async () => {
    const { store } = makeStore();
    await send(store, { from: PHONES.stranger, text: "hi" });
    await send(store, { from: "617-555-0150", text: "I'm safe" });
    expect(store.getPerson("p_new_1")?.status).toBe("safe");
    expect(store.getPerson("p_new_2")).toBeUndefined();
  });

  it("signs up a sender with a non-phone handle, like a short code, only once", async () => {
    const { store } = makeStore();
    await send(store, { from: "12345", text: "hi" });
    await send(store, { from: " 12345 ", text: "hi again" });
    expect(store.getPerson("p_new_1")?.handle).toBe("12345");
    expect(store.getPerson("p_new_2")).toBeUndefined();
  });

  it("keeps the person_id the channel made up, when it is free", async () => {
    const { store } = makeStore();
    const [action] = await send(store, { from: PHONES.stranger, person_id: "p_0150", text: "hi" });
    expect(action).toMatchObject({ person_id: "p_0150", to: PHONES.stranger });
    expect(store.getPerson("p_0150")?.handle).toBe(PHONES.stranger);
  });

  it("ignores a channel person_id that a unit already uses", async () => {
    const { store } = makeStore();
    await send(store, { from: PHONES.stranger, person_id: "u_4", text: "hi" });
    expect(store.findPersonByHandle(PHONES.stranger)?.person_id).toBe("p_new_1");
  });

  it("ignores a channel person_id that an opted-out person holds", async () => {
    const { store } = makeStore();
    await send(store, { text: "STOP" });
    await send(store, { from: PHONES.stranger, person_id: "p_amit", text: "hi" });
    expect(store.findPersonByHandle(PHONES.stranger)?.person_id).toBe("p_new_1");
  });

  it("does not sign up an unknown texter who sends STOP", async () => {
    const { store } = makeStore();
    expect(await send(store, { from: PHONES.stranger, text: "STOP" })).toEqual([]);
    expect(store.findPersonByHandle(PHONES.stranger)).toBeUndefined();
    expect(rows(store)).toEqual([["imessage", "Unknown caller", "STOP"]]);
  });

  it("does not sign up an unknown voice caller", async () => {
    const { store } = makeStore();
    const actions = await send(store, { channel: "voice", from: PHONES.stranger, text: "hello?" });
    expect(store.findPersonByHandle(PHONES.stranger)).toBeUndefined();
    expect(actions).toEqual([{ type: "say", text: expect.any(String) }]);
    expect(rows(store)[0]).toEqual(["voice", "Unknown caller", "hello?"]);
  });

  it("names an unknown radio sender Radio", async () => {
    const { store } = makeStore();
    await send(store, { channel: "radio", from: PHONES.stranger, text: "Unit 2, copy" });
    expect(rows(store)).toEqual([["radio", "Radio", "Unit 2, copy"]]);
    expect(store.findPersonByHandle(PHONES.stranger)).toBeUndefined();
  });
});

describe("SOS", () => {
  it("marks sos, replies, texts the family contact, and logs it", async () => {
    const { store } = makeStore();
    const actions = await send(store, { text: "my car won't start, I need help" });
    expect(store.getPerson("p_amit")?.status).toBe("sos");
    expect(actions).toEqual([
      { type: "send_text", person_id: "p_amit", to: PHONES.amit, text: expect.stringContaining("SOS"), map_url: null },
      { type: "send_text", person_id: "p_priya", to: PHONES.priya, text: expect.stringContaining("Amit sent an SOS"), map_url: null },
    ]);
    expect(rows(store)).toEqual([
      ["imessage", "Amit", "my car won't start, I need help"],
      ["system", "Relay", 'Amit marked SOS: "my car won\'t start, I need help"'],
      ["imessage", "Relay", expect.stringMatching(/^To Amit: /)],
      ["imessage", "Relay", expect.stringMatching(/^To Priya: /)],
    ]);
  });

  it("pushes the family text to its lane and replies only to the sender", async () => {
    // Channels only answer the person they are talking to, so a family text
    // left in the reply would be dropped.
    const { store } = makeStore();
    const { dispatcher, pushed } = recordingDispatcher();
    const event = makeEvent({ text: "SOS" });
    const { actions } = await handleEvent(event, { store, dispatcher });
    expect(actions).toEqual([expect.objectContaining({ type: "send_text", person_id: "p_amit" })]);
    expect(pushed).toEqual([expect.objectContaining({ type: "send_text", person_id: "p_priya", to: PHONES.priya })]);

    // A redelivered event gets the same reply and does not push again.
    expect((await handleEvent(event, { store, dispatcher })).actions).toEqual(actions);
    expect(pushed).toHaveLength(1);
  });

  it("puts the person first on /state with an sos count", async () => {
    const { store } = makeStore();
    await send(store, { text: "SOS" });
    const s = store.snapshot();
    expect(s.people[0]).toMatchObject({ person_id: "p_amit", status: "sos" });
    expect(s.counts.sos).toBe(1);
  });

  it("does not text the family again on a repeated SOS", async () => {
    const { store } = makeStore();
    await send(store, { text: "SOS" });
    const actions = await send(store, { text: "SOS still trapped" });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ person_id: "p_amit" });
    expect(rows(store).filter((r) => r[2].includes("marked SOS"))).toHaveLength(1);
  });

  it("says the reply on a voice call and still texts the family", async () => {
    const { store } = makeStore();
    const actions = await send(store, { channel: "voice", text: "I'm trapped" });
    expect(actions[0]).toEqual({ type: "say", text: expect.stringContaining("Amit") });
    expect(actions[1]).toMatchObject({ type: "send_text", person_id: "p_priya" });
  });

  it("skips the family text when the family contact has opted out", async () => {
    const { store } = makeStore();
    await send(store, { from: PHONES.priya, text: "STOP" });
    const actions = await send(store, { text: "SOS" });
    expect(actions).toHaveLength(1);
  });

  it("skips the family text when there is no family contact", async () => {
    const { store } = makeStore();
    await send(store, { from: PHONES.stranger, text: "hi" });
    expect(await send(store, { from: PHONES.stranger, text: "SOS" })).toHaveLength(1);
  });

  it("answers a unit that texts SOS by text, not with say", async () => {
    const { store } = makeStore();
    const actions = await send(store, { from: PHONES.unit4, text: "SOS, firefighter injured" });
    expect(actions).toEqual([
      { type: "send_text", person_id: "u_4", to: PHONES.unit4, text: "Relay got your SOS. Responders are being alerted now.", map_url: null },
    ]);
    expect(rows(store)).toContainEqual(["system", "Relay", "SOS from Unit 4, needs human review"]);
  });

  it("asks a person with no location to share it after an SOS", async () => {
    const { store } = makeStore();
    const [action] = await send(store, { from: PHONES.stranger, text: "SOS" });
    expect(action.type === "send_text" && action.text).toContain("share your location");
    expect(store.snapshot().counts.sos).toBe(1);
  });

  it("does not ask for a location it already has", async () => {
    const { store } = makeStore();
    const [action] = await send(store, { text: "SOS" });
    expect(action.type === "send_text" && action.text).not.toContain("share your location");
  });

  it("logs an SOS from an unknown caller for review, without their number", async () => {
    const { store } = makeStore();
    const actions = await send(store, { channel: "voice", from: PHONES.stranger, text: "help me" });
    expect(actions).toEqual([{ type: "say", text: expect.stringContaining("logged your call for help") }]);
    expect(rows(store)).toContainEqual(["system", "Relay", "SOS from Unknown caller, needs human review"]);
    expect(JSON.stringify(store.snapshot())).not.toMatch(/6175550150/);
  });
});

describe("safe and leaving", () => {
  it("marks safe and confirms by text", async () => {
    const { store } = makeStore();
    const [action] = await send(store, { text: "I'm safe" });
    expect(store.getPerson("p_amit")?.status).toBe("safe");
    expect(action).toMatchObject({ type: "send_text", text: expect.stringContaining("marked safe") });
    expect(rows(store)).toContainEqual(["system", "Relay", "Amit marked safe"]);
  });

  it("marks en route", async () => {
    const { store } = makeStore();
    await send(store, { text: "leaving now" });
    expect(store.getPerson("p_amit")?.status).toBe("en_route");
    expect(rows(store)).toContainEqual(["system", "Relay", "Amit marked en_route"]);
  });

  it("understands Spanish", async () => {
    const { store } = makeStore();
    await send(store, { from: PHONES.priya, text: "Estoy bien" });
    expect(store.getPerson("p_priya")?.status).toBe("safe");
  });

  it("says the confirmation on a check-in call", async () => {
    const { store } = makeStore();
    expect(await send(store, { channel: "voice", text: "yes I'm okay" })).toEqual([
      { type: "say", text: "Thanks, Amit. I've marked you safe." },
    ]);
  });

  it.each(["I'm safe", "leaving now"])("holds sos when they say %j", async (text) => {
    const { store } = makeStore();
    await send(store, { text: "SOS" });
    const [action] = await send(store, { text });
    expect(store.getPerson("p_amit")?.status).toBe("sos");
    expect(action).toMatchObject({ type: "send_text", text: expect.stringContaining("SOS stays open") });
    expect(rows(store).some((r) => r[2].includes("SOS kept until a responder confirms"))).toBe(true);
  });

  it("does not log a change when nothing changed", async () => {
    const { store } = makeStore();
    await send(store, { text: "I'm safe" });
    await send(store, { text: "still safe" });
    expect(rows(store).filter((r) => r[2] === "Amit marked safe")).toHaveLength(1);
  });

  it("gives a unit that texts 'safe' the fallback by text", async () => {
    const { store } = makeStore();
    const actions = await send(store, { from: PHONES.unit4, text: "safe" });
    expect(actions).toEqual([
      { type: "send_text", person_id: "u_4", to: PHONES.unit4, text: expect.stringContaining("Reply SAFE"), map_url: null },
    ]);
  });

  it("gives an unknown caller who says 'safe' the spoken fallback", async () => {
    const { store } = makeStore();
    expect(await send(store, { channel: "voice", from: PHONES.stranger, text: "I'm safe" })).toEqual([
      { type: "say", text: expect.stringContaining("Say safe") },
    ]);
  });
});

describe("STOP", () => {
  it("removes the person without replying, since Text confirms STOP", async () => {
    const { store } = makeStore();
    const actions = await send(store, { text: "Stop." });
    expect(store.getPerson("p_amit")).toBeUndefined();
    expect(store.snapshot().people.some((p) => p.person_id === "p_amit")).toBe(false);
    expect(actions).toEqual([]);
    expect(rows(store)).toEqual([
      ["imessage", "Amit", "Stop."],
      ["system", "Relay", "Amit opted out (STOP)"],
    ]);
  });

  it("does not remove anyone for a longer message with stop in it", async () => {
    const { store } = makeStore();
    await send(store, { text: "stop sending me the same route" });
    expect(store.getPerson("p_amit")).toBeDefined();
  });

  it("returns nothing for a unit that sends STOP", async () => {
    const { store } = makeStore();
    expect(await send(store, { from: PHONES.unit4, text: "STOP" })).toEqual([]);
  });

  it("restores them with the same id, name, and family contact if they text again", async () => {
    const { store } = makeStore();
    await send(store, { text: "STOP" });
    const actions = await send(store, { text: "hi again" });
    expect(actions).toEqual([{ type: "send_text", person_id: "p_amit", to: PHONES.amit, text: expect.any(String), map_url: null }]);
    expect(actions[0].type === "send_text" && actions[0].text).not.toMatch(/Welcome back/);
    expect(store.getPerson("p_amit")).toMatchObject({ name: "Amit", family_contact: "p_priya", household_id: "h_patel", status: "unconfirmed" });
    expect(store.getPerson("p_new_1")).toBeUndefined();
    expect(rows(store)).toContainEqual(["system", "Relay", "Amit signed up again after STOP"]);
  });

  it("restores someone who was safe as unconfirmed", async () => {
    const { store } = makeStore();
    await send(store, { text: "I'm safe" });
    await send(store, { text: "STOP" });
    await send(store, { text: "hello" });
    expect(store.getPerson("p_amit")?.status).toBe("unconfirmed");
  });

  it("keeps an SOS through STOP and rejoining", async () => {
    const { store } = makeStore();
    await send(store, { text: "SOS" });
    await send(store, { text: "STOP" });
    await send(store, { text: "hello" });
    expect(store.getPerson("p_amit")?.status).toBe("sos");
    expect(store.snapshot().counts.sos).toBe(1);
  });

  it("handles the first message after rejoining by its own rule", async () => {
    const { store } = makeStore();
    await send(store, { text: "STOP" });
    await send(store, { text: "I'm safe" });
    expect(store.getPerson("p_amit")?.status).toBe("safe");
  });

  it("restores only on text, not on a voice call", async () => {
    const { store } = makeStore();
    await send(store, { text: "STOP" });
    await send(store, { channel: "voice", text: "hello?" });
    expect(store.getPerson("p_amit")).toBeUndefined();
  });
});

describe("radio", () => {
  it("logs chatter without the wake phrase and answers nothing", async () => {
    const { store } = makeStore();
    const { agent, calls } = recordingAgent();
    expect(await send(store, { channel: "radio", from: PHONES.unit4, text: "Unit 2, copy that" }, agent)).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(rows(store)).toEqual([["radio", "Unit 4", "Unit 2, copy that"]]);
  });

  it("hands a wake-phrase question to the agent without the wake phrase", async () => {
    const { store } = makeStore();
    const { agent, calls } = recordingAgent();
    const actions = await send(store, { channel: "radio", from: PHONES.unit4, text: "Relay, wind forecast next 2 hours?" }, agent);
    expect(actions).toEqual([{ type: "say", text: "agent answer" }]);
    expect(calls[0]).toMatchObject({ text: "wind forecast next 2 hours?", who: "Unit 4", person: undefined });
    expect(calls[0].unit).toMatchObject({ unit_id: "u_4" });
    expect(rows(store)).toEqual([
      ["radio", "Unit 4", "Relay, wind forecast next 2 hours?"],
      ["radio", "Relay", "agent answer"],
    ]);
  });

  it("answers with the radio fallback when there is no agent", async () => {
    const { store } = makeStore();
    expect(await send(store, { channel: "radio", from: PHONES.unit4, text: "Relay, status?" })).toEqual([
      { type: "say", text: "Relay copies. I can't answer that right now. Stand by." },
    ]);
  });

  it("does not change anyone's status from radio keywords alone", async () => {
    const { store } = makeStore();
    await send(store, { channel: "radio", from: PHONES.unit4, text: "Relay, Amit is safe" });
    expect(store.getPerson("p_amit")?.status).toBe("unconfirmed");
  });
});

describe("location only", () => {
  it("thanks a known person and updates their location", async () => {
    const { store } = makeStore();
    const [action] = await send(store, { text: "", location: { lat: 37.9, lng: -122.3 } });
    expect(action).toMatchObject({ type: "send_text", text: expect.stringContaining("We have your location") });
    expect(store.getPerson("p_amit")).toMatchObject({ lat: 37.9, lng: -122.3 });
    expect(rows(store)[0]).toEqual(["imessage", "Amit", "[shared location]"]);
  });

  it("treats whitespace-only text as empty", async () => {
    const { store } = makeStore();
    const [action] = await send(store, { text: "   ", location: HERE });
    expect(action.type === "send_text" && action.text).toContain("We have your location");
  });

  it("does not call the agent for a location share", async () => {
    const { store } = makeStore();
    const { agent, calls } = recordingAgent();
    await send(store, { text: "", location: HERE }, agent);
    expect(calls).toHaveLength(0);
  });

  it("logs a photo and an empty message clearly", async () => {
    const { store } = makeStore();
    await send(store, { text: "", media_url: "https://example.com/road.jpg" });
    await send(store, { text: "" });
    expect(rows(store).filter((r) => r[1] === "Amit").map((r) => r[2])).toEqual(["[sent a photo]", "[empty message]"]);
  });
});

describe("agent", () => {
  it("is not called when a fast rule matches", async () => {
    const { store } = makeStore();
    const { agent, calls } = recordingAgent();
    for (const text of ["SOS", "I'm safe", "leaving now", "STOP"]) await send(store, { text }, agent);
    expect(calls).toHaveLength(0);
  });

  it("gets the event, text, a copy of the person, and their name", async () => {
    const { store } = makeStore();
    const { agent, calls } = recordingAgent();
    const event = makeEvent({ text: "where is the nearest shelter?" });
    await handleEvent(event, { store, agent });
    expect(calls).toHaveLength(1);
    expect(calls[0].event).toEqual(event);
    expect(calls[0]).toMatchObject({ text: "where is the nearest shelter?", who: "Amit", unit: undefined });
    expect(calls[0].person).toMatchObject({ person_id: "p_amit", last_contact: expect.any(String) });
    calls[0].person!.status = "sos";
    expect(store.getPerson("p_amit")?.status).toBe("unconfirmed");
  });

  it("returns and logs whatever actions the agent gives", async () => {
    const { store } = makeStore();
    const agent: Agent = async () => [
      { type: "send_text", person_id: "p_amit", to: PHONES.amit, text: "Shelter C is 2 km west.", map_url: null },
      { type: "place_call", person_id: "p_priya", to: PHONES.priya, script: "Checking on Amit.", reason: "family" },
    ];
    const actions = await send(store, { text: "where is the nearest shelter?" }, agent);
    expect(actions).toHaveLength(2);
    expect(rows(store).slice(1)).toEqual([
      ["imessage", "Relay", "To Amit: Shelter C is 2 km west."],
      ["voice", "Relay", "Calling Priya: Checking on Amit."],
    ]);
  });

  it("replies with the fallback when the agent throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store } = makeStore();
    const agent: Agent = async () => {
      throw new Error("Gemini rate limited");
    };
    const actions = await send(store, { text: "where is the nearest shelter?" }, agent);
    expect(actions).toEqual([
      { type: "send_text", person_id: "p_amit", to: PHONES.amit, text: expect.stringContaining(INCIDENT), map_url: null },
    ]);
    expect(log).toHaveBeenCalled();
  });

  it.each([
    ["imessage", "Reply SAFE if you are safe"],
    ["voice", "Say safe if you are safe"],
    ["radio", "Relay copies"],
  ] as const)("uses the %s fallback when there is no agent", async (channel, fallback) => {
    const { store } = makeStore();
    const from = channel === "radio" ? PHONES.unit4 : PHONES.amit;
    const text = channel === "radio" ? "Relay, where is the fire?" : "where is the fire?";
    const [action] = await send(store, { channel, from, text });
    expect("text" in action && action.text).toContain(fallback);
  });

  it("passes a live, not yet aborted signal", async () => {
    const { store } = makeStore();
    let signal: AbortSignal | undefined;
    await send(store, { text: "where is the fire?" }, async (ctx) => {
      signal = ctx.signal;
      return [{ type: "say", text: "west of you" }];
    });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("returns an empty list if the agent returns one", async () => {
    const { store } = makeStore();
    expect(await send(store, { text: "thanks" }, async () => [])).toEqual([]);
  });
});

describe("agent time limit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * An agent that never answers on its own, and records its signal.
   *
   * Returns:
   *     { agent: Agent, signals: AbortSignal[] }: The agent and the signals it got.
   */
  function hangingAgent() {
    const signals: AbortSignal[] = [];
    const agent: Agent = (ctx) => {
      signals.push(ctx.signal);
      return new Promise(() => {});
    };
    return { agent, signals };
  }

  it("is 3.2 seconds, under Voice's 4 second limit", () => {
    expect(AGENT_TIMEOUT_MS).toBe(3200);
  });

  it("lets AGENT_TIMEOUT_MS in the environment raise the wait, read at call time, and ignores bad values", () => {
    vi.stubEnv("AGENT_TIMEOUT_MS", "9000");
    expect(agentTimeoutMs()).toBe(9000);
    for (const bad of ["soon", "", "0", "-5"]) {
      vi.stubEnv("AGENT_TIMEOUT_MS", bad);
      expect(agentTimeoutMs()).toBe(3200);
    }
    vi.unstubAllEnvs();
    expect(agentTimeoutMs()).toBe(3200);
  });

  it("waits for the longer limit when AGENT_TIMEOUT_MS is set", async () => {
    vi.useFakeTimers();
    vi.stubEnv("AGENT_TIMEOUT_MS", "9000");
    const { store } = makeStore();
    const agent: Agent = () =>
      new Promise((resolve) => setTimeout(() => resolve([{ type: "say", text: "slow but here" }]), 7000));
    const pending = handleEvent(makeEvent({ channel: "voice", text: "where is the shelter" }), { store, agent });
    await vi.advanceTimersByTimeAsync(7000);
    expect((await pending).actions).toEqual([{ type: "say", text: "slow but here" }]);
    vi.unstubAllEnvs();
  });

  it("aborts the agent and replies with the fallback once the limit passes", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { store } = makeStore();
    const { agent, signals } = hangingAgent();
    const pending = send(store, { channel: "radio", from: PHONES.unit4, text: "Relay, wind forecast?" }, agent);
    await vi.advanceTimersByTimeAsync(AGENT_TIMEOUT_MS - 1);
    expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual([{ type: "say", text: "Relay copies. I can't answer that right now. Stand by." }]);
    expect(signals[0].aborted).toBe(true);
  });

  it("uses the agent's answer if it arrives just in time", async () => {
    vi.useFakeTimers();
    const { store } = makeStore();
    const agent: Agent = () =>
      new Promise((resolve) => setTimeout(() => resolve([{ type: "say", text: "just in time" }]), AGENT_TIMEOUT_MS - 1));
    const pending = send(store, { channel: "voice", text: "where is the fire?" }, agent);
    await vi.advanceTimersByTimeAsync(AGENT_TIMEOUT_MS);
    expect(await pending).toEqual([{ type: "say", text: "just in time" }]);
  });

  it("leaves no timer running after a fast answer", async () => {
    vi.useFakeTimers();
    const { store } = makeStore();
    await send(store, { text: "where is the fire?" }, async () => [{ type: "say", text: "fast" }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("duplicates", () => {
  it("returns the same response for a repeated event_id without running it again", async () => {
    const { store } = makeStore();
    const { agent, calls } = recordingAgent();
    const event = makeEvent({ text: "where is the nearest shelter?" });
    const first = await handleEvent(event, { store, agent });
    const before = store.snapshot();
    const second = await handleEvent(event, { store, agent });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(store.snapshot()).toEqual(before);
  });

  it("does not text the family twice for a redelivered SOS", async () => {
    const { store } = makeStore();
    const event = makeEvent({ text: "SOS" });
    await handleEvent(event, { store });
    await handleEvent(event, { store });
    expect(rows(store).filter((r) => r[2].startsWith("To Priya"))).toHaveLength(1);
  });

  it("runs a duplicate once even when both copies arrive while the agent is thinking", async () => {
    const { store } = makeStore();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const agent: Agent = async () => {
      calls++;
      await gate;
      return [{ type: "say", text: "answer" }];
    };
    const event = makeEvent({ text: "what is the wind like?" });
    const both = Promise.all([handleEvent(event, { store, agent }), handleEvent(event, { store, agent })]);
    release();
    const [a, b] = await both;
    expect(calls).toBe(1);
    expect(b).toEqual(a);
    expect(rows(store).filter((r) => r[1] === "Amit")).toHaveLength(1);
  });

  it("gives each waiting copy its own copy of the response", async () => {
    const { store } = makeStore();
    const event = makeEvent({ text: "where is the fire?" });
    const [a, b] = await Promise.all([handleEvent(event, { store }), handleEvent(event, { store })]);
    a.actions.length = 0;
    expect(b.actions).toHaveLength(1);
    expect((await handleEvent(event, { store })).actions).toHaveLength(1);
  });

  it("treats the same event_id on a different channel as a new event", async () => {
    const { store } = makeStore();
    await handleEvent(makeEvent({ event_id: "evt_1", text: "hi" }), { store });
    await handleEvent(makeEvent({ event_id: "evt_1", channel: "voice", text: "hi" }), { store });
    expect(rows(store).filter((r) => r[1] === "Amit").map((r) => r[0])).toEqual(["imessage", "voice"]);
  });

  it("remembers the fallback after an agent failure, so a redelivery does not retry the agent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { store } = makeStore();
    let calls = 0;
    const agent: Agent = async () => {
      calls++;
      if (calls === 1) throw new Error("first try failed");
      return [{ type: "say", text: "ok" }];
    };
    const event = makeEvent({ text: "where is the fire?" });
    const first = await handleEvent(event, { store, agent });
    const second = await handleEvent(event, { store, agent });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it("handles two events with the same text but different ids", async () => {
    const { store } = makeStore();
    await send(store, { text: "hi" });
    await send(store, { text: "hi" });
    expect(rows(store).filter((r) => r[1] === "Amit")).toHaveLength(2);
  });
});

describe("Contract B shape", () => {
  it("only ever returns send_text, place_call, or say with exactly their fields", async () => {
    const { store } = makeStore();
    const inputs: Partial<RelayEvent>[] = [
      { from: PHONES.stranger, text: "hi" },
      { text: "SOS" },
      { from: PHONES.priya, text: "I'm safe" },
      { channel: "voice", text: "I'm okay" },
      { channel: "radio", from: PHONES.unit4, text: "Relay, status?" },
      { from: PHONES.unit4, text: "safe" },
      { from: PHONES.sam, text: "where do you need me?" },
      { from: PHONES.priya, text: "", location: HERE },
      { from: PHONES.priya, text: "STOP" },
    ];
    for (const overrides of inputs) {
      for (const action of await send(store, overrides)) {
        const keys = Object.keys(action).sort();
        if (action.type === "say") expect(keys).toEqual(["text", "type"]);
        else expect(keys).toEqual(["map_url", "person_id", "text", "to", "type"]);
        expect("text" in action && action.text.length).toBeGreaterThan(0);
      }
    }
  });

  it("never puts a phone number on /state, even after strangers text in", async () => {
    const { store } = makeStore();
    await send(store, { from: PHONES.stranger, text: "SOS", location: HERE });
    await send(store, { channel: "voice", from: PHONES.stranger2, text: "help me" });
    expect(JSON.stringify(store.snapshot())).not.toMatch(/\+?1?617555015\d/);
  });
});
