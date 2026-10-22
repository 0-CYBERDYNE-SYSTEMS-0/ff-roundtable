import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

describe("production Free access without changing login/session behavior", () => {
  let app: express.Express;
  let cookie: string;
  let userId: number;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { setupAuth } = await import("../server/auth");
    app = express();
    app.use(express.json());
    setupAuth(app);
    app.get("/api/protected/check", (_req, res) => res.sendStatus(200));
    const registered = await request(app).post("/api/register")
      .set("X-Forwarded-Proto", "https")
      .send({ username: "production-free-test", email: "production-free-test@example.com", password: "test-only-password" });
    expect(registered.status).toBe(201);
    userId = registered.body.id;
    cookie = registered.headers["set-cookie"][0].split(";")[0];
  });

  afterAll(() => vi.unstubAllEnvs());

  it("allows a newly signed-up Free user through the production API gate", async () => {
    expect((await request(app).get("/api/protected/check").set("Cookie", cookie)).status).toBe(200);
  });

  it("still denies unauthenticated users", async () => {
    expect((await request(app).get("/api/protected/check")).status).toBe(401);
  });

  it("preserves paid-account gates and admits complimentary active Pro", async () => {
    const { storage } = await import("../server/storage");
    await storage.updateUserStripeInfo(userId, { stripeCustomerId: null, tier: "pro", subscriptionStatus: "inactive" });
    expect((await request(app).get("/api/protected/check").set("Cookie", cookie)).status).toBe(403);
    await storage.updateUserStripeInfo(userId, { stripeCustomerId: null, tier: "pro", subscriptionStatus: "active" });
    expect((await request(app).get("/api/protected/check").set("Cookie", cookie)).status).toBe(200);
  });
});
