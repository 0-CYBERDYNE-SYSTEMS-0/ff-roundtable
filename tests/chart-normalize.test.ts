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
