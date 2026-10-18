/**
 * The languages Relay has fixed reply texts for.
 *
 * A person's `language` is a free string from the scenario or from language
 * detection. Everything that picks a translation goes through `resolveLang`,
 * so an unknown or oddly written code ("es-MX", "ZH", "fr") always lands on a
 * supported language, falling back to English.
 */

/** Every language with committed translations. English is the fallback. */
export const LANGUAGES = ["en", "es", "zh", "gu", "hi"] as const;

/** A supported language code. */
export type Lang = (typeof LANGUAGES)[number];

/** The fallback language for unknown codes and unknown senders. */
export const DEFAULT_LANG: Lang = "en";

/** Names the LLM is given, so it knows exactly which language to answer in. */
export const LANGUAGE_NAMES: Record<Lang, string> = {
  en: "English",
  es: "Spanish",
  zh: "Mandarin Chinese (Simplified)",
  gu: "Gujarati",
  hi: "Hindi",
};

/**
 * Turn any language code into a supported one.
 *
 * Only the part before "-" or "_" counts, so "es-MX" is Spanish and
 * "zh-Hans" is Chinese.
 *
 * Args:
 *     code (string | null | undefined): A language code, e.g. "es" or "zh-CN".
 *
 * Returns:
 *     Lang: The supported language, or "en" if the code is unknown or empty.
 */
export function resolveLang(code: string | null | undefined): Lang {
  const base = (code ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return (LANGUAGES as readonly string[]).includes(base) ? (base as Lang) : DEFAULT_LANG;
}

/**
 * The display name of a language code, for the agent prompt.
 *
 * Args:
 *     code (string): A language code, e.g. "gu".
 *
 * Returns:
 *     string | null: The name, e.g. "Gujarati", or null if Relay does not
 *         know the code.
 */
export function languageName(code: string): string | null {
  const base = code.trim().toLowerCase().split(/[-_]/)[0];
  return (LANGUAGES as readonly string[]).includes(base) ? LANGUAGE_NAMES[base as Lang] : null;
}
