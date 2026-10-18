/**
 * Tests for the fast keyword rules that run before the LLM.
 *
 * These must work with the LLM down, so they carry the demo. Order matters:
 * STOP, then SOS, then safe, then en route, then the agent.
 */
import { describe, expect, it } from "vitest";
import type { Channel } from "../src/contracts.js";
import { classify, stripWakePhrase } from "../src/rules/fastpath.js";

/**
 * Classify a text message with the scenario's wake phrase.
 *
 * Args:
 *     text (string): The message.
 *     channel (Channel): Where it came from. Defaults to iMessage.
 *
 * Returns:
 *     string: The intent.
 */
function intent(text: string, channel: Channel = "imessage"): string {
  return classify(text, channel, "relay").intent;
}

describe("STOP", () => {
  it.each(["STOP", "stop", "Stop.", "  stop  ", "STOP!", "stop alerts", "Unsubscribe", "cancel", "QUIT", "end"])(
    "%j is stop",
    (text) => {
      expect(intent(text)).toBe("stop");
    },
  );

  it.each(["stop sending me alerts", "please stop", "don't stop", "unstoppable", "the end of Oak St is blocked"])(
    "%j is not stop, since only exact words count",
    (text) => {
      expect(intent(text)).not.toBe("stop");
    },
  );

  it("wins over SOS words only when the message is exactly a stop word", () => {
    expect(intent("stop")).toBe("stop");
    expect(intent("stop, I need help")).toBe("sos");
  });
});

describe("SOS", () => {
  it.each([
    "SOS",
    "sos!!",
    "help",
    "HELP!",
    "help me",
    "I need help",
    "my car won't start, I need help",
    "we need an ambulance",
    "need rescue",
    "we're trapped",
    "I'm injured",
    "my son is hurt",
    "I can't get out",
    "can't breathe",
    "can’t move",
    "this is an emergency",
    "I'm not safe",
    "it's unsafe here",
    "ayuda",
    "Socorro!",
  ])("%j is sos", (text) => {
    expect(intent(text)).toBe("sos");
  });

  it.each(["Don't need help", "don’t need help", "dont need help", "I do not need help", "no longer need help", "No help needed", "I can help"])(
    "%j is not sos",
    (text) => {
      expect(intent(text)).not.toBe("sos");
    },
  );

  it("treats 'not safe' as sos, never safe", () => {
    expect(intent("not safe")).toBe("sos");
    expect(intent("we are NOT safe here")).toBe("sos");
  });

  it("checks SOS before safe", () => {
    expect(intent("I'm safe but my neighbor's son is hurt")).toBe("sos");
  });

  it("does not match SOS inside other words", () => {
    expect(intent("helpful info, thanks")).not.toBe("sos");
    expect(intent("the hurtle is fine")).not.toBe("sos");
  });
});

describe("safe", () => {
  it.each([
    "safe",
    "I'm safe",
    "I’m ok",
    "i am fine",
    "Im good",
    "we're okay",
    "we are safe now",
    "all good here",
    "at the shelter",
    "We're at shelter C",
    "made it",
    "estoy bien",
    "estamos a salvo",
  ])("%j is safe", (text) => {
    expect(intent(text)).toBe("safe");
  });

  it.each(["I'm not okay", "not fine"])("%j is not safe", (text) => {
    expect(intent(text)).not.toBe("safe");
  });

  it.each(["ok", "Okay", "Yes", "yeah", "yep", "fine"])("%j by text goes to the agent, since it could mean anything", (text) => {
    expect(intent(text)).toBe("agent");
  });

  it.each(["ok", "Okay", "Yes", "yeah", "yep", "fine", "yes I am", "I'm fine", "Yes."])(
    "%j on a voice call is safe, since the check-in call asks 'Are you safe?'",
    (text) => {
      expect(intent(text, "voice")).toBe("safe");
    },
  );

  it.each(["no", "nope", "not really"])("%j on a voice call is not safe", (text) => {
    expect(intent(text, "voice")).not.toBe("safe");
  });

  it("checks safe before en route", () => {
    expect(intent("made it, leaving the car here")).toBe("safe");
  });
});

describe("negation and questions", () => {
  // A false SOS cannot be cleared without a responder and texts the family.
  // A false safe stops the check-in chain for someone who may be in danger.
  const cases: [string, string][] = [
    ["We're safe, nobody is hurt", "safe"],
    ["I'm ok, not injured", "safe"],
    ["No emergency here, we're fine", "safe"],
    ["no one is hurt", "agent"],
    ["Can you help me find a shelter?", "agent"],
    ["No necesito ayuda", "agent"],
    ["Is Route 24 safe?", "agent"],
    ["Is the shelter safe for pets?", "agent"],
    ["am I safe here", "agent"],
    ["We are not leaving", "agent"],
    ["not leaving yet", "agent"],
  ];

  it.each(cases)("%j is %s", (text, expected) => {
    expect(intent(text)).toBe(expected);
  });

  it("only looks 3 words back for a negator", () => {
    expect(intent("not that I know, but my son is hurt")).toBe("sos");
    expect(intent("there is no road out and my son is hurt")).toBe("sos");
  });

  it("treats a leading no as an answer, not a negation", () => {
    expect(intent("no I need help", "voice")).toBe("sos");
    expect(intent("no we're trapped")).toBe("sos");
  });

  it.each(["no I'm not hurt", "no one is hurt"])("%j is not sos", (text) => {
    expect(intent(text)).not.toBe("sos");
    expect(intent(text, "voice")).not.toBe("sos");
  });

  it("does not carry a negation across a clause boundary", () => {
    expect(intent("No. I'm trapped")).toBe("sos");
    expect(intent("not good, we're trapped")).toBe("sos");
    expect(intent("No! Help me")).toBe("sos");
  });

  it("still finds SOS in a later statement after a question", () => {
    expect(intent("Is anyone there? We're trapped")).toBe("sos");
    expect(intent("Where do we go? I'm injured")).toBe("sos");
  });

  it("counts the word SOS even inside a question", () => {
    expect(intent("SOS can anyone hear me?")).toBe("sos");
    expect(intent("can you send an SOS for us?")).toBe("sos");
  });

  it("does not count a negated SOS", () => {
    expect(intent("not an SOS, just checking the route")).not.toBe("sos");
  });
});

describe("en route", () => {
  it.each(["leaving now", "on my way", "On our way!", "we're evacuating", "heading out", "heading to Shelter C", "en route", "driving to my sister's"])(
    "%j is en_route",
    (text) => {
      expect(intent(text)).toBe("en_route");
    },
  );
});

describe("agent", () => {
  it.each(["where is the nearest shelter?", "what's the wind like", "I have a truck and can carry 4 people", "looking for my mom, Priya", "", "   "])(
    "%j goes to the agent",
    (text) => {
      expect(intent(text)).toBe("agent");
    },
  );

  it("passes the original text through for non-radio messages", () => {
    expect(classify("  Where is the SHELTER?  ", "imessage", "relay").text).toBe("  Where is the SHELTER?  ");
  });
});

describe("channels", () => {
  it.each(["sms", "voice"] as Channel[])("treats %s like iMessage", (channel) => {
    expect(intent("SOS", channel)).toBe("sos");
    expect(intent("I'm okay", channel)).toBe("safe");
    expect(intent("STOP", channel)).toBe("stop");
  });
});

describe("radio", () => {
  it("answers when the message starts with the wake phrase, and strips it", () => {
    expect(classify("Relay, wind forecast next 2 hours?", "radio", "relay")).toEqual({
      intent: "agent",
      text: "wind forecast next 2 hours?",
    });
  });

  it("accepts a call sign before the wake phrase", () => {
    expect(classify("Unit 4 to Relay: how many unaccounted in Zone 3?", "radio", "relay")).toEqual({
      intent: "agent",
      text: "how many unaccounted in Zone 3?",
    });
  });

  it("accepts the wake phrase as the 5th word but not the 6th", () => {
    expect(intent("this is unit four relay, go ahead", "radio")).toBe("agent");
    expect(intent("this is unit four calling relay, go ahead", "radio")).toBe("radio_chatter");
  });

  it("is case and punctuation insensitive", () => {
    expect(classify("RELAY. Status?", "radio", "relay").text).toBe("Status?");
    expect(classify("relay - status?", "radio", "relay").text).toBe("status?");
  });

  it("marks traffic without the wake phrase as chatter and keeps the text", () => {
    expect(classify("Unit 2, copy that", "radio", "relay")).toEqual({ intent: "radio_chatter", text: "Unit 2, copy that" });
  });

  it("does not run the keyword rules on radio", () => {
    expect(intent("SOS, we have injured", "radio")).toBe("radio_chatter");
    expect(intent("STOP", "radio")).toBe("radio_chatter");
    expect(intent("Relay, we have injured", "radio")).toBe("agent");
  });

  it("does not wake on a word that only contains the phrase", () => {
    expect(intent("message relayed to unit 2", "radio")).toBe("radio_chatter");
  });

  it("handles the wake phrase on its own", () => {
    expect(classify("Relay", "radio", "relay")).toEqual({ intent: "agent", text: "" });
  });

  it("matches a wake phrase of more than one word", () => {
    expect(classify("Hey Relay, wind forecast?", "radio", "hey relay")).toEqual({ intent: "agent", text: "wind forecast?" });
    expect(classify("Unit 4, hey relay: status", "radio", "hey relay").text).toBe("status");
    expect(classify("Relay, wind forecast?", "radio", "hey relay").intent).toBe("radio_chatter");
    expect(classify("hey there relay", "radio", "hey relay").intent).toBe("radio_chatter");
  });

  it("never wakes on a blank wake phrase", () => {
    expect(classify("anything at all", "radio", "  ").intent).toBe("radio_chatter");
  });

  it("uses the scenario's wake phrase, not a hardcoded one", () => {
    expect(classify("Base, copy?", "radio", "base").intent).toBe("agent");
    expect(classify("Relay, copy?", "radio", "base").intent).toBe("radio_chatter");
  });
});

describe("a misheard wake phrase", () => {
  it.each([
    ["Really, where is the nearest shelter?", "where is the nearest shelter?"],
    ["Really where is the nearest shelter", "where is the nearest shelter"],
    ["Rely, wind forecast?", "wind forecast?"],
    ["REALLY. Is it safe to drive north?", "Is it safe to drive north?"],
  ])("%j wakes Relay with the request after it", (text, rest) => {
    expect(classify(text, "radio", "relay")).toEqual({ intent: "agent", text: rest });
  });

  it("does not wake on a bare 'Really?' with nothing after it", () => {
    expect(classify("Really?", "radio", "relay").intent).toBe("radio_chatter");
    expect(classify("really", "radio", "relay").intent).toBe("radio_chatter");
  });

  it("only counts as the first word", () => {
    expect(classify("that is really bad", "radio", "relay").intent).toBe("radio_chatter");
    expect(classify("unit four really, go ahead", "radio", "relay").intent).toBe("radio_chatter");
  });

  it("prefers the real wake phrase when both appear", () => {
    expect(classify("Relay, really?", "radio", "relay")).toEqual({ intent: "agent", text: "really?" });
  });

  it("only applies to the wake phrase 'relay'", () => {
    expect(classify("Really, copy?", "radio", "base").intent).toBe("radio_chatter");
  });

  it("does not run on text or voice, only radio", () => {
    expect(classify("Really, where is the shelter?", "imessage", "relay").intent).toBe("agent");
    expect(classify("Really, where is the shelter?", "imessage", "relay").text).toBe("Really, where is the shelter?");
  });
});

describe("stripWakePhrase", () => {
  it("returns the rest of the message, or null", () => {
    expect(stripWakePhrase("Relay, route to Oak St avoiding the fire line?", "relay")).toBe(
      "route to Oak St avoiding the fire line?",
    );
    expect(stripWakePhrase("copy that", "relay")).toBeNull();
    expect(stripWakePhrase("", "relay")).toBeNull();
  });
});
