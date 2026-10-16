/**
 * AI Providers Unit Tests
 *
 * Covers:
 *  - getProvider() routes local/* to LocalOpenAIProvider
 *  - getProvider() routes other models to OpenRouterProvider
 *  - LocalOpenAIProvider constructs correct baseUrl from LOCAL_AI_BASE_URL
 *  - isFreeModel() correctly identifies :free suffix
 *
 * Uses vitest with vi.mock for fetch calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock fetch BEFORE importing providers ──
const mockFetch = vi.fn();
global.fetch = mockFetch;

const { mockGetConversation, mockGetConversationExperts, mockGetUserApiKey } = vi.hoisted(() => ({
  mockGetConversation: vi.fn(),
  mockGetConversationExperts: vi.fn(),
  mockGetUserApiKey: vi.fn(),
}));

vi.mock("../server/storage", () => ({
  storage: {
    getConversation: mockGetConversation,
    getConversationExperts: mockGetConversationExperts,
    getUserApiKey: mockGetUserApiKey,
  },
}));

import {
  getProvider,
  OpenRouterProvider,
  LocalOpenAIProvider,
} from "../server/ai-providers";
import type { AIMessage } from "../server/ai";
import { getModeratorNextSpeakerSuggestion } from "../server/ai";
import type { ModeratorContext } from "../server/ai";
import { isFreeModel } from "../server/tiers";

function mockSseResponse(events: object[]) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}`).join("\n") + "\ndata: [DONE]\n";
  return { ok: true, body: new Response(body).body };
}

describe("AI Providers", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    mockGetConversation.mockReset();
    mockGetConversationExperts.mockReset();
    mockGetUserApiKey.mockReset().mockResolvedValue(null);
    delete process.env.LOCAL_AI_BASE_URL;
    delete process.env.LOCAL_AI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_REASONING_EFFORT;
    delete process.env.OPENROUTER_SPEND_CAP_USD;
  });

  describe("Moderator suggestion storage failures", () => {
    const moderator: ModeratorContext = {
      id: null,
      conversationId: 42,
      name: "Moderator",
      role: "Moderator",
      model: "test/model",
      systemPrompt: "Route the discussion.",
    };

    it("returns null when loading the conversation charter rejects", async () => {
      mockGetConversation.mockRejectedValue(new Error("conversation read failed"));

      await expect(
        getModeratorNextSpeakerSuggestion(moderator, [], ["Agronomist"]),
      ).resolves.toBeNull();
      expect(mockGetConversationExperts).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns null when loading the conversation roster rejects", async () => {
      mockGetConversation.mockResolvedValue({ charter: null });
      mockGetConversationExperts.mockRejectedValue(new Error("expert roster read failed"));

      await expect(
        getModeratorNextSpeakerSuggestion(moderator, [], ["Agronomist"]),
      ).resolves.toBeNull();
      expect(mockGetConversation).toHaveBeenCalledWith(42);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Provider Routing
  // ─────────────────────────────────────────────────────────────────

  describe("getProvider()", () => {
    it("routes local/* models to LocalOpenAIProvider", () => {
      const provider = getProvider("local/llama3.1");
      expect(provider).toBeInstanceOf(LocalOpenAIProvider);
    });

    it("routes local/ prefix with nested path to LocalOpenAIProvider", () => {
      const provider = getProvider("local/deepseek/deepseek-v3");
      expect(provider).toBeInstanceOf(LocalOpenAIProvider);
    });

    it("routes non-local models to OpenRouterProvider", () => {
      const provider = getProvider("deepseek/deepseek-v3");
      expect(provider).toBeInstanceOf(OpenRouterProvider);
    });

    it("routes openrouter models to OpenRouterProvider", () => {
      const provider = getProvider("openrouter/whatever");
      expect(provider).toBeInstanceOf(OpenRouterProvider);
    });

    it("routes :free suffix models to OpenRouterProvider", () => {
      const provider = getProvider("deepseek/deepseek-v3:free");
      expect(provider).toBeInstanceOf(OpenRouterProvider);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // LocalOpenAIProvider baseUrl
  // ─────────────────────────────────────────────────────────────────

  describe("LocalOpenAIProvider baseUrl", () => {
    it("uses default baseUrl when LOCAL_AI_BASE_URL is not set", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "hi" } }],
        }),
      });

      const provider = new LocalOpenAIProvider();
      await provider.chat([{ role: "user", content: "hello" }], "local/llama3");

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toBe("http://localhost:11434/v1/chat/completions");
    });

    it("uses LOCAL_AI_BASE_URL when set", async () => {
      process.env.LOCAL_AI_BASE_URL = "http://my-local-ai:8080/v1";
      process.env.OPENROUTER_API_KEY = "test-key";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "hi" } }],
        }),
      });

      const provider = new LocalOpenAIProvider();
      await provider.chat([{ role: "user", content: "hello" }], "local/llama3");

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toBe("http://my-local-ai:8080/v1/chat/completions");
    });

    it("strips local/ prefix from model ID", async () => {
      process.env.LOCAL_AI_BASE_URL = "http://localhost:11434/v1";
      process.env.OPENROUTER_API_KEY = "test-key";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "hi" } }],
        }),
      });

      const provider = new LocalOpenAIProvider();
      await provider.chat([{ role: "user", content: "hello" }], "local/llama3.1:8b");

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.model).toBe("llama3.1:8b");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // OpenRouterProvider
  // ─────────────────────────────────────────────────────────────────

  describe("OpenRouterProvider", () => {
    it("calls OpenRouter API with correct headers", async () => {
      process.env.OPENROUTER_API_KEY = "or-key-123";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "hi" } }],
        }),
      });

      const provider = new OpenRouterProvider();
      await provider.chat([{ role: "user", content: "hello" }], "deepseek/deepseek-v3");

      const [_url, options] = mockFetch.mock.calls[0];
      expect(options.headers["Authorization"]).toBe("Bearer or-key-123");
      expect(options.headers["HTTP-Referer"]).toBe("https://farm-friend-roundtable.replit.app");
      expect(options.headers["X-Title"]).toBe("Farm Friend Roundtable");
      expect(JSON.parse(options.body)).not.toHaveProperty("reasoning");
      expect(JSON.parse(options.body)).not.toHaveProperty("plugins");
    });

    it("requests usage and records actual cost and provider metadata", async () => {
      process.env.OPENROUTER_API_KEY = "or-key-123";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "gen_123",
          model: "deepseek/deepseek-v4.1-flash",
          provider: "Mock Provider",
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, cost: "0.12" },
          choices: [{ message: { role: "assistant", content: "Grounded answer." } }],
        }),
      });

      const provider = new OpenRouterProvider(1);
      const result = await provider.chat([{ role: "user", content: "Question" }], "deepseek/deepseek-v4.1-flash");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);

      expect(body.usage).toEqual({ include: true });
      expect(body.max_tokens).toBe(4096);
      expect(body.provider.max_price).toEqual({ prompt: expect.any(Number), completion: expect.any(Number) });
      expect(result.usage).toEqual({ prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, cost: "0.12" });
      expect(result.providerGenerationId).toBe("gen_123");
      expect(result.providerName).toBe("Mock Provider");
      expect(provider.getUsageSnapshot()).toMatchObject({
        capUsd: 1,
        spentUsd: 0.12,
        reservedUsd: 0,
        attempts: [{ generationId: "gen_123", model: "deepseek/deepseek-v4.1-flash", provider: "Mock Provider", result: "success", costUsd: 0.12 }],
      });
    });

    it("accounts for usage on the final streaming chunk", async () => {
      process.env.OPENROUTER_API_KEY = "or-key-123";
      mockFetch.mockResolvedValueOnce(mockSseResponse([
        { id: "gen_stream", provider: "Mock Provider", model: "z-ai/glm-5.3-flash", choices: [{ delta: { content: "Answer." }, finish_reason: null }] },
        { id: "gen_stream", provider: "Mock Provider", model: "z-ai/glm-5.3-flash", choices: [], usage: { prompt_tokens: 25, completion_tokens: 8, total_tokens: 33, cost: 0.07 } },
        { id: "gen_stream", provider: "Mock Provider", model: "z-ai/glm-5.3-flash", choices: [{ delta: {}, finish_reason: "stop" }] },
      ]));

      const provider = new OpenRouterProvider(0.5);
      const result = await provider.chatStream([{ role: "user", content: "Question" }], "z-ai/glm-5.3-flash", () => {});
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);

      expect(body.usage).toEqual({ include: true });
      expect(body.max_tokens).toBe(4096);
      expect(result.providerGenerationId).toBe("gen_stream");
      expect(result.usage?.cost).toBe(0.07);
      expect(provider.getUsageSnapshot()).toMatchObject({
        spentUsd: 0.07,
        attempts: [{ generationId: "gen_stream", provider: "Mock Provider", result: "success", costUsd: 0.07 }],
      });
    });

    it("blocks requests after the configured spend cap is consumed", async () => {
      process.env.OPENROUTER_API_KEY = "or-key-123";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          usage: { cost: 0.3 },
          choices: [{ message: { role: "assistant", content: "Answer." } }],
        }),
      });
      const provider = new OpenRouterProvider(0.3);

      await provider.chat([{ role: "user", content: "Question" }], "z-ai/glm-5.3-flash");
      await expect(provider.chat([{ role: "user", content: "Another question" }], "z-ai/glm-5.3-flash"))
        .rejects.toThrow("spend limit has been reached");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(provider.getUsageSnapshot().spentUsd).toBe(0.3);
    });

    it("reserves the full request budget when the response omits usage cost", async () => {
      process.env.OPENROUTER_API_KEY = "or-key-123";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { role: "assistant", content: "Answer." } }] }),
      });
      const provider = new OpenRouterProvider(0.4);

      await provider.chat([{ role: "user", content: "Question" }], "z-ai/glm-5.3-flash");

      expect(provider.getUsageSnapshot()).toMatchObject({
        spentUsd: 0.4,
        attempts: [{ result: "success", costUsd: null }],
      });
    });

    it.each(["chat", "chatStream"] as const)("adds web search to %s without changing the selected model", async (method) => {
      process.env.OPENROUTER_API_KEY = "mock-only-key";
      mockFetch.mockResolvedValueOnce(method === "chat"
        ? {
            ok: true,
            json: async () => ({ choices: [{ message: { role: "assistant", content: "Grounded answer." } }] }),
          }
        : mockSseResponse([
            { choices: [{ delta: { content: "Grounded answer." }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
          ]));

      const provider = new OpenRouterProvider();
      if (method === "chat") {
        await provider.chat([{ role: "user", content: "Question" }], "xiaomi/mimo-v2.6-flash", undefined, true);
      } else {
        await provider.chatStream([{ role: "user", content: "Question" }], "xiaomi/mimo-v2.6-flash", () => {}, undefined, true);
      }

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe("xiaomi/mimo-v2.6-flash");
      expect(body.plugins).toEqual([{ id: "web", max_results: 3 }]);
    });

    it("prefers the user's stored API key when a user ID is passed", async () => {
      process.env.OPENROUTER_API_KEY = "platform-key";
      mockGetUserApiKey.mockResolvedValue("stored-user-key");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "hi" } }],
        }),
      });

      const provider = new OpenRouterProvider();
      await provider.chat([{ role: "user", content: "hello" }], "deepseek/deepseek-v4.1-flash", 27);

      expect(mockGetUserApiKey).toHaveBeenCalledWith(27);
      expect(mockFetch.mock.calls[0][1].headers["Authorization"]).toBe("Bearer stored-user-key");
    });

    it.each(["chat", "chatStream"] as const)("forwards configured reasoning effort to %s requests", async (method) => {
      process.env.OPENROUTER_API_KEY = "or-key-123";
      process.env.OPENROUTER_REASONING_EFFORT = "low";
      mockFetch.mockResolvedValueOnce(method === "chat"
        ? {
            ok: true,
            json: async () => ({ choices: [{ message: { role: "assistant", content: "hi" } }] }),
          }
        : mockSseResponse([
            { choices: [{ delta: { content: "hi" }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
          ]));

      const provider = new OpenRouterProvider();
      if (method === "chat") {
        await provider.chat([{ role: "user", content: "hello" }], "openai/gpt-6-luna");
      } else {
        await provider.chatStream([{ role: "user", content: "hello" }], "openai/gpt-6-luna", () => {});
      }

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.reasoning).toEqual({ effort: "low" });
    });

    it("throws when an SSE frame contains a provider error", async () => {
      process.env.OPENROUTER_API_KEY = "or-key-123";
      mockFetch.mockResolvedValueOnce(mockSseResponse([
        { error: { message: "provider credits exhausted" } },
      ]));
      const provider = new OpenRouterProvider();

      await expect(
        provider.chatStream([{ role: "user", content: "hello" }], "z-ai/glm-5.3-flash", () => {}),
      ).rejects.toThrow("OpenRouter could not complete this request");
    });

    it("throws when a streamed response ends with finish_reason length", async () => {
      process.env.OPENROUTER_API_KEY = "or-key-123";
      mockFetch.mockResolvedValueOnce(mockSseResponse([
        { choices: [{ delta: { content: '{"type":"chart",' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "length" }] },
      ]));
      const provider = new OpenRouterProvider();

      await expect(
        provider.chatStream([{ role: "user", content: "hello" }], "z-ai/glm-5.3-flash", () => {}),
      ).rejects.toThrow("output limit");
    });

    it("throws when a non-streamed response ends with finish_reason length", async () => {
      process.env.OPENROUTER_API_KEY = "or-key-123";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: '{"type":"chart",' }, finish_reason: "length" }],
        }),
      });
      const provider = new OpenRouterProvider();

      await expect(
        provider.chat([{ role: "user", content: "hello" }], "z-ai/glm-5.3-flash"),
      ).rejects.toThrow("shorter response or split");
    });

    it("throws when OPENROUTER_API_KEY is missing", async () => {
      delete process.env.OPENROUTER_API_KEY;
      const provider = new OpenRouterProvider();

      await expect(
        provider.chat([{ role: "user", content: "hello" }], "deepseek/deepseek-v3")
      ).rejects.toThrow("OpenRouter API key not provided");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Multimodal content passthrough (vision input, SPEC §B6)
  // ─────────────────────────────────────────────────────────────────

  describe("Multimodal content passthrough", () => {
    const multimodalMessages: AIMessage[] = [
      { role: "system", content: "You describe images." },
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aGVsbG8gdmlzaW9u" },
          },
        ],
      },
    ];

    it("passes array content with image_url verbatim in the OpenRouter fetch body", async () => {
      process.env.OPENROUTER_API_KEY = "or-key-123";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "A field." } }],
        }),
      });

      const provider = new OpenRouterProvider();
      await provider.chat(multimodalMessages, "openai/gpt-4o");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages).toEqual(multimodalMessages);
      const userContent = body.messages[1].content;
      expect(Array.isArray(userContent)).toBe(true);
      expect(userContent[1].type).toBe("image_url");
      expect(userContent[1].image_url.url).toBe("data:image/png;base64,aGVsbG8gdmlzaW9u");
    });

    it("passes array content with image_url verbatim in the local provider fetch body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "A field." } }],
        }),
      });

      const provider = new LocalOpenAIProvider();
      await provider.chat(multimodalMessages, "local/llava");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages).toEqual(multimodalMessages);
      expect(body.messages[1].content[1].image_url.url).toBe(
        "data:image/png;base64,aGVsbG8gdmlzaW9u"
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // isFreeModel
  // ─────────────────────────────────────────────────────────────────

  describe("isFreeModel()", () => {
    it("returns true for models ending with :free", () => {
      expect(isFreeModel("deepseek/deepseek-v3:free")).toBe(true);
      expect(isFreeModel("google/gemma-4b:free")).toBe(true);
      expect(isFreeModel("nvidia/llama-3.1-nemotron-70b:free")).toBe(true);
    });

    it("returns false for non-free models", () => {
      expect(isFreeModel("deepseek/deepseek-v3")).toBe(false);
      expect(isFreeModel("anthropic/claude-3.5-sonnet")).toBe(false);
      expect(isFreeModel("openai/gpt-4o")).toBe(false);
    });

    it("returns false for local models", () => {
      expect(isFreeModel("local/llama3.1")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isFreeModel("")).toBe(false);
    });
  });
});
