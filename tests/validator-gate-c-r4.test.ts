// Validator gate C round 4 on dev 8c8f804 (2026-10-25): one regression per finding.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { compile, type TopLevelSpec } from "vega-lite";
import { resetCacheForSession } from "../client/src/lib/queryClient";
import { extractScheduleRows, parseTimingCell, findTimingAnchor, parseMonthDay } from "../shared/schedule-extract";
import { extractArtifacts } from "../server/artifact-extractor";
import { applyFacetScales, parseVegaChart, themedVegaSpec, filterRelevantSources } from "../shared/chart-artifact";
import { validateChartArtifactDetailed, runToolCalls } from "../server/expert-tools";

describe("(P) react-query cache cleared on every account change", () => {
  it("resetCacheForSession clears everything, then seeds /api/user", () => {
    const calls: string[] = [];
    const client = { clear: vi.fn(() => calls.push("clear")), setQueryData: vi.fn(() => calls.push("set")) };
    resetCacheForSession(client, { id: 21 });
    expect(calls).toEqual(["clear", "set"]);
    expect(client.setQueryData).toHaveBeenCalledWith(["/api/user"], { id: 21 });
  });
  it("login, register, logout and dev login all use it", () => {
    const auth = readFileSync("client/src/hooks/use-auth.tsx", "utf8");
    expect(auth.match(/resetCacheForSession\(queryClient, (user|null)\)/g)).toHaveLength(3);
    expect(auth).not.toMatch(/setQueryData\(\["\/api\/user"\]/);
    expect(readFileSync("client/src/pages/auth-page.tsx", "utf8")).toMatch(/resetCacheForSession\(queryClient, user\)/);
  });
});

describe("(P2) Quick dev login only in dev builds", () => {
  it("button is gated on import.meta.env.DEV; server route only outside production", () => {
    const page = readFileSync("client/src/pages/auth-page.tsx", "utf8");
    expect(page).toMatch(/const DEVELOPMENT_MODE = import\.meta\.env\.DEV;/);
    expect(page).toMatch(/\{DEVELOPMENT_MODE && <div[^>]*>\s*<Button[^>]*onClick=\{handleDevLogin\}/);
    const routes = readFileSync("server/routes.ts", "utf8");
    expect(routes).toMatch(/const DEVELOPMENT_MODE = process\.env\.NODE_ENV !== "production";/);
    expect(routes).toMatch(/if \(DEVELOPMENT_MODE\) \{\s*app\.post\("\/api\/dev-login"/);
  });
});

describe("(5) calendar: timing columns become real events", () => {
  const today = "2026-10-25";
  it("parses month-day, ISO, week and T-n timing", () => {
    expect(parseMonthDay("April 20 – May 20", today)).toBe("2027-04-20");
    expect(parseMonthDay("Nov 3", today)).toBe("2026-11-03");
    expect(parseTimingCell("2027-03-01", { todayIso: today })).toEqual({ date: "2027-03-01" });
    expect(parseTimingCell("Week 3", { todayIso: today })).toEqual({ weekIndex: 3 });
    expect(parseTimingCell("T-14 days", { todayIso: today, anchorIso: "2027-04-15" })).toEqual({ date: "2027-04-01" });
    expect(parseTimingCell("T+2 weeks", { todayIso: today, anchorIso: "2027-04-15" })).toEqual({ date: "2027-04-29" });
    expect(parseTimingCell("T-14", { todayIso: today })).toBeUndefined();
    expect(parseTimingCell("When soil is fit", { todayIso: today })).toBeUndefined();
    expect(findTimingAnchor("Target planting date: April 25. Plan below.", today)).toBe("2027-04-25");
    expect(findTimingAnchor("T = 2027-04-15", today)).toBe("2027-04-15");
  });
  it("the Validator's table (Trigger / timing) yields >0 events", () => {
    const table = "| Task | Why it matters | Trigger / timing |\n|---|---|---|\n| Soil sampling | pH | As soon as fields are fit (early spring) |\n| Corn planting | window | April 20 – May 20 S1 |\n| Soybean planting | window | May 1 – June 5 S1 |\n| Side-dress N | uptake | ~V4–V6 growth stage |";
    const art = extractArtifacts(`Plan:\n\n${table}\n`).artifacts.find(a => a.type === "table")!;
    const rows = extractScheduleRows([{ content: "", artifacts: [art] }] as any, [], undefined, today);
    expect(rows.map(r => r.date)).toEqual(["2027-04-20", "2027-05-01"]);
    expect(rows[0].description).toMatch(/Corn planting/);
  });
  it("T-n rows resolve against the anchor stated in the message", () => {
    const table = "| Task | Timing |\n|---|---|\n| Soil test | T-28 |\n| Plant | T |";
    const art = extractArtifacts(`x\n\n${table}\n`).artifacts.find(a => a.type === "table")!;
    const rows = extractScheduleRows([{ content: "Target planting date: 2027-04-15", artifacts: [art] }] as any, [], undefined, today);
    expect(rows.map(r => r.date)).toEqual(["2027-03-18", "2027-04-15"]);
  });
  it("a generated .md deliverable with a timing table also counts", () => {
    const md = "# Spring Field Task Calendar\n\n| Task | When |\n|---|---|\n| Prune | Feb 10 |\n";
    const file = { filename: "spring.md", uploadedBy: "Expert:Crop", fileUrl: "/uploads/spring.md" };
    expect(extractScheduleRows([], [file] as any, () => md, today).map(r => r.date)).toEqual(["2027-02-10"]);
  });
});

describe("(NEW) faceted charts: independent y per panel when units differ", () => {
  const data = [
    { crop: "Blueberries (tons/ac)", season: "2021", y: 4 }, { crop: "Blueberries (tons/ac)", season: "2022", y: 5 },
    { crop: "Grass seed (lb/ac)", season: "2021", y: 1800 }, { crop: "Grass seed (lb/ac)", season: "2022", y: 2100 },
  ];
  const spec = { mark: "bar", encoding: { column: { field: "crop", type: "nominal" }, x: { field: "season", type: "ordinal" }, y: { field: "y", type: "quantitative" } } };
  it("sets resolve.scale.y independent and keeps the caption truthful", () => {
    const out = applyFacetScales({ data, spec, description: "All crops on the same y-axis scale." });
    expect((out.spec as any).resolve).toEqual({ scale: { y: "independent" } });
    expect(out.description).not.toMatch(/same y-axis/);
    expect(out.description).toMatch(/own y-axis scale/);
  });
  it("survives validation (no-dual-axis rule must not strip facet scales) and compiles", () => {
    process.env.FF_PREMIUM_CHARTS = "1";
    try {
      const json = JSON.stringify({ type: "vega-lite", title: "Illustrative per-acre yield by crop, Eugene OR", description: "Independent y-axis scales per crop because units differ.", data, sources: ["assumptions"], spec: { ...spec, resolve: { scale: { y: "independent" } } } });
      const r = validateChartArtifactDetailed(json, [], { farmerText: "yield chart for my Eugene farm" });
      expect(r.ok).toBe(true);
      const chart = parseVegaChart(JSON.parse((r as any).json))!;
      expect((chart.spec as any).resolve.scale.y).toBe("independent");
      expect(() => compile(themedVegaSpec(chart) as TopLevelSpec)).not.toThrow();
    } finally { delete process.env.FF_PREMIUM_CHARTS; }
  });
  it("same units and magnitudes stay shared, and the caption says so", () => {
    const same = data.map(d => ({ ...d, crop: d.crop.replace(/\(.*\)/, "(lb/ac)"), y: d.y > 100 ? d.y : d.y * 400 }));
    const out = applyFacetScales({ data: same, spec, description: "Independent y-axis scales per crop." });
    expect((out.spec as any).resolve).toBeUndefined();
    expect(out.description).toMatch(/share one y-axis scale/);
  });
});

describe("(c) research relevance applies to every prompt type", () => {
  const eugene = "Make a spring task table plus a calendar for my farm in Eugene, Oregon";
  it("drops Iowa corn/soy, Montana and cropple.ai for a Eugene question", () => {
    expect(filterRelevantSources([
      "https://crops.extension.iastate.edu/cropnews/corn-soybean-planting",
      "https://www.montana.edu/extension/planting",
      "https://extension.example.org/montana-spring-guide",
      "https://cropple.ai/blog/spring",
      "https://extension.oregonstate.edu/catalog/em-9305",
    ], eugene)).toEqual(["https://extension.oregonstate.edu/catalog/em-9305"]);
  });
  it("runToolCalls skips irrelevant search results before fetching (non-chart prompts too)", async () => {
    const r = (u: string) => `<a class="result__a" href="${u}">t</a><a class="result__snippet" href="${u}">s</a>`;
    const ddg = r("https://crops.extension.iastate.edu/corn") + r("https://cropple.ai/x");
    const fetched: string[] = [];
    const fetchImpl = (async (url: string) => {
      fetched.push(String(url));
      if (String(url).includes("duckduckgo")) return new Response(ddg, { headers: { "content-type": "text/html" } });
      return new Response("<title>OSU spring</title><p>Willamette Valley timing</p>", { headers: { "content-type": "text/html" } });
    }) as any;
    const run = await runToolCalls([{ tool: "search", query: "spring planting calendar" }, { tool: "fetch", url: "https://www.montana.edu/extension/x" }] as any, fetchImpl, eugene);
    expect(run.sources).toEqual([]);
    expect(run.notes.filter(n => /not relevant to the farmer's crop\/region/.test(n))).toHaveLength(3);
    expect(fetched.some(u => u.includes("iastate") || u.includes("cropple"))).toBe(false);
  });
});
