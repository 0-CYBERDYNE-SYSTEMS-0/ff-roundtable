import { describe, expect, it } from "vitest";
import { compile, type TopLevelSpec } from "vega-lite";
import { parseVegaChart, themedVegaSpec } from "../shared/chart-artifact";
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
});
