import { describe, expect, it } from "vitest";
import { buildVCalendar } from "../shared/ics";
import { calendarEventsSchema } from "../shared/calendar-draft";
import { inspectCalendar } from "../server/calendar-files";
import { extractScheduleRows } from "../shared/schedule-extract";

const events = [{ uid: "soil@farm", summary: "Soil test", startDate: "2026-04-01", description: "Scout, sample; record\nKeep notes." }];
describe("calendar inspection and editing contract", () => {
  it("never turns dated visualization measurements into calendar tasks", () => {
    const messages = [{ artifacts: [{ type: "chart", title: "Observed water use", content: JSON.stringify({ type: "vega-lite", data: [{ date: "2026-04-01", water: 12 }] }) }] }];
    expect(extractScheduleRows(messages as any, [])).toEqual([]);
  });
  it("preserves Markdown plan section spacing and source URLs in event notes", () => {
    const file = { filename: "review.md", fileUrl: "/uploads/review.md", uploadedBy: "Expert: File Creator" };
    const markdown = "## Week 1 — Review references\n\nOBJECTIVE\nSummarize the evidence.\n\nSTEPS\n1. Read [source](https://example.org/research).\n2. Record uncertainty.\n\nCOMPLETION CHECK\nA source-backed brief.\n";
    const rows = extractScheduleRows([], [file] as any, () => markdown);
    expect(rows[0].description).toContain("OBJECTIVE\nSummarize the evidence.\n\nSTEPS");
    expect(rows[0].description).toContain("1. Read source (https://example.org/research).");
    expect(rows[0].description).toContain("\n\nCOMPLETION CHECK\nA source-backed brief.");
  });
  it("round-trips every editable field including escaped and folded text", () => {
    const inspected = inspectCalendar(buildVCalendar(events, "Farm"));
    expect(inspected).toEqual({ events });
  });
  it("preserves long task briefs, numbered steps, links and AI prompts without truncation", () => {
    const description = [
      "OBJECTIVE", "Review the supplied literature; record uncertainty.", "", "STEPS",
      "1. Open the supplied source.", "2. Record the evidence and limitations — including Unicode: 🌱.",
      "", "SOURCES", "Sulfur reference — verify scope", "https://npic.orst.edu/factsheets/sulfurgen.html",
      "", "COMPLETION CHECK", "A source-backed summary with open questions.", "", "AI HANDOFF",
      "Task: Prepare a research summary.", "Context: Desk research only.", "Inputs needed: The source URL above.",
      "Expected output: Findings, citations and evidence gaps.", "Completion checks: Flag unsupported claims.",
      "Limits / human approval: Draft only; do not contact others or change external records.",
      "Additional context: " + "Preserve this detail, including punctuation; and line breaks. ".repeat(30),
    ].join("\n");
    const reviewed = [{ ...events[0], description }];
    expect(calendarEventsSchema.safeParse(reviewed).success).toBe(true);
    const ics = buildVCalendar(reviewed, "Research");
    expect(ics).toContain("\r\n ");
    expect(inspectCalendar(ics).events).toEqual(reviewed);
  });
  it("shows timed and recurring events without allowing lossy edits", () => {
    const ics = buildVCalendar(events, "Farm").replace("DTSTART;VALUE=DATE:20260401", "DTSTART:20260401T090000Z").replace("DTEND;VALUE=DATE:20260402", "DTEND:20260401T100000Z\r\nRRULE:FREQ=WEEKLY;COUNT=3");
    const result = inspectCalendar(ics);
    expect(result.readOnlyReason).toBeTruthy();
    expect(result.events).toHaveLength(1);
    expect(result.events[0].description).toContain("09:00:00Z");
    expect(result.events[0].description).toContain("FREQ=WEEKLY");
  });
  it("preserves alarms and multi-day semantics by making them read-only", () => {
    const multi = buildVCalendar(events, "Farm").replace("DTEND;VALUE=DATE:20260402", "DTEND;VALUE=DATE:20260405");
    expect(inspectCalendar(multi).readOnlyReason).toBeTruthy();
    const alarm = buildVCalendar(events, "Farm").replace("END:VEVENT", "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT");
    expect(inspectCalendar(alarm).readOnlyReason).toBeTruthy();
  });
  it("rejects impossible dates, duplicate IDs and ICS line injection", () => {
    expect(calendarEventsSchema.safeParse([{ ...events[0], startDate: "2026-02-30" }]).success).toBe(false);
    expect(calendarEventsSchema.safeParse([...events, ...events]).success).toBe(false);
    expect(calendarEventsSchema.safeParse([{ ...events[0], uid: "x\r\nBEGIN:VEVENT" }]).success).toBe(false);
  });
});
