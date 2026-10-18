/** Tests for reading an OpenAI-style chat request. */
import { describe, expect, it } from "vitest";
import { lastUserText, parseCallContext } from "../src/llmRequest.js";

describe("lastUserText", () => {
  it("returns the last user message, trimmed", () => {
    expect(
      lastUserText([
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "  I am okay  " },
      ]),
    ).toBe("I am okay");
  });

  it("joins text parts of array content", () => {
    expect(lastUserText([{ role: "user", content: [{ text: "hel" }, { text: "lo" }] }])).toBe("hello");
  });

  it("returns empty when there is no user message", () => {
    expect(lastUserText([{ role: "system", content: "x" }])).toBe("");
  });
});

describe("parseCallContext", () => {
  const sys = (line: string) => [{ role: "system", content: `You are Relay.\n${line}\nBe brief.` }];

  it("reads person_id and caller_number from the RELAY_CALL line", () => {
    expect(parseCallContext(sys("RELAY_CALL person_id=p_amit caller_number=+15550001111"))).toEqual({
      personId: "p_amit",
      callerNumber: "+15550001111",
    });
  });

  it("treats unfilled variables as missing", () => {
    expect(parseCallContext(sys("RELAY_CALL person_id={{person_id}} caller_number={{caller_number}}"))).toEqual({
      personId: null,
      callerNumber: null,
    });
  });

  it("returns nulls when the line is absent", () => {
    expect(parseCallContext(sys("nothing here"))).toEqual({ personId: null, callerNumber: null });
  });
});
