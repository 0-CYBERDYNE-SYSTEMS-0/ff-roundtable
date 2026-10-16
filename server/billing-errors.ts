/**
 * Billing errors shown to farmers must never echo Stripe's raw messages
 * (they can include key prefixes, request ids and config details).
 * The full error goes to the server log; the client gets a stable code.
 */
export type BillingErrorBody = { code: string; message: string };

export const BILLING_UNAVAILABLE_MESSAGE =
  "Subscriptions are temporarily unavailable. You can keep using the free plan; please try again later.";

export function billingUnavailable(reason: string): { status: number; body: BillingErrorBody } {
  console.error(`[billing] unavailable: ${reason}`);
  return { status: 503, body: { code: "BILLING_UNAVAILABLE", message: BILLING_UNAVAILABLE_MESSAGE } };
}

export function billingErrorResponse(error: unknown, context: string): { status: number; body: BillingErrorBody } {
  const err = error as { type?: string; code?: string; statusCode?: number; message?: string } | undefined;
  console.error(`[billing] ${context} failed: type=${err?.type ?? "unknown"} code=${err?.code ?? "-"} status=${err?.statusCode ?? "-"} ${err?.message ?? String(error)}`);
  if (err?.type === "StripeAuthenticationError" || err?.type === "StripePermissionError" || err?.statusCode === 401) {
    return billingUnavailable(`${context}: Stripe rejected the configured secret key`);
  }
  if (err?.type === "StripeCardError") {
    return { status: 402, body: { code: "CARD_DECLINED", message: "Your card was declined. Please try a different payment method." } };
  }
  return { status: 502, body: { code: "BILLING_ERROR", message: "We couldn't reach the payment service. Please try again in a few minutes." } };
}
