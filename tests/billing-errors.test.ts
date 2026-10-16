import { describe, expect, it, vi } from "vitest";
import { billingErrorResponse, billingUnavailable, BILLING_UNAVAILABLE_MESSAGE } from "../server/billing-errors";

describe("billing error mapping", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  it("never echoes Stripe's raw message (invalid key)", () => {
    const r = billingErrorResponse({ type: "StripeAuthenticationError", statusCode: 401, message: "Invalid API Key provided: sk_test_abc" }, "create-subscription");
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ code: "BILLING_UNAVAILABLE", message: BILLING_UNAVAILABLE_MESSAGE });
    expect(JSON.stringify(r.body)).not.toMatch(/sk_|Invalid API Key/);
  });
  it("maps card errors and unknown errors to safe messages", () => {
    expect(billingErrorResponse({ type: "StripeCardError", message: "raw" }, "x").body.code).toBe("CARD_DECLINED");
    const unknown = billingErrorResponse(new Error("ECONNRESET at 10.0.0.1"), "x");
    expect(unknown.status).toBe(502);
    expect(unknown.body.message).not.toMatch(/ECONNRESET|10\.0/);
  });
  it("missing config is a 503 with a stable code", () => {
    expect(billingUnavailable("no key")).toMatchObject({ status: 503, body: { code: "BILLING_UNAVAILABLE" } });
  });
});
