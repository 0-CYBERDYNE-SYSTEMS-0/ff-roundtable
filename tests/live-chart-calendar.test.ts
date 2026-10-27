import { describe, expect, it, vi } from "vitest";
import { validateChartArtifact } from "../server/expert-tools";
import { compile } from "vega-lite";
import { normalizeMixedUnitChart, themedVegaSpec, parseVegaChart } from "../shared/chart-artifact";
import { finalizeCalendarEvents, buildInlineCalendarArtifact } from "../shared/schedule-extract";

describe("live mixed-unit charts", () => {
  const data = [{ year: 2027, hay: 3, blueberry: 14000 }, { year: 2028, hay: 4, blueberry: 12000 }];
  const title = "Hay yield (tons/ac), Blueberry yield (lb/ac)";
  const y = (field: string) => ({ field, type: "quantitative", title, scale: { domain: [0, 14000] } });
  const layered = { encoding: { x: { field: "year", type: "ordinal" } }, layer: [
    { mark: "bar", encoding: { y: y("hay") } }, { mark: "line", encoding: { y: y("blueberry") } },
  ], resolve: { scale: { y: "shared" } } };
  const variants = [layered,
    { mark: "line", transform: [{ fold: ["hay (tons/ac)", "blueberry (lb/ac)"] }], encoding: { x: { field: "year", type: "ordinal" }, y: y("value"), color: { field: "key" } } },
    { repeat: ["hay (tons/ac)", "blueberry (lb/ac)"], spec: { mark: "bar", encoding: { x: { field: "year", type: "ordinal" }, y: { field: { repeat: "repeat" }, type: "quantitative" } } } },
  ];
  for (const [index, spec] of variants.entries()) it(`facets and compiles rendered variant ${index}`, () => {
    const rows = index ? data.map(r => ({ year: r.year, "hay (tons/ac)": r.hay, "blueberry (lb/ac)": r.blueberry })) : data;
    const parsed = parseVegaChart({ type: "vega-lite", title: "Yield", sources: ["assumptions"], data: rows, spec });
    expect(parsed).toBeTruthy();
    const rendered = themedVegaSpec(parsed! ) as any;
    expect(rendered.facet.field).toBe("__ff_unit");
    expect(rendered.resolve.scale.y).toBe("independent");
    expect(new Set(rendered.data.values.map((r: any) => r.__ff_unit))).toEqual(new Set(["tons/ac", "lb/ac"]));
    expect(() => compile(rendered)).not.toThrow();
    expect(rendered.spec.layer.map((l: any) => l.mark)).toEqual(index ? ["line", "line"].map(m => index === 2 ? "bar" : m) : ["bar", "line"]);
  });
  it("normalizes the premium acceptance path without mutating input", () => {
    const result = normalizeMixedUnitChart({ data, spec: layered }) as any;
    vi.stubEnv("FF_PREMIUM_CHARTS", "1");
    try {
      const accepted = validateChartArtifact(JSON.stringify({ type: "vega-lite", title: "Illustrative: yield", sources: ["assumptions"], data, spec: layered }), []);
      expect(accepted).toBeTruthy();
      const rendered = themedVegaSpec(parseVegaChart(JSON.parse(accepted!.json))!) as any;
      expect(rendered.facet.field).toBe("__ff_unit");
      expect(rendered.resolve.scale.y).toBe("independent");
      expect(() => compile(rendered)).not.toThrow();
    } finally { vi.unstubAllEnvs(); }
    expect(result.spec.resolve.scale.y).toBe("independent");
    expect(result.data.map((r: any) => r.__ff_value)).toEqual([3, 4, 14000, 12000]);
    expect(layered.resolve.scale.y).toBe("shared");
  });
});

describe("anchored calendar labels", () => {
  for (const prefix of ["Mar 23–29", "29", "12", ""]) it(`cleans leftover ${prefix || "dash"}`, () => {
    const [event] = finalizeCalendarEvents([{ summary: `${prefix} — Week 1`, startDate: "2027-03-20", description: "Mar 23–29 — Start seeds indoors" }], undefined);
    expect(event.summary).toBe("Start seeds indoors — Week 1 (Mar 20)");
    expect(event.description).toContain("Mar 20–26");
    expect(event.description).not.toContain("Mar 23");
  });
  it("uses the season anchor consistently when expert windows start three days later", () => {
    const artifact = buildInlineCalendarArtifact({ artifacts: [{ type: "table", title: "Planting calendar", content: "| Week | Window | Task |\n|---|---|---|\n| Week 1 | Mar 23–29 | Start seeds indoors |\n| Week 2 | Mar 30–Apr 5 | Prepare beds |" }], contextText: "Make a planting calendar for next spring", todayIso: "2026-10-26" });
    const { anchor, events } = JSON.parse(artifact!.content);
    expect(anchor).toBe("2027-03-20");
    expect(events[0].startDate).toBe("2027-03-20");
    expect(events[0].summary).toContain("Start seeds indoors");
    expect(events[0].description).toContain("Mar 20–26");
    expect(events[1].startDate).toBe("2027-03-27");
    expect(events[1].description).toContain("Mar 27–Apr 2");
  });
  it("cleans Week 2 and aligns its window", () => {
    const [event] = finalizeCalendarEvents([{ summary: "— Week 2", startDate: "2027-03-27", description: "Mar 30–Apr 5 — Start seeds indoors" }], undefined);
    expect(event.summary).toBe("Start seeds indoors — Week 2 (Mar 27)");
    expect(event.description).toContain("Mar 27–Apr 2");
  });
});
