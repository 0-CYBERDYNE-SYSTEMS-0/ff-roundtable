import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { compile } from "vega-lite";
import { CHART_CATALOG } from "../shared/chart-catalog";
import { parseVegaChart, themedVegaSpec } from "../shared/chart-artifact";
import { buildChartPickerPrompt, classifyChartRequest, pickChartExamples } from "../server/chart-picker";
import { fallbackSpecFromRows, parseChartJsonWithRepair } from "../server/chart-repair";
import { validateChartArtifactDetailed } from "../server/expert-tools";
import { artifactExamplesForRequest } from "../server/artifact-examples";

const ids = (q: string) => pickChartExamples(q).map(e => e.id);
beforeEach(() => { process.env.FF_PREMIUM_CHARTS = "1"; });
afterEach(() => { delete process.env.FF_PREMIUM_CHARTS; });

describe("chart catalog", () => {
  it("has 20+ entries spanning every intent", () => {
    expect(CHART_CATALOG.length).toBeGreaterThanOrEqual(20);
    const intents = new Set(CHART_CATALOG.flatMap(e => e.intents));
    for (const i of ["change", "part", "rank", "deviation", "correlation", "distribution", "flow", "spatial", "schedule", "magnitude", "uncertainty"]) expect(intents.has(i as any)).toBe(true);
  });
  it.each(CHART_CATALOG.map(e => [e.id, e] as const))("%s example is a valid, compact, illustrative envelope", (_id, e) => {
    const parsed = parseVegaChart(e.example);
    expect(parsed).not.toBeNull();
    expect(() => compile(themedVegaSpec(parsed!, 720) as any)).not.toThrow();
    expect(JSON.stringify(e.example).length).toBeLessThan(2600);
    const v = validateChartArtifactDetailed(JSON.stringify(e.example), []);
    expect(v.ok).toBe(true);
  });
});

describe("picker", () => {
  it("fits charts to intent and data shape", () => {
    expect(ids("Chart daily rainfall vs soil moisture for June")).toContain("dual-axis");
    expect(ids("Show where the money goes from revenue to net income per acre")).toContain("waterfall");
    expect(ids("Rank our soybean varieties by yield")).toContain("ranked-lollipop");
    expect(ids("Plot the spread of yield monitor samples by field")).toContain("boxplot");
    expect(ids("Make a timeline of spring field operations")).toContain("gantt");
    expect(ids("Corn price forecast with best and worst case")).toContain("range-band");
    expect(ids("Map soil pH across the grid samples")).toContain("field-grid-map");
    expect(ids("Graph the profit or loss per acre for each crop")).toContain("diverging-bar");
    expect(ids("Chart weekly futures open high low close")).toContain("candlestick");
  });
  it("returns 1–3 examples and versatile defaults for vague asks", () => {
    expect(pickChartExamples("make me a chart").length).toBeGreaterThanOrEqual(2);
    expect(pickChartExamples("chart crop revenue rank over the years with share of acres and stacked costs").length).toBeLessThanOrEqual(3);
    expect(classifyChartRequest("trend of prices over time").intents).toContain("change");
  });
  it("prompt carries the brief, the menu and only the picked examples", () => {
    const p = buildChartPickerPrompt("Chart daily rainfall vs soil moisture");
    expect(p).toContain("PREMIUM CHART BRIEF");
    expect(p).toContain('"theme":"farmfriend"');
    expect((p.match(/^FIT:/gm) ?? []).length).toBeLessThanOrEqual(3);
    expect(p.length).toBeLessThan(9000);
  });
  it("is off by default and falls back to the legacy examples", () => {
    delete process.env.FF_PREMIUM_CHARTS;
    expect(artifactExamplesForRequest("make a chart of rainfall")).toContain("VISUAL DESIGN TRAINING EXAMPLES");
    process.env.FF_PREMIUM_CHARTS = "1";
    expect(artifactExamplesForRequest("make a chart of rainfall")).toContain("PREMIUM CHART BRIEF");
    expect(artifactExamplesForRequest("timeline of field operations")).toContain("PREMIUM CHART BRIEF");
  });
});

describe("repair and fallback", () => {
  const env = { type: "vega-lite", title: "Illustrative: test chart rows", sources: ["assumptions"], data: [{ m: "Jan", v: 1 }, { m: "Feb", v: 2 }] };
  it("repairs fences, unquoted keys, comments, trailing commas and truncation", () => {
    expect(parseChartJsonWithRepair('```chart\n{"a":1}\n```').repaired).toBe("extracted");
    expect(parseChartJsonWithRepair('{a: 1, "b": [1,2,], // note\n}').value).toEqual({ a: 1, b: [1, 2] });
    expect(parseChartJsonWithRepair('{"a": {"b": [1, 2').value).toEqual({ a: { b: [1, 2] } });
    expect(() => parseChartJsonWithRepair("no json here")).toThrow();
  });
  it("validator repairs JSON and rebuilds an uncompilable spec from rows when premium is on", () => {
    const broken = JSON.stringify({ ...env, spec: { mark: "bar", encoding: { x: { field: "m", type: "nominal" }, y: { field: "v", type: "bogus-type" } } } });
    expect(validateChartArtifactDetailed(broken, []).ok).toBe(true);
    const nested = JSON.stringify({ ...env, spec: { data: { values: [] }, mark: "line" } });
    expect(validateChartArtifactDetailed(nested, []).ok).toBe(true);
    const sloppy = JSON.stringify({ ...env, spec: { mark: "bar", encoding: { x: { field: "m", type: "nominal" }, y: { field: "v", type: "quantitative" } } } }).replace('"title"', "title");
    expect(validateChartArtifactDetailed(sloppy, []).ok).toBe(true);
    delete process.env.FF_PREMIUM_CHARTS;
    expect(validateChartArtifactDetailed(broken, []).ok).toBe(false);
    expect(validateChartArtifactDetailed(sloppy, []).ok).toBe(false);
  });
  it("security: url/nested data never survives, even through fallback", () => {
    const evil = JSON.stringify({ ...env, spec: { mark: "line", data: { url: "https://evil.example/x.json" } } });
    const v = validateChartArtifactDetailed(evil, []);
    expect(v.ok && v.json.includes("evil.example")).toBe(false);
  });
  it("fallback picks a line for time-like x and a bar otherwise", () => {
    expect((fallbackSpecFromRows([{ date: "2026-01-01", mm: 3 }]) as any).mark.type).toBe("line");
    expect((fallbackSpecFromRows([{ crop: "Corn", bu: 180 }]) as any).mark.type).toBe("bar");
  });
});

describe("regression: 18 saved Free-model outputs (2026-10-24)", () => {
  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/chart-llm-outputs-2026-10-24.json"), "utf8"));
  it("has all 18", () => expect(rows.length).toBe(18));
  it.each(rows.map((r: any) => [`${r.model} ${r.engine} #${r.prompt}`, r]))("%s parses (with repair)", (_n, r: any) => {
    const { value } = parseChartJsonWithRepair(r.text);
    expect(value && typeof value === "object").toBe(true);
    if (r.engine !== "vegalite") return;
    // Raw Vega-Lite → FFRT envelope, then the premium validator must accept it.
    const { data, $schema, config, ...spec } = value as any;
    const envelope = { type: "vega-lite", title: `Illustrative: ${String((value as any).title?.text ?? (value as any).title ?? "farm chart regression")}`.slice(0, 170), sources: ["assumptions"], data: data?.values ?? [], spec };
    expect(validateChartArtifactDetailed(JSON.stringify(envelope), []).ok).toBe(true);
  });
});
