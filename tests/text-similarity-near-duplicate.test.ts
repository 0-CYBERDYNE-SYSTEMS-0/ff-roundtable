import { describe, expect, it } from "vitest";
import { isNearDuplicate } from "../server/text-similarity";

describe("isNearDuplicate", () => {
  it("returns true for a matching prior expert message", () => {
    expect(isNearDuplicate(
      "The soil is dry and needs irrigation today.",
      ["The soil is dry and needs irrigation today."],
    )).toBe(true);
  });

  it("uses an inclusive default threshold of 0.6", () => {
    const original = "one two three four five six";
    const exactlySixtyPercentSimilar = "one two three four five seven";
    expect(isNearDuplicate(exactlySixtyPercentSimilar, [original])).toBe(true);
    expect(isNearDuplicate(exactlySixtyPercentSimilar, [original], 0.61)).toBe(false);
  });

  it("returns false when no prior expert message is sufficiently similar", () => {
    expect(isNearDuplicate("Test soil pH before adding lime.", ["Check field drainage after rainfall."])).toBe(false);
    expect(isNearDuplicate("Anything new?", [])).toBe(false);
  });
});
