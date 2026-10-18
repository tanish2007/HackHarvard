/**
 * Tests for multilingual support: language codes, detection, the new
 * keywords, and replies in each person's language.
 */
import { describe, expect, it } from "vitest";
import { handleEvent } from "../src/event/handle.js";
import { detectLanguage } from "../src/lang/detect.js";
import { languageName, resolveLang } from "../src/lang/languages.js";
import { classify } from "../src/rules/fastpath.js";
import { makeEvent, makeStore, PHONES } from "./helpers.js";

describe("resolveLang and languageName", () => {
  it.each([
    ["es", "es"],
    ["es-MX", "es"],
    ["ZH_cn", "zh"],
    ["gu", "gu"],
    ["fr", "en"],
    ["", "en"],
    [null, "en"],
  ])("resolves %j to %s", (code, lang) => {
    expect(resolveLang(code)).toBe(lang);
  });

  it("names known languages and returns null for others", () => {
    expect(languageName("gu")).toBe("Gujarati");
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
