import { describe, it, expect } from "vitest";
import { FREE_EXPERT_MODELS, FREE_MODERATOR_MODEL, pacificSpendDay } from "../shared/free-plan";
import { freeModelChain, checkHouseKeyCall } from "../server/usage-caps";
import { isModelAvailableForPlan } from "../client/src/lib/openrouter-model-options";
import { MemStorage } from "../server/storage";
import { ensureFreeVerdictTable } from "../server/free-synthesis";

describe("paid Free trial boundaries", () => {
  it("honors each expert pick, restricts the selector and uses GLM on failure", () => {
    for (const model of FREE_EXPERT_MODELS) {
      expect(freeModelChain(model)[0]).toBe(model);
      expect(freeModelChain(model).at(-1)).toBe(FREE_EXPERT_MODELS[2]);
      expect(isModelAvailableForPlan(model, "free", false)).toBe(true);
      expect(checkHouseKeyCall("free", model, 0)).toBeNull();
    }
    expect(isModelAvailableForPlan(FREE_MODERATOR_MODEL, "free", true)).toBe(false);
    expect(isModelAvailableForPlan("openai/o1-pro", "free", true)).toBe(false);
    expect(checkHouseKeyCall("free", "openai/o1-pro", 0)).not.toBeNull();
    expect(freeModelChain("forged/model")).toEqual([FREE_EXPERT_MODELS[0], FREE_EXPERT_MODELS[2]]);
    expect(freeModelChain("forged/model", true)).toEqual([FREE_MODERATOR_MODEL, FREE_EXPERT_MODELS[0]]);
  });
  it("uses midnight Pacific, including summer/winter and DST changes", () => {
    expect(pacificSpendDay(new Date("2026-10-24T06:59:59Z"))).toBe("2026-10-23");
    expect(pacificSpendDay(new Date("2026-10-24T07:00:00Z"))).toBe("2026-10-24");
    expect(pacificSpendDay(new Date("2026-12-24T07:59:59Z"))).toBe("2026-12-23");
    expect(pacificSpendDay(new Date("2026-12-24T08:00:00Z"))).toBe("2026-12-24");
    expect(pacificSpendDay(new Date("2026-11-01T08:30:00Z"))).toBe("2026-11-01");
    expect(pacificSpendDay(new Date("2026-11-01T09:30:00Z"))).toBe("2026-11-01");
  });
  it("counts first-message roundtables, not followups, while retaining per-minute limits", async () => {
    const store = new MemStorage();
    const now = new Date("2026-10-23T12:00:00Z");
    const results = await Promise.all(Array.from({ length: 10 }, () => store.consumeFreeMessageAllowance(1, now, "conversation:1")));
    expect(results.every(x => x === null)).toBe(true);
    expect((await store.getMonthlyUsage(1, "free:roundtables:2026-10")).messageCount).toBe(1);
    expect(await store.consumeFreeMessageAllowance(1, now, "conversation:2")).toMatchObject({ code: "free_minute_limit" });
    expect(await store.consumeFreeMessageAllowance(1, new Date("2026-10-23T12:01:00Z"), "restart:1:unique")).toBeNull();
    expect((await store.getMonthlyUsage(1, "free:roundtables:2026-10")).messageCount).toBe(2);
  });
  it("adds a real-evidence table if the Moderator omits it, without inventing stances", () => {
    const content = ensureFreeVerdictTable("Conditional on field checks.", {
      Soil: { stance: "conditional", confidence: 3, position: "Test soil | roots" }, Crop: null,
    });
    expect(content).toContain("| Soil | conditional | 3 | Test soil \\| roots |");
    expect(content).toContain("| Crop | none recorded | none recorded | none recorded |");
    expect(ensureFreeVerdictTable(content, {})).toBe(content);
  });
});
