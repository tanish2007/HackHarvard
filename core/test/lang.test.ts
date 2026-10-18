/**
 * Tests for multilingual support: language codes, detection, the new
 * keywords, and replies in each person's language.
 */
import { describe, expect, it } from "vitest";
import { handleEvent } from "../src/event/handle.js";
import { detectLanguage } from "../src/lang/detect.js";
import { languageName, resolveLang } from "../src/lang/languages.js";
import { classify } from "../src/rules/fastpath.js";
import { TEMPLATES } from "../src/event/replies.js";
import { makeEvent, makeStore, PHONES } from "./helpers.js";

describe("resolveLang and languageName", () => {
  it.each([
    ["es", "es"],
    ["es-MX", "es"],
    ["ZH_cn", "zh"],
    ["gu", "gu"],
    ["hi", "hi"],
    ["hi-IN", "hi"],
    ["fr", "en"],
    ["", "en"],
    [null, "en"],
  ])("resolves %j to %s", (code, lang) => {
    expect(resolveLang(code)).toBe(lang);
  });

  it("names known languages and returns null for others", () => {
    expect(languageName("gu")).toBe("Gujarati");
    expect(languageName("hi")).toBe("Hindi");
    expect(languageName("fr")).toBeNull();
  });
});

describe("detectLanguage", () => {
  it.each([
    ["Hola, necesito ayuda por favor", "es"],
    ["ayuda", "es"],
    ["救命 我们被困住了", "zh"],
    ["SOS 救命", "zh"],
    ["મદદ કરો", "gu"],
    ["मदद करो", "hi"],
    ["मुझे सबसे नज़दीकी आश्रय स्थल बताइए", "hi"],
  ])("detects %j as %s", (text, lang) => {
    expect(detectLanguage(text)).toBe(lang);
  });

  it.each(["ok", "SOS", "5", "I'm at Peña St", "hello, where is the shelter?", "STOP"])("returns null for %j", (text) => {
    expect(detectLanguage(text)).toBeNull();
  });
});

describe("keywords in other languages", () => {
  it.each([
    ["estamos atrapados", "sos"],
    ["no podemos salir", "sos"],
    ["estamos bien", "safe"],
    ["no estoy bien", "agent"],
    ["vamos saliendo", "en_route"],
  ])("%j is %s", (text, intent) => {
    expect(classify(text, "imessage", "relay").intent).toBe(intent);
  });

  it("treats 'sí' on a check-in call as safe", () => {
    expect(classify("sí", "voice", "relay").intent).toBe("safe");
  });
});

describe("replies in the person's language", () => {
  it("switches a person to Spanish when they text in Spanish, and replies in Spanish", async () => {
    const { store } = makeStore();
    const { actions } = await handleEvent(makeEvent({ text: "Hola, necesito ayuda por favor" }), { store });
    expect(store.getPerson("p_amit")).toMatchObject({ language: "es", status: "sos" });
    const [reply] = actions;
    expect(reply).toMatchObject({ type: "send_text", person_id: "p_amit" });
    expect("text" in reply ? reply.text : "").not.toMatch(/Relay got your SOS/);
  });

  it("texts the family contact in the family's own language", async () => {
    const { store } = makeStore();
    const { actions } = await handleEvent(makeEvent({ text: "SOS" }), { store });
    const family = actions.find((a) => "person_id" in a && a.person_id === "p_priya");
    expect(family && "text" in family ? family.text : "").toMatch(/\p{Script=Gujarati}/u);
  });

  it("keeps the language for a short or English message", async () => {
    const { store } = makeStore();
    await handleEvent(makeEvent({ from: PHONES.priya, text: "ok" }), { store });
    await handleEvent(makeEvent({ from: PHONES.priya, text: "where is the shelter?" }), { store });
    expect(store.getPerson("p_priya")?.language).toBe("gu");
  });

  it("never switches language from radio traffic", async () => {
    const { store } = makeStore();
    await handleEvent(makeEvent({ channel: "radio", from: PHONES.unit4, text: "Relay, hola necesito ayuda por favor" }), { store });
    expect(store.listPeople().every((p) => p.language !== "es" || p.simulated)).toBe(true);
  });
});

describe("Hindi keywords", () => {
  it.each([
    ["मुझे मदद चाहिए", "imessage", "sos"],
    ["मैं फंस गया हूँ", "imessage", "sos"],
    ["बचाओ", "imessage", "sos"],
    ["मदद", "imessage", "sos"],
    ["मैं सुरक्षित नहीं हूँ", "imessage", "sos"],
    ["मैं सुरक्षित हूँ", "imessage", "safe"],
    ["हम सब ठीक हैं", "imessage", "safe"],
    ["सुरक्षित", "imessage", "safe"],
    ["हाँ", "voice", "safe"],
    ["जी हां", "voice", "safe"],
  ])("%j on %s is %s", (text, channel, intent) => {
    expect(classify(text, channel as "imessage" | "voice", "relay").intent).toBe(intent);
  });

  it.each([
    ["मदद की ज़रूरत नहीं है", "negated: no help needed"],
    ["क्या मैं सुरक्षित हूँ?", "a question about being safe"],
    ["कहाँ है सबसे नज़दीकी आश्रय स्थल", "a question about shelters"],
  ])("%j is not an SOS or safe (%s)", (text) => {
    expect(classify(text, "imessage", "relay").intent).toBe("agent");
  });

  it("does not treat a bare yes as safe on text, only on a call", () => {
    expect(classify("हाँ", "imessage", "relay").intent).toBe("agent");
  });

  it("matches ज़ typed as one precomposed letter or as ज plus a nukta", () => {
    const precomposed = "मदद की ज़रूरत है";
    const decomposed = "मदद की ज़रूरत है";
    expect(precomposed).not.toBe(decomposed);
    expect(classify(precomposed, "imessage", "relay").intent).toBe("sos");
    expect(classify(decomposed, "imessage", "relay").intent).toBe("sos");
  });
});

describe("Hindi replies", () => {
  it("switches a person to Hindi when they text in Hindi, and replies in Hindi", async () => {
    const { store } = makeStore();
    const { actions } = await handleEvent(makeEvent({ text: "मुझे मदद चाहिए, मैं फंस गया हूँ" }), { store });
    expect(store.getPerson("p_amit")).toMatchObject({ language: "hi", status: "sos" });
    const reply = actions[0];
    expect(reply).toMatchObject({ type: "send_text", person_id: "p_amit" });
    expect("text" in reply ? reply.text : "").toMatch(/\p{Script=Devanagari}/u);
  });

  it("answers a spoken safe check-in in Hindi for a Hindi speaker", async () => {
    const { store } = makeStore();
    store.setLanguage("p_amit", "hi");
    const { actions } = await handleEvent(makeEvent({ channel: "voice", text: "मैं सुरक्षित हूँ" }), { store });
    const reply = actions[0];
    expect(reply).toMatchObject({ type: "say" });
    expect("text" in reply ? reply.text : "").toMatch(/\p{Script=Devanagari}/u);
  });
});

describe("every fixed reply has Hindi", () => {
  const placeholders = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it.each(Object.keys(TEMPLATES))("%s has Hindi with the same placeholders as English", (id) => {
    const t = TEMPLATES[id as keyof typeof TEMPLATES];
    expect(t.hi).toMatch(/\p{Script=Devanagari}/u);
    expect(placeholders(t.hi)).toEqual(placeholders(t.en));
  });
});
