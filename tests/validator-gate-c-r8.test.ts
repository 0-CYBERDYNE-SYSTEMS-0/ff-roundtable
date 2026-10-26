import { describe, it, expect } from "vitest";
import { ensureAuthoritativeFrostCitation, FROST_REFERENCE_SOURCES, isAuthoritativeClimateHost } from "../shared/chart-artifact";
import { capEventTitle, finalizeCalendarEvents, planRevisionOf, replyIsWeekPlan, buildInlineCalendarArtifact } from "../shared/schedule-extract";
import { clearUserScopedStorage, resetCacheForSession } from "../client/src/lib/queryClient";
import { sanitizeSha, buildSha, resetBuildShaCache } from "../server/version";

function mem(init: Record<string, string>) {
  const m = new Map(Object.entries(init));
  return { get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), m };
}

describe("B2 frost answers always cite OSU, USDA or NOAA", () => {
  const q = "When is the last spring frost in Eugene?";
  it("Almanac-only reply gets an official NOAA reference appended", () => {
    const r = ensureAuthoritativeFrostCitation("Last frost is about April 10 [S2](https://www.almanac.com/gardening/frostdates/OR/Eugene).", q, [{ title: "Almanac", url: "https://www.almanac.com/x" }]);
    expect(r.addition).toContain(FROST_REFERENCE_SOURCES[0].url);
    const urls = r.content.match(/https?:\/\/[^\s)]+/g) ?? [];
    expect(urls.some(isAuthoritativeClimateHost)).toBe(true);
  });
  it("prefers a fetched authoritative source over the static reference", () => {
    const r = ensureAuthoritativeFrostCitation("About April 10.", q, [{ title: "Frost dates | OSU Extension", url: "https://extension.oregonstate.edu/frost" }]);
    expect(r.addition).toContain("https://extension.oregonstate.edu/frost");
    expect(r.addition).not.toContain("verify local");
  });
  it("no-op when an authoritative link is already cited or the topic is not frost", () => {
    const cited = "See [S1](https://www.weather.gov/pqr/).";
    expect(ensureAuthoritativeFrostCitation(cited, q).addition).toBe("");
    expect(ensureAuthoritativeFrostCitation("Use 20 lb/ac.", "How much rye seed per acre?").addition).toBe("");
  });
  it("every static reference is an authoritative host", () => {
    expect(FROST_REFERENCE_SOURCES.every(s => isAuthoritativeClimateHost(s.url))).toBe(true);
  });
});

describe("B3 Week-1 anchor from turn 1, live field refresh, title cap", () => {
  it("caps titles at 75 chars with an ellipsis", () => {
    const t = "A".repeat(77);
    const c = capEventTitle(t);
    expect(c.length).toBe(75);
    expect(c.endsWith("\u2026")).toBe(true);
    expect(capEventTitle("Short")).toBe("Short");
  });
  it("finalizeCalendarEvents caps every summary", () => {
    const ev = finalizeCalendarEvents([{ summary: "Plant cool-season crops (peas, spinach, radish, lettuce) once soil reaches 40F — Week 3", startDate: "2027-03-20", description: "x" }], undefined);
    expect(ev[0].summary.length).toBeLessThanOrEqual(75);
  });
  it("a week-numbered planting calendar reply counts as a plan on turn 1", () => {
    const reply = "Illustrative: Eugene spring planting calendar (Week numbers; you pick the start date)\n| Week | Task |\n|---|---|\n| W3–W4 | Plant peas |";
    expect(replyIsWeekPlan(reply)).toBe(true);
    expect(replyIsWeekPlan("Frost is around April 10.")).toBe(false);
  });
  it("turn-1 week table gets dated events", () => {
    const table = { type: "table", title: "Planting calendar", content: "| Week | Task |\n|---|---|\n| Week 1 | Soil test |\n| Week 3 | Plant peas |" } as any;
    const cal = buildInlineCalendarArtifact({ artifacts: [table], contextText: "planting calendar", todayIso: "2026-10-26" });
    expect(cal).not.toBeNull();
    const { anchor, events } = JSON.parse(cal!.content);
    expect(anchor).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(events.every((e: any) => /^\d{4}-\d{2}-\d{2}$/.test(e.startDate))).toBe(true);
  });
  it("planRevision changes when a turn adds artifacts", () => {
    const a = planRevisionOf([{ id: 1, artifacts: [] }]);
    const b = planRevisionOf([{ id: 1, artifacts: [] }, { id: 2, artifacts: [{}] }]);
    expect(b).not.toBe(a);
  });
});

describe("B5 logout / account switch clears per-account form state", () => {
  it("removes Week-1 picks and dismissals, keeps layout prefs, clears session storage", () => {
    const ls = mem({ "farmFriendCalendarStart:16": "2027-03-20", ffFarmProfileDismissed: "1", ffLeftSidebarWidth: "300" });
    const ss = mem({ draft: "x" });
    expect(clearUserScopedStorage(ls as any, ss as any)).toBe(2);
    expect([...ls.m.keys()]).toEqual(["ffLeftSidebarWidth"]);
    expect(ss.m.size).toBe(0);
  });
  it("resetCacheForSession still clears the query cache (node: no window)", () => {
    let cleared = false; const set: unknown[] = [];
    resetCacheForSession({ clear: () => { cleared = true; }, setQueryData: (_k, d) => set.push(d) }, null);
    expect(cleared).toBe(true); expect(set).toEqual([null]);
  });
});

describe("/api/version", () => {
  it("only ever returns a short hex sha", () => {
    expect(sanitizeSha("91159aa3f\n")).toBe("91159aa");
    expect(sanitizeSha("sk_live_abc")).toBe("unknown");
    expect(sanitizeSha(undefined)).toBe("unknown");
  });
  it("buildSha reads git once and falls back to unknown", () => {
    const prev = [process.env.BUILD_SHA, process.env.REPLIT_GIT_COMMIT];
    delete process.env.BUILD_SHA; delete process.env.REPLIT_GIT_COMMIT;
    resetBuildShaCache();
    expect(buildSha(() => "abcdef1234")).toBe("abcdef1");
    resetBuildShaCache();
    expect(buildSha(() => { throw new Error("no git"); })).toBe("unknown");
    resetBuildShaCache();
    if (prev[0] !== undefined) process.env.BUILD_SHA = prev[0];
    if (prev[1] !== undefined) process.env.REPLIT_GIT_COMMIT = prev[1];
  });
});
