import { describe, it, expect } from "vitest";
import { MemStorage } from "../server/storage";

describe("monthly usage storage (MemStorage)", () => {
  it("counts messages and accumulates spend per user per period", async () => {
    const s = new MemStorage();
    expect(await s.getMonthlyUsage(1, "2026-10")).toEqual({ messageCount: 0, aiSpendUsd: 0 });
    expect(await s.incrementMonthlyMessages(1, "2026-10")).toBe(1);
    expect(await s.incrementMonthlyMessages(1, "2026-10")).toBe(2);
    await s.addMonthlyAiSpend(1, "2026-10", 0.5);
    await s.addMonthlyAiSpend(1, "2026-10", 0.25);
    await s.addMonthlyAiSpend(1, "2026-10", -3);
    expect(await s.getMonthlyUsage(1, "2026-10")).toEqual({ messageCount: 2, aiSpendUsd: 0.75 });
    expect(await s.getMonthlyUsage(1, "2026-11")).toEqual({ messageCount: 0, aiSpendUsd: 0 });
    expect(await s.getMonthlyUsage(2, "2026-10")).toEqual({ messageCount: 0, aiSpendUsd: 0 });
  });
});
