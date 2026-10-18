/**
 * Looks up a person's language from Core, so a call can be placed in it.
 *
 * Core holds each person's language (detected from their messages or set in
 * the scenario) and publishes it in GET /state. Voice only reads it.
 */

/** Options for {@link fetchPersonLanguage}. */
export interface PersonLanguageOptions {
  /** Base URL of Core, for example http://localhost:3000. */
  coreUrl: string;
  /** Request timeout in milliseconds. Defaults to 2000. */
  timeoutMs?: number;
  /** Fetch implementation, injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Find a person's language code in Core's state.
 *
 * Args:
 *   personId: The Contract E person id.
 *   opts: Core's URL and test hooks.
 *
 * Returns:
 *   The language code such as "hi", or null if the person is not found or
 *   Core cannot be reached. It never throws, because a call must still go
 *   out in the default language if this lookup fails.
 */
export async function fetchPersonLanguage(
  personId: string,
  opts: PersonLanguageOptions,
): Promise<string | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${opts.coreUrl}/state`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { people?: { person_id?: string; language?: unknown }[] };
    const person = body.people?.find((p) => p.person_id === personId);
    return typeof person?.language === "string" && person.language ? person.language : null;
  } catch {
    return null;
  }
}
