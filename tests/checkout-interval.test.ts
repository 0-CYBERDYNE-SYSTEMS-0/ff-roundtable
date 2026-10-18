/**
 * Checkout interval: monthly -> STRIPE_PRICE_ID_PRO, annual ->
 * STRIPE_PRICE_ID_PRO_ANNUAL. Clients send an interval, never a price id.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";

process.env.DATABASE_URL = "";
process.env.SESSION_SECRET = "vitest-session-secret";
process.env.NODE_ENV = "test";
process.env.STRIPE_SECRET_KEY = "sk_test_mocked";
process.env.STRIPE_PRICE_ID_PRO = "price_month_mocked";
process.env.STRIPE_PRICE_ID_PRO_ANNUAL = "price_year_mocked";

const { mockCustomerCreate, mockSessionCreate } = vi.hoisted(() => ({
  mockCustomerCreate: vi.fn(),
  mockSessionCreate: vi.fn(),
}));

vi.mock("stripe", () => {
  const MockStripe = vi.fn();
  MockStripe.prototype.customers = { create: mockCustomerCreate };
  MockStripe.prototype.checkout = { sessions: { create: mockSessionCreate } };
  MockStripe.prototype.subscriptions = { create: vi.fn(), retrieve: vi.fn() };
  MockStripe.prototype.webhooks = { constructEvent: vi.fn() };
  return { default: MockStripe };
});

let app: Express;
beforeAll(async () => {
  const { registerRoutes } = await import("../server/routes");
  app = express();
  app.use(express.json());
  await registerRoutes(app);
});

beforeEach(() => {
  mockCustomerCreate.mockReset().mockResolvedValue({ id: "cus_1" });
  mockSessionCreate.mockReset().mockResolvedValue({ url: "https://checkout.stripe.test/s" });
});

async function loggedIn() {
  const agent = request.agent(app);
  const res = await agent.post("/api/login").send({ username: "developer", password: "password" });
  expect(res.status).toBe(200);
  return agent;
}

const pricePassed = () => mockSessionCreate.mock.calls[0][0].line_items[0].price;

describe("POST /api/create-checkout-session interval", () => {
  it("defaults to the monthly Pro price", async () => {
    const res = await (await loggedIn()).post("/api/create-checkout-session").send({});
    expect(res.status).toBe(200);
    expect(pricePassed()).toBe("price_month_mocked");
  });

  it("uses the annual price for interval=year", async () => {
    const res = await (await loggedIn()).post("/api/create-checkout-session").send({ interval: "year" });
    expect(res.status).toBe(200);
    expect(pricePassed()).toBe("price_year_mocked");
  });

  it("rejects unknown intervals and ignores client-supplied price ids", async () => {
    const agent = await loggedIn();
    const bad = await agent.post("/api/create-checkout-session").send({ interval: "week" });
    expect(bad.status).toBe(400);
    expect(mockSessionCreate).not.toHaveBeenCalled();
    const sneaky = await agent.post("/api/create-checkout-session").send({ interval: "month", priceId: "price_attacker" });
    expect(sneaky.status).toBe(200);
    expect(pricePassed()).toBe("price_month_mocked");
  });
});
