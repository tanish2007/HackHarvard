/**
 * The tools the agent can call.
 *
 * The model sees Relay-shaped tools ("plan_route to Oak St"), not raw
 * coordinates. Each tool resolves names from the scenario, then calls the
 * Contract C data functions underneath. The safety rules live here in code,
 * not in the prompt:
 *     - A resident can only change their own status.
 *     - Only a responder can clear an SOS.
 *     - No tool output ever includes a phone number.
 */
import type { RelayAction } from "../contracts.js";
import type { DataTools } from "../data/types.js";
import { familyAlert } from "../event/alerts.js";
import { compassDirection, distanceKm } from "../lib/geo.js";
import type { PersonStatus } from "../scenario/schema.js";
import type { IncidentStore, TrackedPerson, TrackedUnit } from "../state/store.js";
import type { ToolDeclaration } from "./llm.js";
import { resolvePlace, type Point } from "./places.js";

/** How many names a people lookup returns, so answers stay short. */
const MAX_NAMES = 10;

/** A person counts as at a shelter within this distance of it. */
const AT_SHELTER_KM = 0.3;

/** Farthest a volunteer is sent to someone who needs help, in km. */
const MATCH_RADIUS_KM = 5;

/**
 * Everything a tool needs for one agent run.
 *
 * Attributes:
 *     store (IncidentStore): The live incident state.
 *     data (DataTools): The Contract C functions.
 *     person (TrackedPerson | undefined): The sender, if a person.
 *     unit (TrackedUnit | undefined): The sender, if a responder unit.
 *     who (string): The sender's display name.
 *     isResponder (boolean): True for units and radio traffic. Responders can
 *         update anyone and clear an SOS.
 *     origin (Point): Where the sender is, or the command post for
 *         responders. "Me" and "nearest" are measured from here.
 *     extraActions (RelayAction[]): Actions tools add besides the reply,
 *         such as the family text after an SOS.
 */
export interface ToolContext {
  store: IncidentStore;
  data: DataTools;
  person: TrackedPerson | undefined;
  unit: TrackedUnit | undefined;
  who: string;
  isResponder: boolean;
  origin: Point;
  extraActions: RelayAction[];
}

/**
 * A tool: what the model sees, and the code that runs.
 *
 * Attributes:
 *     declaration (ToolDeclaration): Name, description, and argument schema.
 *     run (function): Runs the tool. Returns a JSON-able result. Throws an
 *         Error with a helpful message when the arguments are unusable.
 */
export interface Tool {
  declaration: ToolDeclaration;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

/**
 * Read an optional string argument.
 *
 * Args:
 *     args (Record<string, unknown>): The model's arguments.
 *     key (string): Argument name.
 *
 * Returns:
 *     string | undefined: The trimmed value, or undefined if missing or blank.
 */
function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Resolve a place argument, or throw a message that lists what is known.
 *
 * Args:
 *     query (string | undefined): The place the model passed.
 *     ctx (ToolContext): The run context.
 *
 * Returns:
 *     Point: The resolved place.
 *
 * Raises:
 *     Error: If the name matches nothing in the scenario.
 */
function placeOrThrow(query: string | undefined, ctx: ToolContext): Point {
  const p = resolvePlace(query, ctx.origin, ctx.store.scenario, ctx.store.listPeople());
  if (p) return p;
  const known = [...ctx.store.scenario.places.map((x) => x.name), ...ctx.store.scenario.shelters.map((x) => x.name)];
  throw new Error(`Unknown place "${query}". Known places: ${known.join(", ")}.`);
}

/**
 * The zone name for a zone id.
 *
 * Args:
 *     ctx (ToolContext): The run context.
 *     zoneId (string | null): A zone id.
 *
 * Returns:
 *     string | null: The zone's name, or null.
 */
function zoneName(ctx: ToolContext, zoneId: string | null): string | null {
  return ctx.store.scenario.zones.find((z) => z.id === zoneId)?.name ?? null;
}

const nearArg = {
  near: {
    type: "string",
    description: "Optional place, shelter, zone, or person name. Leave empty for the sender's own location.",
  },
};

export const TOOLS: Tool[] = [
  {
    declaration: {
      name: "get_hazards",
      description:
        "Active fires and weather hazards near a place: kind, severity, distance, and direction. Use for questions about where the fire is or whether an area is dangerous.",
      parameters: { type: "object", properties: nearArg },
    },
    async run(args, ctx) {
      const at = placeOrThrow(str(args, "near"), ctx);
      const radius = ctx.store.scenario.settings.alert_radius_km * 2;
      const hazards = await ctx.data.getHazards(at.lat, at.lng, radius);
      return {
        near: at.name,
        hazards: hazards.map((h) => ({
          kind: h.kind,
          severity: h.severity,
          distance_km: distanceKm(at.lat, at.lng, h.lat, h.lng),
          direction: compassDirection(at.lat, at.lng, h.lat, h.lng),
          radius_km: h.radius_km,
          source: h.source,
        })),
      };
    },
  },
  {
    declaration: {
      name: "plan_route",
      description:
        "A driving route that avoids fire areas, with distance, minutes, and steps. Use for any 'route to', 'how do I get to', or 'fastest way to' question, including 'nearest shelter'.",
      parameters: {
        type: "object",
        properties: {
          destination: { type: "string", description: "Where to go: a place, shelter, zone, person, or 'nearest shelter'." },
          origin: { type: "string", description: "Optional start. Leave empty to start from the sender." },
        },
        required: ["destination"],
      },
    },
    async run(args, ctx) {
      // An empty place resolves to the start, so a missing destination
      // would plan a route from the start to itself.
      const destination = str(args, "destination");
      if (!destination) throw new Error("destination is required, e.g. a shelter name or 'nearest shelter'.");
      const from = placeOrThrow(str(args, "origin"), ctx);
      const to = placeOrThrow(destination, { ...ctx, origin: from });
      const route = await ctx.data.getRoute(from.lat, from.lng, to.lat, to.lng);
      return {
        from: from.name,
        to: to.name,
        distance_km: route.distance_km,
        duration_min: route.duration_min,
        steps: route.steps,
        avoided_hazards: route.avoided_hazards,
        source: route.source,
      };
    },
  },
  {
    declaration: {
      name: "get_shelters",
      description: "The nearest open shelters with distance and notes such as pets or medical staff.",
      parameters: { type: "object", properties: nearArg },
    },
    async run(args, ctx) {
      const at = placeOrThrow(str(args, "near"), ctx);
      const shelters = await ctx.data.getShelters(at.lat, at.lng);
      return {
        near: at.name,
        shelters: shelters.slice(0, 3).map((s) => ({ name: s.name, distance_km: s.distance_km, capacity_note: s.capacity_note })),
      };
    },
  },
  {
    declaration: {
      name: "get_weather",
      description: "Current weather and the next 2 hours: wind speed and direction, temperature. Use for wind and forecast questions.",
      parameters: { type: "object", properties: nearArg },
    },
    async run(args, ctx) {
      const at = placeOrThrow(str(args, "near"), ctx);
      return { near: at.name, ...(await ctx.data.getWeather(at.lat, at.lng)) };
    },
  },
  {
    declaration: {
      name: "get_people_status",
      description:
        "How many residents are safe, unconfirmed, in SOS, or on their way, overall or in one zone, with the names of people who need attention. Use for 'how many unaccounted for' or 'who still needs help'.",
      parameters: {
        type: "object",
        properties: { zone: { type: "string", description: "Optional zone name, e.g. 'Zone 3'. Leave empty for everyone." } },
      },
    },
    async run(args, ctx) {
      const zoneQuery = str(args, "zone");
      let zoneId: string | null = null;
      if (zoneQuery) {
        const z = ctx.store.scenario.zones.find((x) => x.name.toLowerCase() === zoneQuery.toLowerCase() || x.id === zoneQuery);
        if (!z) throw new Error(`Unknown zone "${zoneQuery}". Zones: ${ctx.store.scenario.zones.map((x) => x.name).join(", ")}.`);
        zoneId = z.id;
      }
      const people = ctx.store.listPeople().filter((p) => p.role === "resident" || p.status === "sos");
      const inZone = zoneId ? people.filter((p) => p.zone === zoneId) : people;
      const counts = { safe: 0, unconfirmed: 0, sos: 0, en_route: 0 };
      for (const p of inZone) counts[p.status]++;
      const namesWith = (s: PersonStatus) => inZone.filter((p) => p.status === s).slice(0, MAX_NAMES).map((p) => p.name);
      return {
        zone: zoneQuery ? zoneName(ctx, zoneId) : "all zones",
        counts,
        unaccounted_for: counts.unconfirmed + counts.sos,
        sos: namesWith("sos"),
        unconfirmed: namesWith("unconfirmed"),
      };
    },
  },
  {
    declaration: {
      name: "find_person",
      description:
        "Find someone's status and whereabouts, for family reunification ('looking for my mom'). Use relation 'family' when the sender asks about their own family.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The person's name, if given." },
          relation: { type: "string", enum: ["family"], description: "Set to 'family' for the sender's own family contact." },
        },
      },
    },
    async run(args, ctx) {
      const name = str(args, "name")?.toLowerCase();
      let matches: TrackedPerson[];
      if (str(args, "relation") === "family") {
        const id = ctx.person?.family_contact;
        const fam = id ? ctx.store.getPerson(id) : undefined;
        matches = fam ? [fam] : [];
      } else if (name) {
        matches = ctx.store.listPeople().filter((p) => p.name.toLowerCase().includes(name) || name.includes(p.name.toLowerCase()));
      } else {
        throw new Error("Give a name, or relation 'family'.");
      }
      return {
        found: matches.slice(0, 5).map((p) => {
          let atShelter: string | null = null;
          if (p.lat !== null && p.lng !== null) {
            const s = ctx.store.scenario.shelters.find((x) => distanceKm(p.lat!, p.lng!, x.lat, x.lng) <= AT_SHELTER_KM);
            atShelter = s?.name ?? null;
          }
          return { person_id: p.person_id, name: p.name, status: p.status, zone: zoneName(ctx, p.zone), at_shelter: atShelter, last_contact: p.last_contact };
        }),
      };
    },
  },
  {
    declaration: {
      name: "register_volunteer",
      description:
        "Sign the sender up as a volunteer when they offer help, a vehicle, or seats ('I have a truck and can carry 4'). Then call match_volunteer.",
      parameters: {
        type: "object",
        properties: {
          capacity_note: { type: "string", description: "What they offer in a few words, e.g. 'truck, carries 4'." },
        },
        required: ["capacity_note"],
      },
    },
    async run(args, ctx) {
      const note = str(args, "capacity_note");
      if (!note) throw new Error("capacity_note is required, e.g. 'truck, carries 4'.");
      const me = ctx.person;
      if (!me) throw new Error("Only a person texting Relay can volunteer.");
      ctx.store.registerVolunteer(me.person_id, note);
      ctx.store.addTimeline({ channel: "system", who: "Relay", text: `${me.name} volunteered: ${note}` });
      return { name: me.name, capacity_note: note, location_known: me.lat !== null };
    },
  },
  {
    declaration: {
      name: "match_volunteer",
      description:
        "Find the nearest resident who still needs help for the sender, after register_volunteer. People in SOS come first. Use plan_route to that person for directions.",
      parameters: { type: "object", properties: {} },
    },
    async run(_args, ctx) {
      const me = ctx.person;
      const offer = me ? ctx.store.getOffer(me.person_id) : undefined;
      if (!me || !offer) throw new Error("Call register_volunteer first.");
      if (me.lat === null || me.lng === null) return { matched: null, reason: "Ask them to share their location first." };
      const { lat, lng } = me;
      const needs = ctx.store
        .listPeople()
        .filter((p) => p.role === "resident" && p.person_id !== me.person_id && p.lat !== null && p.lng !== null)
        .filter((p) => p.status === "sos" || p.status === "unconfirmed")
        .map((p) => ({ p, km: distanceKm(lat, lng, p.lat!, p.lng!) }))
        .filter((x) => x.km <= MATCH_RADIUS_KM)
        .sort((a, b) => Number(b.p.status === "sos") - Number(a.p.status === "sos") || a.km - b.km);
      const best = needs[0];
      if (!best) return { matched: null, reason: `Nobody needs help within ${MATCH_RADIUS_KM} km right now.` };
      ctx.store.assignVolunteer(me.person_id, best.p.person_id);
      ctx.store.addTimeline({
        channel: "system",
        who: "Relay",
        text: `${me.name} (${offer.capacity_note}) matched to ${best.p.name} (${best.p.status}), ${best.km.toFixed(1)} km away`,
      });
      return {
        matched: {
          name: best.p.name,
          status: best.p.status,
          zone: zoneName(ctx, best.p.zone),
          distance_km: Math.round(best.km * 10) / 10,
          direction: compassDirection(lat, lng, best.p.lat!, best.p.lng!),
        },
        note: "Tell the volunteer to stay out of the fire area and follow responders' instructions.",
      };
    },
  },
  {
    declaration: {
      name: "set_status",
      description:
        "Update a person's status. Set 'sos' when someone describes danger or needs help. Responders may also confirm someone 'safe'. Residents may only update themselves.",
      parameters: {
        type: "object",
        properties: {
          person_id: { type: "string", description: "The person's id, from the context or find_person." },
          status: { type: "string", enum: ["safe", "unconfirmed", "sos", "en_route"] },
          reason: { type: "string", description: "Short reason, for the incident timeline." },
        },
        required: ["person_id", "status", "reason"],
      },
    },
    async run(args, ctx) {
      const id = str(args, "person_id") ?? "";
      const status = str(args, "status") as PersonStatus | undefined;
      const reason = str(args, "reason") ?? "";
      if (!status || !["safe", "unconfirmed", "sos", "en_route"].includes(status)) throw new Error("status must be safe, unconfirmed, sos, or en_route.");
      const target = ctx.store.getPerson(id);
      if (!target) throw new Error(`Unknown person_id "${id}". Use find_person first.`);
      if (!ctx.isResponder && target.person_id !== ctx.person?.person_id) {
        throw new Error("Residents can only update their own status.");
      }

      const result = ctx.store.setStatus(id, status, { byResponder: ctx.isResponder });
      if (result.changed) {
        ctx.store.addTimeline({ channel: "system", who: "Relay", text: `${target.name} marked ${status} by ${ctx.who}: ${reason}` });
        if (status === "sos") ctx.extraActions.push(...familyAlert(target, ctx.store));
      }
      return {
        name: target.name,
        status: ctx.store.getPerson(id)?.status,
        previous: result.previous,
        held_for_responder: result.held,
      };
    },
  },
];
