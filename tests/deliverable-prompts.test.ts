import { describe, expect, it } from "vitest";
import { buildToolUsePrompt, buildToolPlanningPrompt } from "../server/expert-tools";
import { ARTIFACT_DESIGN_PROMPT } from "../server/artifact-design";
describe("deliverable prompts", () => {
  it("tell experts to deliver Illustrative charts instead of refusing", () => {
    expect(buildToolUsePrompt()).toMatch(/Illustrative:/);
    expect(buildToolUsePrompt()).not.toMatch(/do not make a chart/i);
    expect(ARTIFACT_DESIGN_PROMPT).toMatch(/Illustrative:/);
  });
  it("allow self-contained HTML visuals", () => {
    expect(buildToolUsePrompt()).toMatch(/```html/);
  });
  it("planning asks for real data when numbers or charts are requested", () => {
    expect(buildToolPlanningPrompt("Agronomist", "chart yields", 2)).toMatch(/SEARCH for real current data/);
  });
});
