import { describe, expect, it } from "vitest";
import { parseModelJson } from "../server/model-json";
import { hasVisibleText } from "../server/ai-providers";

describe("parseModelJson", () => {
  it("parses plain, fenced and prose-wrapped JSON", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseModelJson('```json\n{"title":"T","points":["x"]}\n```')).toEqual({ title: "T", points: ["x"] });
    expect(parseModelJson('Here you go:\n{"a":[1,2,],}\nThanks')).toEqual({ a: [1, 2] });
  });
  it("recovers truncated JSON", () => {
    expect(parseModelJson('{"title":"T","points":["one","tw')).toEqual({ title: "T", points: ["one"] });
    expect(parseModelJson('```json\n{"title":"T","points":["one",')).toEqual({ title: "T", points: ["one"] });
  });
  it("returns null for nothing usable", () => {
    expect(parseModelJson("")).toBeNull();
    expect(parseModelJson("no json here")).toBeNull();
    expect(parseModelJson(null)).toBeNull();
  });
});

describe("hasVisibleText", () => {
  it("treats empty, whitespace and bare STANCE lines as invisible", () => {
    expect(hasVisibleText(null)).toBe(false);
    expect(hasVisibleText("  \n ")).toBe(false);
    expect(hasVisibleText("**STANCE: agree | 4 | ok**")).toBe(false);
    expect(hasVisibleText("Check nitrogen first.\nSTANCE: agree | 4 | ok")).toBe(true);
  });
});
