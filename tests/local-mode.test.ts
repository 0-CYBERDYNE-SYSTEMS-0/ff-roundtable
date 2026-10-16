import { afterEach, describe, expect, it } from "vitest";
import { getProvider, isLocalOnlyMode, resolveLocalModel, LocalOpenAIProvider } from "../server/ai-providers";

describe("OLLAMA_ENABLED local-only mode", () => {
  afterEach(() => { delete process.env.OLLAMA_ENABLED; delete process.env.OLLAMA_MODEL; });
  it("is off by default and local/ prefix still routes locally", () => {
    expect(isLocalOnlyMode()).toBe(false);
    expect(getProvider("local/llama3")).toBeInstanceOf(LocalOpenAIProvider);
    expect(getProvider("google/gemma-4-31b-it:free")).not.toBeInstanceOf(LocalOpenAIProvider);
    expect(resolveLocalModel("local/qwen3")).toBe("qwen3");
  });
  it("routes every model to OLLAMA_MODEL when enabled", () => {
    process.env.OLLAMA_ENABLED = "true"; process.env.OLLAMA_MODEL = "mistral";
    expect(getProvider("openai/gpt-4o")).toBeInstanceOf(LocalOpenAIProvider);
    expect(resolveLocalModel("openai/gpt-4o")).toBe("mistral");
    delete process.env.OLLAMA_MODEL;
    expect(resolveLocalModel("anything")).toBe("llama3");
  });
});
