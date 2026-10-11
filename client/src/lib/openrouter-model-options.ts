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
