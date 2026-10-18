/**
 * Tests for the store methods that /event uses: looking people up, signing
 * them up, removing them, statuses, units, and duplicate event memory.
 */
import { describe, expect, it } from "vitest";
import { errorMessage, loadEdited, makeStore, PHONES, T0 } from "./helpers.js";

const LATER = "2026-10-17T14:00:10.000Z";

describe("getPerson", () => {
  it("returns a copy, so changing it does not change the store", () => {
    const { store } = makeStore();
    const amit = store.getPerson("p_amit")!;
    amit.status = "sos";
    amit.name = "changed";
    expect(store.getPerson("p_amit")).toMatchObject({ status: "unconfirmed", name: "Amit" });
  });

  it("returns undefined for an unknown id", () => {
    expect(makeStore().store.getPerson("p_nobody")).toBeUndefined();
  });

  it("tracks the scenario fields and a normalized handle", () => {
    expect(makeStore().store.getPerson("p_amit")).toEqual({
      person_id: "p_amit",
      name: "Amit",
      role: "resident",
      handle: PHONES.amit,
      status: "unconfirmed",
      lat: 37.851,
      lng: -122.224,
      language: "en",
      zone: "zone_3",
      household_id: "h_patel",
      family_contact: "p_priya",
      simulated: false,
      last_contact: null,
    });
  });

  it("gives simulated people no handle", () => {
    expect(makeStore().store.getPerson("sim_001")?.handle).toBeNull();
  });
});

describe("findPersonByHandle", () => {
  it.each(["+16175550101", "(617) 555-0101", "617.555.0101", "6175550101"])("finds Amit by %s", (handle) => {
    expect(makeStore().store.findPersonByHandle(handle)?.person_id).toBe("p_amit");
  });

  it("finds a volunteer too", () => {
    expect(makeStore().store.findPersonByHandle(PHONES.sam)?.person_id).toBe("v_sam");
  });

  it("does not return a unit", () => {
    expect(makeStore().store.findPersonByHandle(PHONES.unit4)).toBeUndefined();
  });

  it.each([PHONES.stranger, "", "abc", "12345"])("returns undefined for %j", (handle) => {
    expect(makeStore().store.findPersonByHandle(handle)).toBeUndefined();
  });

  it("returns a copy", () => {
    const { store } = makeStore();
    store.findPersonByHandle(PHONES.amit)!.status = "sos";
    expect(store.getPerson("p_amit")?.status).toBe("unconfirmed");
  });
});

describe("findUnitByHandle", () => {
  it("finds Unit 4 by any format of its number", () => {
    const { store } = makeStore();
    expect(store.findUnitByHandle("(617) 555-0104")).toEqual({
      unit_id: "u_4",
      name: "Unit 4",
      handle: PHONES.unit4,
      last_heard: null,
    });
  });

  it("does not return a person", () => {
    expect(makeStore().store.findUnitByHandle(PHONES.amit)).toBeUndefined();
  });
});

describe("addPerson", () => {
  it("adds an unconfirmed English-speaking resident with the next p_new id", () => {
    const { store } = makeStore();
    expect(store.addPerson("(617) 555-0150", null)).toEqual({
      person_id: "p_new_1",
      name: "New resident 1",
      role: "resident",
      handle: PHONES.stranger,
      status: "unconfirmed",
      lat: null,
      lng: null,
      language: "en",
      zone: null,
      household_id: null,
      family_contact: null,
      simulated: false,
      last_contact: null,
    });
    expect(store.addPerson(PHONES.stranger2, null).person_id).toBe("p_new_2");
  });

  it("skips an id the scenario already uses", () => {
    const scenario = loadEdited((f) => f.people.push({ ...f.people[0], person_id: "p_new_1", phone: "+16175550160", family_contact: null }));
    const { store } = makeStore(scenario);
    const added = store.addPerson(PHONES.stranger, null);
    expect(added.person_id).toBe("p_new_2");
    expect(store.getPerson("p_new_1")?.name).toBe("Amit");
  });

  it("can be found by handle afterwards", () => {
    const { store } = makeStore();
    store.addPerson(PHONES.stranger, null);
    expect(store.findPersonByHandle("617-555-0150")?.person_id).toBe("p_new_1");
  });

  it("keeps a new person off the map until they share a location, but counts them", () => {
    const { store } = makeStore();
    store.addPerson(PHONES.stranger, null);
    const s = store.snapshot();
    expect(s.people.some((p) => p.person_id === "p_new_1")).toBe(false);
    expect(s.counts.unconfirmed).toBe(6);
  });

  it("counts an SOS from someone with no location", () => {
    const { store } = makeStore();
    store.addPerson(PHONES.stranger, null);
    store.setStatus("p_new_1", "sos");
    const s = store.snapshot();
    expect(s.counts.sos).toBe(1);
    expect(s.people.some((p) => p.status === "sos")).toBe(false);
  });

  it("uses the channel's person_id when it is free", () => {
    const { store } = makeStore();
    expect(store.addPerson(PHONES.stranger, null, "p_0150").person_id).toBe("p_0150");
    expect(store.addPerson(PHONES.stranger2, null).person_id).toBe("p_new_2");
  });

  it.each(["p_amit", "u_4", "sim_001"])("does not take a preferred id %s that is already used", (id) => {
    const { store } = makeStore();
    expect(store.addPerson(PHONES.stranger, null, id).person_id).toBe("p_new_1");
  });

  it("does not take a preferred id held by someone who opted out", () => {
    const { store } = makeStore();
    store.removePerson("p_amit");
    expect(store.addPerson(PHONES.stranger, null, "p_amit").person_id).toBe("p_new_1");
  });

  it("stores a short code as it was sent, trimmed and lowercased", () => {
    const { store } = makeStore();
    expect(store.addPerson(" RELAY1 ", null).handle).toBe("relay1");
    expect(store.findPersonByHandle("relay1")?.person_id).toBe("p_new_1");
  });

  it("puts a new person with a location on /state and in the counts", () => {
    const { store } = makeStore();
    store.addPerson(PHONES.stranger, { lat: 37.86, lng: -122.22 });
    const s = store.snapshot();
    expect(s.people.find((p) => p.person_id === "p_new_1")).toMatchObject({ lat: 37.86, lng: -122.22, status: "unconfirmed" });
    expect(s.counts.unconfirmed).toBe(6);
  });

  it("moves incident.updated_at", () => {
    const { store, advance } = makeStore();
    advance(10);
    store.addPerson(PHONES.stranger, null);
    expect(store.snapshot().incident.updated_at).toBe(LATER);
  });

  it("is undone by reset, which also restarts the numbering", () => {
    const { store } = makeStore();
    store.addPerson(PHONES.stranger, null);
    store.addPerson(PHONES.stranger2, null);
    store.reset();
    expect(store.getPerson("p_new_1")).toBeUndefined();
    expect(store.addPerson(PHONES.stranger, null).person_id).toBe("p_new_1");
  });
});

describe("removePerson", () => {
  it("removes a person from /state and the counts", () => {
    const { store } = makeStore();
    expect(store.removePerson("p_amit")).toBe(true);
    const s = store.snapshot();
    expect(s.people.some((p) => p.person_id === "p_amit")).toBe(false);
    expect(s.counts.unconfirmed).toBe(4);
    expect(store.getPerson("p_amit")).toBeUndefined();
    expect(store.findPersonByHandle(PHONES.amit)).toBeUndefined();
  });

  it("returns false for someone who is not there", () => {
    const { store } = makeStore();
    store.removePerson("p_amit");
    expect(store.removePerson("p_amit")).toBe(false);
    expect(store.removePerson("p_nobody")).toBe(false);
  });

  it("comes back after reset", () => {
    const { store } = makeStore();
    store.removePerson("p_amit");
    store.reset();
    expect(store.getPerson("p_amit")?.name).toBe("Amit");
    expect(store.restoreByHandle(PHONES.amit)).toBeUndefined();
  });
});

describe("restoreByHandle", () => {
  it("brings back an opted-out person with everything but their status", () => {
    const { store } = makeStore();
    const before = store.getPerson("p_amit")!;
    store.setStatus("p_amit", "safe");
    store.removePerson("p_amit");
    const restored = store.restoreByHandle("(617) 555-0101");
    expect(restored).toEqual({ ...before, status: "unconfirmed" });
    expect(store.getPerson("p_amit")).toEqual(restored);
    expect(store.snapshot().people.some((p) => p.person_id === "p_amit")).toBe(true);
  });

  it("keeps sos", () => {
    const { store } = makeStore();
    store.setStatus("p_amit", "sos");
    store.removePerson("p_amit");
    expect(store.restoreByHandle(PHONES.amit)?.status).toBe("sos");
  });

  it("only restores once", () => {
    const { store } = makeStore();
    store.removePerson("p_amit");
    store.restoreByHandle(PHONES.amit);
    expect(store.restoreByHandle(PHONES.amit)).toBeUndefined();
  });

  it.each([PHONES.stranger, PHONES.priya, "", "  "])("returns undefined for %j, who did not opt out", (handle) => {
    const { store } = makeStore();
    store.removePerson("p_amit");
    expect(store.restoreByHandle(handle)).toBeUndefined();
  });

  it("returns a copy", () => {
    const { store } = makeStore();
    store.removePerson("p_amit");
    store.restoreByHandle(PHONES.amit)!.name = "changed";
    expect(store.getPerson("p_amit")?.name).toBe("Amit");
  });
});

describe("listPeople", () => {
  it("lists everyone tracked in scenario order, with no location filter", () => {
    const { store } = makeStore();
    store.addPerson(PHONES.stranger, null);
    const ids = store.listPeople().map((p) => p.person_id);
    expect(ids.slice(0, 3)).toEqual(["p_amit", "p_priya", "v_sam"]);
    expect(ids).toHaveLength(52);
    expect(ids.at(-1)).toBe("p_new_1");
  });

  it("leaves out people who opted out", () => {
    const { store } = makeStore();
    store.removePerson("p_amit");
    expect(store.listPeople().some((p) => p.person_id === "p_amit")).toBe(false);
  });

  it("returns copies", () => {
    const { store } = makeStore();
    store.listPeople()[0].status = "sos";
    expect(store.getPerson("p_amit")?.status).toBe("unconfirmed");
  });
});

describe("recordContact", () => {
  it("stamps last_contact with the clock and shows it on /state", () => {
    const { store, advance } = makeStore();
    advance(10);
    store.recordContact("p_amit", null);
    expect(store.getPerson("p_amit")?.last_contact).toBe(LATER);
    expect(store.snapshot().people.find((p) => p.person_id === "p_amit")?.last_contact).toBe(LATER);
    expect(store.snapshot().incident.updated_at).toBe(LATER);
  });

  it("updates the location when one is given", () => {
    const { store } = makeStore();
    store.recordContact("p_amit", { lat: 37.9, lng: -122.3 });
    expect(store.getPerson("p_amit")).toMatchObject({ lat: 37.9, lng: -122.3 });
  });

  it("keeps the last known location when given null", () => {
    const { store } = makeStore();
    store.recordContact("p_amit", null);
    expect(store.getPerson("p_amit")).toMatchObject({ lat: 37.851, lng: -122.224 });
  });

  it("puts a new person on the map once they share a location", () => {
    const { store } = makeStore();
    store.addPerson(PHONES.stranger, null);
    store.recordContact("p_new_1", { lat: 37.86, lng: -122.22 });
    expect(store.snapshot().people.some((p) => p.person_id === "p_new_1")).toBe(true);
  });

  it("does nothing for an unknown person", () => {
    const { store } = makeStore();
    const before = store.snapshot();
    store.recordContact("p_nobody", { lat: 1, lng: 1 });
    expect(store.snapshot()).toEqual(before);
  });
});

describe("setStatus", () => {
  it("changes the status and reports the previous one", () => {
    const { store } = makeStore();
    expect(store.setStatus("p_amit", "safe")).toEqual({ changed: true, previous: "unconfirmed", held: false });
    expect(store.getPerson("p_amit")?.status).toBe("safe");
    expect(store.snapshot().counts).toEqual({ safe: 46, unconfirmed: 4, sos: 0, en_route: 0 });
  });

  it("reports no change when the status is already set", () => {
    const { store, advance } = makeStore();
    advance(10);
    expect(store.setStatus("p_amit", "unconfirmed")).toEqual({ changed: false, previous: "unconfirmed", held: false });
    expect(store.snapshot().incident.updated_at).toBe(T0);
  });

  it.each(["safe", "unconfirmed", "en_route"] as const)("holds sos when asked to move to %s", (status) => {
    const { store } = makeStore();
    store.setStatus("p_amit", "sos");
    expect(store.setStatus("p_amit", status)).toEqual({ changed: false, previous: "sos", held: true });
    expect(store.getPerson("p_amit")?.status).toBe("sos");
  });

  it("lets a responder clear sos", () => {
    const { store } = makeStore();
    store.setStatus("p_amit", "sos");
    expect(store.setStatus("p_amit", "safe", { byResponder: true })).toEqual({ changed: true, previous: "sos", held: false });
    expect(store.getPerson("p_amit")?.status).toBe("safe");
  });

  it("does not hold a repeated sos", () => {
    const { store } = makeStore();
    store.setStatus("p_amit", "sos");
    expect(store.setStatus("p_amit", "sos")).toEqual({ changed: false, previous: "sos", held: false });
  });

  it("can raise anyone to sos", () => {
    const { store } = makeStore();
    store.setStatus("p_amit", "safe");
    expect(store.setStatus("p_amit", "sos").changed).toBe(true);
  });

  it("throws for an unknown person", () => {
    const { store } = makeStore();
    expect(errorMessage(() => store.setStatus("p_nobody", "sos"))).toBe('Unknown person "p_nobody"');
  });

  it("moves an SOS volunteer from volunteers to people, and back once cleared", () => {
    const { store } = makeStore();
    store.setStatus("v_sam", "sos");
    let s = store.snapshot();
    expect(s.volunteers).toEqual([]);
    expect(s.people[0]).toMatchObject({ person_id: "v_sam", status: "sos" });
    expect(s.counts.sos).toBe(1);

    store.setStatus("v_sam", "safe", { byResponder: true });
    s = store.snapshot();
    expect(s.volunteers.map((v) => v.volunteer_id)).toEqual(["v_sam"]);
    expect(s.people.some((p) => p.person_id === "v_sam")).toBe(false);
  });
});

describe("markUnitHeard", () => {
  it("stamps last_heard on /state", () => {
    const { store, advance } = makeStore();
    advance(10);
    store.markUnitHeard("u_4");
    expect(store.snapshot().units).toEqual([{ unit_id: "u_4", name: "Unit 4", last_heard: LATER }]);
    expect(store.snapshot().incident.updated_at).toBe(LATER);
  });

  it("does nothing for an unknown unit", () => {
    const { store } = makeStore();
    store.markUnitHeard("u_99");
    expect(store.snapshot().units[0].last_heard).toBeNull();
  });
});

describe("seenResponse and rememberResponse", () => {
  const response = { actions: [{ type: "say" as const, text: "hi" }] };

  it("returns undefined for an event it has not seen", () => {
    expect(makeStore().store.seenResponse("evt_new")).toBeUndefined();
  });

  it("returns a copy of what was remembered", () => {
    const { store } = makeStore();
    const mine = structuredClone(response);
    store.rememberResponse("evt_1", mine);
    mine.actions.push({ type: "say", text: "changed after" });
    const first = store.seenResponse("evt_1")!;
    first.actions.length = 0;
    expect(store.seenResponse("evt_1")).toEqual(response);
  });

  it("keeps the newest 500 and forgets the oldest", () => {
    const { store } = makeStore();
    for (let i = 0; i <= 500; i++) store.rememberResponse(`evt_${i}`, response);
    expect(store.seenResponse("evt_0")).toBeUndefined();
    expect(store.seenResponse("evt_1")).toEqual(response);
    expect(store.seenResponse("evt_500")).toEqual(response);
  });

  it("forgets everything on reset", () => {
    const { store } = makeStore();
    store.rememberResponse("evt_1", response);
    store.reset();
    expect(store.seenResponse("evt_1")).toBeUndefined();
  });
});

describe("addTimeline", () => {
  it("returns a copy, so changing it does not change the store", () => {
    const { store } = makeStore();
    const entry = store.addTimeline({ channel: "radio", who: "Unit 4", text: "copy" });
    entry.text = "changed";
    expect(store.snapshot().timeline[0].text).toBe("copy");
  });
});
