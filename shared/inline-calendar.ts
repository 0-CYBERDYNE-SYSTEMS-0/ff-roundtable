export type InlineEvent = { summary: string; startDate: string; description?: string };

/** Parses the inline calendar artifact; null when it is not a usable event list. */
export function parseInlineCalendar(content: string): { anchor?: string; events: InlineEvent[] } | null {
  try {
    const parsed = JSON.parse(content);
    const events = Array.isArray(parsed?.events)
      ? parsed.events.filter((e: any) => typeof e?.summary === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e?.startDate ?? ""))
      : [];
    return events.length ? { anchor: parsed.anchor, events } : null;
  } catch {
    return null;
  }
}
