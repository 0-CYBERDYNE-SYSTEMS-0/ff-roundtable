const CACHE_TTL_MS = 10 * 60_000;
type ModelCatalog = { data: Array<{ id: string; [key: string]: unknown }> };
let cached: { value: ModelCatalog; expiresAt: number } | undefined;
let pending: Promise<ModelCatalog> | undefined;

/** Public model metadata, proxied same-origin without exposing a house key. */
export async function getModelCatalog(): Promise<ModelCatalog> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (pending) return pending;
  pending = (async () => {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Model catalog returned HTTP ${response.status}`);
    const value = await response.json() as ModelCatalog;
    if (!Array.isArray(value?.data) || value.data.some(model => typeof model?.id !== "string")) {
      throw new Error("Model catalog returned an invalid model list");
    }
    cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  })();
  try {
    return await pending;
  } finally {
    pending = undefined;
  }
}
