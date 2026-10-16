import { describe, expect, it } from "vitest";
import { formatLocalDateTime } from "../client/src/lib/format-local-time";

describe("formatLocalDateTime", () => {
  it("does not throw and shows the user's zone (live: 19:28Z must read 12:28 PM PDT, not 5:28 AM)", () => {
    const out = formatLocalDateTime("2026-10-16T19:28:31.368Z", "America/Los_Angeles");
    expect(out).toMatch(/12:28/);
    expect(out).toMatch(/PM/);
    expect(out).toMatch(/PDT|GMT-7/);
  });
});
