/**
 * Pro $20 pricing caps (see /docs or PR "pricing-caps-pro20").
 *
 * Definitions:
 * - A "message" is ONE farmer (user) message stored in a conversation,
 *   including answers to open questions and explicit /restart topics.
 *   Expert replies, tool-planning calls, insights and autonomous turns do
 *   NOT count as messages. Limits reset each UTC calendar month.
 * - "AI spend" is the OpenRouter-reported cost (usage.cost) of calls made
 *   with the house OPENROUTER_API_KEY. Calls made with the user's own
 *   (BYOK) key never count and are never blocked by budget or allowlist.
 */
import { getTierLimits } from "./tiers";

/** Exact ids pinned in client/src/lib/openrouter-model-options.ts. */
export const HOUSE_KEY_PAID_MODEL_ALLOWLIST = [
  "z-ai/glm-5.3-flash",
  "deepseek/deepseek-v4.1-flash",
  "xiaomi/mimo-v2.6-flash",
  "openai/gpt-6-luna",
] as const;

export function isHouseKeyAllowedModel(model: string): boolean {
  return model.endsWith(":free") || (HOUSE_KEY_PAID_MODEL_ALLOWLIST as readonly string[]).includes(model);
}

export function currentUsagePeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Monthly house-key AI budget in USD by tier. Free is $0 (free models only). */
export function monthlyAiBudgetUsd(tier: string | null | undefined): number {
  const t = tier || "free";
  if (t === "enterprise") return Number.POSITIVE_INFINITY;
  if (t === "pro") {
    const parsed = Number(process.env.PRO_MONTHLY_AI_BUDGET_USD);
    return Number.isFinite(parsed) && parsed >= 0 && process.env.PRO_MONTHLY_AI_BUDGET_USD?.trim() ? parsed : 8;
  }
  return 0;
}

export type CapDenial = { status: 402 | 429; code: string; message: string; upgradeUrl?: string };

export function checkMessageAllowance(tier: string | null | undefined, usedThisMonth: number): CapDenial | null {
  const limits = getTierLimits(tier || "free");
  if (usedThisMonth < limits.maxMessages) return null;
  const isFree = (tier || "free") === "free";
  return {
    status: isFree ? 402 : 429,
    code: "message_limit_reached",
    message: isFree
      ? `You've used all ${limits.maxMessages} messages on the Free plan this month. Upgrade to Pro ($20/month) for ${getTierLimits("pro").maxMessages} messages a month.`
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
  if (model.endsWith(":free")) return null;
  if (t === "enterprise") return null;
  if (t === "free") {
    return { status: 402, code: "paid_model_requires_pro", message: "Upgrade to Pro for paid models.", upgradeUrl: "/subscribe" };
  }
  if (!isHouseKeyAllowedModel(model)) {
    return {
      status: 402,
      code: "model_requires_own_key",
      message: `${model} isn't included in Pro. Pick an included model (${HOUSE_KEY_PAID_MODEL_ALLOWLIST.join(", ")}) or add your own OpenRouter key in Settings.`,
    };
  }
  const budget = monthlyAiBudgetUsd(t);
  if (spentUsd >= budget) {
    return {
      status: 429,
      code: "ai_budget_exhausted",
      message: `You've used this month's included AI budget. Switch experts to free models, add your own OpenRouter key, or wait for the reset on the 1st.`,
    };
  }
  return null;
}
