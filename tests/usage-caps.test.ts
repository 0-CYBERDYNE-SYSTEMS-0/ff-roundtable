/**
 * Pricing caps (Pro $20): message allowance, house-key model allowlist,
 * monthly AI budget, BYOK exemption, and per-user monthly usage storage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
global.fetch = mockFetch;

const { store } = vi.hoisted(() => ({
  store: {
    getUser: vi.fn(),
    getUserApiKey: vi.fn(),
    getMonthlyUsage: vi.fn(),
    addMonthlyAiSpend: vi.fn(),
  },
}));
vi.mock("../server/storage", () => ({ storage: store }));

import {
  checkMessageAllowance,
  checkHouseKeyCall,
  currentUsagePeriod,
  monthlyAiBudgetUsd,
  isHouseKeyAllowedModel,
  HOUSE_KEY_PAID_MODEL_ALLOWLIST,
  UsageCapError,
  BUDGET_FALLBACK_MODEL,
  EXPERT_REPLY_MAX_TOKENS,
} from "../server/usage-caps";
import { OpenRouterProvider, FREE_MODEL_FALLBACKS } from "../server/ai-providers";
import { REQUESTED_OPENROUTER_MODELS } from "../client/src/lib/openrouter-model-options";

const okResponse = (cost: number) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { role: "assistant", content: "hi" } }], usage: { cost } }),
});

describe("usage caps: pure rules", () => {
  afterEach(() => { delete process.env.PRO_MONTHLY_AI_BUDGET_USD; });

  it("uses UTC calendar-month periods", () => {
    expect(currentUsagePeriod(new Date("2026-10-31T23:59:59Z"))).toBe("2026-10");
    expect(currentUsagePeriod(new Date("2026-11-01T00:00:00Z"))).toBe("2026-11");
  });

  it("allows Free 100 and Pro 1000 messages a month, then denies with upgrade hints", () => {
    expect(checkMessageAllowance("free", 99)).toBeNull();
    expect(checkMessageAllowance("free", 100)).toMatchObject({ status: 402, code: "message_limit_reached", upgradeUrl: "/subscribe" });
    expect(checkMessageAllowance(null, 100)?.status).toBe(402);
    expect(checkMessageAllowance("pro", 999)).toBeNull();
    expect(checkMessageAllowance("pro", 1000)).toMatchObject({ status: 429, code: "message_limit_reached" });
  });

  it("falls back to a free model the app already uses", () => {
    expect(FREE_MODEL_FALLBACKS).toContain(BUDGET_FALLBACK_MODEL);
  });

  it("keeps the server allowlist in sync with the picker's pinned models", () => {
    expect([...HOUSE_KEY_PAID_MODEL_ALLOWLIST].sort()).toEqual(REQUESTED_OPENROUTER_MODELS.map(m => m.id).sort());
    expect(isHouseKeyAllowedModel("z-ai/glm-5.3-flash")).toBe(true);
    expect(isHouseKeyAllowedModel("google/gemma-4-31b-it:free")).toBe(true);
    expect(isHouseKeyAllowedModel("openai/o1-pro")).toBe(false);
  });

  it("budgets Pro at $4 by default, overridable by env; Free has no paid budget", () => {
    expect(monthlyAiBudgetUsd("pro")).toBe(4);
    process.env.PRO_MONTHLY_AI_BUDGET_USD = "5";
    expect(monthlyAiBudgetUsd("pro")).toBe(5);
    expect(monthlyAiBudgetUsd("free")).toBe(0);
  });

  it("gates house-key calls by tier, allowlist and budget", () => {
    expect(checkHouseKeyCall("free", "nvidia/nemotron-3-super-120b-a12b:free", 0)).toBeNull();
    expect(checkHouseKeyCall("free", "z-ai/glm-5.3-flash", 0)?.code).toBe("paid_model_requires_pro");
    expect(checkHouseKeyCall("pro", "z-ai/glm-5.3-flash", 3.99)).toBeNull();
    expect(checkHouseKeyCall("pro", "openai/o1-pro", 0)?.code).toBe("model_requires_own_key");
    expect(checkHouseKeyCall("pro", "z-ai/glm-5.3-flash", 4)?.code).toBe("ai_budget_exhausted");
    expect(checkHouseKeyCall("pro", "google/gemma-4-31b-it:free", 100)).toBeNull();
    expect(checkHouseKeyCall("enterprise", "openai/o1-pro", 1e6)).toBeNull();
  });
});

describe("usage caps: OpenRouterProvider enforcement", () => {
  const messages = [{ role: "user" as const, content: "hello" }];
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENROUTER_API_KEY = "sk-or-house";
    store.getUserApiKey.mockResolvedValue(null);
    store.getMonthlyUsage.mockResolvedValue({ messageCount: 0, aiSpendUsd: 0 });
    store.addMonthlyAiSpend.mockResolvedValue(undefined);
  });

  it("blocks a non-allowlisted model on the house key before any request", async () => {
    store.getUser.mockResolvedValue({ id: 1, tier: "pro" });
    await expect(new OpenRouterProvider(null).chat(messages, "openai/o1-pro", 1)).rejects.toBeInstanceOf(UsageCapError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("falls back to a free model (not an error) once the Pro budget is spent", async () => {
    store.getUser.mockResolvedValue({ id: 1, tier: "pro" });
    store.getMonthlyUsage.mockResolvedValue({ messageCount: 3, aiSpendUsd: 4.01 });
    mockFetch.mockResolvedValue(okResponse(0));
    const res = await new OpenRouterProvider(null).chat(messages, "z-ai/glm-5.3-flash", 1);
    expect(res.message.content).toBe("hi");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe(BUDGET_FALLBACK_MODEL);
    expect(body.model.endsWith(":free")).toBe(true);
    await new Promise(r => setTimeout(r, 10));
    expect(store.addMonthlyAiSpend).not.toHaveBeenCalled();
  });

  it("caps expert replies at the requested max_tokens", async () => {
    store.getUser.mockResolvedValue({ id: 1, tier: "pro" });
    mockFetch.mockResolvedValue(okResponse(0.001));
    await new OpenRouterProvider(null).chat(messages, "z-ai/glm-5.3-flash", 1, false, { maxTokens: EXPERT_REPLY_MAX_TOKENS });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).max_tokens).toBe(1200);
    mockFetch.mockClear();
    await new OpenRouterProvider(null).chat(messages, "z-ai/glm-5.3-flash", 1);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).max_tokens).toBe(4096);
  });

  it("records house-key spend per user per month", async () => {
    store.getUser.mockResolvedValue({ id: 1, tier: "pro" });
    mockFetch.mockResolvedValue(okResponse(0.0123));
    await new OpenRouterProvider(null).chat(messages, "z-ai/glm-5.3-flash", 1);
    await vi.waitFor(() => expect(store.addMonthlyAiSpend).toHaveBeenCalledWith(1, currentUsagePeriod(), 0.0123));
  });

  it("never caps or counts calls made with the user's own key", async () => {
    store.getUserApiKey.mockResolvedValue("sk-or-user");
    mockFetch.mockResolvedValue(okResponse(5));
    await new OpenRouterProvider(null).chat(messages, "openai/o1-pro", 1);
    expect(store.getUser).not.toHaveBeenCalled();
    await new Promise(r => setTimeout(r, 10));
    expect(store.addMonthlyAiSpend).not.toHaveBeenCalled();
  });
});
