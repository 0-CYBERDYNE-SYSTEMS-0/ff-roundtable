import { describe, it, expect, vi, beforeEach } from "vitest";
const { query, release } = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock("../server/database-pool", () => ({
  getDatabasePool: () => ({ query, connect: async () => ({ query, release }) }),
}));
import { assertFreeCapacity, reserveFreeCall, settleFreeCall, sweepStaleFreeReservations, startFreeReservationSweep } from "../server/free-capacity";

describe("durable global Free spend ledger", () => {
  beforeEach(() => {
    query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    release.mockClear();
  });
  it("reserves atomically with a $5 conditional update before recording a pending call", async () => {
    query.mockImplementation(async (sql: string) => ({ rows: [], rowCount: sql.startsWith("UPDATE free_spend_days") ? 1 : 0 }));
    await reserveFreeCall("attempt-1", 1, "anthropic/claude-haiku-5.5");
    expect(query.mock.calls[0][0]).toBe("BEGIN");
    const update = query.mock.calls.find(c => c[0].startsWith("UPDATE free_spend_days"))!;
    expect(update[0]).toContain("charged_usd + $2 <= $3");
    expect(update[1].slice(1)).toEqual([0.1, 5]);
    expect(query.mock.calls.at(-1)![0]).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });
  it("rolls back and gives the upgrade hint when concurrent reservations use the capacity", async () => {
    await expect(reserveFreeCall("attempt-2", 1, "model")).rejects.toMatchObject({
      denial: { code: "free_capacity_used", upgradeUrl: "/subscribe" },
    });
    expect(query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
    expect(query.mock.calls.some(c => c[0].startsWith("INSERT INTO free_ai_calls"))).toBe(false);
  });
  it("fails closed when the ledger is unreachable", async () => {
    query.mockRejectedValue(new Error("database unavailable"));
    await expect(assertFreeCapacity()).rejects.toThrow("database unavailable");
  });
  it("settles the real cost, model, generation ID and reasoning tokens exactly once", async () => {
    query.mockImplementation(async (sql: string) => ({
      rows: sql.startsWith("UPDATE free_ai_calls") ? [{ day: "2026-10-23", reserved_usd: 0.1 }] : [], rowCount: 1,
    }));
    await settleFreeCall("attempt-3", "success", {
      cost: 0.002, prompt_tokens: 100, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 50 },
    }, { generationId: "gen-1", responseModel: "actual/model" });
    const call = query.mock.calls.find(c => c[0].startsWith("UPDATE free_ai_calls"))!;
    expect(call[0]).toContain("result IN ('pending', 'expired')");
    expect(call[1]).toEqual(["attempt-3", "success", 0.002, "actual/model", "gen-1", 100, 200, 50]);
    const day = query.mock.calls.find(c => c[0].startsWith("UPDATE free_spend_days"))!;
    expect(day[1][1]).toBeCloseTo(-0.098);
  });
  it("never refunds an unknown-cost timeout or error", async () => {
    query.mockImplementation(async (sql: string) => ({
      rows: sql.startsWith("UPDATE free_ai_calls") ? [{ day: "2026-10-23", reserved_usd: 0.1 }] : [], rowCount: 1,
    }));
    await settleFreeCall("attempt-4", "success", undefined, {});
    expect(query.mock.calls.some(c => c[0].startsWith("UPDATE free_spend_days"))).toBe(false);
  });
  it("does not settle twice when the call is already finalized", async () => {
    await settleFreeCall("attempt-5", "success", { cost: 0.001 }, {});
    expect(query.mock.calls.some(c => c[0].startsWith("UPDATE free_spend_days"))).toBe(false);
  });
  it.each(["402", "429", "timeout", "other error"])("releases unknown-cost failures (%s) and marks the reservation released", async () => {
    query.mockImplementation(async (sql: string) => ({
      rows: sql.startsWith("UPDATE free_ai_calls") ? [{ day: "2026-10-23", reserved_usd: 0.1 }] : [], rowCount: 1,
    }));
    await settleFreeCall("failed-attempt", "failed", undefined, {});
    expect(query.mock.calls.find(c => c[0].startsWith("UPDATE free_spend_days"))?.[1]).toEqual(["2026-10-23", -0.1]);
    expect(query.mock.calls.some(c => c[0] === "UPDATE free_ai_calls SET reserved_usd=0 WHERE id=$1")).toBe(true);
  });
  it("releases the reservation but still accounts for a real provider-reported charge on failure", async () => {
    query.mockImplementation(async (sql: string) => ({
      rows: sql.startsWith("UPDATE free_ai_calls") ? [{ day: "2026-10-23", reserved_usd: 0.1 }] : [], rowCount: 1,
    }));
    await settleFreeCall("charged-failure", "failed", { cost: 0.002 }, {});
    expect(query.mock.calls.find(c => c[0].startsWith("UPDATE free_spend_days"))?.[1][1]).toBeCloseTo(-0.098);
  });
  it("preflights the capacity before roundtable quota is consumed", async () => {
    query.mockResolvedValue({ rows: [{ charged_usd: 5 }], rowCount: 1 });
    await expect(assertFreeCapacity()).rejects.toMatchObject({ denial: { code: "free_capacity_used" } });
    query.mockResolvedValue({ rows: [{ charged_usd: 4.8 }], rowCount: 1 });
    await expect(assertFreeCapacity()).resolves.toBeUndefined();
  });
  it("atomically expires only old pending or failed unknown-cost reservations across days", async () => {
    query.mockResolvedValue({ rows: [{ released_count: 3 }] });
    expect(await sweepStaleFreeReservations()).toBe(3);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain("INTERVAL '10 minutes'");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("result = 'pending' OR (result = 'failed' AND cost_usd IS NULL)");
    expect(sql).toContain("reserved_usd = 0");
    expect(sql).toContain("THEN 'expired'");
    expect(sql).toContain("SUM(reserved_usd)");
    expect(sql).toContain("days.charged_usd - totals.refund");
    expect(query).toHaveBeenCalledOnce();
  });
  it("runs at startup and every minute, and stops on shutdown", async () => {
    vi.useFakeTimers();
    try {
      const stop = startFreeReservationSweep();
      await vi.advanceTimersByTimeAsync(0);
      expect(query).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(query).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(query).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it("counts late real costs after expiry without refunding the reservation twice", async () => {
    query.mockImplementation(async (sql: string) => ({
      rows: sql.startsWith("UPDATE free_ai_calls") ? [{ day: "2026-10-23", reserved_usd: 0 }] : [],
    }));
    await settleFreeCall("expired-call", "success", { cost: 0.002 }, {});
    expect(query.mock.calls.find(c => c[0].startsWith("UPDATE free_spend_days"))?.[1]).toEqual(["2026-10-23", 0.002]);
  });
});
