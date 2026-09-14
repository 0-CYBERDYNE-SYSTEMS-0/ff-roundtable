/**
 * .ics export unit tests — RFC 5545 builder + schedule extraction + anchoring.
 * Node env only; no server imports (route tests live in the second half).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";
import {
  buildVCalendar,
  escapeIcsText,
  foldContentLine,
  addDaysIso,
  toIcsUtcStamp,
  truncateChars,
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

// ── Route-test preamble (mirrors tests/conversations.test.ts) ──
// Env forcing MUST run before the server imports below; vite's SSR transform
// executes module statements in textual order.
process.env.DATABASE_URL = "";
process.env.SESSION_SECRET = "vitest-ics-secret";
process.env.NODE_ENV = "test";
process.env.LOGIN_RATELIMIT_MAX = "1000";

const { mockProcessMessageTurnBased } = vi.hoisted(() => ({
  mockProcessMessageTurnBased: vi.fn(),
}));

vi.mock("../server/orchestrator", () => ({
  processMessageTurnBased: mockProcessMessageTurnBased,
  InteractionOrchestrator: class {
    pause() {}
    resume() {}
    enableAutonomous(_maxTurns?: number) {}
    disableAutonomous() {}
  },
  getConversationState: vi.fn().mockReturnValue(null),
}));

vi.mock("../server/ai", () => ({
  generateSystemPrompt: vi.fn().mockReturnValue("You are a helpful agricultural expert."),
  callOpenRouterAPI: vi.fn(),
  callPerplexityAPI: vi.fn(),
  getExpertResponse: vi.fn(),
  generateInsights: vi.fn(),
}));

import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";

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

describe("truncateChars", () => {
  it("caps at max UTF-16 units and never leaves a lone high surrogate", () => {
    const emojiTitle = "🌱".repeat(38); // 76 units; each emoji is a surrogate pair
    const cut = truncateChars(emojiTitle, 75);
    expect(cut.length).toBe(74); // backed off from the split pair
    expect(cut).toBe("🌱".repeat(37));
    expect(truncateChars("short", 75)).toBe("short");
  });
});

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

  it("rejects time-axis lookalikes (anchored match, not substring)", () => {
    expect(parseWeekCell("Day 1")).toBeUndefined();
    expect(parseWeekCell("10:30")).toBeUndefined();
    expect(parseWeekCell("March 15")).toBeUndefined();
    expect(parseWeekCell("Week 99")).toBeUndefined(); // outside 1..53
    expect(parseWeekCell("Week 3 extra")).toBeUndefined(); // trailing junk
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

  it("ignores Day columns instead of misreading them as week numbers", () => {
    const artifact: Artifact = {
      type: "table",
      title: "Soil Metrics",
      content: "| Day | pH | Moisture |\n| --- | --- | --- |\n| Day 1 | 6.2 | 40 |\n| Day 2 | 6.4 | 45 |",
    };
    expect(extractScheduleRows([makeMessage([artifact])], [])).toEqual([]);
  });

  it("ignores Time and Month columns instead of misreading them as weeks", () => {
    const time: Artifact = {
      type: "table",
      title: "Chat Log",
      content: "| Time | Note |\n| --- | --- |\n| 10:30 | Irrigation on |",
    };
    const month: Artifact = {
      type: "table",
      title: "Season",
      content: "| Month | Task |\n| --- | --- |\n| March 15 | Start seeds |",
    };
    expect(extractScheduleRows([makeMessage([time, month])], [])).toEqual([]);
  });

  it("still accepts Week columns (W1 / Week 2 / bare digits) and Date columns (ISO)", () => {
    const artifact: Artifact = {
      type: "table",
      title: "Plan",
      content:
        "| Week | Date | Task |\n| --- | --- | --- |\n| W1 | 2026-05-04 | Soil test |\n| Week 2 | not-a-date | Side-dress |",
    };
    const rows = extractScheduleRows([makeMessage([artifact])], []);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ date: "2026-05-04", weekIndex: 1, description: "Soil test" });
    expect(rows[1]).toMatchObject({ weekIndex: 2, description: "Side-dress" });
  });

  it("reads chart entries keyed by day/time/month as nothing", () => {
    const artifact: Artifact = {
      type: "chart",
      title: "Soil",
      content: JSON.stringify({ type: "line", data: [{ day: 1, ph: 6.2 }, { day: 2, ph: 6.4 }] }),
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
    // 55 valid week lines (cycling 1..53) + 10 valid date lines = 65 parseable
    // rows, so the cap (not the source) is what limits the output.
    const manyWeeks = [
      ...Array.from({ length: 55 }, (_, i) => `## Week ${(i % 53) + 1}`),
      ...Array.from({ length: 10 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")} milestone`),
    ].join("\n");
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

describe("extractScheduleRows — .md phantom-event guard", () => {
  it("does not emit events for week/date lines that fail to parse", () => {
    const md = [
      "# Plan",
      "## Week 1: soil test",
      "- Week 99: celebrate", // out of range -> not an event
      "Due 2026-99-99 submit report", // impossible date -> not an event
    ].join("\n");
    const rows = extractScheduleRows([], [makeFile()], () => md);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ weekIndex: 1 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Route: GET /api/protected/conversations/:id/export.ics
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /api/protected/conversations/:id/export.ics", () => {
  let app: Express;

  const tableArtifact = (title = "Nitrogen Plan"): Artifact => ({
    type: "table",
    title,
    content: [
      "| Week | Task | Amount |",
      "| --- | --- | --- |",
      "| W1 | Soil test | 10 kg |",
      "| Week 2 | Compost turn | 5 kg |",
      "| 3 | Spread lime | 2 kg |",
    ].join("\n"),
  });

  async function registerAndLogin(
    agent: request.SuperAgentTest,
    username: string,
    password = "icspass123",
    email = "ics@example.com",
  ) {
    const res = await agent.post("/api/register").send({ username, password, email: `${username}.${email}` });
    expect(res.status).toBe(201);
    return agent;
  }

  async function createConversation(agent: request.SuperAgentTest, title = "ICS Roundtable") {
    const res = await agent.post("/api/protected/conversations").send({ title });
    expect(res.status).toBe(201);
    return res.body as { id: number; title: string };
  }

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    await registerRoutes(app);
  });

  beforeEach(() => {
    mockProcessMessageTurnBased.mockReset();
    mockProcessMessageTurnBased.mockResolvedValue(undefined);
  });

  it("returns 401 when not authenticated", async () => {
    const res = await request(app).get("/api/protected/conversations/1/export.ics");
    expect(res.status).toBe(401);
  });

  it("returns 404 for a non-existent conversation", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent, "icsMissing");
    const res = await agent.get("/api/protected/conversations/999999/export.ics");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the conversation belongs to another user", async () => {
    const owner = request.agent(app);
    await registerAndLogin(owner, "icsOwner");
    const convo = await createConversation(owner, "Owned Elsewhere");

    const other = request.agent(app);
    await registerAndLogin(other, "icsOther");

    const res = await other.get(`/api/protected/conversations/${convo.id}/export.ics`);
    expect(res.status).toBe(404);
  });

  it("returns 422 with the exact error for a conversation with nothing schedulable", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent, "icsEmpty");
    const convo = await createConversation(agent, "No Plan Here");

    const res = await agent.get(`/api/protected/conversations/${convo.id}/export.ics`);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "No schedulable items found in this conversation. Ask an expert for a week-by-week plan first.",
    });
  });

  it("returns 200 text/calendar starting with BEGIN:VCALENDAR for a table artifact", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent, "icsTable");
    const convo = await createConversation(agent, "Soil; Plan & More");

    await storage.createMessage({
      conversationId: convo.id,
      content: "plan in artifact only",
      role: "expert",
      artifacts: [tableArtifact()],
    } as any);

    const res = await agent.get(`/api/protected/conversations/${convo.id}/export.ics`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/calendar");
    expect(res.headers["content-disposition"]).toContain('attachment; filename="roundtable-soil--plan---more-');
    expect(res.headers["content-disposition"]).toContain('.ics"');

    const body = res.text;
    expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(body).toContain("VERSION:2.0\r\n");
    expect(body).toContain("PRODID:");
    expect(body).toContain("X-WR-CALNAME:Soil\\; Plan & More\r\n");
    expect(body).toContain(`UID:${convo.id}-0@farmfriend-roundtable\r\n`);
    expect(body).toContain(`UID:${convo.id}-1@farmfriend-roundtable\r\n`);
    expect(body).toContain(`UID:${convo.id}-2@farmfriend-roundtable\r\n`);
    expect(body.endsWith("END:VCALENDAR\r\n")).toBe(true);
    // Every VEVENT carries a DTSTAMP
    expect(body.match(/DTSTAMP:\d{8}T\d{6}Z\r\n/g)?.length).toBe(3);
  });

  it("honors an explicit ?start anchor with exclusive DTEND", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent, "icsStart");
    const convo = await createConversation(agent, "Anchored");

    await storage.createMessage({
      conversationId: convo.id,
      content: "",
      role: "expert",
      artifacts: [tableArtifact()],
    } as any);

    const res = await agent
      .get(`/api/protected/conversations/${convo.id}/export.ics`)
      .query({ start: "2026-04-06" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("DTSTART;VALUE=DATE:20260406\r\n");
    expect(res.text).toContain("DTEND;VALUE=DATE:20260407\r\n"); // exclusive +1 day
    expect(res.text).toContain("DTSTART;VALUE=DATE:20260413\r\n"); // week 2
    expect(res.text).toContain("DTSTART;VALUE=DATE:20260420\r\n"); // week 3
  });

  it("returns 422 for garbage ?start values", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent, "icsGarbage");
    const convo = await createConversation(agent, "Garbage Anchor");

    await storage.createMessage({
      conversationId: convo.id,
      content: "",
      role: "expert",
      artifacts: [tableArtifact()],
    } as any);

    for (const garbage of ["not-a-date", "2026-02-30", "2026-3-1", "04/06/2026"]) {
      const res = await agent
        .get(`/api/protected/conversations/${convo.id}/export.ics`)
        .query({ start: garbage });
      expect(res.status).toBe(422);
    }
  });

  it("defaults the anchor to the next Monday (strictly after today)", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent, "icsMonday");
    const convo = await createConversation(agent, "Next Monday");

    await storage.createMessage({
      conversationId: convo.id,
      content: "",
      role: "expert",
      artifacts: [tableArtifact()],
    } as any);

    const expectedAnchor = nextMondayFrom(new Date());
    const res = await agent.get(`/api/protected/conversations/${convo.id}/export.ics`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`DTSTART;VALUE=DATE:${expectedAnchor.replace(/-/g, "")}\r\n`);
  });

  it("exports Expert-generated .md plan files from disk", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent, "icsFiles");
    const convo = await createConversation(agent, "Generated Plan");

    await storage.createFile({
      conversationId: convo.id,
      filename: "nitrogen-plan.md",
      fileUrl: "/tests/fixtures/nitrogen-plan.md",
      fileType: "text/markdown",
      uploadedBy: "Expert: File Creator",
    } as any);

    const res = await agent.get(`/api/protected/conversations/${convo.id}/export.ics`);
    expect(res.status).toBe(200);
    // Two week headings + one ISO date line in the fixture.
    expect(res.text.match(/BEGIN:VEVENT\r\n/g)?.length).toBe(3);
    expect(res.text).toContain("SUMMARY:nitrogen-plan — Week 1\r\n");
    expect(res.text).toContain("DTSTART;VALUE=DATE:20260401\r\n");
  });

  it("user-uploaded .md files are never exported as events", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent, "icsUserFile");
    const convo = await createConversation(agent, "User Upload Only");

    await storage.createFile({
      conversationId: convo.id,
      filename: "my-notes.md",
      fileUrl: "/tests/fixtures/nitrogen-plan.md",
      fileType: "text/markdown",
      uploadedBy: "User",
    } as any);

    const res = await agent.get(`/api/protected/conversations/${convo.id}/export.ics`);
    expect(res.status).toBe(422);
  });
});
