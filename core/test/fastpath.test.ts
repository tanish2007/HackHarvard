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
    "ok",
    "Yes",
    "yep",
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

  it("checks safe before en route", () => {
    expect(intent("made it, leaving the car here")).toBe("safe");
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

  it("uses the scenario's wake phrase, not a hardcoded one", () => {
    expect(classify("Base, copy?", "radio", "base").intent).toBe("agent");
    expect(classify("Relay, copy?", "radio", "base").intent).toBe("radio_chatter");
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
