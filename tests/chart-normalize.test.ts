import { describe, expect, it } from "vitest";
import { compile, type TopLevelSpec } from "vega-lite";
import { parseVegaChart, parseChartNumericValue, themedVegaSpec } from "../shared/chart-artifact";
import { fallbackSpecFromRows } from "../server/chart-repair";
describe("chart normalization", () => {
  it("turns quoted numbers on y into a quantitative scale and keeps labels readable", () => {
    const chart = parseVegaChart({ type: "vega-lite", title: "Labor hours by season, 10 ac", theme: "earth", sources: ["assumptions"],
      data: [{ season: "Apr–May", hours: "120" }, { season: "Jun–Aug", hours: "1,340" }],
      spec: { mark: "bar", encoding: { x: { field: "season", type: "nominal" }, y: { field: "hours", type: "ordinal" } } } })!;
    const spec: any = themedVegaSpec(chart, 700);
    expect(spec.encoding.y.type).toBe("quantitative");
    expect(spec.data.values[1].hours).toBe(1340);
    expect(spec.config.axis.labelOverlap).toBe(true);
    expect(spec.autosize.type).toBe("fit");
    expect(() => compile(spec as TopLevelSpec)).not.toThrow();
  });

  it.each([
    ["14,000-20,000", 17000],
    ["14k–20k", 17000],
    ["14k—20k", 17000],
    ["14,000 to 20,000", 17000],
    ["14-20k", 17000],
    ["14k–20,000", 17000],
    ["14k", 14000],
    ["1,250", 1250],
  ])("plots %s as %s instead of combining range bounds", (value, expected) => {
    expect(parseChartNumericValue(value)).toBe(expected);
    const chart = parseVegaChart({
      type: "vega-lite", title: "Blueberry yield", sources: ["assumptions"],
      data: [{ crop: "blueberry", yield: value }],
      spec: { mark: "bar", encoding: { x: { field: "crop" }, y: { field: "yield", type: "ordinal" } } },
    })!;
    const rendered: any = themedVegaSpec(chart);
    expect(rendered.data.values[0].yield).toBe(expected);
    expect(rendered.encoding.y.type).toBe("quantitative");
  });

  it("keeps range-valued fields numeric when repairing a chart spec", () => {
    expect(fallbackSpecFromRows([{ crop: "blueberry", yield: "14,000 to 20,000" }])?.encoding).toMatchObject({
      y: { field: "yield", type: "quantitative" },
    });
  });
});

describe("low/mid/high range charts", () => {
  const rows = [2021, 2022, 2023].map((year, i) => ({ year, low: 8000 + i * 100, mid: 11000 + i * 100, high: 14000 + i * 100 }));
  const chartOf = (y: string, mark: unknown = "line") => parseVegaChart({
    type: "vega-lite", title: "Blueberry yield (lb/acre)", sources: ["assumptions"], data: rows,
    spec: { mark, encoding: { x: { field: "year", type: "ordinal" }, y: { field: y, type: "quantitative", title: "low" } } },
  })!;

  it.each(["low", "mid", "high"])("draws mid as the line with a low-to-high band when the spec plots only %s", y => {
    const spec: any = themedVegaSpec(chartOf(y));
    const [band, line] = spec.layer;
    expect(band.encoding.y.field).toBe("low");
    expect(band.encoding.y2.field).toBe("high");
    expect(line.encoding.y.field).toBe("mid");
    expect(JSON.stringify(spec.layer)).not.toContain('"title":"low"');
    expect(() => compile(spec as TopLevelSpec)).not.toThrow();
  });

  it("uses a floating bar and tick for categorical x", () => {
    const chart = parseVegaChart({ type: "vega-lite", title: "Yield", sources: ["assumptions"],
      data: [{ crop: "hay", low: 3, mid: 4, high: 5 }, { crop: "oats", low: 2, mid: 3, high: 4 }],
      spec: { mark: "bar", encoding: { x: { field: "crop", type: "nominal" }, y: { field: "low", type: "quantitative" } } } })!;
    const spec: any = themedVegaSpec(chart);
    expect(spec.layer[0].mark.type).toBe("bar");
    expect(spec.layer[1].mark.type).toBe("tick");
    expect(() => compile(spec as TopLevelSpec)).not.toThrow();
  });

  it("leaves a spec that already plots the whole range alone", () => {
    const chart = parseVegaChart({ type: "vega-lite", title: "Yield", sources: ["assumptions"], data: rows,
      spec: { mark: "area", encoding: { x: { field: "year", type: "quantitative" }, y: { field: "low", type: "quantitative" }, y2: { field: "high" } } } })!;
    expect((themedVegaSpec(chart) as any).layer).toBeUndefined();
  });

  it("fallback spec plots mid so the band expansion covers the rest", () => {
    const fb: any = fallbackSpecFromRows(rows);
    expect(fb.encoding.y.field).toBe("mid");
    const spec: any = themedVegaSpec(parseVegaChart({ type: "vega-lite", title: "Yield", sources: ["assumptions"], data: rows, spec: fb })!);
    expect(spec.layer[0].encoding.y2.field).toBe("high");
  });
});
