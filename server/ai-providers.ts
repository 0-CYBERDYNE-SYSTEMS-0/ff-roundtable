import { checkHouseKeyCall, currentUsagePeriod, UsageCapError, BUDGET_FALLBACK_MODEL } from "./usage-caps";
import type { AIMessage, AIModelResponse } from './ai';
import { randomUUID } from 'crypto';

const AI_REQUEST_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT_ERROR = "Response reached the output limit. Please ask for a shorter response or split the request into smaller parts.";
// Output ceiling per call. 1024 truncated File Creator SOPs mid-document;
// 8192 let one runaway answer cost 8x a normal turn. 4096 (~3,000 words)
// fits the longest documents we generate. Override with OPENROUTER_MAX_OUTPUT_TOKENS.
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
export function maxOutputTokens(): number {
  const parsed = Number(process.env.OPENROUTER_MAX_OUTPUT_TOKENS);
  return Number.isInteger(parsed) && parsed >= 256 && parsed <= 32768 ? parsed : DEFAULT_MAX_OUTPUT_TOKENS;
}
// Free OpenRouter models come and go; when a :free model is requested,
// OpenRouter's `models` array lets it fall through to these (verified live 2026-10-16).
export const FREE_MODEL_FALLBACKS = [
  "dots-studio/dots-3-note-preview:free",
];
export function modelRouting(model: string): { model: string; models?: string[] } {
  if (!model.endsWith(":free")) return { model };
  return { model, models: [model, ...FREE_MODEL_FALLBACKS.filter(m => m !== model)].slice(0, 3) };
}
const SPEND_CAP_PER_REQUEST_USD = 0.4;

export class OpenRouterSpendLimitError extends Error {
  constructor() {
    super("The OpenRouter verification spend limit has been reached. Keep the saved work and retry only after reviewing usage.");
    this.name = "OpenRouterSpendLimitError";
  }
}

type OpenRouterAttempt = {
  id: string;
  model: string;
  startedAt: number;
  reservedUsd: number;
  maxTokens: number;
  houseKeyUserId?: number;
  usagePeriod?: string;
  providerPriceLimit?: { prompt: number; completion: number };
  settled: boolean;
};

export type OpenRouterUsageSnapshot = {
  capUsd: number | null;
  spentUsd: number;
  reservedUsd: number;
  attempts: Array<{
    requestId: string;
    generationId?: string;
    model: string;
    responseModel?: string;
    provider?: string;
    elapsedMs: number;
    result: "success" | "failed";
    costUsd: number | null;
    errorCode?: number;
  }>;
};

function configuredSpendCap(): number | null {
  const raw = process.env.OPENROUTER_SPEND_CAP_USD;
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function numericCost(usage: any): number | undefined {
  const value = usage?.cost ?? usage?.total_cost ?? usage?.totalCost;
  const cost = typeof value === "string" ? Number(value) : value;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

const UNSUPPORTED_IMAGE_ERROR = /(?:image|vision|modalit|multimodal)[\s\S]{0,100}(?:not\s+support|unsupport\w*|reject\w*|invalid|disabled|not\s+allowed|can(?:not|'t)|unable)|(?:not\s+support|unsupport\w*|reject\w*|invalid|disabled|not\s+allowed|can(?:not|'t)|unable)[\s\S]{0,100}(?:image|vision|modalit|multimodal)|support\s+(?:[\w-]+\s+){0,2}(?:image|vision|multimodal|modalit)/i;

function safeOpenRouterError(status: number | undefined, providerDetail?: unknown): Error {
  let detail = "";
  try {
    detail = typeof providerDetail === "string" ? providerDetail : JSON.stringify(providerDetail ?? "");
  } catch {
    detail = "";
  }
  const unsupportedImage = status === 413 ||
    ((status === undefined || [400, 404, 422].includes(status)) && UNSUPPORTED_IMAGE_ERROR.test(detail.slice(0, 4096)));
  const message = unsupportedImage
    ? "This model does not support image input."
    : status === 401
    ? "OpenRouter authentication failed. Contact the account operator."
    : status === 402
      ? "The OpenRouter account needs credits. Contact the account operator."
      : status === 429
        ? "OpenRouter is temporarily rate-limited. Try again later."
        : `OpenRouter could not complete this request${status === undefined ? "" : ` (${status})`}. Retry or continue with available work.`;
  return Object.assign(new Error(message), status === undefined ? {} : { statusCode: status });
}

// ─── Provider Interface ───────────────────────────────────────────────────────

/** Per-call options. maxTokens overrides the default output cap (e.g. expert replies). */
export type ChatOptions = { maxTokens?: number };

export interface AIProvider {
  chat(messages: AIMessage[], model: string, userId?: number, webSearch?: boolean, options?: ChatOptions): Promise<AIModelResponse>;
  chatStream(
    messages: AIMessage[],
    model: string,
    onToken: (token: string) => void,
    userId?: number,
    webSearch?: boolean,
    options?: ChatOptions
  ): Promise<AIModelResponse>;
}

// ─── OpenRouter Provider ───────────────────────────────────────────────────────

export class OpenRouterProvider implements AIProvider {
  private readonly spendCapUsd: number | null;
  private spentUsd = 0;
  private reservedUsd = 0;
  private attempts: OpenRouterUsageSnapshot["attempts"] = [];

  constructor(spendCapUsd?: number | null) {
    this.spendCapUsd = spendCapUsd === undefined ? configuredSpendCap() : spendCapUsd;
  }

  getUsageSnapshot(): OpenRouterUsageSnapshot {
    return {
      capUsd: this.spendCapUsd,
      spentUsd: Number(this.spentUsd.toFixed(8)),
      reservedUsd: Number(this.reservedUsd.toFixed(8)),
      attempts: this.attempts.map(attempt => ({ ...attempt })),
    };
  }

  private beginAttempt(model: string, messages: AIMessage[], maxTokensOverride?: number): OpenRouterAttempt {
    const maxTokens = maxTokensOverride && maxTokensOverride > 0 ? Math.min(maxTokensOverride, maxOutputTokens()) : maxOutputTokens();
    const attempt: OpenRouterAttempt = {
      id: randomUUID(),
      model,
      startedAt: Date.now(),
      reservedUsd: 0,
      maxTokens,
      settled: false,
    };
    if (this.spendCapUsd === null) return attempt;

    const remainingUsd = this.spendCapUsd - this.spentUsd - this.reservedUsd;
    if (remainingUsd < 0.002) throw new OpenRouterSpendLimitError();
    const reservation = Math.min(SPEND_CAP_PER_REQUEST_USD, remainingUsd);
    const estimatedInputTokens = Math.max(1, Math.ceil(JSON.stringify(messages).length * 2));
    attempt.reservedUsd = reservation;
    attempt.maxTokens = maxTokens;
    attempt.providerPriceLimit = {
      prompt: Number(((reservation * 0.45 * 1_000_000) / estimatedInputTokens).toFixed(8)),
      completion: Number(((reservation * 0.45 * 1_000_000) / attempt.maxTokens).toFixed(8)),
    };
    this.reservedUsd += reservation;
    return attempt;
  }

  private settleAttempt(
    attempt: OpenRouterAttempt,
    result: "success" | "failed",
    usage?: unknown,
    metadata: { generationId?: string; responseModel?: string; provider?: string; errorCode?: number } = {},
  ): void {
    if (attempt.settled) return;
    attempt.settled = true;
    const costUsd = numericCost(usage);
    if (attempt.houseKeyUserId && attempt.usagePeriod && costUsd) {
      const { houseKeyUserId, usagePeriod } = attempt;
      void import("./storage")
        .then(({ storage }) => storage.addMonthlyAiSpend(houseKeyUserId, usagePeriod, costUsd))
        .catch(err => console.error("[CAPS] failed to record AI spend:", (err as Error).message));
    }
    if (attempt.reservedUsd > 0) {
      this.reservedUsd = Math.max(0, this.reservedUsd - attempt.reservedUsd);
      // When the provider omits cost, conservatively consume the reservation
      // so later calls cannot turn missing telemetry into unbounded spend.
      this.spentUsd += costUsd ?? attempt.reservedUsd;
    } else if (costUsd !== undefined) {
      this.spentUsd += costUsd;
    }
    const record: OpenRouterUsageSnapshot["attempts"][number] = {
      requestId: attempt.id,
      ...(metadata.generationId ? { generationId: metadata.generationId } : {}),
      model: attempt.model,
      ...(metadata.responseModel ? { responseModel: metadata.responseModel } : {}),
      ...(metadata.provider ? { provider: metadata.provider } : {}),
      elapsedMs: Date.now() - attempt.startedAt,
      result,
      costUsd: costUsd ?? null,
      ...(metadata.errorCode === undefined ? {} : { errorCode: metadata.errorCode }),
    };
    this.attempts.push(record);
    if (this.attempts.length > 100) this.attempts.splice(0, this.attempts.length - 100);
    console.info(`OPENROUTER_ATTEMPT ${JSON.stringify({
      ...record,
      ...(attempt.reservedUsd ? { reservedUsd: attempt.reservedUsd } : {}),
      usageKnown: costUsd !== undefined,
      sessionSpentUsd: Number(this.spentUsd.toFixed(8)),
      sessionCapUsd: this.spendCapUsd,
    })}`);
  }

  private requestBudget(attempt: OpenRouterAttempt) {
    return {
      max_tokens: attempt.maxTokens,
      ...(attempt.providerPriceLimit ? { provider: { max_price: attempt.providerPriceLimit } } : {}),
    };
  }

  private async getApiKey(userId?: number): Promise<string> {
    return (await this.resolveKey(userId)).key;
  }

  /**
   * Resolve the key for a call and enforce pricing caps on house-key calls
   * (server/usage-caps.ts): tier gate, Pro model allowlist, monthly budget.
   * BYOK calls are never capped and never counted.
   */
  private async authorizeCall(attempt: OpenRouterAttempt, model: string, userId?: number): Promise<{ key: string; model: string }> {
    const { key, byok } = await this.resolveKey(userId);
    if (byok || !userId) return { key, model };
    const { storage } = await import("./storage");
    const user = await storage.getUser(userId);
    const period = currentUsagePeriod();
    const usage = await storage.getMonthlyUsage(userId, period);
    const denial = checkHouseKeyCall(user?.tier, model, usage.aiSpendUsd);
    if (denial?.code === "ai_budget_exhausted") {
      // Graceful fallback: keep answering on a free model; the client shows
      // BUDGET_EXHAUSTED_NOTICE from /api/user/tier.
      console.info(`[CAPS] user ${userId} AI budget spent — ${model} -> ${BUDGET_FALLBACK_MODEL}`);
      attempt.model = BUDGET_FALLBACK_MODEL;
      return { key, model: BUDGET_FALLBACK_MODEL };
    }
    if (denial) throw new UsageCapError(denial);
    attempt.houseKeyUserId = userId;
    attempt.usagePeriod = period;
    return { key, model };
  }

  private async resolveKey(userId?: number): Promise<{ key: string; byok: boolean }> {
    // If a userId is provided, try to use their stored BYOK key first
    if (userId) {
      try {
        const { storage } = await import("./storage");
        const userKey = await storage.getUserApiKey(userId);
        if (userKey) {
          console.log(`[BYOK] Using user-provided API key for user ${userId}`);
          return { key: userKey, byok: true };
        }
      } catch (err) {
        console.warn("[BYOK] Failed to retrieve user API key:", (err as Error).message);
      }
    }

    // Fall back to platform key
    const platformKey = process.env.OPENROUTER_API_KEY;
    if (!platformKey) {
      throw new Error("OpenRouter API key not provided");
    }
    return { key: platformKey, byok: false };
  }

  async chat(messages: AIMessage[], model: string, userId?: number, webSearch = false, options: ChatOptions = {}): Promise<AIModelResponse> {
    const attempt = this.beginAttempt(model, messages, options.maxTokens);
    let requestStarted = false;
    let usage: unknown;
    let generationId: string | undefined;
    let provider: string | undefined;
    let responseModel: string | undefined;
    try {
      const authorized = await this.authorizeCall(attempt, model, userId);
      const openRouterKey = authorized.key;
      model = authorized.model;

      requestStarted = true;
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${openRouterKey}`,
          "HTTP-Referer": "https://farm-friend-roundtable.replit.app",
          "X-Title": "Farm Friend Roundtable"
        },
        body: JSON.stringify({
          ...modelRouting(model),
          messages: messages,
          temperature: 0.7,
          ...this.requestBudget(attempt),
          usage: { include: true },
          ...(process.env.OPENROUTER_REASONING_EFFORT
            ? { reasoning: { effort: process.env.OPENROUTER_REASONING_EFFORT } }
            : {}),
          ...(webSearch ? { plugins: [{ id: "web", max_results: 3 }] } : {}),
        }),
        signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw safeOpenRouterError(response.status, await response.text().catch(() => ""));
      }

      const data = await response.json() as any;
      usage = data?.usage;
      generationId = typeof data?.id === "string" ? data.id : undefined;
      provider = typeof data?.provider === "string" ? data.provider : undefined;
      responseModel = typeof data?.model === "string" ? data.model : undefined;

      if (data && data.error) {
        throw safeOpenRouterError(Number.isInteger(data.error.code) ? data.error.code : undefined, data.error);
      }

      if (!data || !data.choices || !Array.isArray(data.choices) || data.choices.length === 0 || !data.choices[0] || !data.choices[0].message) {
        throw new Error("Invalid response format from OpenRouter API");
      }

      if (data.choices[0].finish_reason === "length") {
        throw new Error(OUTPUT_LIMIT_ERROR);
      }

      this.settleAttempt(attempt, "success", usage, { generationId, responseModel, provider });
      return {
        message: data.choices[0].message,
        ...(Array.isArray(data.citations) ? { citations: data.citations.filter((value: unknown): value is string => typeof value === "string") } : {}),
        ...(usage && typeof usage === "object" ? { usage } : {}),
        ...(generationId ? { providerGenerationId: generationId } : {}),
        ...(responseModel ? { providerModel: responseModel } : {}),
        ...(provider ? { providerName: provider } : {}),
      };
    } catch (error: unknown) {
      const status = typeof (error as any)?.statusCode === "number" ? (error as any).statusCode : undefined;
      this.settleAttempt(attempt, "failed", requestStarted ? usage : { cost: 0 }, {
        generationId,
        responseModel,
        provider,
        errorCode: status,
      });
      if (error instanceof Error) {
        throw error;
      } else {
        throw new Error("OpenRouter could not complete this request. Retry or continue with available work.");
      }
    }
  }

  async chatStream(
    messages: AIMessage[],
    model: string,
    onToken: (token: string) => void,
    userId?: number,
    webSearch = false,
    options: ChatOptions = {}
  ): Promise<AIModelResponse> {
    const attempt = this.beginAttempt(model, messages, options.maxTokens);
    let requestStarted = false;
    let usage: unknown;
    let generationId: string | undefined;
    let provider: string | undefined;
    let responseModel: string | undefined;
    try {
      const authorized = await this.authorizeCall(attempt, model, userId);
      const openRouterKey = authorized.key;
      model = authorized.model;

      requestStarted = true;
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${openRouterKey}`,
          "HTTP-Referer": "https://farm-friend-roundtable.replit.app",
          "X-Title": "Farm Friend Roundtable"
        },
        body: JSON.stringify({
          ...modelRouting(model),
          messages: messages,
          temperature: 0.7,
          ...this.requestBudget(attempt),
          usage: { include: true },
          ...(process.env.OPENROUTER_REASONING_EFFORT
            ? { reasoning: { effort: process.env.OPENROUTER_REASONING_EFFORT } }
            : {}),
          ...(webSearch ? { plugins: [{ id: "web", max_results: 3 }] } : {}),
          stream: true,
        }),
        signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw safeOpenRouterError(response.status, await response.text().catch(() => ""));
      }

      if (!response.body) {
        throw new Error("No response body for streaming");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";
      let buffer = "";
      let finishReason: string | null = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;

            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;

            let parsed: any;
            try {
              parsed = JSON.parse(data);
            } catch {
              // Skip unparseable chunks
              continue;
            }

            if (parsed?.id && typeof parsed.id === "string") generationId = parsed.id;
            if (parsed?.provider && typeof parsed.provider === "string") provider = parsed.provider;
            if (parsed?.model && typeof parsed.model === "string") responseModel = parsed.model;
            if (parsed?.usage) usage = parsed.usage;

            if (parsed?.error) {
              throw safeOpenRouterError(Number.isInteger(parsed.error.code) ? parsed.error.code : undefined, parsed.error);
            }

            const choice = parsed?.choices?.[0];
            if (typeof choice?.finish_reason === "string") {
              finishReason = choice.finish_reason;
            }
            const content = choice?.delta?.content;
            if (content) {
              fullContent += content;
              onToken(content);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (finishReason === "length") {
        throw new Error(OUTPUT_LIMIT_ERROR);
      }

      this.settleAttempt(attempt, "success", usage, { generationId, responseModel, provider });

      return {
        message: { role: "assistant", content: fullContent },
        ...(usage && typeof usage === "object" ? { usage } : {}),
        ...(generationId ? { providerGenerationId: generationId } : {}),
        ...(responseModel ? { providerModel: responseModel } : {}),
        ...(provider ? { providerName: provider } : {}),
      };
    } catch (error: unknown) {
      const status = typeof (error as any)?.statusCode === "number" ? (error as any).statusCode : undefined;
      this.settleAttempt(attempt, "failed", requestStarted ? usage : { cost: 0 }, {
        generationId,
        responseModel,
        provider,
        errorCode: status,
      });
      if (error instanceof Error) throw error;
      throw new Error("OpenRouter could not complete this request. Retry or continue with available work.");
    }
  }
}

// ─── Local OpenAI-compatible Provider (ollama / LM Studio / llama.cpp) ─────────

export class LocalOpenAIProvider implements AIProvider {
  private getBaseUrl(): string {
    return process.env.LOCAL_AI_BASE_URL || 'http://localhost:11434/v1';
  }

  private getApiKey(): string | undefined {
    return process.env.LOCAL_AI_API_KEY || undefined;
  }

  private getActualModel(model: string): string {
    return resolveLocalModel(model);
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const apiKey = this.getApiKey();
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
  }

  async chat(messages: AIMessage[], model: string, _userId?: number): Promise<AIModelResponse> {
    const baseUrl = this.getBaseUrl();
    const actualModel = this.getActualModel(model);

    console.log(`[DEBUG] Entering LocalOpenAIProvider.chat for model: ${actualModel} at ${baseUrl}`);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({
          model: actualModel,
          messages: messages,
          temperature: 0.7,
          max_tokens: maxOutputTokens(),
          stream: false,
        }),
        signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
      });

      console.log(`[DEBUG] Local AI fetch completed. Status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[DEBUG] Local AI API Error Response Text: ${errorText}`);
        throw new Error(`Local AI API Error (${response.status}): ${errorText}`);
      }

      console.log("[DEBUG] Local AI response OK. Parsing JSON...");
      const data = await response.json();
      console.log("[DEBUG] Local AI JSON parsed successfully.");

      if (data && data.error) {
        console.error(`[DEBUG] Local AI returned error object:`, JSON.stringify(data.error));
        const errorMsg = data.error.message || JSON.stringify(data.error);
        throw new Error(`Local AI Provider Error: ${errorMsg}`);
      }

      if (!data || !data.choices || !Array.isArray(data.choices) || data.choices.length === 0 || !data.choices[0] || !data.choices[0].message) {
        console.error("[DEBUG] Invalid/Incomplete response structure from Local AI:", JSON.stringify(data));
        throw new Error("Invalid response format from Local AI API");
      }

      console.log("[DEBUG] Local AI response structure validated. Returning message.");
      return {
        message: data.choices[0].message
      };
    } catch (error: unknown) {
      console.error("[DEBUG] Error caught within LocalOpenAIProvider.chat:", error);
      if (error instanceof Error) {
        throw error;
      } else {
        throw new Error(`Unknown error in LocalOpenAIProvider.chat: ${String(error)}`);
      }
    }
  }

  async chatStream(
    messages: AIMessage[],
    model: string,
    onToken: (token: string) => void,
    _userId?: number
  ): Promise<AIModelResponse> {
    const baseUrl = this.getBaseUrl();
    const actualModel = this.getActualModel(model);

    console.log(`[STREAM] Starting local stream for model: ${actualModel} at ${baseUrl}`);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({
          model: actualModel,
          messages: messages,
          temperature: 0.7,
          max_tokens: maxOutputTokens(),
          stream: true,
        }),
        signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Local AI API Error (${response.status}): ${errorText}`);
      }

      if (!response.body) {
        throw new Error("No response body for local streaming");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;

            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              const content = parsed?.choices?.[0]?.delta?.content;
              if (content) {
                fullContent += content;
                onToken(content);
              }
            } catch {
              // Skip unparseable chunks
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      console.log(`[STREAM] Local complete for ${actualModel}. ${fullContent.length} chars`);

      return {
        message: { role: "assistant", content: fullContent }
      };
    } catch (error: unknown) {
      console.error("[STREAM] Local Error:", error);
      if (error instanceof Error) throw error;
      throw new Error(`Unknown error in LocalOpenAIProvider.chatStream: ${String(error)}`);
    }
  }
}

// ─── Singleton instances ──────────────────────────────────────────────────────

const openRouterProvider = new OpenRouterProvider();
const localOpenAIProvider = new LocalOpenAIProvider();

/**
 * Return the appropriate AI provider for a given model ID.
 * Models prefixed with "local/" use the local OpenAI-compatible provider
 * (ollama, LM Studio, llama.cpp). All others use OpenRouter.
 */
export function isLocalOnlyMode(): boolean {
  return /^(1|true|yes)$/i.test(process.env.OLLAMA_ENABLED ?? "");
}

/**
 * Map a requested model to the model name sent to the local server.
 * In local-only mode (OLLAMA_ENABLED=true) every expert uses OLLAMA_MODEL
 * (default "llama3"), so a self-hoster needs no paid keys at all.
 */
export function resolveLocalModel(model: string): string {
  if (isLocalOnlyMode()) return process.env.OLLAMA_MODEL || "llama3";
  const stripped = model.replace(/^local\//, '');
  return stripped === "default" ? (process.env.OLLAMA_MODEL || "llama3") : stripped;
}

export function getProvider(modelId: string): AIProvider {
  if (isLocalOnlyMode() || modelId.startsWith('local/')) {
    return localOpenAIProvider;
  }
  return openRouterProvider;
}
