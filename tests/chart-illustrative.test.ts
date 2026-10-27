import { describe, expect, it } from "vitest";
import { filterChartArtifacts } from "../server/expert-tools";
import { extractArtifacts } from "../server/artifact-extractor";
const spec = { mark: "bar", encoding: { x: { field: "year", type: "ordinal" }, y: { field: "rev", type: "quantitative" } } };
const chart = (o: Record<string, unknown>) => "```chart\n" + JSON.stringify({ type: "vega-lite", title: "Hazelnut revenue 2026-2030, 40 ac Oregon", theme: "earth", data: [{ year: "2026", rev: 42000 }, { year: "2027", rev: 51000 }], spec, ...o }) + "\n```";
const run = (text: string, urls: string[] = []) => filterChartArtifacts(extractArtifacts(text).artifacts, urls, { farmerText: "40 acres" });
describe("chart source gate", () => {
  it("keeps labeled Illustrative charts without sources", () => {
    expect(run(chart({ title: "Illustrative: hazelnut revenue 2026-2030, 40 ac" })).kept).toHaveLength(1);
    expect(run(chart({ description: "Illustrative, based on assumptions: $1.20/lb", sources: ["assumptions"] })).kept).toHaveLength(1);
  });
  it("still drops unlabeled unsourced charts", () => {
    expect(run(chart({})).droppedReasons).toEqual(["missing-source"]);
    expect(run(chart({ sources: ["assumptions"] })).droppedReasons).toEqual(["unverified-source"]);
  });
  it("keeps charts sourced from fetched research URLs", () => {
    const url = "https://extension.oregonstate.edu/hazelnuts";
    expect(run(chart({ sources: [url] }), [url]).kept).toHaveLength(1);
  });
});
