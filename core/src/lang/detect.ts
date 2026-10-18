/**
 * Conservative language detection for incoming messages.
 *
 * Used to switch a person's reply language when they text in another
 * language, so a new Spanish texter gets a Spanish welcome. It only answers
 * when a message clearly is Gujarati, Hindi, Chinese, or Spanish. Short or mixed
 * messages ("ok", "SOS", "5", "I'm at Peña St") return null and the person
 * keeps their language. It never detects English, so nobody is switched back
 * to English by a short reply.
 *
 * Rules:
 *     - Gujarati: at least two Gujarati script characters (the U+0A80 to
 *       U+0AFF block), and no fewer than the Latin letters.
 *     - Hindi: at least two Devanagari characters (the U+0900 to U+097F
 *       block), and no fewer than the Latin letters. Marathi and Nepali share
 *       the script and would also match, which is fine: the Hindi replies are
 *       the closest Relay has.
 *     - Chinese: at least two Han characters, no Japanese kana, and no fewer
 *       than the Latin letters.
 *     - Spanish: Spanish words (plus ¿ ¡ ñ and "por favor") must outnumber
 *       English words, with at least two Spanish signals, or the whole
 *       message is one clearly Spanish word such as "hola" or "ayuda".
 *
 * Keywords people type in Latin letters in any language (SOS, SAFE, STOP, OK,
 * Relay) are ignored when weighing scripts, so "SOS 救命" is Chinese.
 */
import type { Lang } from "./languages.js";

/** Latin words that say nothing about the language: the keywords and the name. */
const NEUTRAL_WORDS = new Set(["sos", "safe", "stop", "ok", "okay", "relay"]);

/** Words that only Spanish uses, so each one is a sign of Spanish. */
const SPANISH_WORDS = new Set([
  "hola", "gracias", "ayuda", "ayudame", "ayúdame", "ayudenme", "ayúdenme", "ayudennos", "ayúdennos",
  "auxilio", "socorro", "estoy", "estamos", "está", "están", "estan", "necesito", "necesitamos",
  "necesita", "por", "dónde", "donde", "qué", "cómo", "cuándo", "tengo", "tenemos", "puedo",
  "podemos", "salir", "refugio", "incendio", "fuego", "humo", "atrapado", "atrapada", "atrapados",
  "atrapadas", "herido", "herida", "heridos", "heridas", "bien", "también", "ahora", "aquí", "aqui",
  "calle", "nosotros", "usted", "ustedes", "soy", "somos", "vamos", "voy", "hacia", "camino",
  "evacuando", "saliendo", "seguro", "segura", "seguros", "seguras", "salvo", "mamá", "papá", "hijo",
  "hija", "hijos", "abuela", "abuelo", "mascota", "perro", "gato", "cerca", "lejos", "ruta", "para",
  "sí", "familia", "dirección", "zona",
]);

/** One-word messages that are clearly Spanish on their own. */
const SPANISH_SINGLE = new Set([
  "hola", "gracias", "ayuda", "ayudame", "ayúdame", "ayudenme", "ayúdenme", "ayudennos", "ayúdennos",
  "auxilio", "socorro",
]);

/** Common English words. If these match or beat the Spanish ones, it is not Spanish. */
const ENGLISH_WORDS = new Set([
  "the", "i", "i'm", "im", "i'll", "you", "your", "is", "are", "am", "my", "we", "we're", "our",
  "and", "to", "of", "in", "at", "it", "it's", "please", "help", "need", "where", "what", "how",
  "can", "not", "have", "has", "this", "that", "here", "there", "with", "for", "on", "out", "get",
  "now", "me", "just", "be", "do", "don't", "will", "street", "st", "thanks",
]);

/** Latin letters, including the accented ones Spanish uses. */
const LATIN_LETTER = /[a-zà-öø-ɏ]/g;

/**
 * Lowercase Latin-script words in the message, with curly apostrophes
 * straightened. Han, Gujarati and Devanagari characters are left out, so "SOS救命" gives
 * just "sos".
 *
 * Args:
 *     text (string): Raw text.
 *
 * Returns:
 *     string[]: The Latin words, letters and apostrophes only.
 */
function latinWords(text: string): string[] {
  return text.normalize("NFC").toLowerCase().replace(/[‘’]/g, "'").match(/[a-zà-öø-ɏ']+/g) ?? [];
}

/**
 * Count the matches of a pattern.
 *
 * Args:
 *     text (string): Text to search.
 *     pattern (RegExp): A global pattern.
 *
 * Returns:
 *     number: How many times it matches.
 */
function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/**
 * Guess the language of a message, only when it is clear.
 *
 * Args:
 *     text (string): The raw message text.
 *
 * Returns:
 *     Lang | null: "gu", "hi", "zh", or "es" when the message clearly is in that
 *         language, otherwise null (keep whatever language the person has).
 */
export function detectLanguage(text: string): Lang | null {
  const tokens = latinWords(text).filter((w) => !NEUTRAL_WORDS.has(w));
  const latin = count(tokens.join(""), LATIN_LETTER);

  const gujarati = count(text, /\p{Script=Gujarati}/gu);
  const devanagari = count(text, /\p{Script=Devanagari}/gu);
  const han = count(text, /\p{Script=Han}/gu);
  const kana = count(text, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu);

  if (gujarati >= 2 && gujarati >= han && gujarati >= latin) return "gu";
  if (devanagari >= 2 && devanagari >= han && devanagari >= latin) return "hi";
  if (han >= 2 && kana === 0 && han >= latin) return "zh";

  const english = tokens.filter((w) => ENGLISH_WORDS.has(w)).length;
  const signs = (/[¿¡ñ]/i.test(text) ? 1 : 0) + (/\bpor favor\b/i.test(text) ? 1 : 0);
  const spanish = tokens.filter((w) => SPANISH_WORDS.has(w)).length + signs;
  if (spanish === 0 || english >= spanish) return null;
  if (spanish >= 2) return "es";
  if (tokens.length === 1 && SPANISH_SINGLE.has(tokens[0])) return "es";
  return null;
}
