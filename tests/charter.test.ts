/**
 * G6 Council Charter Tests
 *
 * Covers:
 *  - generateSystemPrompt: charter block present when charter set; absent when
 *    null/undefined/whitespace; coexists with farm context (ordering sanity)
 *  - Moderator next-speaker path: charter flows into the Moderator system
 *    prompt (via the provider seam, inspecting the messages array)
 *  - generateClosingSynthesis: charter flows into the Moderator system prompt
 *    and the closing prompt honors goal/stop criteria
 *  - PUT /api/protected/conversations/:id: title/charter/turn-budget updates,
 *    validation, unknown fields (400), empty body (400), non-owner (404),
 *    unauthenticated (401)
 *  - MemStorage.updateConversation: merge, clear-with-null, omitted-key
 *    preservation, turn-budget default/normalization, undefined for a missing id
 *
 * Uses vitest + supertest. Forces MemStorage (DATABASE_URL="" via
 * vitest.config.ts). The orchestrator is mocked so no AI work runs behind the
 * routes; the AI provider layer is mocked so the real ai.ts functions can be
 * exercised and their prompt payloads inspected.
 */

import { afterEach, describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";

// ── Force MemStorage BEFORE any server imports ──
process.env.DATABASE_URL = "";
process.env.SESSION_SECRET = "vitest-charter-secret";
process.env.NODE_ENV = "test";
process.env.LOGIN_RATELIMIT_MAX = "1000";

// ── Mock orchestrator (routes import it; never let it reach the AI layer) ──
const { mockProcessMessageTurnBased, mockPersistAutonomySettings } = vi.hoisted(() => ({
  mockProcessMessageTurnBased: vi.fn(),
  mockPersistAutonomySettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../server/orchestrator", () => ({
  processMessageTurnBased: mockProcessMessageTurnBased,
  persistAutonomySettings: mockPersistAutonomySettings,
  InteractionOrchestrator: class {
    pause() {}
    resume() {}
    enableAutonomous(_maxTurns?: number) {}
    disableAutonomous() {}
  },
  getConversationState: vi.fn().mockReturnValue(null),
}));

// ── Mock the provider seam (real ai.ts stays live; calls are captured here) ──
const { mockProviderChat, mockProviderChatStream } = vi.hoisted(() => ({
  mockProviderChat: vi.fn(),
  mockProviderChatStream: vi.fn(),
}));

vi.mock("../server/ai-providers", () => ({
  getProvider: vi.fn(() => ({
    chat: mockProviderChat,
    chatStream: mockProviderChatStream,
  })),
}));

import { registerRoutes } from "../server/routes";
import { storage, MemStorage, PostgresStorage } from "../server/storage";
import {
  generateSystemPrompt,
  getModeratorNextSpeakerSuggestion,
  generateClosingSynthesis,
  buildClosingSynthesisPrompt,
  getExpertResponse,
  getExpertResponseStream,
  parseTrailingStanceLine,
} from "../server/ai";
import type { ModeratorContext } from "../server/ai";
import { conversations, type Expert } from "../shared/schema";

const CHARTER = "Goal: pick a cover crop for the north field. Stop when a seed and a planting week are chosen.";

function createMockExpert(id: number, conversationId: number, name: string, role: string): Expert {
  return {
    id,
    conversationId,
    name,
    role,
    model: "deepseek/deepseek-v3:free",
    systemPrompt: `You are ${name}, a ${role}.`,
    avatarUrl: null,
  };
}

function createMockModerator(id: number | null, conversationId: number, name = "Moderator"): ModeratorContext {
  return {
    id,
    conversationId,
    name,
    role: "Moderator",
    model: "deepseek/deepseek-v3:free",
    systemPrompt: `You are ${name}, chairing the council.`,
  };
}

// ═══════════════════════════════════════════════════════════════════
// generateSystemPrompt
// ═══════════════════════════════════════════════════════════════════

describe("generateSystemPrompt charter injection", () => {
  const expert = createMockExpert(1, 1, "Dr. Terra", "Soil Scientist");
  const roles = ["Soil Scientist", "Crop Specialist"];
  const farmContext = "Farm: Green Acres\nLocation: Iowa";

  it("includes the charter block when a charter is present", () => {
    const prompt = generateSystemPrompt(expert, roles, undefined, undefined, CHARTER);
    expect(prompt).toContain("📜 COUNCIL CHARTER (governs this roundtable — all experts):");
    expect(prompt).toContain(CHARTER);
    expect(prompt).toContain("All experts follow this charter.");
  });

  it("omits the charter block when the charter is null", () => {
    const prompt = generateSystemPrompt(expert, roles, undefined, undefined, null);
    expect(prompt).not.toContain("COUNCIL CHARTER");
  });

  it("omits the charter block when the charter is undefined (legacy callers)", () => {
    const prompt = generateSystemPrompt(expert, roles);
    expect(prompt).not.toContain("COUNCIL CHARTER");
  });

  it("omits the charter block when the charter is whitespace-only", () => {
    const prompt = generateSystemPrompt(expert, roles, undefined, undefined, "   \n\t  ");
    expect(prompt).not.toContain("COUNCIL CHARTER");
  });

  it("keeps the charter alongside farm context, charter before farm context", () => {
    const prompt = generateSystemPrompt(expert, roles, farmContext, undefined, CHARTER);
    expect(prompt).toContain("📜 COUNCIL CHARTER (governs this roundtable — all experts):");
    expect(prompt).toContain(CHARTER);
    expect(prompt).toContain("🌾 FARMER CONTEXT");
    // Charter is a governing block: it must precede the per-farm context.
    expect(prompt.indexOf("📜 COUNCIL CHARTER")).toBeLessThan(prompt.indexOf("🌾 FARMER CONTEXT"));
  });

  it("requires named cross-talk to reuse two concrete domain terms without repeating a recommendation", () => {
    const prompt = generateSystemPrompt(expert, roles);
    expect(prompt).toContain("use the colleague's full role name");
    expect(prompt).toContain("at least two specific domain terms of five or more letters");
    expect(prompt).toContain("Do not repeat their action step, calculation, or farmer question");
  });

  it("trims the charter content in the prompt", () => {
    const prompt = generateSystemPrompt(expert, roles, undefined, undefined, `  ${CHARTER}  `);
    expect(prompt).toContain(`\n${CHARTER}\n`);
    expect(prompt).not.toContain(`  ${CHARTER}  `);
  });

  it("asks farmer-only questions in plain language and proceeds on a qualified assumption", () => {
    const prompt = generateSystemPrompt(expert, roles);
    expect(prompt).toContain('beginning exactly "Farmer question:"');
    expect(prompt).toContain("plain-language question");
    expect(prompt).toContain("Do not use an @[User] mention for that question");
    expect(prompt).toContain('beginning "Assuming <reasonable assumption>"');
    expect(prompt).toContain("without waiting for the farmer to answer");
    expect(prompt).toContain("fictional or example prices and inputs, calculations, and assumptions");
    expect(prompt).toContain("Avoid unqualified farm-specific prescriptions");
  });

  it("adds concise expert cross-talk guidance and keeps farmer questions plain", () => {
    const prompt = generateSystemPrompt(expert, roles);
    expect(prompt).toContain("💬 CROSS-TALK");
    expect(prompt).toContain("I agree with X because");
    expect(prompt).toContain("I disagree with X on");
    expect(prompt).toContain("Colleagues (not you): [Crop Specialist]");
    expect(prompt).toContain("Tag @[Role] only when you need that specialty");
    expect(prompt).toContain("never tag yourself or force a tag every turn");
    expect(prompt).toContain("Add new information or an objection instead of repeating settled points");
    expect(prompt).toContain('beginning exactly "Farmer question:"');
    expect(prompt).not.toContain("@[User] <question>?");
    expect(prompt).toContain("without waiting for the farmer to answer");
    expect(prompt).toContain("STANCE: <agree|disagree|conditional|abstain> | <confidence 1-5> | <one-line position>");

    const moderatorPrompt = generateSystemPrompt(createMockModerator(null, 1), roles);
    expect(moderatorPrompt).not.toContain("💬 CROSS-TALK");
    expect(moderatorPrompt).not.toContain("STANCE:");
  });
});

describe("G15 expert stance parsing", () => {
  beforeEach(() => {
    mockProviderChat.mockReset();
    mockProviderChatStream.mockReset();
  });

  it("parses case-insensitive valid values and strips a trailing stance line", () => {
    expect(parseTrailingStanceLine("Recommendation.\n  STANCE: conditional | 5 | Wait for a soil test\n\n")).toEqual({
      content: "Recommendation.\n",
      stance: {
        stance: "conditional",
        confidence: 5,
        position: "Wait for a soil test",
      },
    });
  });

  it("strips malformed trailing stance lines, but preserves non-trailing and absent lines", () => {
    expect(parseTrailingStanceLine("Body\nSTANCE: maybe | 9 | invalid\n")).toEqual({
      content: "Body\n",
      stance: null,
    });
    const nonTrailing = "Body\nSTANCE: agree | 4 | an earlier note\nMore body";
    expect(parseTrailingStanceLine(nonTrailing)).toEqual({ content: nonTrailing, stance: null });
    expect(parseTrailingStanceLine("Body without metadata")).toEqual({
      content: "Body without metadata",
      stance: null,
    });
  });

  it("withholds a trailing stance from live stream tokens and returns it as metadata", async () => {
    const convo = await storage.createConversation({ userId: 1, title: "Streaming stance" });
    const expert = createMockExpert(12, convo.id, "Dr. Terra", "Soil Scientist");
    const emitted: string[] = [];
    const stanceLine = "  STANCE: AgReE | 4 | Reduces erosion risk";
    mockProviderChatStream.mockImplementation(async (_messages: any, _model: string, onToken: (token: string) => void) => {
      onToken("Use a cover crop.\n");
      onToken("  STANCE:");
      onToken(" AgReE | 4 | Reduces erosion risk");
      return { message: { role: "assistant", content: `Use a cover crop.\n${stanceLine}` } };
    });

    const result = await getExpertResponseStream(expert, [], "What should I plant?", [], [expert.role], token => emitted.push(token));

    expect(emitted.join("")).toBe("Use a cover crop.\n");
    expect(emitted.join("")).not.toContain("STANCE:");
    expect(result.content).toBe("Use a cover crop.");
    expect(result.stance).toEqual({ stance: "agree", confidence: 4, position: "Reduces erosion risk" });
    expect(mockProviderChatStream.mock.calls[0][3]).toBe(convo.userId);
    const stored = await storage.createMessage(result);
    expect(stored.content).toBe("Use a cover crop.");
    expect(stored.content).not.toContain("STANCE:");
    expect(stored.stance).toEqual(result.stance);
  });

  it("strips stance metadata from the non-stream response too", async () => {
    const convo = await storage.createConversation({ userId: 1, title: "Non-stream stance" });
    const expert = createMockExpert(13, convo.id, "Dr. Terra", "Soil Scientist");
    mockProviderChat.mockResolvedValue({
      message: { role: "assistant", content: "Use a cover crop.\nSTANCE: disagree | 2 | Seed cost is too high" },
    });

    const result = await getExpertResponse(expert, [], "What should I plant?", [], [expert.role]);

    expect(result.content).toBe("Use a cover crop.");
    expect(result.content).not.toContain("STANCE:");
    expect(result.stance).toEqual({ stance: "disagree", confidence: 2, position: "Seed cost is too high" });
  });
});

describe("Research Analyst OpenRouter web search", () => {
  beforeEach(() => {
    mockProviderChat.mockReset();
    mockProviderChatStream.mockReset();
  });

  it("requests grounding on the assigned model in both fallback paths and sets source rules", async () => {
    const previousPerplexityKey = process.env.PERPLEXITY_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    // The paid OpenRouter web plugin is opt-in (free DuckDuckGo tools are the default).
    process.env.OPENROUTER_WEB_PLUGIN = "true";
    try {
      const convo = await storage.createConversation({ userId: 1, title: "Grounded research" });
      const expert = createMockExpert(14, convo.id, "Researcher", "Research Analyst");
      expert.model = "xiaomi/mimo-v2.6-flash";
      const response = {
        message: { role: "assistant", content: "Check the extension guidance.\nSTANCE: conditional | 4 | Confirm with primary evidence" },
      };
      mockProviderChat.mockResolvedValue(response);
      mockProviderChatStream.mockResolvedValue(response);

      await getExpertResponseStream(expert, [], "Nitrogen recommendation?", [], [expert.role], () => {});
      const streamCall = mockProviderChatStream.mock.calls[0];
      expect(streamCall[1]).toBe(expert.model);
      expect(streamCall[3]).toBe(convo.userId);
      expect(streamCall[4]).toBe(true);
      const systemPrompt = streamCall[0].find((message: any) => message.role === "system").content;
      expect(systemPrompt).toContain("prioritize primary sources");
      expect(systemPrompt).toContain("use only exact URLs returned by retrieval");
      expect(systemPrompt).toContain("Never invent or guess source titles, publication dates, quotations, or URLs");
      expect(systemPrompt).toContain("supporting evidence is unavailable");
      expect(systemPrompt).toContain("do not imply a URL or its support was independently verified");
      expect(systemPrompt).toContain("Keep the response concise");
      expect(systemPrompt).toContain("place the exact retrieved URL next to the factual claim");
      expect(systemPrompt).toContain("fictional or example prices and inputs, calculations, and assumptions");

      await getExpertResponse(expert, [], "Nitrogen recommendation?", [], [expert.role]);
      const chatCall = mockProviderChat.mock.calls[0];
      expect(chatCall[1]).toBe(expert.model);
      expect(chatCall[2]).toBe(convo.userId);
      expect(chatCall[3]).toBe(true);
    } finally {
      delete process.env.OPENROUTER_WEB_PLUGIN;
      if (previousPerplexityKey === undefined) {
        delete process.env.PERPLEXITY_API_KEY;
      } else {
        process.env.PERPLEXITY_API_KEY = previousPerplexityKey;
      }
    }
  });
});

describe("Research Analyst retrieved source URLs", () => {
  let previousPerplexityKey: string | undefined;

  beforeEach(() => {
    previousPerplexityKey = process.env.PERPLEXITY_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    mockProviderChat.mockReset();
    mockProviderChatStream.mockReset();
  });

  afterEach(() => {
    if (previousPerplexityKey === undefined) {
      delete process.env.PERPLEXITY_API_KEY;
    } else {
      process.env.PERPLEXITY_API_KEY = previousPerplexityKey;
    }
  });

  it("persists exact OpenRouter citation URLs on non-stream answers and leaves absent citations absent", async () => {
    const convo = await storage.createConversation({ userId: 1, title: "Research citations" });
    const expert = createMockExpert(15, convo.id, "Researcher", "Research Analyst");
    const existingUrl = "https://extension.example.edu/nitrogen-guide";
    const returnedUrl = "https://usda.example.gov/nutrient-data";
    const answer = `The extension guide recommends testing first: [guide](${existingUrl})`;
    mockProviderChat.mockResolvedValue({
      message: { role: "assistant", content: answer },
      citations: [existingUrl, returnedUrl],
    });

    const result = await getExpertResponse(expert, [], "How should I assess nitrogen?", [], [expert.role]);
    const stored = await storage.createMessage(result);

    expect(result.content).toBe(`${answer}\n\nURLs returned by retrieval:\n- ${returnedUrl}`);
    expect(result.content.split(existingUrl)).toHaveLength(2);
    expect(stored.content).toBe(result.content);

    mockProviderChat.mockResolvedValue({
      message: { role: "assistant", content: "Supporting evidence is unavailable." },
    });
    const noSources = await getExpertResponse(expert, [], "How should I assess nitrogen?", [], [expert.role]);
    expect(noSources.content).toBe("Supporting evidence is unavailable.");
    expect(noSources.content).not.toContain("URLs returned by retrieval:");
  });

  it("streams returned OpenRouter citation URLs into the persisted answer", async () => {
    const convo = await storage.createConversation({ userId: 1, title: "Streaming research citations" });
    const expert = createMockExpert(16, convo.id, "Researcher", "Research Analyst");
    const answer = "Check the applicable extension guidance.";
    const exactUrl = "https://extension.example.edu/crop-guide?year=2026";
    mockProviderChatStream.mockImplementation(async (_messages: any, _model: string, onToken: (token: string) => void) => {
      onToken(answer);
      return {
        message: { role: "assistant", content: answer },
        citations: [exactUrl],
      };
    });
    const emitted: string[] = [];

    const result = await getExpertResponseStream(expert, [], "What does the guidance say?", [], [expert.role], token => emitted.push(token));
    const stored = await storage.createMessage(result);

    expect(emitted.join("")).toBe(result.content);
    expect(result.content).toBe(`${answer}\n\nURLs returned by retrieval:\n- ${exactUrl}`);
    expect(stored.content).toBe(result.content);
  });

  it("sends Perplexity the existing research prompt and bounded recent discussion context", async () => {
    const previousPerplexityKey = process.env.PERPLEXITY_API_KEY;
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key";
    const exactUrl = "https://extension.example.edu/research-source";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "The retrieved guidance addresses the question." } }],
        citations: [exactUrl],
      }),
    } as unknown as Response);

    try {
      const convo = await storage.createConversation({ userId: 1, title: "Perplexity context" });
      const expert = createMockExpert(17, convo.id, "Researcher", "Research Analyst");
      const history = [
        { role: "user", content: `OLDER-CONTEXT-START ${"o".repeat(12_000)}` },
        { role: "assistant", content: `MIDDLE-CONTEXT ${"m".repeat(12_000)}` },
        { role: "user", content: `RECENT-CONTEXT ${"r".repeat(12_000)}` },
      ] as any;
      const emitted: string[] = [];

      const result = await getExpertResponseStream(
        expert,
        history,
        "Current farmer question?",
        [],
        [expert.role],
        token => emitted.push(token),
      );

      const request = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
      const systemPrompt = request.messages[0].content as string;
      const userContext = request.messages[1].content as string;
      const stored = await storage.createMessage(result);

      expect(systemPrompt).toContain("You are a Research Analyst specializing in agriculture.");
      expect(systemPrompt).toContain("Never invent or guess source titles, publication dates, quotations, or URLs");
      expect(userContext).toContain("RECENT-CONTEXT");
      expect(userContext).toContain("Current question:\nCurrent farmer question?");
      expect(userContext.length).toBeLessThanOrEqual(24_000);
      expect(userContext).not.toContain("OLDER-CONTEXT-START");
      expect(result.content).toContain(exactUrl);
      expect(emitted.join("")).toBe(result.content);
      expect(stored.content).toBe(result.content);
    } finally {
      fetchSpy.mockRestore();
      if (previousPerplexityKey === undefined) {
        delete process.env.PERPLEXITY_API_KEY;
      } else {
        process.env.PERPLEXITY_API_KEY = previousPerplexityKey;
      }
    }
  });
});

describe("empty and incomplete expert responses", () => {
  beforeEach(() => {
    mockProviderChat.mockReset();
    mockProviderChatStream.mockReset();
  });

  it("replaces an empty successful non-stream response with a warning that persists and allows the next turn", async () => {
    const convo = await storage.createConversation({ userId: 1, title: "Empty expert response" });
    const expert = createMockExpert(18, convo.id, "Dr. Terra", "Soil Scientist");
    mockProviderChat
      .mockResolvedValueOnce({ message: { role: "assistant", content: " \n " } })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "The soil report indicates low organic matter." } });

    const incomplete = await getExpertResponse(expert, [], "Review the soil report.", [], [expert.role]);
    const stored = await storage.createMessage(incomplete);
    const next = await getExpertResponse(
      { ...expert, id: 19, name: "Crop Specialist", role: "Crop Specialist" },
      [],
      "Continue with the available findings.",
      [],
      ["Soil Scientist", "Crop Specialist"],
    );

    expect(incomplete.content.startsWith("⚠️")).toBe(true);
    expect(incomplete.content).toContain("Try a shorter request or split it into smaller requests");
    expect(incomplete.content).toContain("continue with the work available so far");
    expect(stored.content).toBe(incomplete.content);
    expect(stored.content.trim()).not.toBe("");
    expect(next.content).toBe("The soil report indicates low organic matter.");
  });

  it("replaces an empty successful streamed response with a marked actionable message", async () => {
    const convo = await storage.createConversation({ userId: 1, title: "Empty streamed response" });
    const expert = createMockExpert(20, convo.id, "Dr. Terra", "Soil Scientist");
    mockProviderChatStream.mockResolvedValue({ message: { role: "assistant", content: "  " } });
    const emitted: string[] = [];

    const result = await getExpertResponseStream(
      expert,
      [],
      "Review the soil report.",
      [],
      [expert.role],
      token => emitted.push(token),
    );
    const stored = await storage.createMessage(result);

    expect(result.content.startsWith("⚠️")).toBe(true);
    expect(result.content).toContain("Try a shorter request or split it into smaller requests");
    expect(emitted.join("")).toContain(result.content);
    expect(stored.content).toBe(result.content);
    expect(stored.content.trim()).not.toBe("");
  });

  it("replaces output-limit failures with a safe warning and redacts provider payloads", async () => {
    const convo = await storage.createConversation({ userId: 1, title: "Output limit handling" });
    const expert = createMockExpert(21, convo.id, "Dr. Terra", "Soil Scientist");
    const secretPayload = "RAW_PROVIDER_PAYLOAD_SHOULD_NOT_ESCAPE";
    mockProviderChat.mockRejectedValue(new Error(`Response reached the output limit. ${secretPayload}`));
    const nonStream = await getExpertResponse(expert, [], "Review this report.", [], [expert.role]);

    const emitted: string[] = [];
    mockProviderChatStream.mockImplementation(async (_messages: any, _model: string, onToken: (token: string) => void) => {
      onToken("Partial text before the output limit.");
      throw new Error(`Response reached the output limit. ${secretPayload}`);
    });
    const streamed = await getExpertResponseStream(
      expert,
      [],
      "Review this report.",
      [],
      [expert.role],
      token => emitted.push(token),
    );

    for (const response of [nonStream, streamed]) {
      expect(response.content.startsWith("⚠️")).toBe(true);
      expect(response.content).toContain("Try a shorter request or split it into smaller requests");
      expect(response.content).not.toContain(secretPayload);
    }
    expect(emitted.join("")).toContain("Partial text before the output limit.");
    expect(emitted.join("")).toContain("⚠️");
    expect(emitted.join("")).not.toContain(secretPayload);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Moderator next-speaker suggestion (charter-aware judgment)
// ═══════════════════════════════════════════════════════════════════

describe("getModeratorNextSpeakerSuggestion charter awareness", () => {
  beforeEach(() => {
    mockProviderChat.mockReset();
    mockProviderChat.mockResolvedValue({
      message: { role: "assistant", content: "Soil Scientist" },
    });
  });

  it("puts the charter block into the Moderator system prompt", async () => {
    const convo = await storage.createConversation({
      userId: 1,
      title: "Chartered roundtable",
      charter: CHARTER,
    });
    const moderator = createMockModerator(901, convo.id, "Matt");

    const suggestion = await getModeratorNextSpeakerSuggestion(moderator, [], [
      "Soil Scientist",
      "Moderator",
    ]);

    expect(suggestion).toBe("Soil Scientist");
    const messages = mockProviderChat.mock.calls[0][0];
    const systemMessage = messages.find((m: any) => m.role === "system");
    expect(systemMessage.content).toContain("📜 COUNCIL CHARTER (governs this roundtable — all experts):");
    expect(systemMessage.content).toContain(CHARTER);
  });

  it("references the charter in the speak-next/conclude query", async () => {
    const convo = await storage.createConversation({
      userId: 1,
      title: "Chartered roundtable 2",
      charter: CHARTER,
    });
    const moderator = createMockModerator(902, convo.id, "Matt");

    await getModeratorNextSpeakerSuggestion(moderator, [], ["Soil Scientist", "Moderator"]);

    const messages = mockProviderChat.mock.calls[0][0];
    const userQuery = messages.filter((m: any) => m.role === "user").pop();
    expect(userQuery.content).toContain("council charter");
    expect(userQuery.content).toContain("stop criteria");
  });

  it("gives the Moderator the next turn position and explicit routing choices", async () => {
    const convo = await storage.createConversation({ userId: 1, title: "Budget-aware routing" });
    const moderator = createMockModerator(null, convo.id);

    const suggestion = await getModeratorNextSpeakerSuggestion(
      moderator,
      [],
      ["Soil Scientist", "Crop Specialist"],
      false,
      { turnNumber: 3, turnBudget: 8 },
    );

    expect(suggestion).toBe("Soil Scientist");
    const messages = mockProviderChat.mock.calls[0][0];
    const userQuery = messages.filter((m: any) => m.role === "user").pop();
    expect(userQuery.content).toContain("This is turn 3 of 8.");
    expect(userQuery.content).toContain("'Continue'");
    expect(userQuery.content).toContain("'Go deeper: <available role>'");
    expect(userQuery.content).toContain("'Conclude'");
  });

  it.each([
    ["Continue", "RoundRobin"],
    ["Go deeper: Soil Scientist", "Soil Scientist"],
    ["Conclude", "Conclude"],
    ["Soil Scientist", "Soil Scientist"],
    ["RoundRobin", "RoundRobin"],
  ])("normalizes the Moderator choice %s to %s", async (response, expected) => {
    const convo = await storage.createConversation({ userId: 1, title: `Choice ${response}` });
    mockProviderChat.mockResolvedValueOnce({ message: { role: "assistant", content: response } });

    const suggestion = await getModeratorNextSpeakerSuggestion(
      createMockModerator(null, convo.id),
      [],
      ["Soil Scientist", "Crop Specialist"],
    );

    expect(suggestion).toBe(expected);
  });

  it.each(["Go deeper: Unknown Role", "Go deeper:", "Unknown Role"]) (
    "falls back for an invalid Moderator role choice: %s",
    async (response) => {
      const convo = await storage.createConversation({ userId: 1, title: `Invalid choice ${response}` });
      mockProviderChat.mockResolvedValueOnce({ message: { role: "assistant", content: response } });

      const suggestion = await getModeratorNextSpeakerSuggestion(
        createMockModerator(null, convo.id),
        [],
        ["Soil Scientist", "Crop Specialist"],
      );

      expect(suggestion).toBeNull();
    },
  );

  it("stays charter-free when the conversation has no charter", async () => {
    const convo = await storage.createConversation({ userId: 1, title: "Unchartered" });
    expect(convo.charter ?? null).toBeNull();
    const moderator = createMockModerator(903, convo.id, "Matt");

    await getModeratorNextSpeakerSuggestion(moderator, [], ["Soil Scientist", "Moderator"]);

    const messages = mockProviderChat.mock.calls[0][0];
    const systemMessage = messages.find((m: any) => m.role === "system");
    expect(systemMessage.content).not.toContain("COUNCIL CHARTER");
    const userQuery = messages.filter((m: any) => m.role === "user").pop();
    expect(userQuery.content).not.toContain("council charter");
  });

  it("tells the Moderator what the farmer answered and to revisit conflicting assumptions", async () => {
    const convo = await storage.createConversation({ userId: 1, title: "Answered question" });
    const expertQuestion = await storage.createMessage({
      conversationId: convo.id,
      expertId: null,
      userId: null,
      content: "@[User] What was the soil pH?\nAssuming it was near neutral.",
      role: "assistant",
      expertRole: "Soil Scientist",
      mentions: ["User"],
    });
    const question = await storage.createOpenQuestion({
      conversationId: convo.id,
      messageId: expertQuestion.id,
      expertRole: "Soil Scientist",
      question: "What was the soil pH?",
      assumption: "it was near neutral.",
    });
    const answer = await storage.createMessage({
      conversationId: convo.id,
      expertId: null,
      userId: 1,
      content: "The test last month measured 5.8.",
      role: "user",
      answersQuestionId: question.id,
    });
    await storage.answerOpenQuestion(question.id, answer.id);

    await getModeratorNextSpeakerSuggestion(
      createMockModerator(null, convo.id),
      [expertQuestion, answer],
      ["Soil Scientist"],
      true,
    );

    const messages = mockProviderChat.mock.calls[0][0];
    const userQuery = messages.filter((m: any) => m.role === "user").pop();
    expect(userQuery.content).toContain("The farmer answered the open question \"What was the soil pH?\"");
    expect(userQuery.content).toContain("The test last month measured 5.8.");
    expect(userQuery.content).toContain("Revisit any assumptions that conflict with this answer.");
  });

  it("provides the Moderator current stances and unanswered questions for evidence-based routing", async () => {
    const convo = await storage.createConversation({ userId: 1, title: "Evidence-aware routing" });
    const sourceMessage = await storage.createMessage({
      conversationId: convo.id,
      expertId: null,
      userId: null,
      content: "What is the soil pH? Assuming it is near neutral.",
      role: "assistant",
      expertName: "Dr. Terra",
      expertRole: "Soil Scientist",
    });
    await storage.createOpenQuestion({
      conversationId: convo.id,
      messageId: sourceMessage.id,
      expertRole: "Soil Scientist",
      question: "What is the soil pH?",
      assumption: "it is near neutral.",
    });

    await getModeratorNextSpeakerSuggestion(
      createMockModerator(null, convo.id),
      [sourceMessage],
      ["Soil Scientist", "Crop Specialist"],
      false,
      {
        stanceLedger: {
          "Soil Scientist": { stance: "disagree", confidence: 4, position: "Test before liming" },
          "Crop Specialist": null,
        },
      },
    );

    const messages = mockProviderChat.mock.calls[0][0];
    const userQuery = messages.filter((m: any) => m.role === "user").pop();
    expect(userQuery.content).toContain('"expertRole":"Soil Scientist","stance":"disagree"');
    expect(userQuery.content).toContain("What is the soil pH?");
    expect(userQuery.content).toContain("it is near neutral.");
    expect(userQuery.content).toContain("Suggest Conclude only when the discussion and charter provide evidence");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Closing synthesis (G5 × G6)
// ═══════════════════════════════════════════════════════════════════

describe("generateClosingSynthesis charter awareness", () => {
  beforeEach(() => {
    mockProviderChatStream.mockReset();
    mockProviderChatStream.mockResolvedValue({
      message: { role: "assistant", content: "Final synthesis." },
    });
  });

  it("injects the charter into the Moderator system prompt and the closing prompt", async () => {
    const convo = await storage.createConversation({
      userId: 1,
      title: "Chartered closing",
      charter: CHARTER,
    });
    const moderator = createMockModerator(904, convo.id, "Matt");
    const broadcastFn = vi.fn();

    await generateClosingSynthesis(convo.id, moderator, broadcastFn);

    const messages = mockProviderChatStream.mock.calls[0][0];
    const systemMessage = messages.find((m: any) => m.role === "system");
    expect(systemMessage.content).toContain("📜 COUNCIL CHARTER (governs this roundtable — all experts):");
    expect(systemMessage.content).toContain(CHARTER);

    const closingPrompt = messages.filter((m: any) => m.role === "user").pop();
    expect(closingPrompt.content).toContain("council charter");
    expect(closingPrompt.content).toContain("stop criteria");

    // The synthesis lifecycle completed normally.
    const done = broadcastFn.mock.calls.map((c) => c[1]).find((d) => d.type === "expert_stream_done");
    expect(done?.message?.isSynthesis).toBe(true);
    expect(done?.message?.expertRole).toBe("Moderator");
    expect(done?.message?.expertId).toBe(904);
  });

  it("stores a synthetic Moderator synthesis without an expert foreign key", async () => {
    const convo = await storage.createConversation({ userId: 1, title: "System Moderator closing" });
    const moderator = createMockModerator(null, convo.id);

    await generateClosingSynthesis(convo.id, moderator, vi.fn());

    const messages = await storage.getConversationMessages(convo.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      expertId: null,
      expertName: "Moderator",
      expertRole: "Moderator",
      isSynthesis: true,
    });
  });

  it("keeps the closing prompt charter-free when no charter exists", async () => {
    const convo = await storage.createConversation({ userId: 1, title: "Unchartered closing" });
    const moderator = createMockModerator(905, convo.id, "Matt");

    await generateClosingSynthesis(convo.id, moderator, vi.fn());

    const messages = mockProviderChatStream.mock.calls[0][0];
    const systemMessage = messages.find((m: any) => m.role === "system");
    expect(systemMessage.content).not.toContain("COUNCIL CHARTER");
    const closingPrompt = messages.filter((m: any) => m.role === "user").pop();
    expect(closingPrompt.content).not.toContain("council charter");
  });

  it("uses the five required headings and carries open questions plus abstaining stances", async () => {
    const convo = await storage.createConversation({ userId: 1, title: "Unresolved closing" });
    const sourceMessage = await storage.createMessage({
      conversationId: convo.id,
      expertId: null,
      userId: null,
      content: "What was the soil pH? Assuming it was near neutral.",
      role: "assistant",
      expertName: "Dr. Terra",
      expertRole: "Soil Scientist",
    });
    await storage.createOpenQuestion({
      conversationId: convo.id,
      messageId: sourceMessage.id,
      expertRole: "Soil Scientist",
      question: "What was the soil pH?",
      assumption: "it was near neutral.",
    });

    await generateClosingSynthesis(
      convo.id,
      createMockModerator(null, convo.id),
      vi.fn(),
      {
        "Soil Scientist": { stance: "abstain", confidence: 1, position: "Need a soil test" },
        "Crop Specialist": null,
      },
    );

    const messages = mockProviderChatStream.mock.calls[0][0];
    const closingPrompt = messages.filter((m: any) => m.role === "user").pop();
    expect(closingPrompt.content.match(/^## .+$/gm)).toEqual([
      "## Verdict",
      "## Consensus",
      "## Dissent",
      "## Open questions for you",
      "## Assumptions awaiting confirmation",
    ]);
    expect(closingPrompt.content).toContain("What was the soil pH?");
    expect(closingPrompt.content).toContain("it was near neutral.");
    expect(closingPrompt.content).toContain("The Verdict must be conditional or unresolved");
    expect(closingPrompt.content).toContain("explicitly state that there is no expert consensus");
    expect(closingPrompt.content).toContain("Do not invent consensus.");
  });

  it("exposes a pure prompt builder for the no-stance unresolved case", () => {
    const prompt = buildClosingSynthesisPrompt({ "Soil Scientist": null });
    expect(prompt).toContain("## Verdict\n## Consensus\n## Dissent");
    expect(prompt).toContain("The Verdict must be conditional or unresolved");
    expect(prompt).toContain("Do not invent consensus.");
    expect(prompt).toContain("In Dissent, name each expert role from the ledger");
  });
});

// ═══════════════════════════════════════════════════════════════════
// PUT /api/protected/conversations/:id
// ═══════════════════════════════════════════════════════════════════

describe("PUT /api/protected/conversations/:id (charter + title)", () => {
  let app: Express;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    await registerRoutes(app);
  });

  beforeEach(() => mockPersistAutonomySettings.mockReset().mockResolvedValue(undefined));

  async function registerAndLogin(
    agent: request.SuperAgentTest,
    username: string,
    password = "testpass123",
    email = `${username}@example.com`,
  ) {
    const res = await agent
      .post("/api/register")
      .send({ username, password, email });
    expect(res.status).toBe(201);
    return agent;
  }

  async function createConversation(agent: request.SuperAgentTest, title = "Test Roundtable") {
    const res = await agent.post("/api/protected/conversations").send({ title });
    expect(res.status).toBe(201);
    return res.body;
  }

  it("returns 401 when not authenticated", async () => {
    const res = await request(app)
      .put("/api/protected/conversations/1")
      .send({ charter: "nope" });
    expect(res.status).toBe(401);
  });

  it("updates the title only and leaves the charter untouched", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent, "charterTitleUser");
    const convo = await createConversation(agent, "Before");

    const res = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ title: "After" });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("After");
    expect(res.body.charter ?? null).toBeNull();
    expect(res.body.turnBudget).toBe(25);
  });

  it("accepts turn budgets, normalizes zero to null, and preserves omitted values", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent, "charterTurnBudgetUser");
    const convo = await createConversation(agent);

    const set = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ turnBudget: 40 });
    expect(set.status).toBe(200);
    expect(set.body.turnBudget).toBe(40);
    expect(mockPersistAutonomySettings).toHaveBeenCalledWith(convo.id, { maxAutonomousTurns: 40 });

    const omitted = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ title: "Budget preserved" });
    expect(omitted.status).toBe(200);
    expect(omitted.body.turnBudget).toBe(40);
    expect(mockPersistAutonomySettings).toHaveBeenCalledTimes(1);

    const zero = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ turnBudget: 0 });
    expect(zero.status).toBe(200);
    expect(zero.body.turnBudget).toBeNull();
    expect(mockPersistAutonomySettings).toHaveBeenLastCalledWith(convo.id, { maxAutonomousTurns: null });

    const explicitNull = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ turnBudget: null });
    expect(explicitNull.status).toBe(200);
    expect(explicitNull.body.turnBudget).toBeNull();
    expect(mockPersistAutonomySettings).toHaveBeenCalledTimes(3);

    const lowerBound = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ turnBudget: 1 });
    const upperBound = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ turnBudget: 100 });
    expect(lowerBound.body.turnBudget).toBe(1);
    expect(upperBound.body.turnBudget).toBe(100);
    expect(mockPersistAutonomySettings).toHaveBeenLastCalledWith(convo.id, { maxAutonomousTurns: 100 });
  });

  it("rejects invalid turn budgets without changing the stored value", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent, "charterInvalidTurnBudgetUser");
    const convo = await createConversation(agent);

    for (const turnBudget of [-1, 1.5, "25", "not-a-number", 101]) {
      const res = await agent
        .put(`/api/protected/conversations/${convo.id}`)
        .send({ turnBudget });
      expect(res.status).toBe(400);
    }

    const get = await agent.get(`/api/protected/conversations/${convo.id}`);
    expect(get.body.turnBudget).toBe(25);
  });

  it("accepts both numeric turn-budget boundaries", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent, "charterTurnBudgetBoundsUser");
    const convo = await createConversation(agent);

    const minimum = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ turnBudget: 1 });
    expect(minimum.status).toBe(200);
    expect(minimum.body.turnBudget).toBe(1);

    const maximum = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ turnBudget: 100 });
    expect(maximum.status).toBe(200);
    expect(maximum.body.turnBudget).toBe(100);
  });

  it("sets the charter and returns the updated conversation", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent, "charterSetUser");
    const convo = await createConversation(agent);

    const res = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ charter: CHARTER });

    expect(res.status).toBe(200);
    expect(res.body.charter).toBe(CHARTER);

    // Persisted: a fresh GET shows the charter.
    const get = await agent.get(`/api/protected/conversations/${convo.id}`);
    expect(get.status).toBe(200);
    expect(get.body.charter).toBe(CHARTER);
  });

  it("clears the charter with an explicit null", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent, "charterClearUser");
    const convo = await createConversation(agent);
    await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ charter: CHARTER });

    const res = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ charter: null });

    expect(res.status).toBe(200);
    expect(res.body.charter).toBeNull();
    expect(res.body.title).toBe("Test Roundtable"); // untouched by the null charter

    const get = await agent.get(`/api/protected/conversations/${convo.id}`);
    expect(get.body.charter).toBeNull();
  });

  it("rejects a charter over the 2,000-character cap with 400", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent, "charterCapUser");
    const convo = await createConversation(agent);

    const res = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ charter: "x".repeat(2001) });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("2,000");
  });

  it("accepts a charter of exactly 2,000 characters", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent, "charterExactCapUser");
    const convo = await createConversation(agent);

    const res = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ charter: "y".repeat(2000) });

    expect(res.status).toBe(200);
    expect(res.body.charter).toHaveLength(2000);
  });

  it("rejects unknown fields with 400", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent, "charterUnknownUser");
    const convo = await createConversation(agent);

    const res = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ charter: CHARTER, userId: 999 });

    expect(res.status).toBe(400);
  });

  it("rejects an empty body with 400", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent, "charterEmptyUser");
    const convo = await createConversation(agent);

    const res = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 404 for a conversation owned by another user (denied)", async () => {
    const agentA = request.agent(app);
    await registerAndLogin(agentA, "charterOwnerA");
    const convo = await createConversation(agentA, "A's chartered table");

    const agentB = request.agent(app);
    await registerAndLogin(agentB, "charterOwnerB");

    const res = await agentB
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ charter: "hijacked charter" });

    expect(res.status).toBe(404);

    // The owner's charter was not touched.
    const get = await agentA.get(`/api/protected/conversations/${convo.id}`);
    expect(get.body.charter ?? null).toBeNull();
  });

  it("returns 404 for a non-existent conversation", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent, "charterMissingUser");

    const res = await agent
      .put("/api/protected/conversations/999999")
      .send({ title: "Ghost" });

    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MemStorage.updateConversation
// ═══════════════════════════════════════════════════════════════════

describe("MemStorage.updateConversation", () => {
  let mem: MemStorage;
  let convoId: number;

  beforeEach(async () => {
    mem = new MemStorage();
    const convo = await mem.createConversation({ userId: 1, title: "Original" });
    convoId = convo.id;
    expect(convo.turnBudget).toBe(25);
  });

  it("merges provided fields and preserves omitted ones", async () => {
    await mem.updateConversation(convoId, { charter: CHARTER });
    const updated = await mem.updateConversation(convoId, { title: "Renamed" });

    expect(updated).toBeDefined();
    expect(updated!.title).toBe("Renamed");
    expect(updated!.charter).toBe(CHARTER); // omitted charter key preserved
  });

  it("clears the charter with an explicit null", async () => {
    await mem.updateConversation(convoId, { charter: CHARTER });
    const updated = await mem.updateConversation(convoId, { charter: null });

    expect(updated!.charter).toBeNull();
    expect(updated!.title).toBe("Original");
  });

  it("normalizes zero on create and update, and preserves null/omitted update values", async () => {
    const zeroCreated = await mem.createConversation({ userId: 1, title: "No turn cap", turnBudget: 0 });
    const nullCreated = await mem.createConversation({ userId: 1, title: "Nullable cap", turnBudget: null });
    expect(zeroCreated.turnBudget).toBeNull();
    expect(nullCreated.turnBudget).toBeNull();

    expect((await mem.updateConversation(convoId, { turnBudget: 0 }))!.turnBudget).toBeNull();
    expect((await mem.updateConversation(convoId, { turnBudget: null }))!.turnBudget).toBeNull();
    expect((await mem.updateConversation(convoId, { turnBudget: 35 }))!.turnBudget).toBe(35);
    expect((await mem.updateConversation(convoId, { title: "Renamed" }))!.turnBudget).toBe(35);
  });

  it("returns undefined for a missing conversation id", async () => {
    const updated = await mem.updateConversation(999999, { title: "Ghost" });
    expect(updated).toBeUndefined();
  });
});

describe("PostgresStorage conversation turn-budget parity", () => {
  it("defaults new rows and normalizes zero/null while preserving omitted updates", async () => {
    class FakeConversationDb {
      private row: any;
      private nextId = 1;

      insert(table: unknown) {
        if (table !== conversations) throw new Error("Unexpected table");
        return {
          values: (values: any) => ({
            returning: async () => {
              this.row = {
                ...values,
                id: this.nextId++,
                title: values.title ?? "New Conversation",
                charter: values.charter ?? null,
                orchestratorState: null,
                turnBudget: values.turnBudget === undefined ? 25 : values.turnBudget,
                createdAt: new Date(),
              };
              return [{ ...this.row }];
            },
          }),
        };
      }

      update(table: unknown) {
        if (table !== conversations) throw new Error("Unexpected table");
        return {
          set: (updates: any) => ({
            where: () => ({
              returning: async () => {
                if (!this.row) return [];
                this.row = { ...this.row, ...updates };
                return [{ ...this.row }];
              },
            }),
          }),
        };
      }
    }

    const pg = Object.create(PostgresStorage.prototype) as any;
    pg.db = new FakeConversationDb();

    const created = await pg.createConversation({ userId: 1 });
    expect(created.turnBudget).toBe(25);
    expect((await pg.updateConversation(created.id, { turnBudget: 0 })).turnBudget).toBeNull();
    expect((await pg.updateConversation(created.id, { turnBudget: 37 })).turnBudget).toBe(37);
    expect((await pg.updateConversation(created.id, { title: "Preserve budget" })).turnBudget).toBe(37);
    expect((await pg.updateConversation(created.id, { turnBudget: null })).turnBudget).toBeNull();

    const zeroCreated = await pg.createConversation({ userId: 1, turnBudget: 0 });
    expect(zeroCreated.turnBudget).toBeNull();
    const nullCreated = await pg.createConversation({ userId: 1, turnBudget: null });
    expect(nullCreated.turnBudget).toBeNull();
  });
});
