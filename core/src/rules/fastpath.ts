/**
 * Keyword rules that run before the LLM.
 *
 * STOP, SOS, "safe", and "leaving" must work instantly and even when the LLM
 * is down or rate limited, so they are plain string rules. Radio chatter
 * without the wake phrase is logged but never answered.
 *
 * The rules are deliberately cautious. A false SOS texts the family and can
 * only be cleared by a responder, and a false "safe" stops the check-in chain.
 * So a keyword only counts when it is not negated in its own clause ("nobody
 * is hurt") and the clause is not a question ("Is Route 24 safe?"). Anything
 * unclear goes to the agent instead.
 *
 * English and Spanish use word patterns. Chinese has no spaces and Gujarati
 * uses combining vowel signs, so `\b` does not work for them. They use plain
 * phrase lists (SCRIPT_SOS, SCRIPT_SAFE) matched on text that keeps those
 * signs, with their own negation check: Chinese negates before the keyword
 * (不需要帮助), Gujarati usually after it (મદદની જરૂર નથી).
 */
import type { Channel } from "../contracts.js";

/**
 * What a message means, as far as the fast rules can tell.
 *
 * `agent` means no rule matched and the message goes to the LLM agent.
 * `radio_chatter` means radio traffic not addressed to Relay.
 */
export type Intent = "stop" | "sos" | "safe" | "en_route" | "radio_chatter" | "agent";

/**
 * Result of classifying one message.
 *
 * Attributes:
 *     intent (Intent): What the message means.
 *     text (string): The text to pass on. For radio this has the wake phrase
 *         removed, so the agent sees only the question.
 */
export interface Classification {
  intent: Intent;
  text: string;
}

/**
 * Compose each string to NFC, so a phrase typed with a precomposed letter
 * matches text that normalize("NFC") has turned into base letter plus mark.
 *
 * Devanagari needs this: ज़ (a precomposed letter) becomes ज plus a nukta in
 * NFC, and the phrase lists must be in that same form to match.
 *
 * Args:
 *     phrases (string[]): Phrases as written in the source.
 *
 * Returns:
 *     string[]: The same phrases in NFC.
 */
function nfc(phrases: string[]): string[] {
  return phrases.map((p) => p.normalize("NFC"));
}

const STOP_WORDS = new Set(["stop", "stop alerts", "unsubscribe", "cancel", "quit", "end"]);

/** Short answers that mean "safe" only on a check-in call ("Are you safe?"). */
const SPOKEN_YES = new Set(["yes", "yeah", "yep", "yes i am", "ok", "okay", "fine", "i'm fine", "i am fine", "sí", "si"]);

const SOS = [
  /\bsos\b/,
  /^help$/,
  /\bhelp me\b/,
  /\bneed help\b/,
  /\bneed (an )?(ambulance|rescue)\b/,
  /\btrapped\b/,
  /\binjured\b/,
  /\bhurt\b/,
  /\bcan'?t (get out|leave|breathe|move)\b/,
  /\bemergency\b/,
  /\bnot safe\b/,
  /\bunsafe\b/,
  /\bayuda\b/,
  /\bsocorro\b/,
  /\bauxilio\b/,
  /\bay[uú]dame\b/,
  /\bay[uú]d[ae]nme\b/,
  /\bay[uú]dennos\b/,
  /\batrapad[oa]s?\b/,
  /\bherid[oa]s?\b/,
  /\bemergencia\b/,
  /\bno (estoy|estamos) a salvo\b/,
  /\bno (puedo|podemos) salir\b/,
];
const SAFE = [
  /\bsafe\b/,
  /\bi'?m (ok|okay|fine|good)\b/,
  /\bi am (ok|okay|fine|good)\b/,
  /\bwe'?re (ok|okay|fine|good|safe)\b/,
  /\bwe are (ok|okay|fine|good|safe)\b/,
  /\ball good\b/,
  /\bat (the )?shelter\b/,
  /\bmade it\b/,
  /\bestoy bien\b/,
  /\bestamos bien\b/,
  /\ba salvo\b/,
  /\ben el refugio\b/,
  /\bya llegamos\b/,
];
const EN_ROUTE = [
  /\bleaving\b/,
  /\bon (my|our) way\b/,
  /\bevacuating\b/,
  /\bheading (out|to)\b/,
  /\ben route\b/,
  /\bdriving to\b/,
  /\ben camino\b/,
  /\bevacuando\b/,
  /\b(estoy|estamos|vamos) saliendo\b/,
  /\bnos vamos\b/,
  /\bya salimos\b/,
  /\b(voy|vamos) (al|hacia el) refugio\b/,
];

/**
 * Chinese and Gujarati SOS phrases, matched as substrings.
 *
 * Gujarati "help" only counts as a plea (મદદ કરો, મને મદદ, મદદની જરૂર), so a
 * volunteer's "હું મદદ કરી શકું છું" (I can help) is not an SOS.
 */
const SCRIPT_SOS = [
  // Chinese
  "救命", "救救我", "求救", "帮帮我", "需要帮助", "需要帮忙", "需要救援", "需要救护车",
  "被困", "困住", "出不去", "受伤", "不安全", "紧急情况",
  // Gujarati
  "મદદ કરો", "મને મદદ", "અમને મદદ", "મદદની જરૂર", "મદદ જોઈએ", "મદદ જોઇએ", "બચાવો",
  "ફસાઈ", "ફસાય", "ઘાયલ", "ઇજા", "ઈજા", "ઇમરજન્સી", "ઈમરજન્સી", "કટોકટી",
  "સુરક્ષિત નથી", "સલામત નથી", "અસુરક્ષિત",
  // Hindi
  ...nfc([
    "मदद करो", "मदद कीजिए", "मदद कीजिये", "मुझे मदद", "हमें मदद", "हमको मदद", "मदद चाहिए",
    "मदद चाहिये", "मदद की ज़रूरत", "मदद की जरूरत", "सहायता चाहिए", "सहायता करो", "बचाओ",
    "बचाइए", "फंस", "फँस", "घायल", "आपातकाल", "इमरजेंसी", "एमरजेंसी", "सुरक्षित नहीं",
    "असुरक्षित",
  ]),
];

/** Chinese, Gujarati and Hindi safe phrases, matched as substrings. */
const SCRIPT_SAFE = [
  // Chinese
  // Whole phrases only: a bare 我安全 would match 给我安全的路线 (give me a safe route).
  "我很安全", "我安全了", "我现在安全", "我们很安全", "我们安全了", "我们都安全", "我们现在安全",
  "我没事", "我们没事", "我们都没事",
  "我平安", "我们平安", "已经安全", "我在避难所", "我们在避难所", "到避难所了",
  // Gujarati
  "સુરક્ષિત છું", "સુરક્ષિત છીએ", "સલામત છું", "સલામત છીએ", "ઠીક છું", "ઠીક છીએ",
  // Hindi
  ...nfc([
    "सुरक्षित हूँ", "सुरक्षित हूं", "सुरक्षित हैं", "सलामत हूँ", "सलामत हूं", "सलामत हैं",
    "ठीक हूँ", "ठीक हूं", "ठीक हैं", "सब ठीक है",
  ]),
];

/** Whole messages that are an SOS on their own, like English "help". */
const SCRIPT_SOS_EXACT = new Set(["帮助", "帮忙", "帮我", "મદદ", "બચાવ", ...nfc(["मदद", "बचाओ", "सहायता"])]);

/** Whole messages that mean safe on their own, like English "safe". */
const SCRIPT_SAFE_EXACT = new Set(["安全", "平安", "સુરક્ષિત", "સલામત", ...nfc(["सुरक्षित", "सलामत"])]);

/** Chinese, Gujarati and Hindi spoken yes on a check-in call, like SPOKEN_YES. */
const SCRIPT_SPOKEN_YES = new Set([
  "是", "是的", "对", "હા", "હા જી",
  ...nfc(["हाँ", "हां", "हाँ जी", "हां जी", "जी हाँ", "जी हां", "जी", "ठीक है"]),
]);

/** Chinese negation characters, checked just before a keyword: 不需要帮助, 没人受伤. */
const ZH_NEGATOR = /[不没無无别未非]/;

/** Gujarati negation words, checked around a keyword: મદદની જરૂર નથી. */
const GU_NEGATORS = new Set(["નથી", "નહીં", "નહિ", "ના", "ન"]);

/** Hindi negation words, checked around a keyword: मदद की ज़रूरत नहीं है. */
const HI_NEGATORS = new Set(nfc(["नहीं", "नही", "ना", "न", "बिना", "कोई नहीं"]));

/** Negation words for every script language that is matched by phrase. */
const SCRIPT_NEGATORS = new Set([...GU_NEGATORS, ...HI_NEGATORS]);

/** Chinese words that make a clause a question: 吗, 哪里, 有没有. */
const ZH_QUESTION = /(吗|是否|有没有|哪里|哪儿|什么|能不能|呢$)/;

/** Gujarati question words: શું (yes/no), ક્યાં (where), ક્યારે (when), કોણ (who), કેમ (why). */
const GU_QUESTION_WORDS = new Set(["શું", "ક્યાં", "ક્યારે", "કોણ", "કેમ"]);

/** Hindi question words: क्या (yes/no), कहाँ (where), कब (when), कौन (who), क्यों (why), कैसे (how). */
const HI_QUESTION_WORDS = new Set(nfc(["क्या", "कहाँ", "कहां", "कब", "कौन", "क्यों", "कैसे", "कितना", "कितनी"]));

/** Words that negate a keyword right after them: "not injured", "no emergency". */
const NEGATORS = new Set([
  "no", "not", "nobody", "none", "never", "without", "nothing", "noone", "nadie", "sin", "ni",
  "nunca", "tampoco", "ningún", "ningun", "ninguno", "ninguna",
  // Contractions typed without the apostrophe.
  "dont", "doesnt", "didnt", "isnt", "arent", "wasnt", "werent", "wont", "havent", "hasnt",
]);

/** First words that make a clause a question. */
const QUESTION_WORDS = new Set([
  "can", "could", "would", "will", "is", "are", "am", "do", "does", "did", "where", "what", "when",
  "how", "which", "who", "why", "should", "may", "any", "anyone", "anybody",
  // Spanish question words, only in their accented (asking) form.
  "dónde", "cuándo", "qué", "cómo", "cuál", "quién",
]);

/** Words that can open an answer: "no I need help", "nope we're trapped". */
const INTERJECTIONS = new Set(["no", "nope", "nah"]);

/** Subjects that start a new clause after an interjection "no". */
const SUBJECTS = new Set(["i", "i'm", "im", "we", "we're", "were", "my", "our", "yo", "nosotros"]);

/** How many words before a keyword are checked for a negator. */
const NEGATION_WINDOW = 3;

/**
 * Lowercase, straighten quotes, and drop punctuation that does not matter.
 *
 * Args:
 *     text (string): Raw text.
 *
 * Returns:
 *     string: Normalized text with single spaces.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize text for the Chinese, Gujarati and Hindi phrase lists.
 *
 * Like normalize(), but keeps combining marks, which Gujarati vowel signs
 * are (normalize() would turn "છું" into "છ"), and composes the text first
 * so the same word always has the same code points.
 *
 * Args:
 *     text (string): Raw text.
 *
 * Returns:
 *     string: Normalized text with single spaces.
 */
function scriptText(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One clause of a message: the normalized words and whether it asks something.
 *
 * Attributes:
 *     text (string): Normalized clause text.
 *     script (string): The clause normalized for the Chinese and Gujarati
 *         phrase lists (see scriptText).
 *     question (boolean): True if it ends in "?", starts with a question
 *         word, or has a Chinese or Gujarati question word.
 */
interface Clause {
  text: string;
  script: string;
  question: boolean;
}

/**
 * Split a message into clauses at , . ; ! ? and new lines, plus the Chinese
 * full-width marks and the danda.
 *
 * Args:
 *     raw (string): Raw message text.
 *
 * Returns:
 *     Clause[]: Non-empty clauses in order.
 */
function clauses(raw: string): Clause[] {
  return raw
    .split(/(?<=[,.;!?\n，。；！？、।])/)
    .map((piece) => {
      const text = normalize(piece);
      const script = scriptText(piece);
      const first = text.split(" ")[0] ?? "";
      const words = script.split(" ");
      const question =
        /[?？]\s*$/.test(piece) ||
        QUESTION_WORDS.has(first) ||
        ZH_QUESTION.test(script) ||
        words.some((w) => GU_QUESTION_WORDS.has(w) || HI_QUESTION_WORDS.has(w));
      return { text, script, question };
    })
    .filter((c) => c.text.length > 0 || c.script.length > 0);
}

/**
 * Check whether a word negates what follows it.
 *
 * Args:
 *     word (string): A normalized word.
 *
 * Returns:
 *     boolean: True for "no", "not", "nobody", and words like "isn't".
 */
function isNegator(word: string): boolean {
  return NEGATORS.has(word) || word.endsWith("n't");
}

/**
 * Where the words after a leading "no" interjection start.
 *
 * Speech-to-text drops commas, so "No, I need help" arrives as "no I need
 * help". A "no" followed by a subject ("no I", "no we're") answers the
 * question and starts a new clause. It does not negate what comes after.
 *
 * Args:
 *     words (string[]): Normalized words before a keyword.
 *
 * Returns:
 *     number: The index just after the last interjection "no", or 0.
 */
function afterInterjection(words: string[]): number {
  for (let i = words.length - 2; i >= 0; i--) {
    if (INTERJECTIONS.has(words[i]) && SUBJECTS.has(words[i + 1])) return i + 1;
  }
  return 0;
}

/**
 * Find a keyword in a clause that is not negated.
 *
 * A match counts unless one of the few words right before it is a negator,
 * so "nobody is hurt" and "No necesito ayuda" do not count.
 *
 * Args:
 *     clause (string): Normalized clause text.
 *     patterns (RegExp[]): Keyword patterns.
 *
 * Returns:
 *     boolean: True if any pattern matches without a negator before it.
 */
function hasUnnegated(clause: string, patterns: RegExp[]): boolean {
  for (const pattern of patterns) {
    for (const m of clause.matchAll(new RegExp(pattern.source, "g"))) {
      const words = clause.slice(0, m.index).trim().split(" ").filter(Boolean);
      const before = words.slice(afterInterjection(words)).slice(-NEGATION_WINDOW);
      if (!before.some(isNegator)) return true;
    }
  }
  return false;
}

/**
 * Check whether a Chinese or Gujarati keyword is negated.
 *
 * Chinese puts the negation just before the keyword (不需要帮助, 没有人受伤),
 * so the few characters before it are checked. Gujarati usually puts it after
 * (મદદની જરૂર નથી), sometimes before (ના, ...), so the few words on both
 * sides are checked.
 *
 * Args:
 *     clause (string): Clause text from scriptText().
 *     start (number): Where the keyword starts.
 *     end (number): Where the keyword ends.
 *
 * Returns:
 *     boolean: True if a negation is near the keyword.
 */
function isScriptNegated(clause: string, start: number, end: number): boolean {
  if (ZH_NEGATOR.test(clause.slice(Math.max(0, start - NEGATION_WINDOW), start))) return true;
  const before = clause.slice(0, start).trim().split(" ").filter(Boolean).slice(-NEGATION_WINDOW);
  const after = clause.slice(end).trim().split(" ").filter(Boolean).slice(0, NEGATION_WINDOW);
  return [...before, ...after].some((w) => SCRIPT_NEGATORS.has(w));
}

/**
 * Find a Chinese or Gujarati phrase in a clause that is not negated.
 *
 * Args:
 *     clause (string): Clause text from scriptText().
 *     phrases (string[]): Phrases to look for, matched as substrings.
 *
 * Returns:
 *     boolean: True if any phrase is there without a negation near it.
 */
function hasUnnegatedPhrase(clause: string, phrases: string[]): boolean {
  for (const phrase of phrases) {
    for (let i = clause.indexOf(phrase); i !== -1; i = clause.indexOf(phrase, i + 1)) {
      if (!isScriptNegated(clause, i, i + phrase.length)) return true;
    }
  }
  return false;
}

/**
 * Find the wake phrase near the start of a radio message.
 *
 * Accepts "Relay, ..." and "Unit 4 to Relay, ...", and multi-word phrases
 * like "hey relay". The phrase must start within the first five words, so
 * "tell Relay later" deep in a sentence does not trigger it.
 *
 * Args:
 *     text (string): Raw radio text.
 *     wakePhrase (string): The wake phrase from the scenario, e.g. "relay".
 *
 * Returns:
 *     string | null: The text after the wake phrase, or null if it is not
 *         addressed to Relay.
 */
export function stripWakePhrase(text: string, wakePhrase: string): string | null {
  const words = text.trim().split(/\s+/);
  const plain = words.map(normalize);
  const wake = normalize(wakePhrase).split(" ").filter(Boolean);
  if (wake.length === 0) return null;

  for (let i = 0; i < 5 && i + wake.length <= words.length; i++) {
    if (wake.every((w, j) => plain[i + j] === w)) {
      return words.slice(i + wake.length).join(" ").replace(/^[,.:;!?\s-]+/, "");
    }
  }
  return null;
}

/**
 * Classify a message with the fast rules.
 *
 * Order: STOP, then SOS, then safe, then leaving. In a question, only the
 * word "SOS" counts. A bare "yes" or "ok" means safe only on a voice call,
 * where Relay just asked "Are you safe?". On text it could mean anything.
 * Each step checks the English and Spanish patterns first, then the Chinese
 * and Gujarati phrases.
 *
 * Args:
 *     text (string): Raw message text.
 *     channel (Channel): Where it came from. Radio is handled differently.
 *     wakePhrase (string): The scenario's wake phrase.
 *
 * Returns:
 *     Classification: The intent and the text to pass on.
 */
export function classify(text: string, channel: Channel, wakePhrase: string): Classification {
  if (channel === "radio") {
    const question = stripWakePhrase(text, wakePhrase);
    return question === null ? { intent: "radio_chatter", text } : { intent: "agent", text: question };
  }

  const whole = normalize(text);
  if (STOP_WORDS.has(whole)) return { intent: "stop", text };

  const parts = clauses(text);
  const statements = parts.filter((c) => !c.question);
  const wholeScript = scriptText(text);
  if (parts.some((c) => hasUnnegated(c.text, [/\bsos\b/]))) return { intent: "sos", text };
  if (statements.some((c) => hasUnnegated(c.text, SOS))) return { intent: "sos", text };
  if (SCRIPT_SOS_EXACT.has(wholeScript)) return { intent: "sos", text };
  if (statements.some((c) => hasUnnegatedPhrase(c.script, SCRIPT_SOS))) return { intent: "sos", text };
  if (channel === "voice" && (SPOKEN_YES.has(whole) || SCRIPT_SPOKEN_YES.has(wholeScript))) return { intent: "safe", text };
  if (statements.some((c) => hasUnnegated(c.text, SAFE))) return { intent: "safe", text };
  if (SCRIPT_SAFE_EXACT.has(wholeScript)) return { intent: "safe", text };
  if (statements.some((c) => hasUnnegatedPhrase(c.script, SCRIPT_SAFE))) return { intent: "safe", text };
  if (statements.some((c) => hasUnnegated(c.text, EN_ROUTE))) return { intent: "en_route", text };
  return { intent: "agent", text };
}
