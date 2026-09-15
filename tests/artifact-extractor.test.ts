/**
 * F3 — artifact titles: tables/JSON extracted from expert output are named
 * after the nearest preceding markdown heading, else the table's first header
 * cell, else the generic "Data Table N" / "JSON Data N" fallbacks.
 * Pure unit tests — no routes, no DB.
 */

import { describe, it, expect } from "vitest";
import { extractArtifacts, generateTableArtifact } from "../server/artifact-extractor";

function tableArtifactTitles(content: string): string[] {
  return extractArtifacts(content)
    .artifacts.filter((a) => a.type === "table")
    .map((a) => a.title);
}

describe("extractArtifacts — table titles from preceding headings", () => {
  it("uses the nearest preceding heading, stripped to plaintext", () => {
    const content = [
      "Here is the plan.",
      "",
      "## **Spring** Nitrogen Plan",
      "",
      "| Week | Task |",
      "| --- | --- |",
      "| W1 | Soil test |",
    ].join("\n");
    expect(tableArtifactTitles(content)).toEqual(["Spring Nitrogen Plan"]);
  });

  it("uses the NEAREST heading when several precede the table", () => {
    const content = [
      "# Top Level",
      "",
      "prose in between",
      "",
      "### Later Section",
      "",
      "| Week | Task |",
      "| --- | --- |",
      "| W1 | x |",
    ].join("\n");
    expect(tableArtifactTitles(content)).toEqual(["Later Section"]);
  });

  it("ignores headings that come after the table", () => {
    const content = [
      "Intro line so the table is preceded by a newline.",
      "",
      "| Week | Task |",
      "| --- | --- |",
      "| W1 | x |",
      "",
      "## Later Heading",
    ].join("\n");
    // No preceding heading -> first-header-cell fallback, never the later heading.
    expect(tableArtifactTitles(content)).toEqual(["Week"]);
  });

  it("gives each table its own nearest heading", () => {
    const content = [
      "## Nitrogen",
      "",
      "| Week | Task |",
      "| --- | --- |",
      "| W1 | a |",
      "",
      "## Irrigation",
      "",
      "| Week | Task |",
      "| --- | --- |",
      "| W1 | b |",
    ].join("\n");
    expect(tableArtifactTitles(content)).toEqual(["Nitrogen", "Irrigation"]);
  });

  it("truncates very long headings to a sensible length", () => {
    const longHeading = "An Extremely Verbose Heading That Goes On And On For Quite A While Indeed";
    const content = `## ${longHeading}\n\n| Week | Task |\n| --- | --- |\n| W1 | x |`;
    const [title] = tableArtifactTitles(content);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.startsWith("An Extremely Verbose")).toBe(true);
  });
});

describe("extractArtifacts — header-cell and generic fallbacks", () => {
  it("falls back to the first header cell when no heading precedes", () => {
    const content = "Answer:\n\n| 🌱 Week | **Task** |\n| --- | --- |\n| W1 | Soil |";
    expect(tableArtifactTitles(content)).toEqual(["Week"]);
  });

  it("falls back to 'Data Table N' when neither heading nor header text exists", () => {
    const content = "Answer:\n\n| | |\n| --- | --- |\n| W1 | x |";
    expect(tableArtifactTitles(content)).toEqual(["Data Table 1"]);
  });

  it("numbers only the fallback titles (titled tables skip the counter)", () => {
    const content = [
      "## Titled Plan",
      "",
      "| Week | Task |",
      "| --- | --- |",
      "| W1 | a |",
      "",
      "| | |",
      "| --- | --- |",
      "| W1 | b |",
    ].join("\n");
    expect(tableArtifactTitles(content)).toEqual(["Titled Plan", "Data Table 1"]);
  });
});

describe("extractArtifacts — JSON block titles", () => {
  const json = '{"nitrogen": 80, "phosphorus": 40, "potassium": 20, "notes": "side-dress"}';

  it("names a JSON block after the preceding heading", () => {
    const content = `## Nutrient Targets\n\n${json}`;
    const { artifacts } = extractArtifacts(content);
    const jsonArtifact = artifacts.find((a) => a.type === "json");
    expect(jsonArtifact?.title).toBe("Nutrient Targets");
  });

  it("falls back to 'JSON Data N' without a preceding heading", () => {
    const { artifacts } = extractArtifacts(`Prefix text.\n\n${json}`);
    const jsonArtifact = artifacts.find((a) => a.type === "json");
    expect(jsonArtifact?.title).toBe("JSON Data 1");
  });
});

describe("extractArtifacts — explicit artifact blocks keep their titles", () => {
  it("does not rename fenced artifacts that declare a title", () => {
    const content = "## A Heading\n\n```table\n// title: Chosen Title\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```";
    const { artifacts } = extractArtifacts(content);
    const table = artifacts.find((a) => a.type === "table");
    expect(table?.title).toBe("Chosen Title");
  });
});

describe("generateTableArtifact — title preference", () => {
  it("derives the title from the first column name when none is passed", () => {
    expect(generateTableArtifact([{ week_number: 1, task: "x" }]).title).toBe("week number");
  });

  it("prefers the caller-provided title", () => {
    expect(generateTableArtifact([{ week: 1 }], "My Plan").title).toBe("My Plan");
  });

  it('falls back to "Data Table" when there is no data', () => {
    expect(generateTableArtifact([]).title).toBe("Data Table");
  });
});
