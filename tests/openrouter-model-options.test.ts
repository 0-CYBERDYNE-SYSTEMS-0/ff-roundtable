import { describe, expect, it } from "vitest";
import {
  REQUESTED_OPENROUTER_MODELS,
  withRequestedOpenRouterModels,
} from "../client/src/lib/openrouter-model-options";

describe("requested OpenRouter model options", () => {
  it("adds requested models when the live catalog omits them", () => {
    const models = withRequestedOpenRouterModels([{ id: "catalog/model", name: "Catalog model" }]);

    expect(models.map((model) => model.id)).toEqual([
      "catalog/model",
      "z-ai/glm-5.3-flash",
      "deepseek/deepseek-v4.1-flash",
      "xiaomi/mimo-v2.6-flash",
      "openai/gpt-6-luna",
    ]);
  });

  it("keeps the live catalog entry when a requested model is already present", () => {
    const liveModel = { id: REQUESTED_OPENROUTER_MODELS[0].id, name: "Live catalog name", pricing: { prompt: "0" } };
    const models = withRequestedOpenRouterModels([liveModel]);

    expect(models).toHaveLength(4);
    expect(models[0]).toEqual(liveModel);
    expect(models.filter((model) => model.id === liveModel.id)).toHaveLength(1);
  });
});
