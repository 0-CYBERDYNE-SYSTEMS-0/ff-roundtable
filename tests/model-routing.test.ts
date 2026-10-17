import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_OUTPUT_TOKENS, FREE_MODEL_FALLBACKS, maxOutputTokens, modelRouting } from "../server/ai-providers";

describe("model routing and output cap", () => {
  afterEach(() => { delete process.env.OPENROUTER_MAX_OUTPUT_TOKENS; });
  it("adds free fallbacks only for :free models, primary first, max 3", () => {
    const r = modelRouting("google/gemma-4-31b-it:free");
    expect(r.models?.[0]).toBe("google/gemma-4-31b-it:free");
    expect(r.models).toHaveLength(2);
    expect(new Set(r.models).size).toBe(2);
    expect(r.models!.every(m => m.endsWith(":free"))).toBe(true);
    expect(modelRouting("openai/gpt-4o")).toEqual({ model: "openai/gpt-4o" });
    expect(FREE_MODEL_FALLBACKS).toEqual(["dots-studio/dots-3-note-preview:free"]);
  });
  it("uses the current reliable free-model primary and fallback chain", () => {
    expect(modelRouting("nvidia/nemotron-3-super-120b-a12b:free").models).toEqual([
      "nvidia/nemotron-3-super-120b-a12b:free",
      "dots-studio/dots-3-note-preview:free",
    ]);
    expect(modelRouting("dots-studio/dots-3-note-preview:free").models).toEqual([
      "dots-studio/dots-3-note-preview:free",
    ]);
  });
  it("defaults to 4096 and honours a sane override", () => {
    expect(maxOutputTokens()).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    process.env.OPENROUTER_MAX_OUTPUT_TOKENS = "2048"; expect(maxOutputTokens()).toBe(2048);
    process.env.OPENROUTER_MAX_OUTPUT_TOKENS = "9999999"; expect(maxOutputTokens()).toBe(4096);
    process.env.OPENROUTER_MAX_OUTPUT_TOKENS = "abc"; expect(maxOutputTokens()).toBe(4096);
  });
});
