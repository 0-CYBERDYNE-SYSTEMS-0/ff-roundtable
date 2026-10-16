/**
 * Local date/time with zone label, e.g. "Oct 16, 2026, 1:02 PM PDT".
 * Note: Intl rejects dateStyle/timeStyle combined with timeZoneName, so the
 * fields are spelled out.
 */
export function formatLocalDateTime(value: string | number | Date, timeZone?: string): string {
  return new Date(value).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  });
}
