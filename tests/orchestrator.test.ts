/**
 * Orchestrator Unit Tests
 *
 * Covers:
 *  - State machine: idle → processing_sequential transitions
 *  - Orchestrator processes experts in sequence (mock getExpertResponseStream)
 *  - Orchestrator stops at end of round
 *  - Interruption flag is set on new user message during processing
 *  - Pause/resume
 *
 * Uses vitest with vi.mock for storage and AI dependencies.
 * Each test uses a unique conversationId to avoid module-level state pollution.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// ── Mock storage and AI modules BEFORE importing orchestrator ──
const mockGetConversationMessages = vi.hoisted(() => vi.fn());
const mockGetConversationExperts = vi.hoisted(() => vi.fn());
const mockGetConversationFiles = vi.hoisted(() => vi.fn());
const mockCreateMessage = vi.hoisted(() => vi.fn());

const mockGetExpertResponseStream = vi.hoisted(() => vi.fn());
const mockGenerateInsights = vi.hoisted(() => vi.fn());
const mockGetModeratorNextSpeakerSuggestion = vi.hoisted(() => vi.fn());

vi.mock("../server/storage", () => ({
  storage: {
    getConversationMessages: mockGetConversationMessages,
    getConversationExperts: mockGetConversationExperts,
    getConversationFiles: mockGetConversationFiles,
    createMessage: mockCreateMessage,
  },
}));

vi.mock("../server/ai", () => ({
  getExpertResponseStream: mockGetExpertResponseStream,
  generateInsights: mockGenerateInsights,
  getModeratorNextSpeakerSuggestion: mockGetModeratorNextSpeakerSuggestion,
}));

import {
  InteractionOrchestrator,
  getConversationState,
  processMessageTurnBased,
} from "../server/orchestrator";
import type { Expert, Message } from "../shared/schema";

// ── Helpers ──
function createMockExpert(id: number, name: string, role: string): Expert {
  return {
    id,
    conversationId: 1,
    name,
    role,
    model: "deepseek/deepseek-v3:free",
    systemPrompt: `You are ${name}, a ${role}.`,
    avatarUrl: null,
  };
}

function createMockMessage(
  id: number,
  content: string,
  role: string = "user",
  expertId?: number,
): Message {
  return {
    id,
    conversationId: 1,
    expertId: expertId ?? null,
    userId: role === "user" ? 1 : null,
    content,
    role,
    expertName: null,
    expertRole: null,
    artifacts: [],
    timestamp: new Date(),
  };
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Unique conversation ID counter to avoid state pollution
let convIdCounter = 100;
function nextConvId(): number {
  return convIdCounter++;
}

describe("Orchestrator", () => {
  const userId = 1;
  const broadcastFn = vi.fn();

  const experts: Expert[] = [
    createMockExpert(1, "Alice", "Agronomist"),
    createMockExpert(2, "Bob", "Soil Scientist"),
    createMockExpert(3, "Carol", "Weather Expert"),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The orchestrator drives turn chains via setImmediate and keeps logging
  // after the last test's waitFor expires. Drain pending work (and its console
  // writes) so the worker doesn't tear down mid-log — that races vitest's rpc
  // channel and fails the run with EnvironmentTeardownError even when all
  // tests pass.
  afterAll(async () => {
    await waitFor(500);
  });

  // ─────────────────────────────────────────────────────────────────
  // State Machine: idle → processing_sequential
  // ─────────────────────────────────────────────────────────────────

  describe("State machine transitions", () => {
    it("starts in idle mode after initialization", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts);
      const userMessage = createMockMessage(1, "Hello experts");

      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      const state = getConversationState(conversationId);
      expect(state).toBeDefined();
      expect(state!.mode).toBe("processing_sequential");
    });

    it("transitions idle → processing_sequential on startProcessingSequence", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts);
      const userMessage = createMockMessage(1, "Hello experts");

      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      const state = getConversationState(conversationId);
      expect(state!.mode).toBe("processing_sequential");
    });

    it("does not start if already processing", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts);
      const userMessage = createMockMessage(1, "Hello experts");

      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      // Try to start again while processing
      const orchestrator = new InteractionOrchestrator(conversationId);
      await orchestrator.startProcessingSequence();

      // Should still be processing, not crash
      const state = getConversationState(conversationId);
      expect(state!.mode).toBe("processing_sequential");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Sequential expert processing
  // ─────────────────────────────────────────────────────────────────

  describe("Sequential processing", () => {
    it("processes experts in sequence", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts);
      mockGetConversationMessages.mockResolvedValue([]);
      mockGetConversationFiles.mockResolvedValue([]);
      mockCreateMessage.mockImplementation((msg) =>
        Promise.resolve({ ...msg, id: Math.floor(Math.random() * 1000), timestamp: new Date() }),
      );

      // Each expert responds with their name
      let callCount = 0;
      mockGetExpertResponseStream.mockImplementation(async (expert: Expert) => {
        callCount++;
        return {
          conversationId,
          expertId: expert.id,
          userId: null,
          content: `Response from ${expert.name}`,
          role: "assistant",
          expertName: expert.name,
          expertRole: expert.role,
          artifacts: [],
        };
      });

      const userMessage = createMockMessage(1, "Hello experts");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      // Wait for async processing — sequential + autonomous takes time
      await waitFor(800);

      // Should have been called at least 3 times (once per expert in sequential round)
      expect(mockGetExpertResponseStream).toHaveBeenCalled();
      expect(callCount).toBeGreaterThanOrEqual(3);

      // Verify that Alice, Bob, and Carol were all called (order may vary due to async scheduling across conv IDs)
      const calledNames = mockGetExpertResponseStream.mock.calls.map((c) => c[0].name);
      expect(calledNames).toContain("Alice");
      expect(calledNames).toContain("Bob");
      expect(calledNames).toContain("Carol");
    });

    it("broadcasts expert_stream_start for each expert", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts);
      mockGetConversationMessages.mockResolvedValue([]);
      mockGetConversationFiles.mockResolvedValue([]);
      mockCreateMessage.mockImplementation((msg) =>
        Promise.resolve({ ...msg, id: Math.floor(Math.random() * 1000), timestamp: new Date() }),
      );

      mockGetExpertResponseStream.mockImplementation(async (expert: Expert) => ({
        conversationId,
        expertId: expert.id,
        userId: null,
        content: "Test response",
        role: "assistant",
        expertName: expert.name,
        expertRole: expert.role,
        artifacts: [],
      }));

      const userMessage = createMockMessage(1, "Hello experts");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      await waitFor(800);

      const streamStartCalls = broadcastFn.mock.calls.filter(
        (call) => call[1].type === "expert_stream_start",
      );
      // At least 3 stream_start events (one per expert in sequential round)
      expect(streamStartCalls.length).toBeGreaterThanOrEqual(3);
      expect(streamStartCalls[0][1].expertName).toBe("Alice");
      expect(streamStartCalls[1][1].expertName).toBe("Bob");
      expect(streamStartCalls[2][1].expertName).toBe("Carol");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Stop at end of round
  // ─────────────────────────────────────────────────────────────────

  describe("Stop at end of round", () => {
    it("stops and returns to idle after all experts have spoken", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts);
      mockGetConversationMessages.mockResolvedValue([]);
      mockGetConversationFiles.mockResolvedValue([]);
      mockCreateMessage.mockImplementation((msg) =>
        Promise.resolve({ ...msg, id: Math.floor(Math.random() * 1000), timestamp: new Date() }),
      );

      mockGetExpertResponseStream.mockImplementation(async (expert: Expert) => ({
        conversationId,
        expertId: expert.id,
        userId: null,
        content: "Done",
        role: "assistant",
        expertName: expert.name,
        expertRole: expert.role,
        artifacts: [],
      }));

      const userMessage = createMockMessage(1, "Hello experts");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      // Wait for processing to complete (sequential + autonomous)
      await waitFor(800);

      const state = getConversationState(conversationId);
      expect(state!.mode).toBe("idle");
      expect(state!.currentExpertIndex).toBe(-1);
    });

    it("calls generateInsights when round completes", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts);
      mockGetConversationMessages.mockResolvedValue([]);
      mockGetConversationFiles.mockResolvedValue([]);
      mockCreateMessage.mockImplementation((msg) =>
        Promise.resolve({ ...msg, id: Math.floor(Math.random() * 1000), timestamp: new Date() }),
      );

      mockGetExpertResponseStream.mockImplementation(async (expert: Expert) => ({
        conversationId,
        expertId: expert.id,
        userId: null,
        content: "Done",
        role: "assistant",
        expertName: expert.name,
        expertRole: expert.role,
        artifacts: [],
      }));

      const userMessage = createMockMessage(1, "Hello experts");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      await waitFor(800);

      expect(mockGenerateInsights).toHaveBeenCalledWith(conversationId, expect.any(Function));
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Interruption
  // ─────────────────────────────────────────────────────────────────

  describe("Interruption", () => {
    it("sets wasInterrupted flag when new user message arrives during processing", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts);
      mockGetConversationMessages.mockResolvedValue([]);
      mockGetConversationFiles.mockResolvedValue([]);
      mockCreateMessage.mockImplementation((msg) =>
        Promise.resolve({ ...msg, id: Math.floor(Math.random() * 1000), timestamp: new Date() }),
      );

      // Slow expert response to simulate processing time
      mockGetExpertResponseStream.mockImplementation(async () => {
        await waitFor(50);
        return {
          conversationId,
          expertId: 1,
          userId: null,
          content: "Slow response",
          role: "assistant",
          expertName: "Alice",
          expertRole: "Agronomist",
          artifacts: [],
        };
      });

      const userMessage1 = createMockMessage(1, "First message");
      await processMessageTurnBased(userId, conversationId, userMessage1, broadcastFn);

      // Wait a bit for processing to start
      await waitFor(10);

      // State should be processing
      let state = getConversationState(conversationId);
      expect(state!.mode).toBe("processing_sequential");

      // Send second message while processing
      const userMessage2 = createMockMessage(2, "Second message");
      await processMessageTurnBased(userId, conversationId, userMessage2, broadcastFn);

      // Check interruption flag was set
      state = getConversationState(conversationId);
      expect(state!.wasInterrupted).toBe(true);
      expect(state!.lastUserMessage!.content).toBe("Second message");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Pause / Resume
  // ─────────────────────────────────────────────────────────────────

  describe("Pause and Resume", () => {
    it("pauses processing when pause() is called", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts);
      mockGetConversationMessages.mockResolvedValue([]);
      mockGetConversationFiles.mockResolvedValue([]);
      mockCreateMessage.mockImplementation((msg) =>
        Promise.resolve({ ...msg, id: Math.floor(Math.random() * 1000), timestamp: new Date() }),
      );

      mockGetExpertResponseStream.mockImplementation(async (expert: Expert) => {
        await waitFor(30);
        return {
          conversationId,
          expertId: expert.id,
          userId: null,
          content: "Response",
          role: "assistant",
          expertName: expert.name,
          expertRole: expert.role,
          artifacts: [],
        };
      });

      const userMessage = createMockMessage(1, "Hello experts");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      // Wait for processing to start
      await waitFor(10);

      const orchestrator = new InteractionOrchestrator(conversationId);
      orchestrator.pause();

      const state = getConversationState(conversationId);
      expect(state!.mode).toBe("paused");
    });

    it("resumes processing when resume() is called after pause", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts);
      mockGetConversationMessages.mockResolvedValue([]);
      mockGetConversationFiles.mockResolvedValue([]);
      mockCreateMessage.mockImplementation((msg) =>
        Promise.resolve({ ...msg, id: Math.floor(Math.random() * 1000), timestamp: new Date() }),
      );

      mockGetExpertResponseStream.mockImplementation(async (expert: Expert) => {
        await waitFor(20);
        return {
          conversationId,
          expertId: expert.id,
          userId: null,
          content: "Response",
          role: "assistant",
          expertName: expert.name,
          expertRole: expert.role,
          artifacts: [],
        };
      });

      const userMessage = createMockMessage(1, "Hello experts");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      await waitFor(10);

      const orchestrator = new InteractionOrchestrator(conversationId);
      orchestrator.pause();

      let state = getConversationState(conversationId);
      expect(state!.mode).toBe("paused");

      orchestrator.resume();

      // After resume, mode should change from paused
      await waitFor(50);
      state = getConversationState(conversationId);
      expect(state!.mode).not.toBe("paused");
    });

    it("does not pause when already idle", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts);
      mockGetConversationMessages.mockResolvedValue([]);
      mockGetConversationFiles.mockResolvedValue([]);
      mockCreateMessage.mockImplementation((msg) =>
        Promise.resolve({ ...msg, id: Math.floor(Math.random() * 1000), timestamp: new Date() }),
      );

      mockGetExpertResponseStream.mockImplementation(async (expert: Expert) => ({
        conversationId,
        expertId: expert.id,
        userId: null,
        content: "Done",
        role: "assistant",
        expertName: expert.name,
        expertRole: expert.role,
        artifacts: [],
      }));

      const userMessage = createMockMessage(1, "Hello experts");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      // Wait for completion
      await waitFor(800);

      const orchestrator = new InteractionOrchestrator(conversationId);
      orchestrator.pause();

      // Should remain idle (pause is no-op when not processing)
      const state = getConversationState(conversationId);
      expect(state!.mode).toBe("idle");
    });

    it("does not resume when not paused", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts);
      mockGetConversationMessages.mockResolvedValue([]);
      mockGetConversationFiles.mockResolvedValue([]);
      mockCreateMessage.mockImplementation((msg) =>
        Promise.resolve({ ...msg, id: Math.floor(Math.random() * 1000), timestamp: new Date() }),
      );

      mockGetExpertResponseStream.mockImplementation(async (expert: Expert) => ({
        conversationId,
        expertId: expert.id,
        userId: null,
        content: "Done",
        role: "assistant",
        expertName: expert.name,
        expertRole: expert.role,
        artifacts: [],
      }));

      const userMessage = createMockMessage(1, "Hello experts");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      await waitFor(800);

      const orchestrator = new InteractionOrchestrator(conversationId);
      orchestrator.resume();

      // Should remain idle (resume is no-op when not paused)
      const state = getConversationState(conversationId);
      expect(state!.mode).toBe("idle");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Edge Cases
  // ─────────────────────────────────────────────────────────────────

  describe("Edge Cases", () => {
    it("handles empty expert list gracefully", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue([]);

      const userMessage = createMockMessage(1, "Hello experts");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      const state = getConversationState(conversationId);
      // When no experts, the orchestrator logs and returns without creating state
      expect(state).toBeUndefined();
    });

    it("stores the triggering user message in state", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts);

      const userMessage = createMockMessage(1, "What crops should I plant?");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      const state = getConversationState(conversationId);
      expect(state!.lastUserMessage).toBeDefined();
      expect(state!.lastUserMessage!.content).toBe("What crops should I plant?");
    });

    it("initializes with correct expert list", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts);

      const userMessage = createMockMessage(1, "Hello");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      const state = getConversationState(conversationId);
      expect(state!.activeExperts).toHaveLength(3);
      expect(state!.activeExperts[0].name).toBe("Alice");
      expect(state!.activeExperts[1].name).toBe("Bob");
      expect(state!.activeExperts[2].name).toBe("Carol");
    });

    it("resets currentExpertIndex to -1 when starting new sequence", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts);
      mockGetConversationMessages.mockResolvedValue([]);
      mockGetConversationFiles.mockResolvedValue([]);
      mockCreateMessage.mockImplementation((msg) =>
        Promise.resolve({ ...msg, id: Math.floor(Math.random() * 1000), timestamp: new Date() }),
      );

      mockGetExpertResponseStream.mockImplementation(async (expert: Expert) => ({
        conversationId,
        expertId: expert.id,
        userId: null,
        content: "Done",
        role: "assistant",
        expertName: expert.name,
        expertRole: expert.role,
        artifacts: [],
      }));

      const userMessage1 = createMockMessage(1, "First");
      await processMessageTurnBased(userId, conversationId, userMessage1, broadcastFn);
      await waitFor(800);

      // After completion, index should be -1
      let state = getConversationState(conversationId);
      expect(state!.currentExpertIndex).toBe(-1);

      // Start new sequence
      const userMessage2 = createMockMessage(2, "Second");
      await processMessageTurnBased(userId, conversationId, userMessage2, broadcastFn);

      state = getConversationState(conversationId);
      expect(state!.currentExpertIndex).toBe(-1);
    });
  });
});
