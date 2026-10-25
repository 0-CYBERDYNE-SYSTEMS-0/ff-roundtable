// Validator gate C round 5 on dev 1756fb2 (2026-10-25): one regression per finding.
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "fs";
import { buildInlineCalendarArtifact, wantsCalendar, parseSeason, resolveScheduleAnchor, cleanEventNotes, extractScheduleRows, parseTimingCell } from "../shared/schedule-extract";
import { parseInlineCalendar } from "../shared/inline-calendar";
import { rankSource, filterRelevantSources, ensureFacetWhenAsked, applyFacetScales, isFacetedSpec, asksForSmallMultiples } from "../shared/chart-artifact";
import { pickChartExamples, buildChartPickerPrompt } from "../server/chart-picker";
import { buildToolPlanningPrompt } from "../server/expert-tools";

const TODAY = "2026-10-25"; // injected clock
const PLAN = [
  "# grass-seed-calendar-2027",
  "",
  "| Timing | Task | Notes |",
  "|---|---|---|",
  "| this spring | Spring nitrogen topdress — split 1 | **40 lb N/ac** | |",
  "| April 20 | Broadleaf herbicide | scout first | |",
  "| Week 3 | Rust scouting | | |",
].join("\n");

describe("(1) calendar renders inline in the chat message", () => {
  const art = buildInlineCalendarArtifact({ artifacts: [], deliverableMarkdown: PLAN, deliverableTitle: "grass-seed-calendar-2027", contextText: "Make me a calendar for my grass seed field", todayIso: TODAY });
  it("builds a calendar artifact the message can display", () => {
    expect(wantsCalendar("Make me a calendar for my grass seed field")).toBe(true);
    expect(art?.type).toBe("calendar");
    const parsed = parseInlineCalendar(art!.content);
    expect(parsed?.events.length).toBe(3);
  });
  it("ArtifactDisplay renders the calendar case inline; server attaches it in both paths", () => {
    const disp = readFileSync("client/src/components/artifacts/ArtifactDisplay.tsx", "utf8");
    expect(disp).toMatch(/case "calendar"/);
    expect(disp).toMatch(/<InlineCalendar/);
    expect(readFileSync("client/src/components/artifacts/InlineCalendar.tsx", "utf8")).toMatch(/data-testid="inline-calendar"/);
    expect((readFileSync("server/ai.ts", "utf8").match(/attachInlineCalendar\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  describe("(2) relative timing resolves against the injected clock, never in the past", () => {
    it("from Oct 2026 'this spring' is spring 2027", () => {
      expect(parseSeason("this spring", TODAY)).toBe("2027-03-20");
      expect(parseSeason("next fall", TODAY)).toBe("2027-09-22");
      expect(parseSeason("this spring", "2026-02-01")).toBe("2026-03-20");
    });
    it("month-day rolls to next year; Week 1 = today with no stated anchor", () => {
      expect(parseTimingCell("April 20", { todayIso: TODAY } as any)?.date).toBe("2027-04-20");
      expect(resolveScheduleAnchor(undefined, TODAY)).toBe(TODAY);
      expect(resolveScheduleAnchor("2026-04-15", TODAY)).toBe("2027-04-15");
    });
    it("no inline event is before today", () => {
      const ev = parseInlineCalendar(art!.content)!.events;
      for (const e of ev) expect(e.startDate >= TODAY).toBe(true);
      expect(ev.map(e => e.startDate)).toContain("2027-03-20");
      expect(ev.map(e => e.startDate)).toContain("2027-04-20");
    });
  });

  describe("(3) titles from task text; notes clean", () => {
    it("summaries are tasks, not the file slug", () => {
      const sums = parseInlineCalendar(art!.content)!.events.map(e => e.summary);
      expect(sums.some(s => /Spring nitrogen topdress/.test(s))).toBe(true);
      expect(sums.some(s => /Broadleaf herbicide/.test(s))).toBe(true);
      for (const s of sums) expect(s).not.toMatch(/grass-seed-calendar/);
    });
    it("notes carry no stray pipes or markdown", () => {
      for (const e of parseInlineCalendar(art!.content)!.events) {
        expect(e.description ?? "").not.toMatch(/\||\*\*/);
      }
      expect(cleanEventNotes("**40 lb N/ac** | |")).toBe("40 lb N/ac");
      expect(cleanEventNotes("a | | b")).toBe("a — b");
    });
    it("Files-tab rows use the same cleaned task titles", () => {
      const rows = extractScheduleRows([] as any, [{ filename: "grass-seed-calendar-2027.md", uploadedBy: "Expert:x", fileUrl: "/f.md" }] as any, () => PLAN, TODAY);
      expect(rows.some(r => r.task === "Broadleaf herbicide")).toBe(true);
    });
  });
});

describe("(4) field-crop prompts rank OSU field-crop sources above home-garden calendars", () => {
  const q = "Build a calendar for my 80 acres of tall fescue grass seed in the Willamette Valley";
  const garden = "https://extension.oregonstate.edu/gardening/techniques/monthly-garden-calendar";
  const crop = "https://extension.oregonstate.edu/crop-production/field-crops/grass-seed-production";
  it("rankSource orders crop-production before home-garden", () => {
    expect(rankSource(crop, q)).toBeLessThan(rankSource(garden, q));
    expect(filterRelevantSources([garden, crop], q)[0]).toBe(crop);
  });
  it("search results are re-ranked before fetching and the planner asks for crop guides", () => {
    expect(readFileSync("server/expert-tools.ts", "utf8")).toMatch(/rankSource\(a\.r\.url, questionText\)/);
    expect(buildToolPlanningPrompt("Agronomist", q, 2)).toMatch(/field-crop guides/);
  });
  it("home-garden questions are not penalised", () => {
    expect(rankSource(garden, "when do I plant tomatoes in my backyard bed")).toBe(0);
  });
});

export const FACET_TRIGGER_PROMPT = "Make a small multiples chart comparing yield per acre for hazelnuts (lb/ac) and blueberries (tons/ac) on my Eugene, Oregon farm, 2021–2025 — one panel per crop.";

describe("(5) facet trigger prompt reliably hits the facet path", () => {
  it("picker selects small-multiples first and demands a facet", () => {
    expect(asksForSmallMultiples(FACET_TRIGGER_PROMPT)).toBe(true);
    expect(pickChartExamples(FACET_TRIGGER_PROMPT)[0].id).toBe("small-multiples");
    expect(buildChartPickerPrompt(FACET_TRIGGER_PROMPT)).toMatch(/REQUIRED: the farmer asked for small multiples/);
  });
  it("a non-faceted model reply is wrapped into panels with independent y scales", () => {
    const data = [2021, 2022, 2023, 2024, 2025].flatMap((y, i) => [
      { year: y, crop: "Hazelnuts (lb/ac)", yield: 2200 + i * 100 },
      { year: y, crop: "Blueberries (tons/ac)", yield: 7 + i * 0.3 },
    ]);
    const spec = { mark: "line", encoding: { x: { field: "year", type: "ordinal" }, y: { field: "yield", type: "quantitative" }, color: { field: "crop", type: "nominal" } } };
    const faceted = ensureFacetWhenAsked(spec, FACET_TRIGGER_PROMPT);
    expect(isFacetedSpec(faceted as any)).toBe(true);
    const out = applyFacetScales({ data, spec: faceted });
    expect((out.spec as any).resolve.scale.y).toBe("independent");
    expect(ensureFacetWhenAsked(spec, "compare yields")).toBe(spec);
  });
  const REPORT = "/workspace/ffrt-qa/charts-dev-2026-10-25/REPORT.md";
  it.skipIf(!existsSync(REPORT))("prompt is documented in REPORT.md", () => {
    expect(readFileSync(REPORT, "utf8")).toContain(FACET_TRIGGER_PROMPT);
  });
});
