/**
 * Tests for the agent tools, focused on the safety rules that live in code:
 * residents only change themselves, only responders clear an SOS, an SOS
 * texts the family, and no output ever holds a phone number.
 */
import { describe, expect, it } from "vitest";
import { makeStore, PHONES, runTool, toolContext } from "./helpers.js";

/**
 * Run a tool and return the rejection message.
 *
 * Args:
 *     promise (Promise<unknown>): The tool call.
 *
 * Returns:
 *     Promise<string>: The error message.
 *
 * Raises:
 *     Error: If the tool succeeded.
 */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the tool to throw");
}

describe("set_status", () => {
  it("lets a resident raise their own SOS and queues the family text", async () => {
    const { store } = makeStore();
    const ctx = toolContext(store);
    const out = await runTool("set_status", { person_id: "p_amit", status: "sos", reason: "stuck" }, ctx);
    expect(out).toEqual({ name: "Amit", status: "sos", previous: "unconfirmed", held_for_responder: false });
    expect(ctx.extraActions).toEqual([expect.objectContaining({ type: "send_text", person_id: "p_priya", to: PHONES.priya })]);
  });

  it("does not let a resident change someone else", async () => {
    const { store } = makeStore();
    const msg = await rejection(runTool("set_status", { person_id: "p_priya", status: "safe", reason: "x" }, toolContext(store)));
    expect(msg).toBe("Residents can only update their own status.");
  });

  it("holds a resident's own SOS, but lets a responder clear it", async () => {
    const { store } = makeStore();
    store.setStatus("p_amit", "sos");
    const own = await runTool("set_status", { person_id: "p_amit", status: "safe", reason: "x" }, toolContext(store));
    expect(own).toMatchObject({ status: "sos", held_for_responder: true });
    await runTool("set_status", { person_id: "p_amit", status: "safe", reason: "x" }, toolContext(store, { unitId: "u_4" }));
    expect(store.getPerson("p_amit")?.status).toBe("safe");
  });

  it("throws for an unknown person or status", async () => {
    const { store } = makeStore();
    const ctx = toolContext(store);
    expect(await rejection(runTool("set_status", { person_id: "p_ghost", status: "sos", reason: "x" }, ctx))).toMatch(/Unknown person_id/);
    expect(await rejection(runTool("set_status", { person_id: "p_amit", status: "lost", reason: "x" }, ctx))).toMatch(/status must be/);
  });
});

describe("plan_route", () => {
  it("throws when no destination is given, instead of routing to the start", async () => {
    const { store } = makeStore();
    expect(await rejection(runTool("plan_route", {}, toolContext(store)))).toMatch(/destination/i);
  });
});

describe("lookups", () => {
  it("lists known places when a place is unknown", async () => {
    const { store } = makeStore();
    expect(await rejection(runTool("plan_route", { destination: "Elm St" }, toolContext(store)))).toMatch(
      /^Unknown place "Elm St"\. Known places: Command Post, Oak St/,
    );
  });

  it("gives the same counts as the dashboard, overall and by zone", async () => {
    const { store } = makeStore();
    const ctx = toolContext(store, { unitId: "u_4" });
    expect((await runTool("get_people_status", {}, ctx)).counts).toEqual(store.snapshot().counts);
    expect((await runTool("get_people_status", { zone: "zone 3" }, ctx)).counts).toEqual({ safe: 15, unconfirmed: 2, sos: 0, en_route: 0 });
  });

  it("finds the sender's family contact", async () => {
    const { store } = makeStore();
    const out = await runTool("find_person", { relation: "family" }, toolContext(store));
    expect(out.found.map((p: { name: string }) => p.name)).toEqual(["Priya"]);
  });
});

describe("no phone numbers", () => {
  it("never puts a phone number in any tool output", async () => {
    const { store } = makeStore();
    const resident = toolContext(store);
    const unit = toolContext(store, { unitId: "u_4" });
    const outputs = [
      await runTool("get_hazards", {}, resident),
      await runTool("plan_route", { destination: "nearest shelter" }, unit),
      await runTool("get_shelters", {}, resident),
      await runTool("get_weather", {}, unit),
      await runTool("get_people_status", {}, unit),
      await runTool("find_person", { name: "a" }, resident),
      await runTool("set_status", { person_id: "p_amit", status: "sos", reason: "x" }, resident),
    ];
    expect(JSON.stringify(outputs)).not.toMatch(/\+?\d{10,}/);
  });
});
