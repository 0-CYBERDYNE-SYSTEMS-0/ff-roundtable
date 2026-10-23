import { expect, it } from "vitest";
import { requiresUpgradeBadge } from "../client/src/lib/openrouter-model-options";
import { FREE_EXPERT_MODELS } from "../shared/free-plan";

it.each(FREE_EXPERT_MODELS)("does not mark included Free model %s as PRO or upgrade-only", modelId => {
  expect(requiresUpgradeBadge(modelId)).toBe(false);
});
it("retains upgrade badges for other paid models, not local or :free models", () => {
  expect(requiresUpgradeBadge("openai/expensive-model")).toBe(true);
  expect(requiresUpgradeBadge("other/model:free")).toBe(false);
  expect(requiresUpgradeBadge("local/llama3")).toBe(false);
});
