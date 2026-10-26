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

const MAX_RECORD_EVENTS = 40;

/** The newest calendar artifact in the conversation as a dated list the closing synthesis must agree with; "" when there is none. */
export function calendarOfRecord(messages: Array<{ artifacts?: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const artifacts = Array.isArray(messages[i].artifacts) ? messages[i].artifacts as Array<{ type?: string; content?: string }> : [];
    for (const a of artifacts) {
      if (a?.type !== "calendar" || typeof a.content !== "string") continue;
      const parsed = parseInlineCalendar(a.content);
      if (!parsed) continue;
      const events = [...parsed.events].sort((x, y) => x.startDate.localeCompare(y.startDate)).slice(0, MAX_RECORD_EVENTS);
      return events.map(e => `- ${e.startDate}: ${e.summary}`).join("\n");
    }
  }
  return "";
}
