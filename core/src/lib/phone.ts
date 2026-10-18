/**
 * Normalizing contact handles so the same person always matches.
 *
 * A handle is what a channel puts in `from`: usually a phone number, but
 * iMessage can also use an email address.
 */

/**
 * Turn a phone number or iMessage email into one comparable form.
 *
 * Args:
 *     raw (string): The handle as a channel sent it, e.g. "(617) 555-0101",
 *         "+16175550101", or "Amit@Example.com".
 *
 * Returns:
 *     string | null: E.164 for phone numbers (10-digit US numbers get +1),
 *         lowercase for emails, or null if there is nothing usable.
 */
export function normalizeHandle(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7) return null;
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}
