/**
 * Edge cases for loading scenario.json and scenario.local.json.
 *
 * On demo day one edited file moves the whole system to the venue, so a typo
 * there must fail loudly at startup, with a message that names the field,
 * instead of breaking the map mid-demo.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenario } from "../src/scenario/load.js";
import { errorMessage, loadEdited, ROOT, writeScenarioDir, type ScenarioJson } from "./helpers.js";

type Edit = (f: ScenarioJson) => void;

const PHONE_AMIT = "+16175550101";

describe("scenario.json: wrong types and bad values", () => {
  const cases: [string, Edit, RegExp][] = [
    ["a latitude given as a string", (f) => (f.people[0].lat = "37.851"), /"lat"/],
    ["a longitude given as null", (f) => (f.shelters[0].lng = null), /"lng"/],
    ["a simulated flag that is not a boolean", (f) => (f.people[0].simulated = "no"), /"simulated"/],
    ["a status outside the four allowed", (f) => (f.people[0].initial_status = "missing"), /"initial_status"/],
    ["an unknown role", (f) => (f.people[0].role = "mayor"), /"role"/],
    ["an empty incident name", (f) => (f.incident.name = ""), /"incident"/],
    ["a zero check-in timeout", (f) => (f.settings.checkin_timeout_sec = 0), /"checkin_timeout_sec"/],
    ["a negative fire radius", (f) => (f.fire_area.radius_km = -1), /"radius_km"/],
    ["a fractional simulated count", (f) => (f.simulated_population.count = 2.5), /"count"/],
    ["a negative simulated sos count", (f) => (f.simulated_population.sos = -1), /"sos"/],
    ["an empty simulated name list", (f) => (f.simulated_population.names = []), /"names"/],
    ["an empty wake phrase", (f) => (f.settings.wake_phrase = ""), /"wake_phrase"/],
    ["people given as an object instead of a list", (f) => (f.people = {}), /"people"/],
  ];

  it.each(cases)("rejects %s", (_label, edit, field) => {
    expect(errorMessage(() => loadEdited(edit))).toMatch(field);
  });
});

describe("scenario.json: zone polygons", () => {
  it.each([
    ["no points", []],
    ["one point", [[37.87, -122.23]]],
    ["two points", [[37.87, -122.23], [37.86, -122.22]]],
  ])("rejects a polygon with %s", (_label, polygon) => {
    expect(errorMessage(() => loadEdited((f) => (f.zones[0].polygon = polygon)))).toMatch(/"polygon"/);
  });

  it("accepts a triangle, the smallest real polygon", () => {
    const s = loadEdited((f) => (f.zones[0].polygon = [[37.875, -122.235], [37.875, -122.215], [37.865, -122.225]]));
    expect(s.zones[0].polygon).toHaveLength(3);
  });

  it("rejects a point with only one coordinate", () => {
    expect(errorMessage(() => loadEdited((f) => (f.zones[0].polygon[0] = [37.875])))).toMatch(/"polygon"/);
  });
});

describe("scenario.json: missing fields", () => {
  const topLevel = [
    "incident",
    "relay_lines",
    "zones",
    "fire_area",
    "shelters",
    "people",
    "simulated_population",
    "units",
    "emergency_contact",
    "agents",
    "settings",
    "places",
    "fake_weather",
  ];

  it.each(topLevel)("rejects a file with no %s", (key) => {
    expect(errorMessage(() => loadEdited((f) => delete f[key]))).toMatch(new RegExp(`"${key}"`));
  });

  it.each(["phone", "zone", "family_contact", "household_id"])(
    "rejects a person with %s missing, since nullable fields may be null but never missing",
    (key) => {
      expect(errorMessage(() => loadEdited((f) => delete f.people[0][key]))).toMatch(new RegExp(`"${key}"`));
    },
  );

  it("accepts a named person whose phone is null", () => {
    const s = loadEdited((f) => (f.people[0].phone = null));
    expect(s.people.find((p) => p.person_id === "p_amit")?.phone).toBeNull();
  });
});

describe("scenario.json: phone numbers", () => {
  const badPhones = ["6175550150", "+1 617 555 0150", "+1-617-555-0150", "+06175550150", "+16175", "tel:+16175550150", ""];
  const places: [string, (f: ScenarioJson, phone: string) => void][] = [
    ["a person", (f, phone) => (f.people[0].phone = phone)],
    ["a unit", (f, phone) => (f.units[0].phone = phone)],
    ["the emergency contact", (f, phone) => (f.emergency_contact.phone = phone)],
    ["a relay line", (f, phone) => (f.relay_lines.voice = phone)],
  ];

  for (const [where, set] of places) {
    it.each(badPhones)(`rejects "%s" as the phone of ${where}`, (phone) => {
      expect(errorMessage(() => loadEdited((f) => set(f, phone)))).toMatch(/E\.164/);
    });
  }
});

describe("scenario.json: references and simulated population limits", () => {
  it("rejects sos + unconfirmed greater than count", () => {
    const edit: Edit = (f) => Object.assign(f.simulated_population, { count: 4, sos: 3, unconfirmed: 2 });
    expect(errorMessage(() => loadEdited(edit))).toMatch(/sos \+ unconfirmed is more than count/);
  });

  it("accepts sos + unconfirmed equal to count, leaving nobody safe", () => {
    const s = loadEdited((f) => Object.assign(f.simulated_population, { count: 5, sos: 2, unconfirmed: 3 }));
    const sim = s.people.filter((p) => p.simulated);
    expect(sim.map((p) => p.initial_status)).toEqual(["sos", "sos", "unconfirmed", "unconfirmed", "unconfirmed"]);
  });

  it("rejects simulated people when there are no zones to put them in", () => {
    const edit: Edit = (f) => {
      f.zones = [];
      for (const p of f.people) p.zone = null;
    };
    expect(errorMessage(() => loadEdited(edit))).toMatch(/needs at least one zone/);
  });

  it("allows no zones when nobody is simulated", () => {
    const s = loadEdited((f) => {
      f.zones = [];
      for (const p of f.people) p.zone = null;
      f.simulated_population.count = 0;
      f.simulated_population.unconfirmed = 0;
    });
    expect(s.zones).toEqual([]);
    expect(s.people.some((p) => p.simulated)).toBe(false);
  });

  it("rejects a person in a zone that does not exist", () => {
    expect(errorMessage(() => loadEdited((f) => (f.people[0].zone = "zone_9")))).toMatch(
      /p_amit: unknown zone "zone_9"/,
    );
  });

  it("rejects a family contact who does not exist", () => {
    expect(errorMessage(() => loadEdited((f) => (f.people[0].family_contact = "p_nobody")))).toMatch(
      /p_amit: unknown family_contact "p_nobody"/,
    );
  });

  it("rejects an agent that trusts an agent that does not exist", () => {
    expect(errorMessage(() => loadEdited((f) => f.agents[0].trusts.push("hh_nobody")))).toMatch(
      /gov_county: trusts unknown agent "hh_nobody"/,
    );
  });

  it("rejects two named people with the same person_id", () => {
    const edit: Edit = (f) => f.people.push({ ...f.people[0], name: "Other Amit" });
    expect(errorMessage(() => loadEdited(edit))).toMatch(/Duplicate person_id "p_amit"/);
  });
});

describe("scenario.json: duplicate ids", () => {
  it("rejects a named person whose id collides with a generated sim_ id", () => {
    const edit: Edit = (f) => f.people.push({ ...f.people[0], person_id: "sim_001", name: "Collider" });
    expect(errorMessage(() => loadEdited(edit))).toMatch(/Duplicate person_id "sim_001"/);
  });

  const dupes: [string, Edit, RegExp][] = [
    ["shelter", (f) => f.shelters.push({ ...f.shelters[0], name: "Copy" }), /Duplicate shelter id "sh_a"/],
    ["zone", (f) => f.zones.push({ ...f.zones[0], name: "Copy" }), /Duplicate zone id "zone_1"/],
    ["unit", (f) => f.units.push({ ...f.units[0], name: "Copy" }), /Duplicate unit_id "u_4"/],
    ["agent", (f) => f.agents.push({ ...f.agents[0] }), /Duplicate agent_id "gov_county"/],
    ["person and unit", (f) => (f.units[0].unit_id = "p_amit"), /Duplicate person or unit id "p_amit"/],
    ["unit and generated person", (f) => (f.units[0].unit_id = "sim_002"), /Duplicate person or unit id "sim_002"/],
    ["person and the reserved emergency_contact", (f) => (f.people[2].person_id = "emergency_contact"), /"emergency_contact"/],
    ["unit and the reserved emergency_contact", (f) => (f.units[0].unit_id = "emergency_contact"), /"emergency_contact"/],
  ];

  it.each(dupes)("rejects a duplicate %s id", (_label, edit, message) => {
    expect(errorMessage(() => loadEdited(edit))).toMatch(message);
  });
});

describe("scenario.json: places, fake weather, and the command post", () => {
  it("loads the committed places and forecast", () => {
    const s = loadScenario({ dir: ROOT, useLocal: false });
    expect(s.places.map((p) => p.id)).toEqual(["pl_command_post", "pl_oak_st", "pl_pine_ave", "pl_route_24"]);
    expect(s.settings.command_post).toBe("pl_command_post");
    expect(s.fake_weather).toMatchObject({ wind_mph: 22, wind_dir: "NE" });
  });

  it("rejects a duplicate place id", () => {
    expect(errorMessage(() => loadEdited((f) => f.places.push({ ...f.places[1], name: "Copy" })))).toMatch(
      /Duplicate place id "pl_oak_st"/,
    );
  });

  it("rejects a command post that is not a place", () => {
    expect(errorMessage(() => loadEdited((f) => (f.settings.command_post = "sh_a")))).toMatch(
      /settings\.command_post: unknown place "sh_a"/,
    );
  });

  it("rejects a missing command post", () => {
    expect(errorMessage(() => loadEdited((f) => delete f.settings.command_post))).toMatch(/"command_post"/);
  });

  it("rejects no places at all, since the command post must be one", () => {
    expect(errorMessage(() => loadEdited((f) => (f.places = [])))).toMatch(/command_post/);
  });

  const bad: [string, Edit, RegExp][] = [
    ["a place with no aliases list", (f) => delete f.places[0].aliases, /"aliases"/],
    ["an empty alias", (f) => (f.places[0].aliases = [""]), /"aliases"/],
    ["a place latitude as a string", (f) => (f.places[0].lat = "37.86"), /"lat"/],
    ["wind speed as a string", (f) => (f.fake_weather.wind_mph = "22"), /"wind_mph"/],
    ["a forecast with no next_2h", (f) => delete f.fake_weather.next_2h, /"next_2h"/],
  ];

  it.each(bad)("rejects %s", (_label, edit, field) => {
    expect(errorMessage(() => loadEdited(edit))).toMatch(field);
  });
});

describe("scenario.json: shared phone numbers", () => {
  // With few demo phones it is easy to reuse one. Then a resident's texts
  // resolve to the unit, and their SOS never sets a status.
  it("rejects a person and a unit with the same phone", () => {
    expect(errorMessage(() => loadEdited((f) => (f.units[0].phone = PHONE_AMIT)))).toMatch(/Duplicate phone "\+16175550101"/);
  });

  it("rejects two people with the same phone", () => {
    expect(errorMessage(() => loadEdited((f) => (f.people[1].phone = PHONE_AMIT)))).toMatch(/Duplicate phone/);
  });

  it("rejects a shared phone set through scenario.local.json", () => {
    const local = { phones: { p_amit: "+16175550160", u_4: "+16175550160" } };
    expect(errorMessage(() => loadEdited(() => {}, local))).toMatch(/Duplicate phone "\+16175550160"/);
  });

  it("rejects a relay line that is also a person's phone", () => {
    expect(errorMessage(() => loadEdited((f) => (f.relay_lines.voice = PHONE_AMIT)))).toMatch(
      /relay_lines\.voice uses the same phone as a person or unit/,
    );
  });

  it("allows the emergency contact to share a persona's phone, since it is only ever called", () => {
    const s = loadEdited((f) => (f.emergency_contact.phone = PHONE_AMIT));
    expect(s.emergency_contact.phone).toBe(PHONE_AMIT);
  });

  it("allows many people with no phone", () => {
    const s = loadEdited((f) => {
      f.people[0].phone = null;
      f.people[1].phone = null;
    });
    expect(s.people.filter((p) => p.phone === null).length).toBeGreaterThan(2);
  });
});

describe("scenario.json: unreadable files", () => {
  it("names the file when scenario.json is missing", () => {
    const dir = join(writeScenarioDir(), "nowhere");
    expect(errorMessage(() => loadScenario({ dir, useLocal: false }))).toMatch(/Could not read .*scenario\.json/);
  });

  it("names the file when scenario.json is not valid JSON", () => {
    const dir = writeScenarioDir();
    writeFileSync(join(dir, "scenario.json"), '{ "incident": ');
    expect(errorMessage(() => loadScenario({ dir, useLocal: false }))).toMatch(/Could not read .*scenario\.json/);
  });
});

describe("scenario.local.json", () => {
  it.each(["6175550150", "+1 617 555 0150", "555-0150", ""])('rejects "%s" as an override phone', (phone) => {
    expect(errorMessage(() => loadEdited(() => {}, { phones: { p_amit: phone } }))).toMatch(/E\.164/);
  });

  it("rejects an invalid number for a relay line", () => {
    expect(errorMessage(() => loadEdited(() => {}, { relay_lines: { voice: "not a phone" } }))).toMatch(/E\.164/);
  });

  it("rejects a phone given as a number instead of a string", () => {
    expect(errorMessage(() => loadEdited(() => {}, { phones: { p_amit: 16175550150 } }))).toMatch(/"p_amit"/);
  });

  it("refuses to give a phone to a simulated person, who never has one", () => {
    expect(errorMessage(() => loadEdited(() => {}, { phones: { sim_001: "+16175550150" } }))).toMatch(
      /unknown id "sim_001"/,
    );
  });

  it("names the file when the override is not valid JSON", () => {
    expect(errorMessage(() => loadEdited(() => {}, "{ not json"))).toMatch(/Could not read .*scenario\.local\.json/);
  });

  it("accepts a _readme note and an empty override", () => {
    const s = loadEdited(() => {}, { _readme: "copy me" });
    expect(s.relay_lines.messaging).toBe("+16175550100");
  });

  it("is ignored completely when useLocal is false, even if broken", () => {
    const dir = writeScenarioDir(undefined, "{ not json");
    expect(loadScenario({ dir, useLocal: false }).incident.name).toBe("Oak Ridge Fire");
  });

  it("only changes the ids it names", () => {
    const s = loadEdited(() => {}, { phones: { v_sam: "+16175550150" } });
    expect(s.people.find((p) => p.person_id === "v_sam")?.phone).toBe("+16175550150");
    expect(s.people.find((p) => p.person_id === "p_amit")?.phone).toBe("+16175550101");
    expect(s.units[0].phone).toBe("+16175550104");
    expect(s.emergency_contact.phone).toBe("+16175550111");
  });
});

describe(".gitignore", () => {
  it("keeps real numbers and secrets out of the public repo", () => {
    const lines = readFileSync(join(ROOT, ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines).toContain("scenario.local.json");
    expect(lines).toContain(".env");
  });
});
