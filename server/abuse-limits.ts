import rateLimit from "express-rate-limit";

/** Per-process IP shields; durable per-user AI quotas live in the usage ledger. */
export function createApiIpLimiter(limit = 300) {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    // Stripe delivery/authentication must keep its existing behavior.
    skip: (req) => req.path === "/webhook",
    message: { code: "ip_request_limit", message: "Too many requests from this network. Please wait a minute and try again." },
  });
}

export function createSignupIpLimiter(limit = 5) {
  return rateLimit({
    windowMs: 60 * 60_000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: "signup_rate_limit", message: "Too many signups from this network. Please try again in an hour." },
  });
}
