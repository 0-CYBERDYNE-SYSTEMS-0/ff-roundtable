// Validator gate C round 3 on dev 4559032 (2026-10-25): one regression per finding.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compile, type TopLevelSpec } from "vega-lite";
import { themedVegaSpec, parseVegaChart, chartHasPlottableSeries, stripDualAxis, asksForDualAxis, filterRelevantSources, tidySourceList } from "../shared/chart-artifact";
import { validateChartArtifactDetailed } from "../server/expert-tools";
import { extractArtifacts } from "../server/artifact-extractor";
import { normalizeMarkdownTable, normalizeMarkdownTablesInText } from "../shared/markdown-table-normalize";
import { extractScheduleRows } from "../shared/schedule-extract";
import { CALENDAR_TABLE_RULE } from "../server/calendar-notes-prompt";
import { readFileSync } from "fs";

const OSU = "https://extension.oregonstate.edu/crop-production/berries/blueberry";
const IOWA = "https://crops.extension.iastate.edu/corn/yield";
const SHUNCY = "https://shuncy.com/article/blueberry-yield";
const rows = Array.from({ length: 15 }, (_, i) => ({ month: `2026-${String((i % 12) + 1).padStart(2, "0")}`, yield: 100 + i }));
const farmer = "Chart blueberry yield for my western Oregon farm near Eugene.";

const prev = process.env.FF_PREMIUM_CHARTS;
beforeEach(() => { process.env.FF_PREMIUM_CHARTS = "1"; });
afterEach(() => { if (prev === undefined) delete process.env.FF_PREMIUM_CHARTS; else process.env.FF_PREMIUM_CHARTS = prev; });

describe("NEW: empty first chart", () => {
  it("detects axes-only specs whose fields are missing from the data", () => {
    const empty = parseVegaChart({ type: "vega-lite", title: "Yield", data: rows, sources: [OSU], spec: { mark: "line", encoding: { x: { field: "Month", type: "ordinal" }, y: { field: "Yield_bu", type: "quantitative" } } } })!;
    expect(chartHasPlottableSeries(empty)).toBe(false);
    const good = parseVegaChart({ type: "vega-lite", title: "Yield", data: rows, sources: [OSU], spec: { mark: "line", encoding: { x: { field: "month", type: "ordinal" }, y: { field: "yield", type: "quantitative" } } } })!;
    expect(chartHasPlottableSeries(good)).toBe(true);
  });
  it("rebuilds an empty chart from its rows instead of showing empty axes", () => {
    const json = JSON.stringify({ type: "vega-lite", title: "Illustrative blueberry yield", data: rows, sources: [OSU], spec: { mark: "line", encoding: { x: { field: "Month", type: "ordinal" }, y: { field: "Yield_bu", type: "quantitative" } } } });
    const r = validateChartArtifactDetailed(json, [OSU], { farmerText: farmer });
    expect(r.ok).toBe(true);
    if (r.ok) expect(chartHasPlottableSeries(parseVegaChart(JSON.parse(r.json))!)).toBe(true);
  });
  it("rejects a chart with no numeric values at all", () => {
    const json = JSON.stringify({ type: "vega-lite", title: "Blueberry yield", data: [{ m: "a", y: "n/a" }], sources: [OSU], spec: { mark: "bar", encoding: { x: { field: "m", type: "nominal" }, y: { field: "y", type: "quantitative" } } } });
    expect(validateChartArtifactDetailed(json, [OSU], { farmerText: farmer })).toEqual({ ok: false, reason: "empty-series" });
  });
  it("client VegaChart suppresses non-plottable charts", () => {
    expect(readFileSync("client/src/components/artifacts/VegaChart.tsx", "utf8")).toMatch(/chartHasPlottableSeries\(parsed\)/);
  });
});

describe("(a) reference-line label renders once", () => {
  it("filters a constant text layer to one row", () => {
    const chart = parseVegaChart({ type: "vega-lite", title: "Price", data: rows, sources: [OSU], spec: { layer: [
      { mark: "line", encoding: { x: { field: "month", type: "ordinal" }, y: { field: "yield", type: "quantitative" } } },
      { mark: "rule", encoding: { y: { datum: 105 } } },
      { mark: { type: "text", text: "12-month average" }, encoding: { x: { field: "month", type: "ordinal" }, y: { datum: 105 } } },
    ] } })!;
    const spec = themedVegaSpec(chart) as any;
    const text = spec.layer.find((l: any) => (l.mark?.type ?? l.mark) === "text");
    expect(text.transform).toEqual(expect.arrayContaining([{ filter: "datum.__ff_rn === 1" }]));
    expect(() => compile(spec as TopLevelSpec)).not.toThrow();
  });
});

describe("(b) no dual axis unless asked", () => {
  it("strips independent y scales and right axes", () => {
    const out = stripDualAxis({ layer: [{ encoding: { y: { field: "a", axis: { orient: "right", title: "A" } } } }], resolve: { scale: { y: "independent" } } }) as any;
    expect(out.resolve).toBeUndefined();
    expect(out.layer[0].encoding.y.axis).toEqual({ title: "A" });
  });
  it("only keeps a dual axis on explicit request", () => {
    expect(asksForDualAxis("Show price and yield on a secondary axis")).toBe(true);
    expect(asksForDualAxis("Use a dual-axis chart")).toBe(true);
    expect(asksForDualAxis(farmer)).toBe(false);
    const json = JSON.stringify({ type: "vega-lite", title: "Blueberry yield and price", data: rows.map(r => ({ ...r, price: 2 })), sources: [OSU], spec: { layer: [
      { mark: "line", encoding: { x: { field: "month", type: "ordinal" }, y: { field: "yield", type: "quantitative" } } },
      { mark: "line", encoding: { x: { field: "month", type: "ordinal" }, y: { field: "price", type: "quantitative" } } },
    ], resolve: { scale: { y: "independent" } } } });
    const r = validateChartArtifactDetailed(json, [OSU], { farmerText: farmer });
    expect(r.ok && JSON.parse(r.json).spec.resolve).toBeUndefined();
    const asked = validateChartArtifactDetailed(json, [OSU], { farmerText: farmer + " Put price on a secondary axis." });
    expect(asked.ok && JSON.parse(asked.json).spec.resolve).toEqual({ scale: { y: "independent" } });
  });
});

describe("(c) source relevance + soft: assumptions", () => {
  it("drops Iowa/Purdue corn and shuncy.com for western Oregon questions, OSU first", () => {
    expect(filterRelevantSources([IOWA, SHUNCY, "https://ag.purdue.edu/x", "https://www.nass.usda.gov/or", OSU], farmer)).toEqual([OSU, "https://www.nass.usda.gov/or"]);
    expect(filterRelevantSources([IOWA], "Corn yield trend in Iowa")).toEqual([IOWA]);
  });
  it("validator footer has only relevant sources and no trailing assumptions", () => {
    const json = JSON.stringify({ type: "vega-lite", title: "Illustrative blueberry yield", data: rows, sources: ["assumptions"], spec: { mark: "line", encoding: { x: { field: "month", type: "ordinal" }, y: { field: "yield", type: "quantitative" } } } });
    const r = validateChartArtifactDetailed(json, [OSU, IOWA, SHUNCY], { farmerText: farmer, researchUrls: [IOWA, SHUNCY, OSU] });
    expect(r.ok && JSON.parse(r.json).sources).toEqual([OSU]);
  });
  it("tidySourceList keeps assumptions only when nothing real remains", () => {
    expect(tidySourceList([OSU, "assumptions"])).toEqual([OSU]);
    expect(tidySourceList(["assumptions"])).toEqual(["assumptions"]);
  });
});

describe("(5) table columns match header", () => {
  const bad = "| Task | Timing | Notes | Source |\n|---|---|---|---|\n| Soil test | W1 | Sample 0-6 in | OSU EM 8710 | [S1] |\n| Lime | W2 | Per test |";
  it("merges stray citation cells and pads short rows", () => {
    const out = normalizeMarkdownTable(bad).split("\n");
    expect(out[2]).toBe("| Soil test | W1 | Sample 0-6 in | OSU EM 8710 [S1] |");
    expect(out[3]).toBe("| Lime | W2 | Per test |  |");
  });
  it("applies to extracted table artifacts and inline message text", () => {
    const art = extractArtifacts(`Here:\n\n${bad}\n\nDone.`).artifacts.find(a => a.type === "table")!;
    expect(art.content).not.toMatch(/\| \[S1\] \|/);
    expect(normalizeMarkdownTablesInText(`x\n${bad}\ny`)).toContain("OSU EM 8710 [S1] |");
    expect(readFileSync("client/src/components/chat/ChatInterface.tsx", "utf8")).toMatch(/normalizeMarkdownTablesInText\(prepared\)/);
  });
});

describe("(5) table + calendar produces a schedulable plan", () => {
  it("prompt requires a Week/Date first column for calendar requests", () => {
    expect(CALENDAR_TABLE_RULE).toMatch(/"Week"/);
    expect(readFileSync("server/ai.ts", "utf8")).toMatch(/\$\{CALENDAR_TABLE_RULE\}/);
  });
  it("a table following the rule is picked up by the Calendar plan", () => {
    const table = "| Week | Task | Notes |\n|---|---|---|\n| W1 | Soil test | OSU [S1] |\n| W2 | Lime | per test | [S2] |";
    const art = extractArtifacts(`Plan:\n\n${table}\n`).artifacts.find(a => a.type === "table")!;
    const rowsOut = extractScheduleRows([{ artifacts: [art] }] as any, []);
    expect(rowsOut.map(r => r.weekIndex)).toEqual([1, 2]);
  });
});
