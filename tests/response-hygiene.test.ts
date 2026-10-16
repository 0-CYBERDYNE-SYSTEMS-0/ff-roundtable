import { describe, expect, it } from "vitest";
import { enforceCitationIntegrity, stripMetaLines, mergeDuplicateFarmerQuestions, questionsOverlap } from "../server/response-hygiene";
import { parseTrailingStanceLine } from "../server/ai";

describe("citation integrity", () => {
  const src = [{ id: "S1", url: "https://crops.extension.iastate.edu/a" }, { id: "S2", url: "https://www.ers.usda.gov/b" }];
  it("keeps markers retrieved this turn and strips invented ones (live case: [S9] with 0 sources)", () => {
    const r = enforceCitationIntegrity("Drying costs [S9] vary; basis trends (S1) and S2/S4 matter [S1, S7].", src, []);
    expect(r.content).toBe("Drying costs vary; basis trends (S1) and S2/ matter [S1].".replace("S2/ ", "S2 "));
    expect(r.content).not.toMatch(/S9|S7|S4/);
    expect(r.removedMarkers).toBe(3);
  });
  it("strips every marker when nothing was retrieved", () => {
    expect(enforceCitationIntegrity("See [S1] and S3.", [], []).content).toBe("See and.".replace("and.", "and."));
    expect(enforceCitationIntegrity("See [S1] and S3.", [], []).content).not.toMatch(/S\d/);
  });
  it("unlinks fabricated URLs but keeps retrieved or earlier-conversation URLs", () => {
    const prior = ["Farmer: my co-op posts bids at https://coop.example.com/bids"];
    const r = enforceCitationIntegrity("Per [ISU](https://crops.extension.iastate.edu/a/), [fake](https://made.up/x), https://coop.example.com/bids and https://ghost.example/q.", src, prior);
    expect(r.content).toContain("[ISU](https://crops.extension.iastate.edu/a/)");
    expect(r.content).toContain("https://coop.example.com/bids");
    expect(r.content).toContain("fake");
    expect(r.content).not.toMatch(/made\.up|ghost\.example/);
    expect(r.removedUrls).toBe(2);
  });
  it("does not touch words like 'S10 rule' unless they are source markers", () => {
    expect(enforceCitationIntegrity("Use SS304 steel and S1.", src, []).content).toBe("Use SS304 steel and S1.");
  });
});

describe("metadata never leaks", () => {
  it.each([
    "**STANCE: agree | 5 | Good plan**",
    "> STANCE: disagree | 3 | No",
    "- _stance:_ conditional | 4 | Depends",
    "`STANCE: abstain | 1 | n/a`",
    "### STANCE: agree | 2 | ok",
    "SEARCH: corn basis Iowa",
    "FETCH: https://example.edu",
  ])("strips %s anywhere in the message", (meta) => {
    const r = stripMetaLines(`Answer first.\n${meta}\n\n📄 Created deliverable **X**`);
    expect(r.content).toBe("Answer first.\n\n📄 Created deliverable **X**");
  });
  it("returns the stance from a decorated line", () => {
    expect(stripMetaLines("Body\n**STANCE: agree | 5 | Good**").stanceLine).toBe("STANCE: agree | 5 | Good");
  });
  it("trailing parser accepts markdown-decorated stance lines", () => {
    const r = parseTrailingStanceLine("Body\n**STANCE: agree | 5 | The checklist works.**");
    expect(r.content.trim()).toBe("Body");
    expect(r.stance).toEqual({ stance: "agree", confidence: 5, position: "The checklist works." });
  });
});

describe("overlapping farmer questions", () => {
  const commodity = "Farmer question: What is the cash price per bushel you are being offered for corn at harvest, and what is the current December corn futures price?\nAssuming a $0.40 under basis.";
  it("detects reworded overlaps, not distinct questions", () => {
    expect(questionsOverlap("What cash price per bushel is your elevator offering for corn at harvest, and the December futures price?", "What is the cash price per bushel you are being offered for corn at harvest, and what is the current December corn futures price?")).toBe(true);
    expect(questionsOverlap("How many bushels of on-farm storage do you have?", "What is the December corn futures price?")).toBe(false);
  });
  it("live case: Farm Finance repeats Commodity's question -> merged pointer, assumption dropped", () => {
    const finance = "Intro.\n**Farmer question:** What cash price per bushel is your elevator offering for corn at harvest, and the December futures price?\nAssuming $4.10 cash.\nChecklist follows.";
    const r = mergeDuplicateFarmerQuestions(finance, [{ role: "Commodity Marketing Advisor", content: commodity }]);
    expect(r.merged).toBe(1);
    expect(r.content).toBe("Intro.\n_(I need the same information the Commodity Marketing Advisor asked for above.)_\nChecklist follows.");
  });
  it("keeps a new question", () => {
    const r = mergeDuplicateFarmerQuestions("Farmer question: What moisture is the corn at harvest?", [{ role: "Commodity Marketing Advisor", content: commodity }]);
    expect(r.merged).toBe(0);
  });
});

import { TrailingStanceStreamFilter } from "../server/ai";
describe("stream filter withholds decorated STANCE lines", () => {
  const run = (chunks: string[]) => { let out = ""; const f = new TrailingStanceStreamFilter(t => { out += t; }); chunks.forEach(c => f.push(c)); f.finish(); return out; };
  it.each([["**STANCE: agree | 5 | ok**"], ["> STANCE: disagree | 2 | no"], ["- stance: abstain | 1 | n/a"]])("hides %s while streaming", (line) => {
    const out = run(["Answer body.\n", line.slice(0, 5), line.slice(5), "\n"]);
    expect(out).toBe("Answer body.\n");
  });
  it("still streams ordinary bold and bullet lines", () => {
    expect(run(["Intro\n", "**Key point:** water", "\n- Step one\n"])).toBe("Intro\n**Key point:** water\n- Step one\n");
  });
});
