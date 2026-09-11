/**
 * Tier System Unit Tests
 *
 * Covers:
 *  - isPaidModel() returns true for non-free models
 *  - getTierLimits() returns correct limits per tier
 *  - Expert addition blocked at tier limit (free tier = 3)
 *  - Paid model blocked for free tier
 *
 * Uses vitest. Tests tier logic in isolation.
 */

import { describe, it, expect } from "vitest";
import { isPaidModel, isFreeModel, getTierLimits, TIERS } from "../server/tiers";

describe("Tier System", () => {
  // ─────────────────────────────────────────────────────────────────
  // isPaidModel
  // ─────────────────────────────────────────────────────────────────

  describe("isPaidModel()", () => {
    it("returns true for non-free models", () => {
      expect(isPaidModel("deepseek/deepseek-v3")).toBe(true);
      expect(isPaidModel("anthropic/claude-3.5-sonnet")).toBe(true);
      expect(isPaidModel("openai/gpt-4o")).toBe(true);
      expect(isPaidModel("local/llama3.1")).toBe(true);
    });

    it("returns false for free models (ends with :free)", () => {
      expect(isPaidModel("deepseek/deepseek-v3:free")).toBe(false);
      expect(isPaidModel("google/gemma-4b:free")).toBe(false);
    });

    it("returns true for empty string", () => {
      expect(isPaidModel("")).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // isFreeModel (complementary)
  // ─────────────────────────────────────────────────────────────────

  describe("isFreeModel()", () => {
    it("returns true for models ending with :free", () => {
      expect(isFreeModel("deepseek/deepseek-v3:free")).toBe(true);
      expect(isFreeModel("google/gemma-4b:free")).toBe(true);
    });

    it("returns false for paid models", () => {
      expect(isFreeModel("anthropic/claude-3.5-sonnet")).toBe(false);
      expect(isFreeModel("openai/gpt-4o")).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // getTierLimits
  // ─────────────────────────────────────────────────────────────────

  describe("getTierLimits()", () => {
    it("returns correct limits for free tier", () => {
      const limits = getTierLimits("free");
      expect(limits.maxExperts).toBe(3);
      expect(limits.maxMessages).toBe(100);
      expect(limits.allowPaidModels).toBe(false);
      expect(limits.name).toBe("Free");
    });

    it("returns correct limits for pro tier", () => {
      const limits = getTierLimits("pro");
      expect(limits.maxExperts).toBe(8);
      expect(limits.maxMessages).toBe(1000);
      expect(limits.allowPaidModels).toBe(true);
      expect(limits.name).toBe("Pro");
    });

    it("returns correct limits for enterprise tier", () => {
      const limits = getTierLimits("enterprise");
      expect(limits.maxExperts).toBe(999);
      expect(limits.maxMessages).toBe(999999);
      expect(limits.allowPaidModels).toBe(true);
      expect(limits.name).toBe("Enterprise");
    });

    it("defaults to free tier for unknown tier names", () => {
      const limits = getTierLimits("nonexistent");
      expect(limits.maxExperts).toBe(3);
      expect(limits.allowPaidModels).toBe(false);
      expect(limits.name).toBe("Free");
    });

    it("returns a copy (mutation-safe)", () => {
      const limits = getTierLimits("free");
      limits.maxExperts = 999;
      const fresh = getTierLimits("free");
      expect(fresh.maxExperts).toBe(3);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Tier constants
  // ─────────────────────────────────────────────────────────────────

  describe("TIERS constant", () => {
    it("has exactly three tiers", () => {
      expect(Object.keys(TIERS)).toHaveLength(3);
      expect(TIERS).toHaveProperty("free");
      expect(TIERS).toHaveProperty("pro");
      expect(TIERS).toHaveProperty("enterprise");
    });

    it("free tier has lower limits than pro", () => {
      expect(TIERS.free.maxExperts).toBeLessThan(TIERS.pro.maxExperts);
      expect(TIERS.free.maxMessages).toBeLessThan(TIERS.pro.maxMessages);
      expect(TIERS.free.allowPaidModels).toBe(false);
      expect(TIERS.pro.allowPaidModels).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Business rule: expert addition blocked at tier limit
  // ─────────────────────────────────────────────────────────────────

  describe("Expert limit enforcement (business rule)", () => {
    it("blocks expert addition when free tier limit (3) is reached", () => {
      const currentExperts = 3;
      const limits = getTierLimits("free");
      const canAdd = currentExperts < limits.maxExperts;
      expect(canAdd).toBe(false);
    });

    it("allows expert addition when under free tier limit", () => {
      const currentExperts = 2;
      const limits = getTierLimits("free");
      const canAdd = currentExperts < limits.maxExperts;
      expect(canAdd).toBe(true);
    });

    it("allows up to 8 experts for pro tier", () => {
      const limits = getTierLimits("pro");
      expect(limits.maxExperts).toBe(8);
      const canAddAt7 = 7 < limits.maxExperts;
      const canAddAt8 = 8 < limits.maxExperts;
      expect(canAddAt7).toBe(true);
      expect(canAddAt8).toBe(false);
    });

    it("allows many experts for enterprise tier", () => {
      const limits = getTierLimits("enterprise");
      expect(limits.maxExperts).toBe(999);
      const canAddAt100 = 100 < limits.maxExperts;
      expect(canAddAt100).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Business rule: paid model blocked for free tier
  // ─────────────────────────────────────────────────────────────────

  describe("Paid model blocking (business rule)", () => {
    it("blocks paid models for free tier users", () => {
      const modelId = "anthropic/claude-3.5-sonnet";
      const limits = getTierLimits("free");
      const isPaid = isPaidModel(modelId);
      const allowed = limits.allowPaidModels || !isPaid;
      expect(isPaid).toBe(true);
      expect(allowed).toBe(false);
    });

    it("allows free models for free tier users", () => {
      const modelId = "deepseek/deepseek-v3:free";
      const limits = getTierLimits("free");
      const isPaid = isPaidModel(modelId);
      const allowed = limits.allowPaidModels || !isPaid;
      expect(isPaid).toBe(false);
      expect(allowed).toBe(true);
    });

    it("allows paid models for pro tier users", () => {
      const modelId = "anthropic/claude-3.5-sonnet";
      const limits = getTierLimits("pro");
      const isPaid = isPaidModel(modelId);
      const allowed = limits.allowPaidModels || !isPaid;
      expect(isPaid).toBe(true);
      expect(allowed).toBe(true);
    });

    it("allows paid models for enterprise tier users", () => {
      const modelId = "openai/gpt-4o";
      const limits = getTierLimits("enterprise");
      const isPaid = isPaidModel(modelId);
      const allowed = limits.allowPaidModels || !isPaid;
      expect(isPaid).toBe(true);
      expect(allowed).toBe(true);
    });

    it("blocks all non-free models for free tier regardless of provider", () => {
      const paidModels = [
        "deepseek/deepseek-v3",
        "anthropic/claude-3.5-sonnet",
        "openai/gpt-4o",
        "google/gemini-pro",
        "meta/llama-3.1-70b",
      ];
      const limits = getTierLimits("free");

      for (const modelId of paidModels) {
        const isPaid = isPaidModel(modelId);
        const allowed = limits.allowPaidModels || !isPaid;
        expect(isPaid).toBe(true);
        expect(allowed).toBe(false);
      }
    });
  });
});
