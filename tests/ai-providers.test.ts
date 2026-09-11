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

import {
  getProvider,
  OpenRouterProvider,
  LocalOpenAIProvider,
} from "../server/ai-providers";
import { isFreeModel } from "../server/tiers";

describe("AI Providers", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    delete process.env.LOCAL_AI_BASE_URL;
    delete process.env.LOCAL_AI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
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
