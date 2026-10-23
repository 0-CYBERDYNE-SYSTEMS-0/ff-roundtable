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
  FREE_EXPERT_MAX_TOKENS,
  FREE_CAPABLE_MODEL,
  FREE_RETRY_CHAIN,
} from "../server/usage-caps";
import { OpenRouterProvider, FREE_MODEL_FALLBACKS, FREE_TRUNCATION_NOTE } from "../server/ai-providers";
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

  it("pins Free house-key calls to a zero-price model, short low-reasoning replies and no paid web plugin", async () => {
    store.getUser.mockResolvedValue({ id: 1, tier: "free" });
    mockFetch.mockResolvedValue(okResponse(0));
    await new OpenRouterProvider(null).chat(messages, "openai/o1-pro", 1, true);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe(BUDGET_FALLBACK_MODEL);
    expect(body.max_tokens).toBe(FREE_EXPERT_MAX_TOKENS);
    expect(body.provider.max_price).toEqual({ prompt: 0, completion: 0 });
    expect(body.reasoning).toEqual({ effort: "low", exclude: true });
    expect(body.plugins).toBeUndefined();
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
    expect(body.models).toEqual(FREE_MODEL_FALLBACKS.slice(0, 3));
    await new Promise(r => setTimeout(r, 10));
    expect(store.addMonthlyAiSpend).not.toHaveBeenCalled();
  });

  it("gives Free auxiliary calls 6000 tokens while preserving zero-price fallback routing", async () => {
    store.getUser.mockResolvedValue({ id: 1, tier: "free" });
    mockFetch.mockResolvedValue(okResponse(0));
    await new OpenRouterProvider(null).chat(messages, "paid/model", 1, false, { purpose: "auxiliary" });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(6000);
    expect(body.model).toBe(FREE_CAPABLE_MODEL);
    expect(body.models).toBeUndefined();
    expect(body.provider.max_price).toEqual({ prompt: 0, completion: 0 });
  });

  it("honors the expert's own :free pick on Free", async () => {
    store.getUser.mockResolvedValue({ id: 1, tier: "free" });
    mockFetch.mockResolvedValue(okResponse(0));
    await new OpenRouterProvider(null).chat(messages, "nvidia/nemotron-3-super-120b-a12b:free", 1, false, { maxTokens: EXPERT_REPLY_MAX_TOKENS });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe("nvidia/nemotron-3-super-120b-a12b:free");
    expect(body.max_tokens).toBe(FREE_EXPERT_MAX_TOKENS);
    expect(body.provider.max_price).toEqual({ prompt: 0, completion: 0 });
  });

  it("routes the Moderator (capable) to the strongest free model", async () => {
    store.getUser.mockResolvedValue({ id: 1, tier: "free" });
    mockFetch.mockResolvedValue(okResponse(0));
    await new OpenRouterProvider(null).chat(messages, "recursive/flint-v1.0:free", 1, false, { capable: true });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).model).toBe(FREE_CAPABLE_MODEL);
  });

  it("falls back to the next free model when the pick errors", async () => {
    store.getUser.mockResolvedValue({ id: 1, tier: "free" });
    mockFetch
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(okResponse(0));
    const res = await new OpenRouterProvider(null).chat(messages, "google/gemma-4-26b-a4b-it:free", 1);
    expect(res.message.content).toBe("hi");
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).model).toBe("google/gemma-4-26b-a4b-it:free");
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).model).toBe(FREE_RETRY_CHAIN[0]);
  });

  it("returns Free partial text with a truncation note instead of throwing", async () => {
    store.getUser.mockResolvedValue({ id: 1, tier: "free" });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "length", message: { role: "assistant", content: "Partial answer" } }],
      usage: { cost: 0 },
    })));
    const result = await new OpenRouterProvider(null).chat(messages, BUDGET_FALLBACK_MODEL, 1);
    expect(result.message.content).toBe("Partial answer" + FREE_TRUNCATION_NOTE);
  });

  it("retries an empty / reasoning-only Free reply on the next model instead of showing a bare note", async () => {
    store.getUser.mockResolvedValue({ id: 1, tier: "free" });
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: "length", message: { role: "assistant", content: null } }],
        usage: { cost: 0 },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "   " } }],
        usage: { cost: 0 },
      })))
      .mockResolvedValueOnce(okResponse(0));
    const result = await new OpenRouterProvider(null).chat(messages, BUDGET_FALLBACK_MODEL, 1);
    expect(result.message.content).toBe("hi");
    expect(mockFetch.mock.calls.map(c => JSON.parse(c[1].body).model)).toEqual(FREE_RETRY_CHAIN);
  });

  it("gives a friendly error when every free model comes back empty", async () => {
    store.getUser.mockResolvedValue({ id: 1, tier: "free" });
    mockFetch.mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "length", message: { role: "assistant", content: null } }],
      usage: { cost: 0 },
    })));
    await expect(new OpenRouterProvider(null).chat(messages, BUDGET_FALLBACK_MODEL, 1)).rejects.toThrow("free models are busy");
  });

  it("streams Free partial text and the same truncation note", async () => {
    store.getUser.mockResolvedValue({ id: 1, tier: "free" });
    mockFetch.mockResolvedValue(new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Partial answer" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ finish_reason: "length", delta: {} }], usage: { cost: 0 } })}`,
      "data: [DONE]", "",
    ].join("\n\n")));
    const onToken = vi.fn();
    const result = await new OpenRouterProvider(null).chatStream(messages, BUDGET_FALLBACK_MODEL, onToken, 1);
    expect(result.message.content).toBe("Partial answer" + FREE_TRUNCATION_NOTE);
    expect(onToken).toHaveBeenLastCalledWith(FREE_TRUNCATION_NOTE);
  });

  it("preserves paid Pro output-limit errors", async () => {
    store.getUser.mockResolvedValue({ id: 1, tier: "pro" });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "length", message: { role: "assistant", content: "Partial" } }],
      usage: { cost: 0.001 },
    })));
    await expect(new OpenRouterProvider(null).chat(messages, "z-ai/glm-5.3-flash", 1)).rejects.toThrow("output limit");
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
