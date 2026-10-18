export interface RequestedOpenRouterModel {
  id: string;
  name: string;
  description: string;
}

export const REQUESTED_OPENROUTER_MODELS: RequestedOpenRouterModel[] = [
  {
    id: "z-ai/glm-5.3-flash",
    name: "GLM 5.3 Flash",
    description: "GLM 5.3 Flash from Z.ai",
  },
  {
    id: "deepseek/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    description: "DeepSeek V4.1 Flash from DeepSeek",
  },
  {
    id: "xiaomi/mimo-v2.6-flash",
    name: "MiMo V2.6 Flash",
    description: "MiMo V2.6 Flash from Xiaomi",
  },
  {
    id: "openai/gpt-6-luna",
    name: "GPT-6 Luna",
    description: "GPT-6 Luna from OpenAI",
  },
];

export function withRequestedOpenRouterModels<T extends { id: string }>(models: T[]) {
  const existingIds = new Set(models.map((model) => model.id));
  return [
    ...models,
    ...REQUESTED_OPENROUTER_MODELS.filter((model) => !existingIds.has(model.id)),
  ];
}

// Keep in sync with HOUSE_KEY_PAID_MODEL_ALLOWLIST in server/usage-caps.ts.
// Pro without their own OpenRouter key may use only these paid models (plus
// any ":free" model); a user's own key unlocks every model.
export const HOUSE_KEY_MODEL_IDS: readonly string[] = REQUESTED_OPENROUTER_MODELS.map((model) => model.id);

export function isModelAvailableForPlan(id: string, tier: string | null, hasOwnKey: boolean): boolean {
  if (id.endsWith(":free")) return true;
  if (tier === "free") return false;
  if (tier === "pro" && !hasOwnKey) return HOUSE_KEY_MODEL_IDS.includes(id);
  return true;
}
