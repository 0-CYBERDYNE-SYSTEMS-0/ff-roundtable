/**
 * .ics export unit tests — RFC 5545 builder + schedule extraction + anchoring.
 * Node env only; no server imports (route tests live in the second half).
 */

import { describe, it, expect } from "vitest";
import {
  buildVCalendar,
  escapeIcsText,
  foldContentLine,
  addDaysIso,
  toIcsUtcStamp,
  SUMMARY_MAX_CHARS,
} from "../shared/ics";
import {
  extractScheduleRows,
  nextMondayFrom,
  parseIsoDate,
  parseWeekCell,
  resolveRowStartDate,
  buildRowSummary,
  MAX_SCHEDULE_ROWS,
} from "../shared/schedule-extract";
import type { Artifact, File, Message } from "../shared/schema";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeMessage(artifacts: Artifact[]): Message {
  return {
    id: 1,
    conversationId: 1,
    expertId: null,
    userId: null,
    content: "",
    role: "expert",
    expertName: null,
    expertRole: null,
    timestamp: new Date(),
    artifacts,
  } as unknown as Message;
}

function makeFile(overrides: Partial<File> = {}): File {
  return {
    id: 1,
    conversationId: 1,
    filename: "nitrogen-plan.md",
    fileUrl: "/uploads/abc123-nitrogen-plan.md",
    fileType: "text/markdown",
    uploadedBy: "Expert: File Creator",
    uploadedAt: new Date(),
    ...overrides,
  } as File;

}

/** RFC 5545 unfolding: remove CRLF + single leading space. */
function unfold(folded: string): string {
  return folded.split("\r\n ").join("");
}

function physicalLines(ics: string): string[] {
  return ics.split("\r\n").filter((l) => l.length > 0);
}

// ═════════════════════════════════════════════════════════════════════════════
// shared/ics.ts — escaping
// ═════════════════════════════════════════════════════════════════════════════

describe("escapeIcsText", () => {
  it("escapes backslash first so it is not double-escaped", () => {
    expect(escapeIcsText("a\\b")).toBe("a\\\\b");
  });

  it("escapes semicolons and commas", () => {
    expect(escapeIcsText("a;b,c")).toBe("a\\;b\\,c");
  });

  it("escapes LF and CRLF newlines as literal \\n", () => {
    expect(escapeIcsText("a\nb")).toBe("a\\nb");
    expect(escapeIcsText("a\r\nb")).toBe("a\\nb");
    expect(escapeIcsText("a\rb")).toBe("a\\nb");
  });

  it("handles combined input without double-escaping", () => {
    expect(escapeIcsText("a\\;b,c\nd")).toBe("a\\\\\\;b\\,c\\nd");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// shared/ics.ts — folding (75 octets, byte-aware)
// ═════════════════════════════════════════════════════════════════════════════

describe("foldContentLine", () => {
  it("leaves a 75-octet line unfolded", () => {
    const line = "x".repeat(75);
    expect(foldContentLine(line)).toBe(line);
  });

  it("folds a 76-octet ASCII line at 75 with a space continuation", () => {
    const line = "x".repeat(76);
    const folded = foldContentLine(line);
    expect(folded).toBe("x".repeat(75) + "\r\n " + "x");
    const parts = folded.split("\r\n");
    expect(Buffer.byteLength(parts[0], "utf8")).toBe(75);
    expect(parts[1][0]).toBe(" ");
  });

  it("never splits a multibyte character (folds before the emoji)", () => {
    // 70 ASCII bytes + three 4-byte emoji = 82 octets. 70+4=74 fits; adding
    // another emoji would exceed 75, so the fold happens after 74 octets.
    const line = "x".repeat(70) + "🌱🌱🌱";
    const folded = foldContentLine(line);
    for (const part of folded.split("\r\n")) {
      expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(75);
    }
    expect(unfold(folded)).toBe(line);
    expect(folded).toContain("x".repeat(70) + "🌱\r\n 🌱🌱");
  });

  it("folds long multibyte content into <=75-octet physical lines losslessly", () => {
    const line = "Département — سول_Descriptor".repeat(20);
    const folded = foldContentLine(line);
    for (const part of folded.split("\r\n")) {
      expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(75);
    }
    expect(unfold(folded)).toBe(line);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// shared/ics.ts — dates & document structure
// ═════════════════════════════════════════════════════════════════════════════

describe("addDaysIso", () => {
  it("crosses month boundaries", () => {
    expect(addDaysIso("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDaysIso("2026-04-30", 1)).toBe("2026-05-01");
  });

  it("crosses year boundaries", () => {
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("handles leap years", () => {
    expect(addDaysIso("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysIso("2026-02-28", 1)).toBe("2026-03-01");
  });
});

describe("toIcsUtcStamp", () => {
  it("formats a UTC timestamp", () => {
    expect(toIcsUtcStamp(new Date(Date.UTC(2026, 8, 14, 15, 30, 45)))).toBe("20260914T153045Z");
  });
});

describe("buildVCalendar", () => {
  const now = new Date(Date.UTC(2026, 8, 14, 12, 0, 0));

  it("emits required PRODID, VERSION, X-WR-CALNAME and CRLF endings", () => {
    const ics = buildVCalendar(
      [{ uid: "7-0@farmfriend-roundtable", summary: "Plan — Week 1", startDate: "2026-09-21" }],
      "Soil; Plan",
      { now },
    );
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("VERSION:2.0\r\n");
    expect(ics).toContain("PRODID:");
    expect(ics).toContain("X-WR-CALNAME:Soil\\; Plan\r\n");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    // No bare LF anywhere: every \n is preceded by \r.
    expect(ics.includes("\n")).toBe(true);
    for (let i = 0; i < ics.length; i++) {
      if (ics[i] === "\n") expect(ics[i - 1]).toBe("\r");
    }
  });

  it("writes all-day DTSTART and exclusive DTEND (+1 day)", () => {
    const ics = buildVCalendar(
      [{ uid: "u1", summary: "s", startDate: "2026-01-31" }],
      "Cal",
      { now },
    );
    expect(ics).toContain("DTSTART;VALUE=DATE:20260131\r\n");
    expect(ics).toContain("DTEND;VALUE=DATE:20260201\r\n");
  });

  it("exclusive DTEND crosses year boundary", () => {
    const ics = buildVCalendar(
      [{ uid: "u1", summary: "s", startDate: "2026-12-31" }],
      "Cal",
      { now },
    );
    expect(ics).toContain("DTEND;VALUE=DATE:20270101\r\n");
  });

  it("stamps every VEVENT's DTSTAMP with the injected now (UTC)", () => {
    const ics = buildVCalendar(
      [{ uid: "u1", summary: "s", startDate: "2026-09-21" }],
      "Cal",
      { now },
    );
    expect(ics).toContain("DTSTAMP:20260914T120000Z\r\n");
    expect(ics.match(/DTSTAMP:/g)?.length).toBe(1);
  });

  it("escapes and caps SUMMARY at 75 chars", () => {
    const longSummary = "N;a\\rrow plan, ".repeat(12); // > 75 chars, has TEXT specials
    const ics = buildVCalendar(
      [{ uid: "u1", summary: longSummary, startDate: "2026-09-21" }],
      "Cal",
      { now },
    );
    // Unfold first so the SUMMARY property can be measured as one line.
    const unfolded = unfold(ics);
    const prop = unfolded.split("\r\n").find((l) => l.startsWith("SUMMARY:"))!;
    const rawValue = prop.slice("SUMMARY:".length);
    expect(escapeIcsText(longSummary.slice(0, SUMMARY_MAX_CHARS))).toBe(rawValue);
    expect(longSummary.slice(0, SUMMARY_MAX_CHARS).length).toBe(SUMMARY_MAX_CHARS);
  });

  it("keeps UIDs verbatim so they stay deterministic", () => {
    const ics = buildVCalendar(
      [
        { uid: "3-0@farmfriend-roundtable", summary: "A", startDate: "2026-09-21" },
        { uid: "3-1@farmfriend-roundtable", summary: "B", startDate: "2026-09-28" },
      ],
      "Cal",
      { now },
    );
    expect(ics).toContain("UID:3-0@farmfriend-roundtable\r\n");
    expect(ics).toContain("UID:3-1@farmfriend-roundtable\r\n");
  });

  it("emits DESCRIPTION when provided", () => {
    const ics = buildVCalendar(
      [{ uid: "u1", summary: "s", startDate: "2026-09-21", description: "Soil test; 10 kg" }],
      "Cal",
      { now },
    );
    expect(ics).toContain("DESCRIPTION:Soil test\\; 10 kg\r\n");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// shared/schedule-extract.ts — parsing helpers
// ═════════════════════════════════════════════════════════════════════════════

describe("parseWeekCell", () => {
  it("parses W1 / Week 2 / bare 3", () => {
    expect(parseWeekCell("W1")).toBe(1);
    expect(parseWeekCell("Week 2")).toBe(2);
    expect(parseWeekCell("3")).toBe(3);
    expect(parseWeekCell("wk. 4")).toBe(4);
  });

  it("rejects non-week values", () => {
    expect(parseWeekCell("no digits")).toBeUndefined();
    expect(parseWeekCell("99")).toBeUndefined(); // outside 1..53
    expect(parseWeekCell("")).toBeUndefined();
  });
});

describe("parseIsoDate", () => {
  it("accepts valid ISO dates", () => {
    expect(parseIsoDate("2026-03-01")).toBe("2026-03-01");
    expect(parseIsoDate("2028-02-29")).toBe("2028-02-29"); // leap day
  });

  it("rejects garbage, impossible dates and non-padded forms", () => {
    expect(parseIsoDate("not-a-date")).toBeUndefined();
    expect(parseIsoDate("2026-02-30")).toBeUndefined();
    expect(parseIsoDate("2026-13-01")).toBeUndefined();
    expect(parseIsoDate("2026-3-1")).toBeUndefined();
    expect(parseIsoDate("")).toBeUndefined();
  });
});

describe("nextMondayFrom", () => {
  // 2024-01-01 was a Monday; 2024-01-02 Tue, 2024-01-06 Sat, 2024-01-07 Sun.
  it("strictly-after convention: a Monday anchors to the following Monday", () => {
    expect(nextMondayFrom(new Date(Date.UTC(2024, 0, 1)))).toBe("2024-01-08");
  });

  it("Tuesday -> +6 days", () => {
    expect(nextMondayFrom(new Date(Date.UTC(2024, 0, 2)))).toBe("2024-01-08");
  });

  it("Saturday -> +2 days", () => {
    expect(nextMondayFrom(new Date(Date.UTC(2024, 0, 6)))).toBe("2024-01-08");
  });

  it("Sunday -> +1 day", () => {
    expect(nextMondayFrom(new Date(Date.UTC(2024, 0, 7)))).toBe("2024-01-08");
  });
});

describe("resolveRowStartDate / buildRowSummary", () => {
  const anchor = "2026-04-06"; // a Monday

  it("week 1 anchors exactly", () => {
    expect(resolveRowStartDate({ weekIndex: 1, title: "t", description: "" }, anchor)).toBe("2026-04-06");
  });

  it("weekIndex n lands on anchor + (n-1)*7 days", () => {
    expect(resolveRowStartDate({ weekIndex: 2, title: "t", description: "" }, anchor)).toBe("2026-04-13");
    expect(resolveRowStartDate({ weekIndex: 5, title: "t", description: "" }, anchor)).toBe("2026-05-04");
  });

  it("uses explicit dates verbatim, ignoring the anchor", () => {
    expect(resolveRowStartDate({ date: "2026-12-25", title: "t", description: "" }, anchor)).toBe("2026-12-25");
  });

  it("SUMMARY is '<source> — Week N' or '<source> — <date>'", () => {
    expect(buildRowSummary({ weekIndex: 2, title: "Nitrogen Plan", description: "" })).toBe("Nitrogen Plan — Week 2");
    expect(buildRowSummary({ date: "2026-04-01", title: "Plan", description: "" })).toBe("Plan — 2026-04-01");
    expect(buildRowSummary({ title: "Plan", description: "" })).toBe("Plan");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// shared/schedule-extract.ts — extraction from artifacts and .md files
// ═════════════════════════════════════════════════════════════════════════════

describe("extractScheduleRows — table artifacts", () => {
  it("extracts week rows from a markdown pipe table, skipping noise rows", () => {
    const artifact: Artifact = {
      type: "table",
      title: "Nitrogen Plan",
      content: [
        "| Week | Task | Amount |",
        "| --- | --- | --- |",
        "| W1 | Soil test | 10 kg |",
        "| Week 2 | Compost turn | 5 kg |",
        "| 3 | Spread lime | 2 kg |",
        "| preamble without digits | x | y |",
      ].join("\n"),
    };
    const rows = extractScheduleRows([makeMessage([artifact])], []);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ weekIndex: 1, title: "Nitrogen Plan", description: "Soil test — 10 kg" });
    expect(rows[1]).toMatchObject({ weekIndex: 2, description: "Compost turn — 5 kg" });
    expect(rows[2]).toMatchObject({ weekIndex: 3, description: "Spread lime — 2 kg" });
  });

  it("extracts date rows from a Date column", () => {
    const artifact: Artifact = {
      type: "table",
      title: "Transplant Schedule",
      content: "| Date | Task |\n| --- | --- |\n| 2026-04-01 | Bed prep |\n| 2026-04-08 | Transplant |",
    };
    const rows = extractScheduleRows([makeMessage([artifact])], []);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ date: "2026-04-01", description: "Bed prep" });
  });

  it("returns nothing when no week/date-ish column exists", () => {
    const artifact: Artifact = {
      type: "table",
      title: "T",
      content: "| Crop | Yield |\n| --- | --- |\n| Corn | 180 bu |",
    };
    expect(extractScheduleRows([makeMessage([artifact])], [])).toEqual([]);
  });
});

describe("extractScheduleRows — chart and json artifacts", () => {
  it("extracts chart data entries with week key and key:value description", () => {
    const artifact: Artifact = {
      type: "chart",
      title: "Nutrient Curve",
      content: JSON.stringify({
        type: "line",
        data: [
          { week: "W1", nitrogen: 80, phosphorus: 40 },
          { week: "W2", nitrogen: 60, phosphorus: 30 },
        ],
        lines: [{ key: "nitrogen", name: "Nitrogen" }],
        title: "Nutrient Curve",
      }),
    };
    const rows = extractScheduleRows([makeMessage([artifact])], []);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      weekIndex: 1,
      title: "Nutrient Curve",
      description: "nitrogen: 80; phosphorus: 40",
    });
    expect(rows[1]).toMatchObject({ weekIndex: 2, description: "nitrogen: 60; phosphorus: 30" });
  });

  it("extracts json artifacts that are bare arrays (heterogeneous keys)", () => {
    const artifact: Artifact = {
      type: "json",
      title: "Plan",
      content: JSON.stringify([
        { date: "2026-04-01", task: "Bed prep" },
        { week: "Week 3", task: "Side-dress" },
      ]),
    };
    const rows = extractScheduleRows([makeMessage([artifact])], []);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ date: "2026-04-01", description: "task: Bed prep" });
    expect(rows[1]).toMatchObject({ weekIndex: 3, description: "task: Side-dress" });
  });

  it("ignores invalid JSON and objects without week/date keys", () => {
    const bad: Artifact = { type: "json", title: "Bad", content: "{not json" };
    const keyless: Artifact = { type: "json", title: "K", content: JSON.stringify([{ foo: 1 }]) };
    expect(extractScheduleRows([makeMessage([bad, keyless])], [])).toEqual([]);
  });
});

describe("extractScheduleRows — Expert-generated .md files", () => {
  const mdContent = [
    "# Nitrogen Plan",
    "",
    "## Week 1 — Soil test and bed prep",
    "Apply 10 kg N per acre.",
    "",
    "## Week 2",
    "Side-dress with compost tea.",
    "",
    "2026-04-01 — Transplant day",
    "Water seedlings well.",
  ].join("\n");

  it("parses week headings, bare week lines and ISO date lines", () => {
    const file = makeFile();
    const rows = extractScheduleRows([], [file], () => mdContent);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      weekIndex: 1,
      title: "nitrogen-plan",
      description: "Soil test and bed prep\nApply 10 kg N per acre.",
    });
    expect(rows[1]).toMatchObject({ weekIndex: 2, description: "Side-dress with compost tea." });
    expect(rows[2]).toMatchObject({ date: "2026-04-01", title: "nitrogen-plan", description: "Transplant day\nWater seedlings well." });
  });

  it("skips user-uploaded files, non-.md files and unreadable files", () => {
    const userFile = makeFile({ uploadedBy: "User", filename: "notes.md" });
    const txtFile = makeFile({ filename: "plan.txt" });
    const unreadable = makeFile({ filename: "gone.md", fileUrl: "/uploads/gone.md" });
    const rows = extractScheduleRows(
      [],
      [userFile, txtFile, unreadable],
      (p) => (p.endsWith("gone.md") ? null : mdContent),
    );
    expect(rows).toEqual([]);
  });

  it("caps md descriptions at 200 chars", () => {
    const longMd = "Week 1\n" + ("Filler line with plenty of words. ".repeat(10) + "\n").repeat(5);
    const rows = extractScheduleRows([], [makeFile()], () => longMd);
    expect(rows).toHaveLength(1);
    expect(rows[0].description.length).toBeLessThanOrEqual(200);
  });

  it("caps the row list at 60 entries", () => {
    const manyWeeks = Array.from({ length: 100 }, (_, i) => `## Week ${i + 1}`).join("\n");
    const rows = extractScheduleRows([], [makeFile()], () => manyWeeks);
    expect(rows).toHaveLength(MAX_SCHEDULE_ROWS);
    expect(rows).toHaveLength(60);
  });
});

describe("extractScheduleRows — no matches", () => {
  it("returns an empty list when nothing parses", () => {
    const rows = extractScheduleRows(
      [makeMessage([{ type: "html", title: "Note", content: "<p>hello</p>" } as Artifact])],
      [makeFile({ uploadedBy: "User" })],
      () => "just prose, no schedule",
    );
    expect(rows).toEqual([]);
  });
});
