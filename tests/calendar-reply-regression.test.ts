import { describe, expect, it } from "vitest";
import { parseInlineCalendar } from "../shared/inline-calendar";
import { buildInlineCalendarArtifact, extractScheduleRows, findConversationAnchor, resolveScheduleAnchor } from "../shared/schedule-extract";

const TODAY = "2026-10-26";
const eventRows = Array.from({ length: 17 }, (_, index) => {
  const startDate = new Date(Date.UTC(2026, 3, 15 + index * 7)).toISOString().slice(0, 10);
  return { startDate, task: ["Start tomatoes indoors", "Harden seedlings", "Prepare planting beds", "Transplant tomatoes"][index % 4] };
});

const table = [
  "| Date | Task | Notes |",
  "|---|---|---|",
  ...eventRows.map(({ startDate, task }) => `| ${startDate} | ${task} | Eugene, Oregon |`),
].join("\n");

const ics = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  ...eventRows.flatMap(({ startDate, task }, index) => [
    "BEGIN:VEVENT",
    `UID:tomato-${index}@farmfriend.example`,
    `DTSTART:${startDate}`,
    `SUMMARY:${task}`,
    "DESCRIPTION:Target planting date: 2027-04-15; imported copy of the table event",
    "END:VEVENT",
  ]),
  "END:VCALENDAR",
].join("\n");

const reply = [
  "# Eugene OR Tomato Planting Calendar 2026 (ICS) - 2027-04-15",
  "Target planting date: 2026-04-15",
  "",
  table,
  "",
  "```ics",
  ics,
  "```",
].join("\n");

describe("calendar reply extraction regressions", () => {
  it("counts table events once and ignores dated headings and fenced ICS text", () => {
    const tableArtifact = { type: "table", title: "Eugene Tomato Planting Calendar", content: table } as any;
    const file = { filename: "eugene-tomato-calendar.md", fileUrl: "/calendar.md", uploadedBy: "Expert: Agronomist" } as any;
    const messages = [{ content: reply, artifacts: [tableArtifact] }] as any;

    const rows = extractScheduleRows(messages, [file], () => reply, TODAY);
    const unfencedReply = reply.replace(`\n\`\`\`ics\n${ics}\n\`\`\``, `\n${ics}`);
    const unfencedRows = extractScheduleRows([], [file], () => unfencedReply, TODAY);
    const inline = buildInlineCalendarArtifact({
      artifacts: [tableArtifact],
      deliverableMarkdown: reply,
      deliverableTitle: "Eugene OR Tomato Planting Calendar 2026 (ICS)",
      contextText: reply,
      todayIso: TODAY,
    });
    const events = parseInlineCalendar(inline!.content)!.events;

    expect(rows).toHaveLength(17);
    expect(unfencedRows).toHaveLength(17);
    expect(events).toHaveLength(17);
    expect(events[0].startDate).toBe("2026-04-15");
    expect(events[16].startDate).toBe("2026-08-05");
    expect(events.every((event) => !/BEGIN:VEVENT|END:VEVENT|UID:|Eugene OR Tomato Planting Calendar.*ICS/i.test(`${event.summary} ${event.description}`))).toBe(true);
  });

  it("keeps an explicit 2026 anchor in the inline calendar and Calendar plan", () => {
    const tableArtifact = { type: "table", title: "Eugene Tomato Planting Calendar", content: table } as any;
    const tableOnlyReply = reply.replace("Target planting date: 2026-04-15\n", "");
    const messages = [{ content: tableOnlyReply, artifacts: [tableArtifact] }] as any;
    const anchor = findConversationAnchor(messages, TODAY);
    const inline = buildInlineCalendarArtifact({ artifacts: [tableArtifact], contextText: tableOnlyReply, todayIso: TODAY });

    expect(anchor).toBe("2026-04-15");
    expect(resolveScheduleAnchor(anchor, TODAY)).toBe("2026-04-15");
    expect(JSON.parse(inline!.content).anchor).toBe("2026-04-15");
  });
});
