import type { AIMessage, AIModelResponse } from './ai';

const AI_REQUEST_TIMEOUT_MS = 120_000;

// ─── Provider Interface ───────────────────────────────────────────────────────

export interface AIProvider {
  chat(messages: AIMessage[], model: string, userId?: number): Promise<AIModelResponse>;
  chatStream(
    messages: AIMessage[],
    model: string,
    onToken: (token: string) => void,
    userId?: number
  ): Promise<AIModelResponse>;
}

// ─── OpenRouter Provider ───────────────────────────────────────────────────────

export class OpenRouterProvider implements AIProvider {
  private async getApiKey(userId?: number): Promise<string> {
    // If a userId is provided, try to use their stored BYOK key first
    if (userId) {
      try {
        const { storage } = await import("./storage");
        const userKey = await storage.getUserApiKey(userId);
        if (userKey) {
          console.log(`[BYOK] Using user-provided API key for user ${userId}`);
          return userKey;
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
    return platformKey;
  }

  async chat(messages: AIMessage[], model: string, userId?: number): Promise<AIModelResponse> {
    console.log(`[DEBUG] Entering OpenRouterProvider.chat for model: ${model}`);
    try {
      const openRouterKey = await this.getApiKey(userId);
      console.log(`[DEBUG] Calling OpenRouter fetch: https://openrouter.ai/api/v1/chat/completions, Model: ${model}`);

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${openRouterKey}`,
          "HTTP-Referer": "https://farm-friend-roundtable.replit.app",
          "X-Title": "Farm Friend Roundtable"
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          temperature: 0.7,
          max_tokens: 8192,
        }),
        signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
      });

      console.log(`[DEBUG] OpenRouter fetch completed. Status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[DEBUG] OpenRouter API Error Response Text: ${errorText}`);
        throw new Error(`OpenRouter API Error (${response.status}): ${errorText}`);
      }

      console.log("[DEBUG] OpenRouter response OK. Parsing JSON...");
      const data = await response.json();
      console.log("[DEBUG] OpenRouter JSON parsed successfully.");

      if (data && data.error) {
        console.error(`[DEBUG] OpenRouter returned error object despite 200 OK:`, JSON.stringify(data.error));
        const errorMsg = data.error.message || JSON.stringify(data.error);
        throw new Error(`OpenRouter Provider Error: ${errorMsg}`);
      }

      if (!data || !data.choices || !Array.isArray(data.choices) || data.choices.length === 0 || !data.choices[0] || !data.choices[0].message) {
        console.error("[DEBUG] Invalid/Incomplete response structure from OpenRouter API:", JSON.stringify(data));
        throw new Error("Invalid response format from OpenRouter API");
      }

      console.log("[DEBUG] OpenRouter response structure validated. Returning message.");
      return {
        message: data.choices[0].message
      };
    } catch (error: unknown) {
      console.error("[DEBUG] Error caught within OpenRouterProvider.chat:", error);
      if (error instanceof Error) {
        throw error;
      } else {
        throw new Error(`Unknown error in OpenRouterProvider.chat: ${String(error)}`);
      }
    }
  }

  async chatStream(
    messages: AIMessage[],
    model: string,
    onToken: (token: string) => void,
    userId?: number
  ): Promise<AIModelResponse> {
    console.log(`[STREAM] Starting OpenRouter stream for model: ${model}`);
    try {
      const openRouterKey = await this.getApiKey(userId);

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${openRouterKey}`,
          "HTTP-Referer": "https://farm-friend-roundtable.replit.app",
          "X-Title": "Farm Friend Roundtable"
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          temperature: 0.7,
          max_tokens: 8192,
          stream: true,
        }),
        signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter API Error (${response.status}): ${errorText}`);
      }

      if (!response.body) {
        throw new Error("No response body for streaming");
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

      console.log(`[STREAM] OpenRouter complete for ${model}. ${fullContent.length} chars`);

      return {
        message: { role: "assistant", content: fullContent }
      };
    } catch (error: unknown) {
      console.error("[STREAM] OpenRouter Error:", error);
      if (error instanceof Error) throw error;
      throw new Error(`Unknown error in OpenRouterProvider.chatStream: ${String(error)}`);
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
    return model.replace(/^local\//, '');
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
          max_tokens: 8192,
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
          max_tokens: 8192,
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
export function getProvider(modelId: string): AIProvider {
  if (modelId.startsWith('local/')) {
    return localOpenAIProvider;
  }
  return openRouterProvider;
}
