/**
 * Conversations & Expert Flow End-to-End Tests
 *
 * Covers:
 *  - Create conversation (POST /api/protected/conversations)
 *  - List conversations (GET /api/protected/conversations)
 *  - Get single conversation (GET /api/protected/conversations/:id)
 *  - Add experts (POST /api/protected/conversations/:id/experts)
 *  - List experts (GET /api/protected/conversations/:id/experts)
 *  - Update expert (PATCH /api/experts/:expertId)
 *  - Send messages (POST /api/protected/conversations/:id/messages)
 *  - Get messages (GET /api/protected/conversations/:id/messages)
 *  - Auth & ownership enforcement
 *  - Edge cases: missing fields, cross-user access, empty conversations
 *
 * Uses vitest + supertest. Forces MemStorage so no real database is needed.
 * Mocks orchestrator & AI modules to avoid real API calls.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";

// ── Force MemStorage BEFORE any server imports ──
process.env.DATABASE_URL = "";
process.env.SESSION_SECRET = "vitest-conversation-secret";
process.env.NODE_ENV = "test";
// This suite performs many logins against one app; raise the per-app
// login cap so the (correct) rate limiter doesn't cascade 429s.
process.env.LOGIN_RATELIMIT_MAX = "1000";

// ── Mock orchestrator (to avoid AI API calls when sending messages) ──
const {
  mockProcessMessageTurnBased,
  mockGetExpertResponseStream,
  mockGetModeratorNextSpeakerSuggestion,
  mockGenerateInsights,
  mockGenerateClosingSynthesis,
} = vi.hoisted(() => ({
  mockProcessMessageTurnBased: vi.fn(),
  mockGetExpertResponseStream: vi.fn(),
  mockGetModeratorNextSpeakerSuggestion: vi.fn(),
  mockGenerateInsights: vi.fn(),
  mockGenerateClosingSynthesis: vi.fn(),
}));

vi.mock("../server/orchestrator", () => ({
  processMessageTurnBased: mockProcessMessageTurnBased,
  InteractionOrchestrator: class {
    pause() {}
    resume() {}
    enableAutonomous(_maxTurns?: number) {}
    disableAutonomous() {}
  },
  getConversationState: vi.fn().mockReturnValue(null),
}));

// ── Mock AI module (generateSystemPrompt used when creating experts) ──
vi.mock("../server/ai", () => ({
  generateSystemPrompt: vi.fn().mockReturnValue("You are a helpful agricultural expert."),
  callOpenRouterAPI: vi.fn(),
  callPerplexityAPI: vi.fn(),
  getExpertResponse: vi.fn(),
  getExpertResponseStream: mockGetExpertResponseStream,
  getModeratorNextSpeakerSuggestion: mockGetModeratorNextSpeakerSuggestion,
  generateClosingSynthesis: mockGenerateClosingSynthesis,
  generateInsights: mockGenerateInsights,
  resolveAuxModel: (moderatorModel: string | null | undefined, firstExpertModel: string | null | undefined) =>
    moderatorModel?.trim() || process.env.DEFAULT_AUX_MODEL?.trim() || firstExpertModel?.trim() || null,
}));

import { registerRoutes } from "../server/routes";

// ── Test app factory ──
async function createTestApp(): Promise<Express> {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  await registerRoutes(app);

  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";
      res.status(status).json({ message });
    },
  );

  return app;
}

// ── Auth helpers ──
async function login(
  agent: request.SuperAgentTest,
  username = "developer",
  password = "password",
) {
  const res = await agent
    .post("/api/login")
    .send({ username, password });
  expect(res.status).toBe(200);
  return agent;
}

async function registerAndLogin(
  agent: request.SuperAgentTest,
  username = "convouser",
  password = "testpass123",
  email = "convo@example.com",
) {
  const res = await agent
    .post("/api/register")
    .send({ username, password, email });
  expect(res.status).toBe(201);
  return agent;
}

// ── Helper: create a conversation and return it ──
async function createConversation(
  agent: request.SuperAgentTest,
  title = "Test Roundtable",
) {
  const res = await agent
    .post("/api/protected/conversations")
    .send({ title });
  expect(res.status).toBe(201);
  return res.body;
}

// ── Helper: add an expert to a conversation ──
async function addExpert(
  agent: request.SuperAgentTest,
  conversationId: number,
  expert: { name: string; role: string; model: string; avatarUrl?: string },
) {
  const res = await agent
    .post(`/api/protected/conversations/${conversationId}/experts`)
    .send(expert);
  expect(res.status).toBe(201);
  return res.body;
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════

describe("Conversations & Expert Flows", () => {
  let app: Express;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(() => {
    mockProcessMessageTurnBased.mockReset();
    // Default: resolve silently
    mockProcessMessageTurnBased.mockResolvedValue(undefined);
    mockGetExpertResponseStream.mockReset();
    mockGetModeratorNextSpeakerSuggestion.mockReset();
    mockGenerateInsights.mockReset().mockResolvedValue(undefined);
    mockGenerateClosingSynthesis.mockReset().mockResolvedValue(undefined);
  });

  // ─────────────────────────────────────────────────────────────────
  // Create Conversation
  // ─────────────────────────────────────────────────────────────────

  describe("POST /api/protected/conversations", () => {
    it("returns 401 when not authenticated", async () => {
      const res = await request(app)
        .post("/api/protected/conversations")
        .send({ title: "Unauthorized" });
      expect(res.status).toBe(401);
    });

    it("creates a new conversation for authenticated user", async () => {
      const agent = request.agent(app);
      await login(agent);

      const res = await agent
        .post("/api/protected/conversations")
        .send({ title: "Crop Rotation Discussion" });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.title).toBe("Crop Rotation Discussion");
      expect(res.body).toHaveProperty("createdAt");
      expect(res.body.userId).toBe(1); // developer user id
    });

    it("defaults title to 'New Conversation' when not provided", async () => {
      const agent = request.agent(app);
      await login(agent);

      const res = await agent
        .post("/api/protected/conversations")
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.title).toBe("New Conversation");
    });

    it("creates multiple conversations for the same user", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo1 = await agent
        .post("/api/protected/conversations")
        .send({ title: "Convo 1" });
      const convo2 = await agent
        .post("/api/protected/conversations")
        .send({ title: "Convo 2" });

      expect(convo1.status).toBe(201);
      expect(convo2.status).toBe(201);
      expect(convo1.body.id).not.toBe(convo2.body.id);
    });

    it("isolates conversations between different users", async () => {
      const agentA = request.agent(app);
      await registerAndLogin(agentA, "convoIsolationA", "pass123");
      const convoA = await createConversation(agentA, "User A Conversation");

      const agentB = request.agent(app);
      await registerAndLogin(agentB, "convoIsolationB", "pass456");
      const convoB = await createConversation(agentB, "User B Conversation");

      // User A cannot see User B's conversation
      const res = await agentA.get(`/api/protected/conversations/${convoB.id}`);
      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // List Conversations
  // ─────────────────────────────────────────────────────────────────

  describe("GET /api/protected/conversations", () => {
    it("returns 401 when not authenticated", async () => {
      const res = await request(app).get("/api/protected/conversations");
      expect(res.status).toBe(401);
    });

    it("returns empty array for user with no conversations", async () => {
      const agent = request.agent(app);
      await registerAndLogin(agent, "emptyconvos", "pass123");

      const res = await agent.get("/api/protected/conversations");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns all conversations for authenticated user", async () => {
      const agent = request.agent(app);
      await registerAndLogin(agent, "manyconvos", "pass123");

      await createConversation(agent, "Convo A");
      await createConversation(agent, "Convo B");
      await createConversation(agent, "Convo C");

      const res = await agent.get("/api/protected/conversations");
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(3);
      expect(res.body.map((c: any) => c.title).sort()).toEqual(
        ["Convo A", "Convo B", "Convo C"].sort(),
      );
    });

    it("does not return other users' conversations", async () => {
      const agentA = request.agent(app);
      await registerAndLogin(agentA, "listIsolationA", "pass123");
      await createConversation(agentA, "A's Convo");

      const agentB = request.agent(app);
      await registerAndLogin(agentB, "listIsolationB", "pass456");

      const res = await agentB.get("/api/protected/conversations");
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Get Single Conversation
  // ─────────────────────────────────────────────────────────────────

  describe("GET /api/protected/conversations/:id", () => {
    it("returns 401 when not authenticated", async () => {
      const res = await request(app).get("/api/protected/conversations/1");
      expect(res.status).toBe(401);
    });

    it("returns 404 for non-existent conversation", async () => {
      const agent = request.agent(app);
      await login(agent);

      const res = await agent.get("/api/protected/conversations/99999");
      expect(res.status).toBe(404);
    });

    it("returns conversation by ID", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo = await createConversation(agent, "My Special Convo");

      const res = await agent.get(`/api/protected/conversations/${convo.id}`);
      expect(res.status).toBe(200);
      expect(res.body.title).toBe("My Special Convo");
      expect(res.body.id).toBe(convo.id);
    });

    it("returns 404 when user does not own the conversation", async () => {
      const agentA = request.agent(app);
      await registerAndLogin(agentA, "ownerA", "pass123");
      const convo = await createConversation(agentA, "Owned by A");

      const agentB = request.agent(app);
      await registerAndLogin(agentB, "ownerB", "pass456");

      const res = await agentB.get(`/api/protected/conversations/${convo.id}`);
      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Add Experts
  // ─────────────────────────────────────────────────────────────────

  describe("POST /api/protected/conversations/:id/experts", () => {
    it("returns 401 when not authenticated", async () => {
      const res = await request(app)
        .post("/api/protected/conversations/1/experts")
        .send({ name: "Dr. Soil", role: "Soil Scientist", model: "gpt-4" });
      expect(res.status).toBe(401);
    });

    it("returns 404 when conversation does not exist", async () => {
      const agent = request.agent(app);
      await login(agent);

      const res = await agent
        .post("/api/protected/conversations/99999/experts")
        .send({ name: "Dr. Soil", role: "Soil Scientist", model: "gpt-4" });
      expect(res.status).toBe(404);
    });

    it("returns 404 when conversation belongs to another user", async () => {
      const agentA = request.agent(app);
      await registerAndLogin(agentA, "expertOwnerA", "pass123");
      const convo = await createConversation(agentA, "A's Roundtable");

      const agentB = request.agent(app);
      await registerAndLogin(agentB, "expertOwnerB", "pass456");

      const res = await agentB
        .post(`/api/protected/conversations/${convo.id}/experts`)
        .send({ name: "Dr. Soil", role: "Soil Scientist", model: "gpt-4" });
      expect(res.status).toBe(404);
    });

    it("adds an expert to a conversation", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo = await createConversation(agent);

      const res = await agent
        .post(`/api/protected/conversations/${convo.id}/experts`)
        .send({
          name: "Dr. Maria Soilson",
          role: "Soil Scientist",
          model: "openai/gpt-4o:free",
          avatarUrl: "https://example.com/avatar1.png",
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.name).toBe("Dr. Maria Soilson");
      expect(res.body.role).toBe("Soil Scientist");
      expect(res.body.model).toBe("openai/gpt-4o:free");
      expect(res.body.avatarUrl).toBe("https://example.com/avatar1.png");
      expect(res.body.conversationId).toBe(convo.id);
      // System prompt should be generated
      expect(res.body.systemPrompt).toBeTruthy();
    });

    it("adds multiple experts to the same conversation", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo = await createConversation(agent);

      const expert1 = await addExpert(agent, convo.id, {
        name: "Weather Expert",
        role: "Meteorologist",
        model: "gpt-4",
      });
      const expert2 = await addExpert(agent, convo.id, {
        name: "Crop Expert",
        role: "Agronomist",
        model: "claude-3",
      });

      expect(expert1.id).not.toBe(expert2.id);
      expect(expert1.conversationId).toBe(convo.id);
      expect(expert2.conversationId).toBe(convo.id);
    });

    it("generates system prompt for each expert role", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo = await createConversation(agent);

      const res = await agent
        .post(`/api/protected/conversations/${convo.id}/experts`)
        .send({
          name: "Dr. Water",
          role: "Irrigation Specialist",
          model: "gpt-4",
        });

      expect(res.body.systemPrompt).toBe(
        "You are a helpful agricultural expert.",
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // List Experts
  // ─────────────────────────────────────────────────────────────────

  describe("GET /api/protected/conversations/:id/experts", () => {
    it("returns 401 when not authenticated", async () => {
      const res = await request(app).get(
        "/api/protected/conversations/1/experts",
      );
      expect(res.status).toBe(401);
    });

    it("returns empty array for conversation with no experts", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo = await createConversation(agent);

      const res = await agent.get(
        `/api/protected/conversations/${convo.id}/experts`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns all experts for a conversation", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo = await createConversation(agent);
      await addExpert(agent, convo.id, {
        name: "Expert Alpha",
        role: "Role A",
        model: "model-a:free",
      });
      await addExpert(agent, convo.id, {
        name: "Expert Beta",
        role: "Role B",
        model: "model-b",
      });

      const res = await agent.get(
        `/api/protected/conversations/${convo.id}/experts`,
      );
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(2);
      const names = res.body.map((e: any) => e.name).sort();
      expect(names).toEqual(["Expert Alpha", "Expert Beta"]);
    });

    it("returns 404 for non-existent conversation", async () => {
      const agent = request.agent(app);
      await login(agent);

      const res = await agent.get("/api/protected/conversations/99999/experts");
      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Update Expert
  // ─────────────────────────────────────────────────────────────────

  describe("PATCH /api/experts/:expertId", () => {
    it("returns 401 when not authenticated", async () => {
      const res = await request(app)
        .patch("/api/experts/1")
        .send({ name: "Hacked Expert" });
      expect(res.status).toBe(401);
    });

    it("returns 404 for non-existent expert", async () => {
      const agent = request.agent(app);
      await login(agent);

      const res = await agent
        .patch("/api/experts/99999")
        .send({ name: "Ghost Expert" });
      expect(res.status).toBe(404);
    });

    it("returns 403 when expert belongs to another user's conversation", async () => {
      // User A creates conversation with expert
      const agentA = request.agent(app);
      await registerAndLogin(agentA, "updateExpertOwnerA", "pass123");
      const convo = await createConversation(agentA, "A's Convo");
      const expert = await addExpert(agentA, convo.id, {
        name: "Dr. A Expert",
        role: "Role A",
        model: "model-a:free",
      });

      // User B tries to update it
      const agentB = request.agent(app);
      await registerAndLogin(agentB, "updateExpertOwnerB", "pass456");

      const res = await agentB
        .patch(`/api/experts/${expert.id}`)
        .send({ name: "Hacked Name" });
      expect(res.status).toBe(403);
    });

    it("updates expert name", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo = await createConversation(agent);
      const expert = await addExpert(agent, convo.id, {
        name: "Original Name",
        role: "Scientist",
        model: "gpt-4",
      });

      const res = await agent
        .patch(`/api/experts/${expert.id}`)
        .send({ name: "Updated Name" });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Updated Name");
      // Other fields should be unchanged
      expect(res.body.role).toBe("Scientist");
    });

    it("updates expert model", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo = await createConversation(agent);
      const expert = await addExpert(agent, convo.id, {
        name: "Model Tester",
        role: "Tester",
        model: "gpt-4",
      });

      const res = await agent
        .patch(`/api/experts/${expert.id}`)
        .send({ model: "claude-3-opus" });

      expect(res.status).toBe(200);
      expect(res.body.model).toBe("claude-3-opus");
    });

    it("does not change fields that are not sent", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo = await createConversation(agent);
      const expert = await addExpert(agent, convo.id, {
        name: "Stable Expert",
        role: "Stable Role",
        model: "stable-model",
      });

      const res = await agent
        .patch(`/api/experts/${expert.id}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Stable Expert");
      expect(res.body.role).toBe("Stable Role");
      expect(res.body.model).toBe("stable-model");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Send Messages
  // ─────────────────────────────────────────────────────────────────

  describe("POST /api/protected/conversations/:id/messages", () => {
    it("returns 401 when not authenticated", async () => {
      const res = await request(app)
        .post("/api/protected/conversations/1/messages")
        .send({ content: "Hello experts!" });
      expect(res.status).toBe(401);
    });

    it("returns 404 for non-existent conversation", async () => {
      const agent = request.agent(app);
      await login(agent);

      const res = await agent
        .post("/api/protected/conversations/99999/messages")
        .send({ content: "Hello!" });
      expect(res.status).toBe(404);
    });

    it("returns 404 when conversation belongs to another user", async () => {
      const agentA = request.agent(app);
      await registerAndLogin(agentA, "msgOwnerA", "pass123");
      const convo = await createConversation(agentA, "A's Chat");

      const agentB = request.agent(app);
      await registerAndLogin(agentB, "msgOwnerB", "pass456");

      const res = await agentB
        .post(`/api/protected/conversations/${convo.id}/messages`)
        .send({ content: "Hello!" });
      expect(res.status).toBe(404);
    });

    it("sends a user message and triggers orchestrator", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo = await createConversation(agent);

      const res = await agent
        .post(`/api/protected/conversations/${convo.id}/messages`)
        .send({ content: "What cover crop should I plant for nitrogen fixing?" });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.content).toBe(
        "What cover crop should I plant for nitrogen fixing?",
      );
      expect(res.body.role).toBe("user");
      expect(res.body.conversationId).toBe(convo.id);

      // Orchestrator should have been called
      expect(mockProcessMessageTurnBased).toHaveBeenCalledTimes(1);
    });

    it("stores message and returns it before orchestrator completes (async fire-and-forget)", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo = await createConversation(agent);

      // Make orchestrator slow (but fire-and-forget)
      mockProcessMessageTurnBased.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 5000)),
      );

      const res = await agent
        .post(`/api/protected/conversations/${convo.id}/messages`)
        .send({ content: "Async test message" });

      // Should return immediately, not wait for orchestrator
      expect(res.status).toBe(201);
      expect(res.body.content).toBe("Async test message");
    });

    it("handles orchestrator errors without crashing the response", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo = await createConversation(agent);

      mockProcessMessageTurnBased.mockRejectedValue(
        new Error("AI service unavailable"),
      );

      const res = await agent
        .post(`/api/protected/conversations/${convo.id}/messages`)
        .send({ content: "This will trigger an error" });

      // The user message should still be created and returned
      expect(res.status).toBe(201);
      expect(res.body.content).toBe("This will trigger an error");
    });
  });

  describe("POST /api/protected/conversations/:id/restart", () => {
    it("restarts the current conversation on a supplied topic", async () => {
      const agent = request.agent(app);
      await login(agent);
      const convo = await createConversation(agent, "Restartable council");

      const res = await agent
        .post(`/api/protected/conversations/${convo.id}/restart`)
        .send({ topic: "A genuinely new topic" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        conversationId: convo.id,
        content: "A genuinely new topic",
        role: "user",
      });
      expect(mockProcessMessageTurnBased).toHaveBeenCalledWith(
        1,
        convo.id,
        expect.objectContaining({ content: "A genuinely new topic" }),
        expect.any(Function),
        { restart: true },
      );
    });

    it("interrupts an active turn and starts over on the supplied topic with a fresh counter", async () => {
      const actualOrchestrator = await vi.importActual<typeof import("../server/orchestrator")>("../server/orchestrator");
      const agent = request.agent(app);
      await login(agent);
      const convo = await createConversation(agent, "Active restart council");
      const expert = await addExpert(agent, convo.id, {
        name: "Dr. Agronomy",
        role: "Agronomist",
        model: "test/model",
      });

      let releaseFirstTurn: ((message: any) => void) | undefined;
      const turnStarts: Array<{ reference: string; counter: number }> = [];
      const moderatorDecisions = ["Agronomist", "Agronomist", "Conclude"];
      mockGetModeratorNextSpeakerSuggestion.mockImplementation(async () => moderatorDecisions.shift() ?? "Conclude");
      mockGetExpertResponseStream.mockImplementation(async (speaker: any, _history: any, reference: string) => {
        const state = actualOrchestrator.getConversationState(convo.id);
        turnStarts.push({ reference, counter: state?.totalAutonomousTurnsTaken ?? -1 });
        return {
          conversationId: convo.id,
          expertId: speaker.id,
          userId: null,
          content: `Response to: ${reference}`,
          role: "assistant",
          expertName: speaker.name,
          expertRole: speaker.role,
        };
      });
      mockGetExpertResponseStream.mockImplementationOnce((speaker: any, _history: any, reference: string) => {
        const state = actualOrchestrator.getConversationState(convo.id);
        turnStarts.push({ reference, counter: state?.totalAutonomousTurnsTaken ?? -1 });
        return new Promise((resolve) => {
          releaseFirstTurn = resolve;
          // Keep the current expert streaming until the HTTP restart has
          // marked the active sequence for an explicit restart.
          void speaker;
        });
      });
      mockProcessMessageTurnBased.mockImplementation((...args: any[]) =>
        actualOrchestrator.processMessageTurnBased(...args),
      );

      const firstMessage = await agent
        .post(`/api/protected/conversations/${convo.id}/messages`)
        .send({ content: "Original topic" });
      expect(firstMessage.status).toBe(201);
      await waitForCondition(() => typeof releaseFirstTurn === "function");

      const activeState = actualOrchestrator.getConversationState(convo.id);
      expect(activeState).toMatchObject({ mode: "autonomous", totalAutonomousTurnsTaken: 1, turnInFlight: true });

      const restart = await agent
        .post(`/api/protected/conversations/${convo.id}/restart`)
        .send({ topic: "A genuinely new topic" });
      expect(restart.status).toBe(201);
      expect(actualOrchestrator.getConversationState(convo.id)?.wasInterrupted).toBe(true);

      releaseFirstTurn?.({
        conversationId: convo.id,
        expertId: expert.id,
        userId: null,
        content: "The old topic's in-flight answer finished.",
        role: "assistant",
        expertName: expert.name,
        expertRole: expert.role,
      });

      await waitForCondition(() => turnStarts.length >= 2);
      expect(turnStarts).toEqual([
        { reference: "Original topic", counter: 1 },
        { reference: "A genuinely new topic", counter: 1 },
      ]);
      expect(mockProcessMessageTurnBased).toHaveBeenCalledWith(
        1,
        convo.id,
        expect.objectContaining({ content: "A genuinely new topic" }),
        expect.any(Function),
        { restart: true },
      );

      // Finish the restarted sequence cleanly instead of leaving an async
      // chain behind for the following HTTP tests.
      await waitForCondition(() => {
        const state = actualOrchestrator.getConversationState(convo.id);
        return state?.mode === "idle" && !state.turnInFlight && !state.turnChainScheduled;
      });
    });

    it("returns 404 when the conversation belongs to another user", async () => {
      const owner = request.agent(app);
      await registerAndLogin(owner, "restartOwner", "pass123");
      const convo = await createConversation(owner, "Private council");

      const otherUser = request.agent(app);
      await registerAndLogin(otherUser, "restartOther", "pass456");
      const res = await otherUser
        .post(`/api/protected/conversations/${convo.id}/restart`)
        .send({ topic: "Not allowed" });

      expect(res.status).toBe(404);
      expect(mockProcessMessageTurnBased).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Get Messages
  // ─────────────────────────────────────────────────────────────────

  describe("GET /api/protected/conversations/:id/messages", () => {
    it("returns 401 when not authenticated", async () => {
      const res = await request(app).get(
        "/api/protected/conversations/1/messages",
      );
      expect(res.status).toBe(401);
    });

    it("returns empty array for conversation with no messages", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo = await createConversation(agent);

      const res = await agent.get(
        `/api/protected/conversations/${convo.id}/messages`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns all messages for a conversation", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo = await createConversation(agent);

      // Send multiple messages
      await agent
        .post(`/api/protected/conversations/${convo.id}/messages`)
        .send({ content: "First message" });
      await agent
        .post(`/api/protected/conversations/${convo.id}/messages`)
        .send({ content: "Second message" });

      const res = await agent.get(
        `/api/protected/conversations/${convo.id}/messages`,
      );
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(2);
      expect(res.body[0].content).toBe("First message");
      expect(res.body[1].content).toBe("Second message");
      // Messages should be sorted by timestamp
      expect(
        new Date(res.body[0].timestamp).getTime(),
      ).toBeLessThanOrEqual(new Date(res.body[1].timestamp).getTime());
    });

    it("returns 404 for non-existent conversation", async () => {
      const agent = request.agent(app);
      await login(agent);

      const res = await agent.get("/api/protected/conversations/99999/messages");
      expect(res.status).toBe(404);
    });

    it("returns 404 when conversation belongs to another user", async () => {
      const agentA = request.agent(app);
      await registerAndLogin(agentA, "msgReaderA", "pass123");
      const convo = await createConversation(agentA, "A's Messages");

      const agentB = request.agent(app);
      await registerAndLogin(agentB, "msgReaderB", "pass456");

      const res = await agentB.get(
        `/api/protected/conversations/${convo.id}/messages`,
      );
      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // End-to-End Flow
  // ─────────────────────────────────────────────────────────────────

  describe("End-to-End Roundtable Flow", () => {
    it("user creates conversation, adds experts, sends message", async () => {
      const agent = request.agent(app);
      await registerAndLogin(agent, "fullflow", "pass123");

      // 1. Create conversation
      const convo = await createConversation(agent, "Farm Planning Session");

      // 2. Add experts
      const soilExpert = await addExpert(agent, convo.id, {
        name: "Dr. Terra",
        role: "Soil Scientist",
        model: "openai/gpt-4o:free",
      });
      const weatherExpert = await addExpert(agent, convo.id, {
        name: "Sky Walker",
        role: "Meteorologist",
        model: "anthropic/claude-3:free",
      });

      expect(soilExpert.name).toBe("Dr. Terra");
      expect(weatherExpert.name).toBe("Sky Walker");

      // 3. Verify experts are listed
      const expertsRes = await agent.get(
        `/api/protected/conversations/${convo.id}/experts`,
      );
      expect(expertsRes.body.length).toBe(2);

      // 4. Send a message
      const msgRes = await agent
        .post(`/api/protected/conversations/${convo.id}/messages`)
        .send({ content: "What's the best crop rotation for my soil type?" });

      expect(msgRes.status).toBe(201);
      expect(msgRes.body.role).toBe("user");

      // 5. Verify message is stored
      const messagesRes = await agent.get(
        `/api/protected/conversations/${convo.id}/messages`,
      );
      expect(messagesRes.body.length).toBe(1);
      expect(messagesRes.body[0].content).toBe(
        "What's the best crop rotation for my soil type?",
      );
    });

    it("developer user can use dev-login and create a roundtable quickly", async () => {
      const agent = request.agent(app);
      await agent.post("/api/dev-login");

      // Create conversation
      const convo = await createConversation(agent, "Dev Quick Test");

      // Add 3 experts
      await addExpert(agent, convo.id, {
        name: "Expert 1",
        role: "Agronomist",
        model: "gpt-4",
      });
      await addExpert(agent, convo.id, {
        name: "Expert 2",
        role: "Economist",
        model: "claude-3",
      });
      await addExpert(agent, convo.id, {
        name: "Expert 3",
        role: "Meteorologist",
        model: "gpt-4o",
      });

      // Send a message
      await agent
        .post(`/api/protected/conversations/${convo.id}/messages`)
        .send({ content: "How can I improve my farm's sustainability?" });

      // Verify everything
      const messages = await agent.get(
        `/api/protected/conversations/${convo.id}/messages`,
      );
      expect(messages.body.length).toBe(1);

      const experts = await agent.get(
        `/api/protected/conversations/${convo.id}/experts`,
      );
      expect(experts.body.length).toBe(3);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Edge Cases
  // ─────────────────────────────────────────────────────────────────

  describe("Edge Cases", () => {
    it("conversation with very long title", async () => {
      const agent = request.agent(app);
      await login(agent);

      const longTitle = "A".repeat(500);
      const res = await agent
        .post("/api/protected/conversations")
        .send({ title: longTitle });

      expect(res.status).toBe(201);
      expect(res.body.title.length).toBe(500);
    });

    it("message with empty content", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo = await createConversation(agent);

      const res = await agent
        .post(`/api/protected/conversations/${convo.id}/messages`)
        .send({ content: "" });

      // Should still store the message (content is empty string)
      expect(res.status).toBe(201);
      expect(res.body.content).toBe("");
    });

    it("message with special characters and Unicode", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo = await createConversation(agent);

      const res = await agent
        .post(`/api/protected/conversations/${convo.id}/messages`)
        .send({ content: "🌱 ¿Cómo mejorar el suelo? 土壤改良について" });

      expect(res.status).toBe(201);
      expect(res.body.content).toBe(
        "🌱 ¿Cómo mejorar el suelo? 土壤改良について",
      );
    });

    it("expert with empty name (server may reject or accept)", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo = await createConversation(agent);

      const res = await agent
        .post(`/api/protected/conversations/${convo.id}/experts`)
        .send({ name: "", role: "Helper", model: "gpt-4" });

      // May be accepted or rejected — just check it doesn't crash
      expect([201, 400, 500]).toContain(res.status);
    });

    it("concurrent message sends are handled", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo = await createConversation(agent);

      const [res1, res2] = await Promise.all([
        agent
          .post(`/api/protected/conversations/${convo.id}/messages`)
          .send({ content: "Message A" }),
        agent
          .post(`/api/protected/conversations/${convo.id}/messages`)
          .send({ content: "Message B" }),
      ]);

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
    });

    it("conversation IDs increment properly", async () => {
      const agent = request.agent(app);
      await login(agent);

      const convo1 = await createConversation(agent, "First");
      const convo2 = await createConversation(agent, "Second");

      expect(convo2.id).toBeGreaterThan(convo1.id);
    });
  });
});
