import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { MemStorage } from "../server/storage";
import { createApiIpLimiter, createSignupIpLimiter } from "../server/abuse-limits";
import { freeQuotaWindows } from "../server/usage-caps";

describe("durable Free message admission", () => {
  it("atomically accepts only 10 of 20 concurrent requests", async () => {
    const store = new MemStorage();
    const now = new Date("2026-10-22T10:00:00Z");
    const results = await Promise.all(Array.from({ length: 20 }, () => store.consumeFreeMessageAllowance(10, now)));
    expect(results.filter(result => result === null)).toHaveLength(10);
    expect(results.filter(result => result?.code === "free_minute_limit")).toHaveLength(10);
    expect((await store.getMonthlyUsage(10, "free:roundtables:2026-10")).messageCount).toBe(10);
  });

  it("enforces 25 daily messages across minute windows and resets at UTC midnight", async () => {
    const store = new MemStorage();
    for (let i = 0; i < 25; i++) {
      expect(await store.consumeFreeMessageAllowance(10, new Date(`2026-10-22T10:${String(i).padStart(2, "0")}:00Z`))).toBeNull();
    }
    expect(await store.consumeFreeMessageAllowance(10, new Date("2026-10-22T11:00:00Z"))).toMatchObject({
      status: 429, code: "free_daily_limit", upgradeUrl: "/subscribe",
    });
    expect(await store.consumeFreeMessageAllowance(10, new Date("2026-10-23T00:00:00Z"))).toBeNull();
    expect((await store.getMonthlyUsage(10, "free:roundtables:2026-10")).messageCount).toBe(26);
  });

  it("enforces 30 roundtables across days and resets each month", async () => {
    const store = new MemStorage();
    for (let i = 0; i < 30; i++) {
      const now = new Date(Date.UTC(2026, 9, 1 + Math.floor(i / 25), 10, i % 25));
      expect(await store.consumeFreeMessageAllowance(10, now)).toBeNull();
    }
    expect(await store.consumeFreeMessageAllowance(10, new Date("2026-10-10T10:00:00Z"))).toMatchObject({ code: "roundtable_limit_reached" });
    expect(await store.consumeFreeMessageAllowance(10, new Date("2026-11-01T00:00:00Z"))).toBeNull();
    expect(await store.consumeFreeMessageAllowance(11, new Date("2026-10-10T10:00:00Z"))).toBeNull();
  });

  it("does not admit a fourth expert even with parallel requests", async () => {
    const store = new MemStorage();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => store.createExpertWithinLimit({
      conversationId: 999, name: `Expert ${i}`, role: `Role ${i}`, model: "test:free",
    }, 3)));
    expect(results.filter(Boolean)).toHaveLength(3);
  });

  it("uses distinct UTC month/day/minute keys", () => {
    expect(freeQuotaWindows(new Date("2026-11-01T00:00:00Z")).map(window => window.period)).toEqual([
      "free:roundtables:2026-11", "free:day:2026-11-01", "free:minute:2026-11-01T00:00",
    ]);
  });
});

describe("IP abuse shields", () => {
  it("throttles signup attempts with a friendly response", async () => {
    const app = express();
    app.post("/api/register", createSignupIpLimiter(2), (_req, res) => res.sendStatus(201));
    expect((await request(app).post("/api/register")).status).toBe(201);
    expect((await request(app).post("/api/register")).status).toBe(201);
    const denied = await request(app).post("/api/register");
    expect(denied.status).toBe(429);
    expect(denied.body.code).toBe("signup_rate_limit");
    expect(denied.headers["retry-after"]).toBeDefined();
  });

  it("throttles API traffic without throttling the Stripe webhook", async () => {
    const app = express();
    app.use("/api", createApiIpLimiter(1));
    app.get("/api/test", (_req, res) => res.sendStatus(200));
    app.post("/api/webhook", (_req, res) => res.sendStatus(200));
    expect((await request(app).get("/api/test")).status).toBe(200);
    expect((await request(app).get("/api/test")).status).toBe(429);
    expect((await request(app).post("/api/webhook")).status).toBe(200);
  });
});
