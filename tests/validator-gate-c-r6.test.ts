// Validator gate C r6 on dev e0105e9 (2026-10-25): Week N anchored to today.
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { findPlanAnchor, findFrostAnchor, buildInlineCalendarArtifact, extractScheduleRows } from "../shared/schedule-extract";
import { parseInlineCalendar } from "../shared/inline-calendar";
import { rankSource, readableSourceTitle, looksLikeFileName } from "../shared/chart-artifact";
import { runToolCalls } from "../server/expert-tools";

const TODAY = "2026-10-25";
const Q = "Make me a planting calendar for my Eugene vegetable field this spring";
const PLAN = [
  "| Week | Task | Notes |",
  "|---|---|---|",
  "| Week 1 | Start brassica seed indoors | Average last frost Mar 25 at 32°F |",
  "| Week 4 | Direct-seed peas | soil 45°F |",
  "| Week 9 | Transplant warm-season crops | after frost risk |",
].join("\n");

describe("BLOCKER: Week 1 anchored to frost date / season, not today", () => {
  it("priority 1: frost date in the table, next future occurrence", () => {
    expect(findFrostAnchor(PLAN, TODAY)).toBe("2027-03-25");
    expect(findPlanAnchor([Q, PLAN], TODAY)).toBe("2027-03-25");
    expect(findFrostAnchor("last frost Mar 25", "2027-02-01")).toBe("2027-03-25");
  });
  it("priority 2: season word when no date", () => {
    expect(findPlanAnchor([Q, PLAN.replace(/Average last frost Mar 25 at 32°F/, "")], TODAY)).toBe("2027-03-20");
  });
  it("priority 3: none → undefined (caller uses today)", () => {
    expect(findPlanAnchor(["make a plan", "| Week 1 | Scout |"], TODAY)).toBeUndefined();
  });
  it("explicit T anchor beats frost and season", () => {
    expect(findPlanAnchor(["T = 2027-04-10", PLAN, Q], TODAY)).toBe("2027-04-10");
  });
  it("inline events: transplant lands in spring 2027, nothing in Nov/Dec 2026", () => {
    const art = buildInlineCalendarArtifact({ artifacts: [], deliverableMarkdown: PLAN, deliverableTitle: "spring-plan", contextText: Q, todayIso: TODAY });
    const ev = parseInlineCalendar(art!.content)!.events;
    const t = ev.find(e => /Transplant warm-season/.test(e.summary))!;
    expect(t.startDate).toBe("2027-05-20");
    expect(ev[0].startDate).toBe("2027-03-25");
    for (const e of ev) expect(e.startDate >= "2027-01-01").toBe(true);
  });
  it("extractScheduleRows uses the plan anchor for T-n rows", () => {
    const rows = extractScheduleRows([{ content: Q, artifacts: [{ type: "table", title: "x", content: "| When | Task |\n|---|---|\n| T-14 | Order seed |\n" }] }] as any, [{ filename: "p.md", uploadedBy: "Expert:A", fileUrl: "/p.md" }] as any, () => PLAN, TODAY);
    expect(rows.find(r => r.task === "Order seed")?.date).toBe("2027-03-11");
  });
  it("server returns the auto anchor; UI fills Week 1 and enables Preview when events exist", () => {
    const routes = readFileSync("server/routes.ts", "utf8");
    expect(routes).toMatch(/res\.json\(\{ \.\.\.draft, anchor, autoAnchor \}\)/);
    expect(routes).toMatch(/findConversationAnchor\(messages, todayIso, planFileTexts\(files\)\)/);
    const ui = readFileSync("client/src/components/sidebar/SidebarPanel.tsx", "utf8");
    expect(ui).toMatch(/value=\{calendarStart \|\| autoAnchor\}/);
    expect(ui).toMatch(/disabled=\{!activeConversationId \|\| !calendarPreview\?\.eventCount\}/);
    expect(ui).toMatch(/start=\{calendarStart \|\| autoAnchor\}/);
  });
});

describe("SOFT (a): OSU/USDA/NOAA frost sources outrank bield.app", () => {
  const q = "When is the last frost in Eugene? build a spring calendar";
  it("rank", () => {
    for (const good of ["https://www.ncei.noaa.gov/access/us-climate-normals/", "https://extension.oregonstate.edu/gardening/frost-dates", "https://www.usda.gov/frost"]) {
      expect(rankSource(good, q)).toBeLessThan(rankSource("https://bield.app/frost-dates/eugene-or", q));
    }
  });
  it("sources across calls are re-ordered and renumbered", async () => {
    const html = (t: string) => new Response(`<html><title>${t}</title><body>Eugene Oregon frost dates last frost spring ${t}</body></html>`, { headers: { "content-type": "text/html" } });
    const fetchImpl = (async (u: string) => u.includes("bield") ? html("Bield frost") : html("NOAA normals")) as any;
    const run = await runToolCalls([{ tool: "fetch", url: "https://bield.app/frost-dates/eugene-or" }, { tool: "fetch", url: "https://www.ncei.noaa.gov/normals" }], fetchImpl, q + " Eugene Oregon");
    expect(run.sources.length).toBe(2);
    {
      expect(run.sources[0].url).toMatch(/noaa/);
      expect(run.sources[0].id).toBe("S1");
    }
  });
});

describe("SOFT (b): readable source names", () => {
  it("never a raw PDF filename", () => {
    const url = "https://extension.oregonstate.edu/sites/default/files/documents/151_strik_davis_legacy_pruning_blueberry.pdf";
    expect(looksLikeFileName("151_strik_davis_legacy_pruning_blueberry.pdf")).toBe(true);
    const t = readableSourceTitle("151_strik_davis_legacy_pruning_blueberry.pdf", url);
    expect(t).toBe("extension.oregonstate.edu — Strik Davis Legacy Pruning Blueberry");
    expect(readableSourceTitle("x.pdf", url, "Pruning Blueberries | OSU Extension")).toBe("Pruning Blueberries | OSU Extension");
    expect(readableSourceTitle("Growing Blueberries in Your Home Garden", url)).toBe("Growing Blueberries in Your Home Garden");
  });
});
