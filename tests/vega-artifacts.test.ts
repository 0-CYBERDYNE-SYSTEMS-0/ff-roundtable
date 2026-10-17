import { describe, expect, it } from "vitest";
import { compile, type TopLevelSpec } from "vega-lite";
import { parse, View } from "vega";
import { expressionInterpreter } from "vega-interpreter";
import { parseVegaChart, themedVegaSpec } from "../shared/chart-artifact";
import { extractArtifacts } from "../server/artifact-extractor";
import { validateChartArtifact } from "../server/expert-tools";
import { artifactExamples, artifactExamplesForRequest } from "../server/artifact-examples";

const chart = {
  type: "vega-lite", title: "Field water use · April", theme: "earth", sources: ["farmer"],
  data: [{ date: "2026-04-01", crop: "Corn", water: 12 }, { date: "2026-04-02", crop: "Corn", water: 15 }, { date: "2026-04-01", crop: "Beans", water: 9 }],
  spec: { mark: "area", encoding: { x: { field: "date", type: "temporal" }, y: { field: "water", type: "quantitative", title: "Water (mm)" }, color: { field: "crop", type: "nominal" } } },
};

describe("themed Vega-Lite artifacts", () => {
  it.each(artifactExamples)("keeps the complete training example valid: $request", async example => {
    const validated = validateChartArtifact(JSON.stringify(example.output), []);
    expect(validated).not.toBeNull();
    const chart = parseVegaChart(JSON.parse(validated!.json))!;
    const spec = compile(themedVegaSpec(chart) as unknown as TopLevelSpec).spec;
    const view = new View(parse(spec, undefined, { ast: true }), { renderer: "none", expr: expressionInterpreter });
    try { await view.runAsync(); expect(await view.toSVG()).toContain("<svg"); }
    finally { view.finalize(); }
  });
  it("loads examples for visualization requests without adding them to ordinary discussion", () => {
    expect(artifactExamplesForRequest("Make an immersive visualization")).toContain("fictional training context, never evidence");
    expect(artifactExamplesForRequest("What should I scout next?")).toBe("");
  });
  it("extracts a sourced chart and renders it using the CSP-safe interpreter", async () => {
    const extracted = extractArtifacts("```chart\n" + JSON.stringify(chart) + "\n```");
    const validated = validateChartArtifact(extracted.artifacts[0].content, []);
    const parsed = parseVegaChart(JSON.parse(validated!.json))!;
    const spec = compile(themedVegaSpec(parsed) as unknown as TopLevelSpec).spec;
    const view = new View(parse(spec, undefined, { ast: true }), { renderer: "none", expr: expressionInterpreter });
    try {
      await view.runAsync();
      expect(await view.toSVG()).toContain("Water (mm)");
    } finally { view.finalize(); }
  });

  it.each([
    { layer: [{ mark: "line", encoding: chart.spec.encoding }, { mark: "point", encoding: chart.spec.encoding }] },
    { facet: { field: "crop", type: "nominal" }, spec: { mark: "line", encoding: chart.spec.encoding } },
    { hconcat: [{ mark: "area", encoding: chart.spec.encoding }, { mark: "point", encoding: chart.spec.encoding }] },
    { mark: "point", params: [{ name: "pick", select: { type: "point", fields: ["crop"] }, bind: "legend" }], encoding: chart.spec.encoding },
    { mark: "rect", encoding: { x: { field: "date", type: "ordinal" }, y: { field: "crop", type: "nominal" }, color: { field: "water", type: "quantitative" } } },
  ])("allows composition and interaction beyond a fixed chart menu: %j", spec => {
    expect(validateChartArtifact(JSON.stringify({ ...chart, spec }), [])).not.toBeNull();
  });

  it.each([
    { ...chart.spec, data: { url: "https://example.com/private" } },
    { layer: [{ mark: "line", data: { values: [{ water: 99 }] } }] },
    { mark: "image" },
    { mark: "point", encoding: { href: { value: "javascript:alert(1)" } } },
    { mark: "point", usermeta: { embedOptions: { loader: "https://example.com" } } },
  ])("rejects resource loading, links and datasets outside the evidence envelope", spec => {
    expect(validateChartArtifact(JSON.stringify({ ...chart, spec }), [])).toBeNull();
  });

  it("retains citation checks and rejects malformed specs", () => {
    expect(validateChartArtifact(JSON.stringify({ ...chart, sources: ["https://invented.test"] }), [])).toBeNull();
    expect(validateChartArtifact(JSON.stringify({ ...chart, spec: { layer: "invalid" } }), [])).toBeNull();
    expect(parseVegaChart({ ...chart, data: [] })).toBeNull();
  });
});
