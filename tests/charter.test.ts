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

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";

// ── Force MemStorage BEFORE any server imports ──
process.env.DATABASE_URL = "";
process.env.SESSION_SECRET = "vitest-charter-secret";
process.env.NODE_ENV = "test";
process.env.LOGIN_RATELIMIT_MAX = "1000";

// ── Mock orchestrator (routes import it; never let it reach the AI layer) ──
const { mockProcessMessageTurnBased, mockSetTurnBudget } = vi.hoisted(() => ({
  mockProcessMessageTurnBased: vi.fn(),
  mockSetTurnBudget: vi.fn(),
}));

vi.mock("../server/orchestrator", () => ({
  processMessageTurnBased: mockProcessMessageTurnBased,
  InteractionOrchestrator: class {
    pause() {}
    resume() {}
    enableAutonomous(_maxTurns?: number) {}
    disableAutonomous() {}
    setTurnBudget(turnBudget: number | null) { mockSetTurnBudget(turnBudget); }
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

  it("trims the charter content in the prompt", () => {
    const prompt = generateSystemPrompt(expert, roles, undefined, undefined, `  ${CHARTER}  `);
    expect(prompt).toContain(`\n${CHARTER}\n`);
    expect(prompt).not.toContain(`  ${CHARTER}  `);
  });

  it("asks experts to log farmer-only questions and proceed on an assumption", () => {
    const prompt = generateSystemPrompt(expert, roles);
    expect(prompt).toContain("@[User] <question>?");
    expect(prompt).toContain("beginning Assuming <reasonable assumption>");
    expect(prompt).toContain("without waiting for the farmer to answer");
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

  beforeEach(() => mockSetTurnBudget.mockReset());

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
    expect(mockSetTurnBudget).toHaveBeenCalledWith(40);

    const omitted = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ title: "Budget preserved" });
    expect(omitted.status).toBe(200);
    expect(omitted.body.turnBudget).toBe(40);
    expect(mockSetTurnBudget).toHaveBeenCalledTimes(1);

    const zero = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ turnBudget: 0 });
    expect(zero.status).toBe(200);
    expect(zero.body.turnBudget).toBeNull();
    expect(mockSetTurnBudget).toHaveBeenLastCalledWith(null);

    const explicitNull = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ turnBudget: null });
    expect(explicitNull.status).toBe(200);
    expect(explicitNull.body.turnBudget).toBeNull();
    expect(mockSetTurnBudget).toHaveBeenCalledTimes(3);

    const lowerBound = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ turnBudget: 1 });
    const upperBound = await agent
      .put(`/api/protected/conversations/${convo.id}`)
      .send({ turnBudget: 100 });
    expect(lowerBound.body.turnBudget).toBe(1);
    expect(upperBound.body.turnBudget).toBe(100);
    expect(mockSetTurnBudget).toHaveBeenLastCalledWith(100);
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
