import { describe, expect, it } from "vitest";
import { normalizeMixedUnitChart } from "../shared/chart-artifact";
import { finalizeCalendarEvents } from "../shared/schedule-extract";
import { buildVCalendar } from "../shared/ics";
import { extractCanonicalFrost } from "../shared/frost-canonical";
import { formatSharedResearchForPrompt, getCanonicalFrost, rememberCanonicalFrost, restoreCanonicalFrost } from "../server/expert-tools";

describe("validator gate C r10", () => {
  it("facets mixed units with independent y scales and leaves one unit alone", () => {
    const spec = { mark: "bar", encoding: { x: { field: "crop", type: "nominal" }, y: { field: "value", type: "quantitative" } } };
    const mixed = normalizeMixedUnitChart({ data: [{ crop: "hay", value: 2, unit: "tons/ac" }, { crop: "blueberry", value: 400, unit: "lb/ac" }], spec });
    expect(mixed.spec.facet || (mixed.spec as any).encoding?.row || (mixed.spec as any).encoding?.column).toBeTruthy();
    expect((mixed.spec as any).resolve.scale.y).toBe("independent");
    const single = normalizeMixedUnitChart({ data: [{ crop: "hay", value: 2, unit: "tons/ac" }, { crop: "straw", value: 3, unit: "tons/ac" }], spec });
    expect(single.spec).toBe(spec);
  });

  it("dates stale approximate calendar labels from the anchored event date", () => {
    const events = finalizeCalendarEvents([{ summary: "Plant berries ~early Feb — Week 1", startDate: "2027-04-15", description: "x" }], undefined);
    expect(events[0].summary).toContain("Apr 15");
    expect(events[0].summary).not.toContain("Feb");
  });

  it("caps ICS summaries with an ellipsis", () => {
    const ics = buildVCalendar([{ uid: "1", summary: "A".repeat(90), startDate: "2027-01-01" }], "Farm");
    const summary = (ics.replace(/\r\n /g, "").match(/SUMMARY:([^\r\n]+)/)?.[1] ?? "");
    expect(summary.length).toBeLessThanOrEqual(75);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("extracts and stores only the first authoritative frost value", () => {
    const source = { title: "NOAA climate normals", url: "https://www.weather.gov/pqr" };
    const first = "The last spring frost for Eugene is May 15 at 36°F. [S1](https://www.weather.gov/pqr)";
    const second = "The last spring frost for Eugene is May 20 at 36°F. [S1](https://www.weather.gov/pqr)";
    expect(extractCanonicalFrost(first, [source])).toMatchObject({ location: "Eugene", lastFrost: "May 15", threshold: "36°F", sourceUrl: source.url });
    rememberCanonicalFrost(9910, first, [{ id: "S1", ...source, snippet: "" }]);
    rememberCanonicalFrost(9910, second, [{ id: "S1", ...source, snippet: "" }]);
    expect(getCanonicalFrost(9910)[0].lastFrost).toBe("May 15");
    expect(rememberCanonicalFrost(9911, "Last spring frost for Eugene is May 15. https://www.almanac.com/frost", [{ id: "S1", title: "Almanac", url: "https://www.almanac.com/frost", snippet: "" }])).toBeNull();
  });

  it("rebuilds the canonical frost value from the conversation after a restart", () => {
    const reply = "The last spring frost for Eugene is May 15 at 36°F. Sources: https://www.weather.gov/pqr";
    expect(getCanonicalFrost(9920)).toEqual([]);
    restoreCanonicalFrost(9920, [{ role: "user", content: "When is the last frost?" }, { role: "assistant", content: reply }, { role: "assistant", content: reply.replace("May 15", "May 20") }]);
    expect(getCanonicalFrost(9920)).toHaveLength(1);
    expect(getCanonicalFrost(9920)[0]).toMatchObject({ location: "Eugene", lastFrost: "May 15" });
  });

  it("puts the canonical value in the expert prompt", () => {
    const line = formatSharedResearchForPrompt([], [], [{ location: "Eugene", lastFrost: "May 15", threshold: "36°F", sourceUrl: "https://www.weather.gov/pqr", sourceTitle: "NOAA" }]);
    expect(line).toContain("CANONICAL FROST");
    expect(line).toContain("May 15");
  });

  it("mixed units in category labels (Hay (tons/ac) vs Blueberry (lb/ac)) never share one y axis", () => {
    const spec = { mark: "bar", encoding: { x: { field: "crop", type: "nominal" }, y: { field: "yield", type: "quantitative" } } };
    const data = [{ crop: "Hay (tons/ac)", yield: 3 }, { crop: "Blueberry (lb/ac)", yield: 9000 }];
    const out = normalizeMixedUnitChart({ data, spec }) as any;
    expect(out.spec.facet).toBeTruthy();
    expect(out.spec.resolve.scale.y).toBe("independent");
    expect((data[0] as any).__ff_unit).toBeUndefined();
  });
});
