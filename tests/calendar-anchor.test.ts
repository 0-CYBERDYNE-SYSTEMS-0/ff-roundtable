import { describe, expect, it } from "vitest";
import { firstDatedScheduleAnchor, readCalendarStartOverride } from "../shared/calendar-anchor";

describe("calendar plan anchor precedence", () => {
  it("uses the earliest dated event and preserves its explicit year", () => {
    expect(firstDatedScheduleAnchor([
      { date: "2026-04-02" },
      { date: "2026-03-26" },
      { weekIndex: 1 },
    ])).toBe("2026-03-26");
  });

  it("does not use a conversation-wide date or legacy localStorage value as a plan edit", () => {
    expect(readCalendarStartOverride("2027-05-07", "current-plan")).toBeNull();
    expect(readCalendarStartOverride(JSON.stringify({ startDate: "2027-05-07", planKey: "old-plan" }), "current-plan")).toBeNull();
  });

  it("restores a saved date only for the plan it was edited on", () => {
    expect(readCalendarStartOverride(JSON.stringify({ startDate: "2026-04-15", planKey: "current-plan" }), "current-plan"))
      .toBe("2026-04-15");
    expect(readCalendarStartOverride(JSON.stringify({ startDate: "2026-02-30", planKey: "current-plan" }), "current-plan"))
      .toBeNull();
  });
});
