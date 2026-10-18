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

/**
 * A stable lookup key for any sender, even one normalizeHandle rejects.
 *
 * Carrier short codes like "12345" are not phone numbers, but the same sender
 * must still match itself, or it signs up again on every message.
 *
 * Args:
 *     raw (string): The handle as a channel sent it.
 *
 * Returns:
 *     string | null: normalizeHandle's result, else the trimmed lowercase
 *         text, or null if the handle is blank.
 */
export function handleKey(raw: string): string | null {
  const normalized = normalizeHandle(raw);
  if (normalized) return normalized;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}
