/**
 * Minimal RFC 5545 (.ics) calendar builder — pure, dependency-free TypeScript.
 *
 * Correctness notes:
 *  - Every physical line (including the final one) ends with CRLF.
 *  - Content lines longer than 75 octets are folded; continuation lines start
 *    with a single space (that space is not part of the content). Folding is
 *    byte-aware so multi-byte UTF-8 characters are never split.
 *  - TEXT values escape backslash first, then semicolon, comma and newline.
 *  - All-day events use DTSTART;VALUE=DATE plus an EXCLUSIVE DTEND (+1 day).
 */

export interface VEventData {
  uid: string;
  summary: string;
  /** Inclusive all-day start, ISO calendar date "YYYY-MM-DD". */
  startDate: string;
  description?: string;
}

export interface VCalendarOptions {
  /** Injection point for tests; defaults to `new Date()`. */
  now?: Date;
}

/** SUMMARY is kept short (75 chars) — safe across Apple/Google Calendar. */
export const SUMMARY_MAX_CHARS = 75;

/** Escape a TEXT property value per RFC 5545 §3.3.11. Backslash must be escaped first. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** Split a string into chunks no larger than the given octet budgets (UTF-8 safe). */
function splitByOctets(line: string, firstMax: number, restMax: number): string[] {
  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of line) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    const limit = parts.length === 0 ? firstMax : restMax;
    if (currentBytes > 0 && currentBytes + chBytes > limit) {
      parts.push(current);
      current = ch;
      currentBytes = chBytes;
    } else {
      current += ch;
      currentBytes += chBytes;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * Fold one content line to the 75-octet limit. The first line may hold 75
 * octets; every continuation line holds 74 because the leading space occupies
 * the 75th octet on the wire.
 */
export function foldContentLine(line: string): string {
  const parts = splitByOctets(line, 75, 74);
  if (parts.length === 1) return parts[0];
  return parts.join("\r\n ");
}

/** Compact UTC stamp "YYYYMMDDTHHMMSSZ" for DTSTAMP. */
export function toIcsUtcStamp(date: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  );
}

/** "YYYY-MM-DD" -> "YYYYMMDD" */
export function isoToCompact(iso: string): string {
  return iso.replace(/-/g, "");
}

/** All-day UTC date arithmetic on ISO calendar dates. */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Truncate by UTF-16 code units (chars) to the cap. */
export function truncateChars(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * Build a complete VCALENDAR document. Output always ends with CRLF.
 */
export function buildVCalendar(
  events: VEventData[],
  calName: string,
  options: VCalendarOptions = {},
): string {
  const now = options.now ?? new Date();
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Farm Friend Roundtable//Schedule Export 1.0//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(calName)}`,
  ];

  for (const event of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${event.uid}`);
    lines.push(`DTSTAMP:${toIcsUtcStamp(now)}`);
    lines.push(`DTSTART;VALUE=DATE:${isoToCompact(event.startDate)}`);
    // DTEND for all-day events is exclusive -> start + 1 day.
    lines.push(`DTEND;VALUE=DATE:${isoToCompact(addDaysIso(event.startDate, 1))}`);
    lines.push(`SUMMARY:${escapeIcsText(truncateChars(event.summary, SUMMARY_MAX_CHARS))}`);
    if (event.description) {
      lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldContentLine).join("\r\n") + "\r\n";
}
