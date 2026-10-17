import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import {
  parseToolPlan, parseDuckDuckGoResults, runToolCalls, formatToolResultsForPrompt, assertPublicUrl,
  extractDeliverable, saveExpertDeliverable, validateChartArtifact, filterChartArtifacts, toolCallLimitForTier, buildToolUsePrompt,
  MAX_TOOL_CALLS_PER_TURN,
} from "../server/expert-tools";

const DDG = `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2F93.184.216.34%2Fnitrogen&amp;rut=x">Nitrogen <b>deficiency</b></a> ... <a class="result__snippet" href="#">Lower leaves yellow in a V</a>`;

describe("tool planning", () => {
  it("parses SEARCH/FETCH lines, caps the count, ignores chatter", () => {
    const plan = parseToolPlan("SEARCH: corn nitrogen loss wet June\nsure!\nFETCH: https://extension.umn.edu/x\nSEARCH: a third\nSEARCH: a fourth", 3);
    expect(plan).toEqual([
      { tool: "search", query: "corn nitrogen loss wet June" },
      { tool: "fetch", url: "https://extension.umn.edu/x" },
      { tool: "search", query: "a third" },
    ]);
    expect(parseToolPlan("NONE", 3)).toEqual([]);
  });
  it("tier caps: free 2, paid up to MAX", () => {
    expect(toolCallLimitForTier("free")).toBe(2);
    expect(toolCallLimitForTier("pro")).toBe(MAX_TOOL_CALLS_PER_TURN);
  });
});

describe("research citation guidance", () => {
  it("requires claim-level support from fetched source text", () => {
    const prompt = buildToolUsePrompt();
    expect(prompt).toContain("a citation supports only what the fetched page states");
    expect(prompt).toContain("Split separate claims into separate sentences");
    expect(prompt).toContain("Every cited number must appear in the fetched text");
    expect(prompt).toContain("qualify, omit, or say you could not verify it");
  });
});

describe("search + fetch", () => {
  it("decodes DuckDuckGo redirect links", () => {
    expect(parseDuckDuckGoResults(DDG)).toEqual([{ url: "https://93.184.216.34/nitrogen", title: "Nitrogen deficiency", snippet: "Lower leaves yellow in a V" }]);
  });
  it("numbers only fetched pages as citable sources", async () => {
    const ok = vi.fn()
      .mockResolvedValueOnce(new Response(DDG, { status: 200 }))
      .mockResolvedValueOnce(new Response("<html><title>Nitrogen basics</title><p>Lower leaves yellow in a V.</p></html>", {
        status: 200, headers: { "content-type": "text/html" },
      })) as any;
    const run = await runToolCalls([{ tool: "search", query: "x" }], ok);
    expect(run.sources[0]).toMatchObject({
      id: "S1", title: "Nitrogen basics", url: "https://93.184.216.34/nitrogen",
      snippet: "Nitrogen basics Lower leaves yellow in a V.",
    });
    expect(formatToolResultsForPrompt(run)).toContain("[S1] Nitrogen basics — https://93.184.216.34/nitrogen");
    expect(formatToolResultsForPrompt(run)).toContain("MANDATORY CITATION CONTRACT");
    expect(ok).toHaveBeenCalledTimes(2);

    const inaccessible = vi.fn()
      .mockResolvedValueOnce(new Response(DDG, { status: 200 }))
      .mockResolvedValueOnce(new Response("denied", { status: 403 })) as any;
    const noPage = await runToolCalls([{ tool: "search", query: "x" }], inaccessible);
    expect(noPage.sources).toEqual([]);
    expect(noPage.notes.join(" ")).toMatch(/no fetchable source/);

    const down = vi.fn(async () => { throw new Error("offline"); }) as any;
    const failed = await runToolCalls([{ tool: "search", query: "x" }], down);
    expect(failed.sources).toEqual([]);
    expect(formatToolResultsForPrompt(failed)).toMatch(/could not verify/);
  });
  it("blocks private/SSRF targets", async () => {
    await expect(assertPublicUrl("http://127.0.0.1:5001/api/user")).rejects.toThrow();
    await expect(assertPublicUrl("http://localhost/")).rejects.toThrow();
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertPublicUrl("http://169.254.169.254/latest")).rejects.toThrow();
  });
});

describe("deliverables", () => {
  const text = "Answer here.\n```deliverable\ntitle: Side-dress plan\n---\n## Steps\n1. Scout 15 plants\n2. Tissue test\n```";
  it("extracts and strips the block", () => {
    const { deliverable, cleanContent } = extractDeliverable(text);
    expect(deliverable?.title).toBe("Side-dress plan");
    expect(deliverable?.content).toContain("Scout 15 plants");
    expect(cleanContent).toBe("Answer here.");
  });
  it("creates then revises the same document by title", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ffrt-"));
    let current: any; const saves: any[] = [];
    const store = {
      getCurrentDeliverableFile: async () => current,
      saveDeliverableVersion: async (file: any, req: any) => { saves.push(req); current = { id: saves.length, filename: file.filename, version: saves.length }; return { file: current, created: true }; },
    };
    const a = await saveExpertDeliverable(store, 1, { name: "Soil", role: "Soil Scientist" }, extractDeliverable(text).deliverable!, dir);
    const b = await saveExpertDeliverable(store, 1, { name: "Soil", role: "Soil Scientist" }, extractDeliverable(text).deliverable!, dir);
    expect([a.revised, b.revised]).toEqual([false, true]);
    expect(saves[1]).toMatchObject({ mode: "revise", expectedCurrentFileId: 1, deliverableId: "expert-side-dress-plan" });
    expect(fs.readdirSync(dir)).toHaveLength(2);
  });
});

describe("charts must be sourced", () => {
  const data = [{ week: "Jun 1", rain_in: 1.2 }];
  it("drops fabricated or generic charts", () => {
    expect(validateChartArtifact(JSON.stringify({ type: "line", title: "chart artifact", data, sources: ["farmer"] }), [])).toBeNull();
    expect(validateChartArtifact(JSON.stringify({ type: "line", title: "Rain", data }), [])).toBeNull();
    expect(validateChartArtifact(JSON.stringify({ type: "line", title: "Rain", data, sources: ["https://made.up/x"] }), ["https://real.edu/a"])).toBeNull();
  });
  it("keeps charts whose sources are retrieved URLs, farmer, or weather", () => {
    expect(validateChartArtifact(JSON.stringify({ type: "line", title: "June rain, Ames IA", data, sources: ["https://real.edu/a"] }), ["https://real.edu/a"])?.title).toBe("June rain, Ames IA");
    const { kept, dropped } = filterChartArtifacts([
      { type: "chart", content: JSON.stringify({ title: "Farm yields 2023-25", data, sources: ["farmer"] }) },
      { type: "chart", content: JSON.stringify({ title: "Illustrative", data }) },
      { type: "table", content: "| a |" },
    ], []);
    expect(dropped).toBe(1);
    expect(kept.map(k => k.type)).toEqual(["chart", "table"]);
  });
});

describe("deliverable extraction edge cases (seen live)", () => {
  it("keeps nested tables inside the document and handles a missing closing fence", () => {
    const text = "Intro.\n```deliverable\ntitle: Store vs Sell Checklist\n---\n### Table\n```table\n| a | b |\n|---|---|\n| 1 | 2 |\n```\nEnd of checklist\n---\n";
    const { deliverable, cleanContent } = extractDeliverable(text);
    expect(deliverable?.title).toBe("Store vs Sell Checklist");
    expect(deliverable?.content).toContain("| 1 | 2 |");
    expect(deliverable?.content).toContain("End of checklist");
    expect(cleanContent).toBe("Intro.");
  });
  it("stops at the closing fence and keeps trailing prose", () => {
    const { deliverable, cleanContent } = extractDeliverable("A\n```deliverable\ntitle: Plan\n---\nStep one is to scout fields.\n```\nAfter text");
    expect(deliverable?.content).toBe("Step one is to scout fields.");
    expect(cleanContent).toBe("A\n\nAfter text".replace("\n\n", "\n"));
  });
});

describe("unfenced deliverable (seen live in a revise turn)", () => {
  it("parses a **deliverable** header with a title line and revises by title", () => {
    const text = "**deliverable**\ntitle: Corn Storage vs. Sell‑at‑Harvest Checklist\n---\n# Corn Storage vs. Sell‑at‑Harvest Checklist\n### Drying Cost Section\n1. Points to remove = 20 - 15";
    const { deliverable, cleanContent } = extractDeliverable(text);
    expect(deliverable?.title).toBe("Corn Storage vs. Sell‑at‑Harvest Checklist");
    expect(deliverable?.content).toContain("Drying Cost Section");
    expect(cleanContent).toBe("");
  });
  it("ignores the word deliverable in prose", () => {
    expect(extractDeliverable("The deliverable is ready.\ntitle: nope").deliverable).toBeNull();
  });
});
