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

describe("event count across expert tables", () => {
  const tableOf = (rows: Array<[string, string]>) => ({ type: "table", title: "Plan", content: ["| Date | Task | Notes |", "|---|---|---|", ...rows.map(([d, t]) => `| ${d} | ${t} | n |`)].join("\n") });

  it("drops only the repeated event across two expert tables (7 + 9 rows, one shared)", () => {
    const a: Array<[string, string]> = [1, 2, 3, 4, 5, 6, 7].map(i => [`2026-03-${String(i * 3).padStart(2, "0")}`, `Task A${i}`]);
    const b: Array<[string, string]> = [1, 2, 3, 4, 5, 6, 7].map(i => [`2026-04-${String(i * 3).padStart(2, "0")}`, `Task B${i}`]);
    b.push(a[0]); // the shared event
    b.push(["2026-03-03", "Different task, same day"]);
    const messages = [{ content: "A", artifacts: [tableOf(a)] }, { content: "B", artifacts: [tableOf(b)] }] as any;
    const rows = extractScheduleRows(messages, [], () => null, TODAY);
    expect(rows).toHaveLength(7 + 9 - 1);
    expect(rows.filter(r => r.date === "2026-03-03")).toHaveLength(2);
  });
});
