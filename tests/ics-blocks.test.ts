import { describe, expect, it } from "vitest";
import { splitIcsBlocks } from "../shared/ics";

const ics = "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:Sow\nDTSTART;VALUE=DATE:20260215\nEND:VEVENT\nBEGIN:VEVENT\nSUMMARY:Plant\nDTSTART;VALUE=DATE:20260420\nEND:VEVENT\nEND:VCALENDAR";

describe("splitIcsBlocks", () => {
  it("collapses a fenced ics block between prose", () => {
    const segs = splitIcsBlocks(`Here you go.\n\n\`\`\`ics\n${ics}\n\`\`\`\n\nEnjoy!`);
    expect(segs.map(s => s.type)).toEqual(["text", "ics", "text"]);
    const block = segs[1] as { ics: string; events: number };
    expect(block.events).toBe(2);
    expect(block.ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(block.ics).not.toContain("```");
    expect(block.ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("collapses a bare ics block", () => {
    const segs = splitIcsBlocks(`Intro\n${ics}\nOutro`);
    expect(segs.map(s => s.type)).toEqual(["text", "ics", "text"]);
  });

  it("leaves prose and incomplete (still streaming) calendars untouched", () => {
    expect(splitIcsBlocks("Plain text")).toEqual([{ type: "text", text: "Plain text" }]);
    const partial = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Sow";
    expect(splitIcsBlocks(partial)).toEqual([{ type: "text", text: partial }]);
  });
});
