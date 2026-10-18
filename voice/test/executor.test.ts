/** Tests for the voice action executor. */
import { describe, expect, it, vi } from "vitest";
import { executeActions } from "../src/executor.js";
import type { RelayAction } from "../src/contracts.js";

const makeDeps = () => ({
  session: { speak: vi.fn(async () => {}) },
  placer: { placeCall: vi.fn(async () => {}) },
  log: vi.fn(),
});

describe("executeActions", () => {
  it("speaks say actions on the open call", async () => {
    const deps = makeDeps();
    await executeActions([{ type: "say", text: "Head to Pine Ave" }], deps);
    expect(deps.session.speak).toHaveBeenCalledWith("Head to Pine Ave");
  });

  it("places calls for place_call actions", async () => {
    const deps = makeDeps();
    await executeActions(
      [{ type: "place_call", person_id: "p_amit", script: "Are you okay?", reason: "missed_checkin" }],
      deps,
    );
    expect(deps.placer.placeCall).toHaveBeenCalledWith("p_amit", "Are you okay?", "missed_checkin");
  });

  it("logs and skips send_text", async () => {
    const deps = makeDeps();
    await executeActions(
      [{ type: "send_text", person_id: "p_amit", text: "x", map_url: null }],
      deps,
    );
    expect(deps.log).toHaveBeenCalled();
    expect(deps.session.speak).not.toHaveBeenCalled();
  });

  it("logs and skips unknown types without crashing", async () => {
    const deps = makeDeps();
    await executeActions([{ type: "teleport" } as unknown as RelayAction], deps);
    expect(deps.log).toHaveBeenCalled();
  });

  it("skips say when there is no open call", async () => {
    const deps = makeDeps();
    await executeActions([{ type: "say", text: "hi" }], { ...deps, session: undefined });
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("no open call"));
  });

  it("keeps going after one action fails", async () => {
    const deps = makeDeps();
    deps.session.speak.mockRejectedValueOnce(new Error("audio down"));
    await executeActions(
      [
        { type: "say", text: "first" },
        { type: "place_call", person_id: "p_amit", script: "s", reason: "r" },
      ],
      deps,
    );
    expect(deps.placer.placeCall).toHaveBeenCalled();
  });
});
