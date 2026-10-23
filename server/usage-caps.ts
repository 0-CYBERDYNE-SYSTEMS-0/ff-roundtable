/**
 * Pro pricing caps ($10/month or $96/year, $4 monthly AI budget). See PR "pricing-caps-pro20".
 *
 * Definitions:
 * - A "message" is ONE farmer (user) message stored in a conversation,
 *   including answers to open questions and explicit /restart topics.
 *   Expert replies, tool-planning calls, insights and autonomous turns do
 *   NOT count as messages. Pro limits reset each UTC calendar month.
 *   Free counts roundtables (first farmer message and explicit /new runs),
 *   not followups, against its separate monthly ledger.
 * - "AI spend" is the OpenRouter-reported cost (usage.cost) of calls made
 *   with the house OPENROUTER_API_KEY. Calls made with the user's own
 *   (BYOK) key on paid plans never count. Free uses only included house models.
 */
import { getTierLimits } from "./tiers";
import { FREE_ALLOWED_MODELS, FREE_EXPERT_MODELS, FREE_MODERATOR_MODEL, isFreeExpertModel } from "@shared/free-plan";

/** Exact ids pinned in client/src/lib/openrouter-model-options.ts. */
export const HOUSE_KEY_PAID_MODEL_ALLOWLIST = [
  "z-ai/glm-5.3-flash",
  "deepseek/deepseek-v4.1-flash",
  "xiaomi/mimo-v2.6-flash",
  "openai/gpt-6-luna",
] as const;

/** Output cap for ordinary expert replies (documents keep maxOutputTokens()). */
export const EXPERT_REPLY_MAX_TOKENS = 1200;
/** Free expert cap, including reasoning tokens. */
export const FREE_EXPERT_MAX_TOKENS = 2000;
/** Moderator synthesis, insights and other structured/auxiliary calls on Free. */
export const FREE_CAPABLE_MODEL = FREE_MODERATOR_MODEL;
/** Paid trial routes; distinct from Pro's unchanged zero-price budget fallback. */
export function freeModelChain(selected: string, capable = false): string[] {
  return capable
    ? [FREE_MODERATOR_MODEL, FREE_EXPERT_MODELS[0]]
    : Array.from(new Set([isFreeExpertModel(selected) ? selected : FREE_EXPERT_MODELS[0], FREE_EXPERT_MODELS[2]]));
}

/** Catalog-verified zero-price ids; first two also answered live on 2026-10-23. */
export const FREE_MODEL_FALLBACKS = [
  "recursive/flint-v1.0:free",
  "liquid/lfm-2.5-2.6b:free",
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-26b-a4b-it:free",
  "dots-studio/dots-3-note-preview:free",
];
/** Preserve Pro's exhausted-budget zero-price fallback unchanged. */
export const BUDGET_FALLBACK_MODEL = FREE_MODEL_FALLBACKS[0];
export const FREE_MAX_TURNS = 3;
export const FREE_MAX_MESSAGE_CHARS = 4000;
export const FREE_MESSAGES_PER_MINUTE = 10;
export const FREE_MESSAGES_PER_DAY = 25;

/** Reuse the durable usage ledger for atomic, cross-instance Free quotas. */
export function freeQuotaWindows(now = new Date()) {
  return [
    { period: `free:roundtables:${currentUsagePeriod(now)}`, limit: getTierLimits("free").maxMessages, code: "roundtable_limit_reached", reset: "next month" },
    { period: `free:day:${now.toISOString().slice(0, 10)}`, limit: FREE_MESSAGES_PER_DAY, code: "free_daily_limit", reset: "tomorrow (UTC)" },
    { period: `free:minute:${now.toISOString().slice(0, 16)}`, limit: FREE_MESSAGES_PER_MINUTE, code: "free_minute_limit", reset: "the next minute" },
  ];
}

export function freeQuotaDenial(window: ReturnType<typeof freeQuotaWindows>[number]): CapDenial {
  return {
    status: 429,
    code: window.code,
    message: `You've reached your Free plan limit of ${window.limit} ${window.code === "roundtable_limit_reached" ? "roundtables per month" : window.code === "free_minute_limit" ? "messages per minute" : "messages per day"}. Try again ${window.reset}, or upgrade to Pro for higher limits.`,
    upgradeUrl: "/subscribe",
  };
}

export const BUDGET_EXHAUSTED_NOTICE = "You've used this month's included fast models; experts are on free models until the 1st.";

export function isHouseKeyAllowedModel(model: string): boolean {
  return model.endsWith(":free") || (HOUSE_KEY_PAID_MODEL_ALLOWLIST as readonly string[]).includes(model);
}

export function currentUsagePeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Monthly Pro AI budget ($4). Free is governed separately by the global daily cap. */
export function monthlyAiBudgetUsd(tier: string | null | undefined): number {
  const t = tier || "free";
  if (t === "enterprise") return Number.POSITIVE_INFINITY;
  if (t === "pro") {
    const parsed = Number(process.env.PRO_MONTHLY_AI_BUDGET_USD);
    return Number.isFinite(parsed) && parsed >= 0 && process.env.PRO_MONTHLY_AI_BUDGET_USD?.trim() ? parsed : 4;
  }
  return 0;
}

export type CapDenial = { status: 401 | 402 | 429; code: string; message: string; upgradeUrl?: string };

export function checkMessageAllowance(tier: string | null | undefined, usedThisMonth: number): CapDenial | null {
  const limits = getTierLimits(tier || "free");
  if (usedThisMonth < limits.maxMessages) return null;
  const isFree = (tier || "free") === "free";
  return {
    status: isFree ? 402 : 429,
    code: isFree ? "roundtable_limit_reached" : "message_limit_reached",
    message: isFree
      ? `You've used all ${limits.maxMessages} roundtables on the Free plan this month. Upgrade to Pro ($10/month) for ${getTierLimits("pro").maxMessages} messages a month.`
      : `You've used all ${limits.maxMessages} ${limits.name} messages this month. Your limit resets on the 1st, or contact us about Enterprise.`,
    upgradeUrl: isFree ? "/subscribe" : undefined,
  };
}

export class UsageCapError extends Error {
  constructor(public readonly denial: CapDenial) {
    super(denial.message);
    this.name = "UsageCapError";
  }
}

/** Decide whether a house-key call to `model` may run. BYOK calls skip this. */
export function checkHouseKeyCall(tier: string | null | undefined, model: string, spentUsd: number): CapDenial | null {
  const t = tier || "free";
  if (t === "free") {
    return FREE_ALLOWED_MODELS.includes(model) ? null
      : { status: 402, code: "model_not_in_free_allowlist", message: "Choose an included Free model or upgrade to Pro.", upgradeUrl: "/subscribe" };
  }
  if (model.endsWith(":free")) return null;
  if (t === "enterprise") return null;
  if (!isHouseKeyAllowedModel(model)) {
    return {
      status: 402,
      code: "model_requires_own_key",
      message: `${model} isn't included in Pro. Pick an included model (${HOUSE_KEY_PAID_MODEL_ALLOWLIST.join(", ")}) or add your own OpenRouter key in Settings.`,
    };
  }
  const budget = monthlyAiBudgetUsd(t);
  // Budget exhaustion is graceful: callers fall back to BUDGET_FALLBACK_MODEL
  // (see OpenRouterProvider.authorizeCall) instead of erroring.
  if (spentUsd >= budget) {
    return {
      status: 429,
      code: "ai_budget_exhausted",
      message: `You've used this month's included AI budget. Switch experts to free models, add your own OpenRouter key, or wait for the reset on the 1st.`,
    };
  }
  return null;
}
