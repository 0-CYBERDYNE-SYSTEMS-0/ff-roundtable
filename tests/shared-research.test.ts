import { describe, expect, it } from "vitest";
import { rememberSharedResearch, getSharedResearch, formatSharedResearchForPrompt, filterChartArtifacts } from "../server/expert-tools";
describe("shared roundtable research", () => {
  it("shares fetched sources across experts and expires them", () => {
    rememberSharedResearch(901, [{ title: "OSU hazelnuts", url: "https://extension.oregonstate.edu/h", snippet: "yield 2,500 lb/ac" }], 1000);
    rememberSharedResearch(901, [{ title: "NASS", url: "https://nass.usda.gov/x", snippet: "price $1.10" }], 2000);
    const shared = getSharedResearch(901, 3000);
    expect(shared.map(s => s.id)).toEqual(["R1", "R2"]);
    expect(formatSharedResearchForPrompt(shared, ["https://nass.usda.gov/x"])).toMatch(/OSU hazelnuts/);
    expect(getSharedResearch(901, 2000 + 7 * 3600_000)).toEqual([]);
    expect(getSharedResearch(902, 3000)).toEqual([]);
  });
  it("shared URLs are approved chart sources", () => {
    const url = "https://extension.oregonstate.edu/h";
    const content = JSON.stringify({ title: "Hazelnut yield by orchard age, Oregon", data: [{ a: 1, y: 2500 }], sources: [url] });
    expect(filterChartArtifacts([{ type: "chart", content }], [url]).kept).toHaveLength(1);
  });
});
