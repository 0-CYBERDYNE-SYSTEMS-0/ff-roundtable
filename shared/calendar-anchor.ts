import { parseIsoDate } from "./calendar-date";

/** First dated schedule row, preserving the date's parsed year exactly. */
export function firstDatedScheduleAnchor(rows: Array<{ date?: string }>): string | undefined {
  return rows
    .map((row) => row.date)
    .filter((date): date is string => !!date && !!parseIsoDate(date))
    .sort()[0];
}

/** Accept a saved Week 1 choice only for the exact plan it was edited on. */
export function readCalendarStartOverride(value: string | null, planKey: string): string | null {
  if (!value || !planKey) return null;
  try {
    const saved = JSON.parse(value) as { startDate?: unknown; planKey?: unknown };
    return typeof saved.startDate === "string" && parseIsoDate(saved.startDate) && saved.planKey === planKey
      ? saved.startDate
      : null;
  } catch {
    return null;
  }
}
