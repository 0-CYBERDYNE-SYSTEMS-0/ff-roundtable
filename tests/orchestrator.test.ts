/**
 * Orchestrator Unit Tests
 *
 * Covers:
 *  - State machine: idle → processing_sequential transitions
 *  - Orchestrator processes experts in sequence (mock getExpertResponseStream)
 *  - Orchestrator stops at end of round
 *  - Interruption flag is set on new user message during processing
 *  - Pause/resume
 *  - G5: semantic conclusion (Moderator 'Conclude' → closing synthesis,
 *    budget untouched, inert in sequential mode, interrupts still win)
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
// G7: the orchestrator persists snapshots through these; default no-ops here,
// with dedicated coverage in tests/orchestrator-recovery.test.ts.
const mockGetConversation = vi.hoisted(() => vi.fn());
const mockUpdateConversation = vi.hoisted(() => vi.fn());

const mockGetExpertResponseStream = vi.hoisted(() => vi.fn());
const mockGenerateInsights = vi.hoisted(() => vi.fn());
const mockGetModeratorNextSpeakerSuggestion = vi.hoisted(() => vi.fn());
const mockGenerateClosingSynthesis = vi.hoisted(() => vi.fn());

vi.mock("../server/storage", () => ({
  storage: {
    getConversation: mockGetConversation,
    updateConversation: mockUpdateConversation,
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
  generateClosingSynthesis: mockGenerateClosingSynthesis,
}));

// G7 snapshot persistence defaults: no stored snapshot, writes succeed.
// clearAllMocks() clears calls only, so these survive every test.
mockGetConversation.mockResolvedValue(undefined);
mockUpdateConversation.mockResolvedValue(undefined);

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
  mentions?: string[],
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
    mentions: mentions ?? null,
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

  // Wait (bounded) until the conversation state reaches the given mode.
  async function waitForMode(conversationId: number, mode: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = getConversationState(conversationId);
      if (s && s.mode === mode) return;
      await waitFor(10);
    }
    throw new Error(`Timed out waiting for mode "${mode}" on conversation ${conversationId}`);
  }

  // Deterministic turn gating for the G1/G2 regression tests: every expert
  // turn of `conversationId` parks until the test releases it, so pause and
  // steering can be exercised at exact points in the loop. Turns for other
  // conversations (leftover chains from earlier tests) park forever and can
  // never interfere.
  function setupGatedConversation(conversationId: number) {
    const myExperts = experts.map((e) => ({ ...e, conversationId }));
    mockGetConversationExperts.mockResolvedValue(myExperts);
    mockGetConversationFiles.mockResolvedValue([]);

    const messages: Message[] = [];
    let messageId = 10_000 + conversationId * 50;
    mockGetConversationMessages.mockImplementation((cid: number) =>
      Promise.resolve(messages.filter((m) => m.conversationId === cid)),
    );
    mockCreateMessage.mockImplementation((msg: Partial<Message>) => {
      const stored = { ...msg, id: messageId++, timestamp: new Date() } as Message;
      messages.push(stored);
      return Promise.resolve(stored);
    });

    const gates: Array<() => void> = [];
    let turnsStarted = 0;
    let contentCounter = 0;
    mockGetExpertResponseStream.mockImplementation((expert: Expert) => {
      if (expert.conversationId !== conversationId) {
        return new Promise(() => {}); // park foreign chains forever
      }
      turnsStarted++;
      return new Promise((resolve) => {
        // Unique content per turn keeps the redundancy early-stop out of play.
        const content = `Distinct answer ${++contentCounter} from ${expert.name}`;
        gates.push(() =>
          resolve({
            conversationId: expert.conversationId,
            expertId: expert.id,
            userId: null,
            content,
            role: "assistant",
            expertName: expert.name,
            expertRole: expert.role,
            artifacts: [],
          }),
        );
      });
    });

    const waitForTurns = async (n: number) => {
      const deadline = Date.now() + 5000;
      while (turnsStarted < n) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${n} turns to start (got ${turnsStarted})`);
        }
        await waitFor(5);
      }
    };

    const releaseNextTurn = async () => {
      const deadline = Date.now() + 5000;
      while (gates.length === 0) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for a turn to release");
        await waitFor(5);
      }
      gates.shift()!();
    };

    // Release turns until the sequence returns to idle.
    const drainToIdle = async () => {
      for (let i = 0; i < 25; i++) {
        const s = getConversationState(conversationId);
        if (!s || s.mode === "idle") return;
        if (gates.length > 0) gates.shift()!();
        await waitFor(10);
      }
    };

    const assistantCount = () =>
      messages.filter((m) => m.conversationId === conversationId && m.role === "assistant").length;

    return { waitForTurns, releaseNextTurn, drainToIdle, assistantCount, turnsStarted: () => turnsStarted };
  }

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

  // ─────────────────────────────────────────────────────────────────
  // F2 — Redundancy early-stop in autonomous mode
  // ─────────────────────────────────────────────────────────────────

  describe("F2 redundancy early-stop", () => {
    function mockHistoryBackedStorage() {
      // Conversation-aware backing store (leftover orchestrator chains from
      // earlier tests keep running on their own conversation IDs, so neither
      // the history nor turn counts may be global).
      const messages: Message[] = [];
      let messageId = 100;
      mockGetConversationMessages.mockImplementation((conversationId: number) =>
        Promise.resolve(messages.filter((m) => m.conversationId === conversationId)),
      );
      mockCreateMessage.mockImplementation((msg: Partial<Message>) => {
        const stored = { ...msg, id: messageId++, timestamp: new Date() } as Message;
        messages.push(stored);
        return Promise.resolve(stored);
      });
      return (conversationId: number) =>
        messages.filter((m) => m.conversationId === conversationId && m.role === "assistant").length;
    }

    it("stops the autonomous sequence early on a near-identical repeat of a prior expert message", async () => {
      const conversationId = nextConvId();
      // Experts bound to THIS conversation: the mock returns
      // expert.conversationId, so leftover chains from earlier tests (whose
      // loops keep running on their own conversation IDs) can never pollute
      // this conversation's stored-message counts.
      const myExperts = experts.map((e) => ({ ...e, conversationId }));
      mockGetConversationExperts.mockResolvedValue(myExperts);
      mockGetConversationFiles.mockResolvedValue([]);
      const assistantTurns = mockHistoryBackedStorage();

      const sequentialContents: Record<string, string> = {
        Alice: "Lime this field at two tons per acre and retest the soil in spring",
        Bob: "Tile drainage would fix the wet spot in the north corner",
        Carol: "Frost risk stays low for the next ten days in your county",
      };

      mockGetExpertResponseStream.mockImplementation(async (expert: Expert) => {
        // Autonomous turn (after the 3 sequential turns): near-identical to
        // Alice's sequential message — only the final word differs (0.875 sim).
        const content =
          assistantTurns(conversationId) >= 3
            ? "Lime this field at two tons per acre and retest the soil in autumn"
            : sequentialContents[expert.name];
        return {
          conversationId: expert.conversationId,
          expertId: expert.id,
          userId: null,
          content,
          role: "assistant",
          expertName: expert.name,
          expertRole: expert.role,
          artifacts: [],
        };
      });

      const userMessage = createMockMessage(1, "What should I do about the field?");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      await waitFor(800);

      // Exactly the sequential round (3) + ONE autonomous turn (the redundant
      // one) — the sequence stopped before the maxAutonomousTurns cap of 6.
      expect(assistantTurns(conversationId)).toBe(4);

      const state = getConversationState(conversationId);
      expect(state!.mode).toBe("idle");
      // Same cleanup as a natural end.
      expect(state!.totalAutonomousTurnsTaken).toBe(0);
      expect(mockGenerateInsights).toHaveBeenCalledWith(conversationId, expect.any(Function));
    });

    it("lets the autonomous sequence run to the cap when contributions stay distinct", async () => {
      const conversationId = nextConvId();
      const myExperts = experts.map((e) => ({ ...e, conversationId }));
      mockGetConversationExperts.mockResolvedValue(myExperts);
      mockGetConversationFiles.mockResolvedValue([]);
      const assistantTurns = mockHistoryBackedStorage();

      mockGetExpertResponseStream.mockImplementation(async (expert: Expert) => ({
        conversationId: expert.conversationId,
        expertId: expert.id,
        userId: null,
        content: `Response number ${assistantTurns(conversationId) + 1} from ${expert.name} with fresh vocabulary`,
        role: "assistant",
        expertName: expert.name,
        expertRole: expert.role,
        artifacts: [],
      }));

      const userMessage = createMockMessage(1, "Let's discuss rotation planning");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      await waitFor(1000);

      // 3 sequential + maxAutonomousTurns (3 experts * 2 = 6) — never cut early.
      expect(assistantTurns(conversationId)).toBe(9);
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // G1 — Steering: send immediately, server-side interrupt
  // ─────────────────────────────────────────────────────────────────

  describe("G1 steering", () => {
    it("broadcasts {type:'steering'} when a message arrives mid-autonomous, finishes the current expert, and restarts the round on the new message", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, drainToIdle, assistantCount } =
        setupGatedConversation(conversationId);

      const userMessage1 = createMockMessage(1, "First question");
      await processMessageTurnBased(userId, conversationId, userMessage1, broadcastFn);

      // Run the sequential round (Alice, Bob, Carol) to completion.
      await waitForTurns(1);
      await releaseNextTurn();
      await waitForTurns(2);
      await releaseNextTurn();
      await waitForTurns(3);
      await releaseNextTurn();

      // Autonomous phase: wait for its first turn to be in flight.
      await waitForMode(conversationId, "autonomous");
      await waitForTurns(4);

      // Steering: a new message arrives mid-autonomous-turn.
      const userMessage2 = createMockMessage(2, "Steering question");
      await processMessageTurnBased(userId, conversationId, userMessage2, broadcastFn);

      // Interrupt flagged, newest message stored, steering broadcast sent.
      let state = getConversationState(conversationId);
      expect(state!.wasInterrupted).toBe(true);
      expect(state!.lastUserMessage!.content).toBe("Steering question");
      expect(broadcastFn).toHaveBeenCalledWith(conversationId, { type: "steering" });

      const assistantAtInterrupt = assistantCount();

      // The in-flight expert finishes, then a fresh sequential round starts.
      await releaseNextTurn();
      await waitForMode(conversationId, "processing_sequential");

      const eventsAfterSteering = (type: string) => {
        const all = broadcastFn.mock.calls.filter((c) => c[0] === conversationId);
        const idx = all.findIndex((c) => c[1]?.type === "steering");
        expect(idx).toBeGreaterThanOrEqual(0);
        return all.slice(idx + 1).filter((c) => c[1]?.type === type).map((c) => c[1]);
      };

      // The streaming expert completed after the steering signal...
      expect(eventsAfterSteering("expert_stream_done").length).toBeGreaterThanOrEqual(1);

      // ...and the restarted round runs the full sequential roster on the new message.
      await waitForTurns(5); // Alice (restart)
      await releaseNextTurn();
      await waitForTurns(6); // Bob
      await releaseNextTurn();
      await waitForTurns(7); // Carol
      await releaseNextTurn();

      expect(eventsAfterSteering("expert_stream_start").map((e) => e.expertName)).toEqual([
        "Alice",
        "Bob",
        "Carol",
      ]);

      // A full fresh sequential round ran on the steering message, plus the
      // autonomous turn that was allowed to finish first.
      expect(assistantCount()).toBe(assistantAtInterrupt + 4);

      // Drain the autonomous extension; the sequence ends idle.
      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // G2 — Disable Auto mid-round ends naturally (never pauses)
  // ─────────────────────────────────────────────────────────────────

  describe("G2 disableAutonomous", () => {
    it("ends the sequence naturally at idle with insights (no paused state) when autonomous is disabled mid-round", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, assistantCount } =
        setupGatedConversation(conversationId);

      const userMessage = createMockMessage(1, "First question");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      await waitForTurns(1);
      await releaseNextTurn();
      await waitForTurns(2);
      await releaseNextTurn();
      await waitForTurns(3);
      await releaseNextTurn();
      await waitForMode(conversationId, "autonomous");
      await waitForTurns(4);

      new InteractionOrchestrator(conversationId).disableAutonomous();

      // No pause: the round keeps running so the current expert can finish.
      let state = getConversationState(conversationId);
      expect(state!.mode).toBe("autonomous");
      expect(state!.isAutonomousEnabled).toBe(false);

      await releaseNextTurn(); // the in-flight turn completes

      await waitForMode(conversationId, "idle");
      state = getConversationState(conversationId);
      expect(state!.mode).toBe("idle");
      expect(state!.pausedFromMode).toBeNull();
      // The current expert finished; no further autonomous turns ran.
      expect(assistantCount()).toBe(4);
      expect(mockGenerateInsights).toHaveBeenCalledWith(conversationId, expect.any(Function));
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // G2 — Message while paused = implicit resume-and-restart
  // ─────────────────────────────────────────────────────────────────

  describe("G2 paused deadlock", () => {
    it("restarts the sequence on a new message while paused with no turn in flight", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, drainToIdle, assistantCount } =
        setupGatedConversation(conversationId);

      const userMessage1 = createMockMessage(1, "First question");
      await processMessageTurnBased(userId, conversationId, userMessage1, broadcastFn);
      await waitForTurns(1); // first sequential turn is streaming

      const orchestrator = new InteractionOrchestrator(conversationId);
      orchestrator.pause();
      expect(getConversationState(conversationId)!.mode).toBe("paused");

      // The in-flight turn completes and the loop parks — no next turn.
      await releaseNextTurn();
      await waitFor(30);
      let state = getConversationState(conversationId);
      expect(state!.mode).toBe("paused");
      expect(state!.turnInFlight).toBe(false);

      // A message while parked brings the council back to life immediately.
      const userMessage2 = createMockMessage(2, "Wake back up");
      await processMessageTurnBased(userId, conversationId, userMessage2, broadcastFn);

      state = getConversationState(conversationId);
      expect(state!.mode).toBe("idle"); // reset synchronously before the restart is scheduled

      // The restart re-processes the new message: a fresh sequential round runs.
      await waitForMode(conversationId, "processing_sequential");
      await waitForTurns(2); // Alice
      await releaseNextTurn();
      await waitForTurns(3); // Bob
      await releaseNextTurn();
      await waitForTurns(4); // Carol
      await releaseNextTurn();
      expect(assistantCount()).toBe(4); // parked-round turn + full restarted round

      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("interrupts after the in-flight turn and restarts on the new message when a message arrives while paused mid-turn", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, drainToIdle, assistantCount } =
        setupGatedConversation(conversationId);

      const userMessage1 = createMockMessage(1, "First question");
      await processMessageTurnBased(userId, conversationId, userMessage1, broadcastFn);
      await waitForTurns(1); // first sequential turn is streaming

      const orchestrator = new InteractionOrchestrator(conversationId);
      orchestrator.pause();

      // Message arrives while the turn is STILL streaming.
      const userMessage2 = createMockMessage(2, "Change of plans");
      await processMessageTurnBased(userId, conversationId, userMessage2, broadcastFn);

      let state = getConversationState(conversationId);
      expect(state!.mode).toBe("paused"); // the running loop owns the transition
      expect(state!.turnInFlight).toBe(true);
      expect(state!.wasInterrupted).toBe(true);
      expect(state!.lastUserMessage!.content).toBe("Change of plans");

      // The in-flight turn finishes; the loop resets to idle and restarts on
      // the new message.
      await releaseNextTurn();
      await waitForMode(conversationId, "processing_sequential");
      state = getConversationState(conversationId);
      expect(state!.wasInterrupted).toBe(false);
      expect(state!.lastUserMessage!.content).toBe("Change of plans");

      await waitForTurns(2); // Alice
      await releaseNextTurn();
      await waitForTurns(3); // Bob
      await releaseNextTurn();
      await waitForTurns(4); // Carol
      await releaseNextTurn();
      expect(assistantCount()).toBe(4);

      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // B-review — red-team regressions
  // ─────────────────────────────────────────────────────────────────

  describe("B-review race conditions", () => {
    it("does not double-drive the loop when pause()+resume() land mid-turn (single turn chain)", async () => {
      const conversationId = nextConvId();
      // Broadcast hook: on the first expert_stream_done (fired synchronously
      // inside the loop, before its next-turn scheduling), call pause() then
      // resume() back-to-back. That is exactly the window where resume()'s
      // scheduled chain and the loop's own next-turn scheduling are both
      // pending — two chains must not run concurrently.
      let hookFired = false;
      const hookedBroadcast = vi.fn((cid: number, data: any) => {
        broadcastFn(cid, data);
        if (cid === conversationId && data?.type === "expert_stream_done" && !hookFired) {
          hookFired = true;
          const orchestrator = new InteractionOrchestrator(conversationId);
          orchestrator.pause();
          orchestrator.resume();
        }
      });
      const { waitForTurns, releaseNextTurn, drainToIdle, assistantCount, turnsStarted } =
        setupGatedConversation(conversationId);

      const userMessage = createMockMessage(1, "First question");
      await processMessageTurnBased(userId, conversationId, userMessage, hookedBroadcast);
      await waitForTurns(1); // first sequential turn is streaming

      // Keep the sequence bounded at the sequential round.
      new InteractionOrchestrator(conversationId).disableAutonomous();

      // Alice's turn completes; the hook fires pause+resume inside the
      // loop's own continuation.
      await releaseNextTurn();
      await waitForTurns(2); // exactly one follow-up turn (Bob) may start

      // The duplicate chain (if any) would start Carol's turn while Bob is
      // still gated — no third turn may begin before Bob is released.
      await waitFor(60);
      expect(turnsStarted()).toBe(2);

      await releaseNextTurn(); // Bob
      await waitForTurns(3); // Carol
      await releaseNextTurn();

      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
      // Exactly one turn per expert: the pause/resume race must not
      // double-drive the loop into concurrent chains.
      expect(assistantCount()).toBe(3);
      await waitFor(80); // a stray duplicate chain would surface as extra turns
      expect(assistantCount()).toBe(3);
      expect(turnsStarted()).toBe(3);
    });

    it("resume after autonomous was disabled while paused ends the sequence without running another expert turn", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, assistantCount } =
        setupGatedConversation(conversationId);

      const userMessage = createMockMessage(1, "First question");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      // Complete the sequential round; park on the first autonomous turn.
      await waitForTurns(1);
      await releaseNextTurn();
      await waitForTurns(2);
      await releaseNextTurn();
      await waitForTurns(3);
      await releaseNextTurn();
      await waitForMode(conversationId, "autonomous");
      await waitForTurns(4);

      const orchestrator = new InteractionOrchestrator(conversationId);
      orchestrator.pause();
      await releaseNextTurn(); // the in-flight autonomous turn completes
      await waitFor(30);
      expect(getConversationState(conversationId)!.mode).toBe("paused"); // parked

      // Auto off while parked, then resume: the documented G2 contract is
      // "the sequence ends naturally once the current expert finishes" —
      // with no expert streaming, resume must not bill one more turn.
      orchestrator.disableAutonomous();
      orchestrator.resume();

      await waitForMode(conversationId, "idle");
      expect(assistantCount()).toBe(4); // 3 sequential + 1 autonomous, nothing more
      expect(mockGenerateInsights).toHaveBeenCalledWith(conversationId, expect.any(Function));
    });

    it("finishes the sequential round and ends at idle (never autonomous) when autonomous is disabled mid-sequential-round", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, drainToIdle, assistantCount } =
        setupGatedConversation(conversationId);

      const userMessage = createMockMessage(1, "First question");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);
      await waitForTurns(1); // Alice is streaming

      new InteractionOrchestrator(conversationId).disableAutonomous();
      expect(getConversationState(conversationId)!.isAutonomousEnabled).toBe(false);

      await releaseNextTurn(); // Alice finishes
      await waitForTurns(2); // Bob
      await releaseNextTurn();
      // Mid-round check: still sequential — the disable must not wedge or
      // transition the phase.
      expect(getConversationState(conversationId)!.mode).toBe("processing_sequential");
      await waitForTurns(3); // Carol
      await releaseNextTurn();

      await drainToIdle();
      const state = getConversationState(conversationId)!;
      expect(state.mode).toBe("idle");
      expect(assistantCount()).toBe(3); // sequential round is never cut
      expect(mockGenerateInsights).toHaveBeenCalledWith(conversationId, expect.any(Function));
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // G4 — Mention mechanics: routing, selective wake, ping-pong guard
  // ─────────────────────────────────────────────────────────────────

  describe("G4 mention mechanics", () => {
    // Gated conversation whose expert messages carry G4 mentions: the
    // resolver decides which roles each speaker tags. Everything else
    // mirrors setupGatedConversation above (unique content per turn keeps
    // the redundancy early-stop out of play).
    function setupGatedMentionConversation(
      conversationId: number,
      roster: Expert[],
      mentionsFor: (expert: Expert) => string[],
    ) {
      const myExperts = roster.map((e) => ({ ...e, conversationId }));
      mockGetConversationExperts.mockResolvedValue(myExperts);
      mockGetConversationFiles.mockResolvedValue([]);

      const messages: Message[] = [];
      let messageId = 20_000 + conversationId * 50;
      mockGetConversationMessages.mockImplementation((cid: number) =>
        Promise.resolve(messages.filter((m) => m.conversationId === cid)),
      );
      mockCreateMessage.mockImplementation((msg: Partial<Message>) => {
        const stored = { ...msg, id: messageId++, timestamp: new Date() } as Message;
        messages.push(stored);
        return Promise.resolve(stored);
      });

      const gates: Array<() => void> = [];
      const startedNames: string[] = [];
      let contentCounter = 0;
      mockGetExpertResponseStream.mockImplementation((expert: Expert) => {
        if (expert.conversationId !== conversationId) {
          return new Promise(() => {}); // park foreign chains forever
        }
        startedNames.push(expert.name);
        return new Promise((resolve) => {
          const content = `Distinct answer ${++contentCounter} from ${expert.name}`;
          gates.push(() =>
            resolve({
              conversationId: expert.conversationId,
              expertId: expert.id,
              userId: null,
              content,
              role: "assistant",
              expertName: expert.name,
              expertRole: expert.role,
              artifacts: [],
              mentions: mentionsFor(expert),
            }),
          );
        });
      });

      const waitForTurns = async (n: number) => {
        const deadline = Date.now() + 5000;
        while (startedNames.length < n) {
          if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${n} turns to start (got ${startedNames.length})`);
          }
          await waitFor(5);
        }
      };

      const releaseNextTurn = async () => {
        const deadline = Date.now() + 5000;
        while (gates.length === 0) {
          if (Date.now() > deadline) throw new Error("Timed out waiting for a turn to release");
          await waitFor(5);
        }
        gates.shift()!();
      };

      // Release turns until the sequence returns to idle.
      const drainToIdle = async () => {
        for (let i = 0; i < 25; i++) {
          const s = getConversationState(conversationId);
          if (!s || s.mode === "idle") return;
          if (gates.length > 0) gates.shift()!();
          await waitFor(10);
        }
      };

      return { waitForTurns, releaseNextTurn, drainToIdle, turnNames: () => [...startedNames] };
    }

    it("mention-routes the next autonomous speaker without asking the Moderator", async () => {
      const conversationId = nextConvId();
      const roster = [
        createMockExpert(1, "Alice", "Agronomist"),
        createMockExpert(2, "Bob", "Soil Scientist"),
        createMockExpert(3, "Carol", "Weather Expert"),
        createMockExpert(4, "Matt", "Moderator"),
      ];
      // Only the Moderator tags anyone: his closing sequential message hands
      // the floor to the Soil Scientist.
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames } =
        setupGatedMentionConversation(conversationId, roster, (e) =>
          e.role === "Moderator" ? ["Soil Scientist"] : [],
        );

      const userMessage = createMockMessage(1, "Plan my week");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      // Full sequential round: Alice, Bob, Carol, Matt (Moderator speaks last).
      for (let i = 1; i <= 4; i++) {
        await waitForTurns(i);
        await releaseNextTurn();
      }

      await waitForMode(conversationId, "autonomous");
      await waitForTurns(5);

      // Mention-routed: Matt tagged the Soil Scientist, so Bob speaks next —
      // round-robin would have picked Alice (index 0) — and the Moderator
      // mock was never consulted for the routing decision.
      expect(turnNames()[4]).toBe("Bob");
      expect(mockGetModeratorNextSpeakerSuggestion).not.toHaveBeenCalled();

      await releaseNextTurn();
      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("falls back to round-robin when the same pair trades mentions a third consecutive time", async () => {
      const conversationId = nextConvId();
      const roster = [
        createMockExpert(1, "Alice", "Agronomist"),
        createMockExpert(2, "Bob", "Soil Scientist"),
        createMockExpert(3, "Carol", "Weather Expert"),
      ];
      // Carol always tags Bob and Bob always tags Carol — a pure ping-pong.
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames } =
        setupGatedMentionConversation(conversationId, roster, (e) =>
          e.role === "Weather Expert"
            ? ["Soil Scientist"]
            : e.role === "Soil Scientist"
              ? ["Weather Expert"]
              : [],
        );

      const userMessage = createMockMessage(1, "Discuss drainage");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      // Sequential round is mention-blind: Alice, Bob, Carol in roster order.
      for (let i = 1; i <= 3; i++) {
        await waitForTurns(i);
        expect(turnNames()[i - 1]).toBe(["Alice", "Bob", "Carol"][i - 1]);
        await releaseNextTurn();
      }

      await waitForMode(conversationId, "autonomous");
      await waitForTurns(4); // auto #1: Carol's message tags Soil Scientist → Bob (route 1)
      expect(turnNames()[3]).toBe("Bob");
      await releaseNextTurn();
      await waitForTurns(5); // auto #2: Bob tags Weather Expert → Carol (route 2, same pair)
      expect(turnNames()[4]).toBe("Carol");
      await releaseNextTurn();
      await waitForTurns(6); // auto #3: guard trips → round-robin → Alice, NOT Bob again
      expect(turnNames()[5]).toBe("Alice");

      await releaseNextTurn();
      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("narrows the sequential round to the addressed experts and keeps the autonomous extension council-wide", async () => {
      const conversationId = nextConvId();
      const roster = [
        createMockExpert(1, "Alice", "Agronomist"),
        createMockExpert(2, "Bob", "Soil Scientist"),
        createMockExpert(3, "Carol", "Weather Expert"),
      ];
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames } =
        setupGatedMentionConversation(conversationId, roster, () => []);

      const userMessage = createMockMessage(
        1,
        "@[Weather Expert] and @[Soil Scientist] please weigh in",
        "user",
        undefined,
        // NOT roster order on purpose — the round must run in roster order.
        ["Weather Expert", "Soil Scientist"],
      );
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      // Only the addressed experts speak, in roster order (Bob before Carol).
      await waitForTurns(1);
      expect(turnNames()[0]).toBe("Bob");
      await releaseNextTurn();
      await waitForTurns(2);
      expect(turnNames()[1]).toBe("Carol");
      await releaseNextTurn();

      // Autonomous extension runs over the FULL council: Alice — not
      // addressed by the user — takes the first autonomous turn.
      await waitForMode(conversationId, "autonomous");
      await waitForTurns(3);
      expect(turnNames()[2]).toBe("Alice");

      await releaseNextTurn();
      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("runs the full round when the user mentions only stale/unknown roles", async () => {
      const conversationId = nextConvId();
      const roster = [
        createMockExpert(1, "Alice", "Agronomist"),
        createMockExpert(2, "Bob", "Soil Scientist"),
        createMockExpert(3, "Carol", "Weather Expert"),
      ];
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames } =
        setupGatedMentionConversation(conversationId, roster, () => []);

      const userMessage = createMockMessage(
        1,
        "@[Rocket Scientist] thoughts?",
        "user",
        undefined,
        ["Rocket Scientist"], // not in the roster — must fall back to all
      );
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      await waitForTurns(1);
      expect(turnNames()[0]).toBe("Alice");
      await releaseNextTurn();
      await waitForTurns(2);
      expect(turnNames()[1]).toBe("Bob");
      await releaseNextTurn();
      await waitForTurns(3);
      expect(turnNames()[2]).toBe("Carol");
      await releaseNextTurn();

      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("re-narrows the round when a steering message carries new mentions (interrupted restart inherits them)", async () => {
      const conversationId = nextConvId();
      const roster = [
        createMockExpert(1, "Alice", "Agronomist"),
        createMockExpert(2, "Bob", "Soil Scientist"),
        createMockExpert(3, "Carol", "Weather Expert"),
      ];
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames } =
        setupGatedMentionConversation(conversationId, roster, () => []);

      const userMessage1 = createMockMessage(1, "First question"); // no mentions → full round
      await processMessageTurnBased(userId, conversationId, userMessage1, broadcastFn);
      await waitForTurns(1); // Alice streaming
      await releaseNextTurn();
      await waitForTurns(2); // Bob streaming

      // Steer mid-round with a message that addresses one expert only.
      const userMessage2 = createMockMessage(
        2,
        "@[Weather Expert] actually just you",
        "user",
        undefined,
        ["Weather Expert"],
      );
      await processMessageTurnBased(userId, conversationId, userMessage2, broadcastFn);
      expect(broadcastFn).toHaveBeenCalledWith(conversationId, { type: "steering" });

      await releaseNextTurn(); // Bob (in-flight) finishes
      await waitForMode(conversationId, "processing_sequential");

      // The restarted round contains ONLY the addressed expert.
      await waitForTurns(3);
      expect(turnNames()[2]).toBe("Carol");
      await releaseNextTurn();

      // Round of one ends; the autonomous extension is council-wide again.
      await waitForMode(conversationId, "autonomous");
      await waitForTurns(4);
      expect(turnNames()[3]).toBe("Alice");

      await releaseNextTurn();
      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // G5 — Semantic conclusion: Moderator 'Conclude' + closing synthesis
  // ─────────────────────────────────────────────────────────────────

  describe("G5 semantic conclusion", () => {
    // Gated conversation whose roster includes a Moderator: the autonomous
    // extension consults the (mocked) Moderator for the next speaker, so a
    // 'Conclude' verdict can be exercised at an exact point in the loop.
    // Everything else mirrors setupGatedConversation above (unique content
    // per turn keeps the redundancy early-stop out of play).
    function setupGatedModeratorConversation(conversationId: number) {
      const roster: Expert[] = [
        createMockExpert(1, "Alice", "Agronomist"),
        createMockExpert(2, "Bob", "Soil Scientist"),
        createMockExpert(3, "Carol", "Weather Expert"),
        createMockExpert(4, "Matt", "Moderator"),
      ];
      const myExperts = roster.map((e) => ({ ...e, conversationId }));
      mockGetConversationExperts.mockResolvedValue(myExperts);
      mockGetConversationFiles.mockResolvedValue([]);

      const messages: Message[] = [];
      let messageId = 30_000 + conversationId * 50;
      mockGetConversationMessages.mockImplementation((cid: number) =>
        Promise.resolve(messages.filter((m) => m.conversationId === cid)),
      );
      mockCreateMessage.mockImplementation((msg: Partial<Message>) => {
        const stored = { ...msg, id: messageId++, timestamp: new Date() } as Message;
        messages.push(stored);
        return Promise.resolve(stored);
      });

      const gates: Array<() => void> = [];
      const startedNames: string[] = [];
      let contentCounter = 0;
      mockGetExpertResponseStream.mockImplementation((expert: Expert) => {
        if (expert.conversationId !== conversationId) {
          return new Promise(() => {}); // park foreign chains forever
        }
        startedNames.push(expert.name);
        return new Promise((resolve) => {
          const content = `Distinct answer ${++contentCounter} from ${expert.name}`;
          gates.push(() =>
            resolve({
              conversationId: expert.conversationId,
              expertId: expert.id,
              userId: null,
              content,
              role: "assistant",
              expertName: expert.name,
              expertRole: expert.role,
              artifacts: [],
            }),
          );
        });
      });

      const waitForTurns = async (n: number) => {
        const deadline = Date.now() + 5000;
        while (startedNames.length < n) {
          if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${n} turns to start (got ${startedNames.length})`);
          }
          await waitFor(5);
        }
      };

      const releaseNextTurn = async () => {
        const deadline = Date.now() + 5000;
        while (gates.length === 0) {
          if (Date.now() > deadline) throw new Error("Timed out waiting for a turn to release");
          await waitFor(5);
        }
        gates.shift()!();
      };

      // Release turns until the sequence returns to idle.
      const drainToIdle = async () => {
        for (let i = 0; i < 25; i++) {
          const s = getConversationState(conversationId);
          if (!s || s.mode === "idle") return;
          if (gates.length > 0) gates.shift()!();
          await waitFor(10);
        }
      };

      const assistantCount = () =>
        messages.filter((m) => m.conversationId === conversationId && m.role === "assistant").length;
      const synthesisMessages = () =>
        messages.filter((m) => m.conversationId === conversationId && m.isSynthesis === true);
      const events = () =>
        broadcastFn.mock.calls.filter((c) => c[0] === conversationId).map((c) => c[1]);

      // Wait (bounded) for a broadcast of the given type. Mode can flip
      // autonomous → idle within a few microtasks when every mock resolves
      // immediately, so event signals are the reliable synchronization point.
      const waitForEvent = async (type: string, timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (broadcastFn.mock.calls.some((c) => c[0] === conversationId && c[1]?.type === type)) return;
          await waitFor(5);
        }
        throw new Error(`Timed out waiting for a "${type}" broadcast on conversation ${conversationId}`);
      };

      return {
        roster,
        waitForTurns,
        releaseNextTurn,
        drainToIdle,
        turnNames: () => [...startedNames],
        assistantCount,
        synthesisMessages,
        events,
        waitForEvent,
      };
    }

    // Emulates the real generateClosingSynthesis contract at the orchestrator
    // boundary: broadcast expert_stream_start → tokens → store an isSynthesis
    // message → expert_stream_done. `onStream` runs mid-stream (after start,
    // before the tokens) so tests can land interrupts at an exact point.
    function mockSynthesisTurn(conversationId: number, onStream?: () => Promise<void> | void) {
      mockGenerateClosingSynthesis.mockImplementation(
        async (cid: number, moderator: Expert, broadcast: (c: number, data: any) => void) => {
          if (cid !== conversationId) return;
          broadcast(cid, {
            type: "expert_stream_start",
            expertId: moderator.id,
            expertName: moderator.name,
            expertRole: "Moderator",
          });
          if (onStream) await onStream();
          for (const token of ["Consensus: lime in spring. ", "Next: retest the soil. "]) {
            broadcast(cid, { type: "expert_stream_token", expertId: moderator.id, token });
          }
          const stored = await mockCreateMessage({
            conversationId: cid,
            expertId: moderator.id,
            userId: null,
            content: "Consensus: lime in spring. Next: retest the soil.",
            role: "assistant",
            expertName: moderator.name,
            expertRole: "Moderator",
            isSynthesis: true,
            mentions: [],
          });
          broadcast(cid, { type: "expert_stream_done", expertId: moderator.id, message: stored });
        },
      );
    }

    it("streams a closing synthesis when the Moderator says 'Conclude' and ends the sequence at idle", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames, assistantCount, synthesisMessages, events, waitForEvent } =
        setupGatedModeratorConversation(conversationId);
      mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("Conclude");
      mockSynthesisTurn(conversationId);

      const userMessage = createMockMessage(1, "Plan my week");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      // Full sequential round: Alice, Bob, Carol, Matt (Moderator speaks last).
      for (let i = 1; i <= 4; i++) {
        await waitForTurns(i);
        await releaseNextTurn();
      }

      // First autonomous decision: the Moderator concludes — no 5th expert
      // turn ever starts; the synthesis streams and the sequence ends.
      await waitForEvent("concluding");
      await waitForMode(conversationId, "idle");

      // The concluding signal was broadcast...
      expect(broadcastFn).toHaveBeenCalledWith(conversationId, { type: "concluding", conversationId });

      // ...the synthesis turn streamed under the Moderator's identity
      // (start → tokens → done) after the concluding signal...
      const allEvents = events();
      const concludingIdx = allEvents.findIndex((e) => e.type === "concluding");
      expect(concludingIdx).toBeGreaterThanOrEqual(0);
      const startsBeforeConcluding = allEvents
        .slice(0, concludingIdx)
        .filter((e) => e.type === "expert_stream_start");
      expect(startsBeforeConcluding).toHaveLength(4); // the sequential round only
      const synthesisStart = allEvents
        .slice(concludingIdx + 1)
        .find((e) => e.type === "expert_stream_start");
      expect(synthesisStart).toMatchObject({ expertId: 4, expertName: "Matt", expertRole: "Moderator" });
      const synthesisTokens = allEvents
        .slice(concludingIdx + 1)
        .filter((e) => e.type === "expert_stream_token" && e.expertId === 4);
      expect(synthesisTokens.length).toBeGreaterThanOrEqual(1);
      const synthesisDone = allEvents
        .slice(concludingIdx + 1)
        .find((e) => e.type === "expert_stream_done");
      expect(synthesisDone?.message?.isSynthesis).toBe(true);

      // ...the synthesis message is stored flagged as synthesis...
      const stored = synthesisMessages();
      expect(stored).toHaveLength(1);
      expect(stored[0].role).toBe("assistant");
      expect(stored[0].expertRole).toBe("Moderator");
      expect(stored[0].isSynthesis).toBe(true);

      // ...exactly the sequential round ran (no extra expert turn)...
      expect(turnNames()).toEqual(["Alice", "Bob", "Carol", "Matt"]);
      expect(assistantCount()).toBe(5); // 4 expert turns + 1 synthesis

      // ...and the sequence ended through the natural-end cleanup.
      const state = getConversationState(conversationId)!;
      expect(state.mode).toBe("idle");
      expect(state.currentExpertIndex).toBe(-1);
      expect(state.totalAutonomousTurnsTaken).toBe(0);
      expect(mockGenerateInsights).toHaveBeenCalledWith(conversationId, expect.any(Function));

      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("does not let the closing synthesis consume the autonomous turn budget", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames, assistantCount, synthesisMessages } =
        setupGatedModeratorConversation(conversationId);
      // The Moderator routes the first autonomous turn to Alice, then calls
      // the round on the next decision.
      mockGetModeratorNextSpeakerSuggestion
        .mockResolvedValueOnce("Agronomist")
        .mockResolvedValue("Conclude");

      // Snapshot the budget at the moment the synthesis streams: one real
      // autonomous turn (Alice) must have been billed, the synthesis none.
      let counterAtSynthesis: number | null = null;
      mockSynthesisTurn(conversationId, () => {
        counterAtSynthesis = getConversationState(conversationId)!.totalAutonomousTurnsTaken;
      });

      const userMessage = createMockMessage(1, "Plan my week");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);
      // Tight cap: one autonomous turn fits before the Moderator concludes.
      new InteractionOrchestrator(conversationId).enableAutonomous(2);

      // Sequential round (4 turns), then autonomous turn #1 (Alice).
      for (let i = 1; i <= 4; i++) {
        await waitForTurns(i);
        await releaseNextTurn();
      }
      await waitForMode(conversationId, "autonomous");
      await waitForTurns(5);
      await releaseNextTurn();

      // Next decision: the Moderator concludes while the budget shows one
      // used turn of two — the synthesis must not bill a second.
      await waitForMode(conversationId, "idle");

      expect(counterAtSynthesis).toBe(1);
      expect(synthesisMessages()).toHaveLength(1);
      // 4 sequential + 1 autonomous expert turn + 1 synthesis. A synthesis
      // billed against the cap would have pushed the loop to the cap first.
      expect(turnNames()).toEqual(["Alice", "Bob", "Carol", "Matt", "Alice"]);
      expect(assistantCount()).toBe(6);
      const state = getConversationState(conversationId)!;
      expect(state.mode).toBe("idle");
      expect(state.totalAutonomousTurnsTaken).toBe(0);

      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("ignores 'Conclude' in sequential mode — the round completes fully", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames, assistantCount, synthesisMessages, events } =
        setupGatedModeratorConversation(conversationId);
      // Would conclude if the Moderator were ever consulted — he must not be.
      mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("Conclude");
      mockSynthesisTurn(conversationId);

      const userMessage = createMockMessage(1, "Plan my week");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);
      // Autonomous off: the sequence ends after the sequential round.
      new InteractionOrchestrator(conversationId).disableAutonomous();

      for (let i = 1; i <= 4; i++) {
        await waitForTurns(i);
        await releaseNextTurn();
      }
      await waitForMode(conversationId, "idle");

      // The Moderator was never asked, no conclusion was signalled, and no
      // synthesis was streamed or stored.
      expect(mockGetModeratorNextSpeakerSuggestion).not.toHaveBeenCalled();
      expect(mockGenerateClosingSynthesis).not.toHaveBeenCalled();
      expect(events().some((e) => e.type === "concluding")).toBe(false);
      expect(synthesisMessages()).toHaveLength(0);
      expect(turnNames()).toEqual(["Alice", "Bob", "Carol", "Matt"]);
      expect(assistantCount()).toBe(4);
      expect(getConversationState(conversationId)!.mode).toBe("idle");

      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("lets an interrupt landing during the closing synthesis win — the queued message restarts a fresh round", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames, assistantCount, synthesisMessages, waitForEvent } =
        setupGatedModeratorConversation(conversationId);
      mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("Conclude");

      // A user message arrives while the synthesis is streaming: the
      // interrupt must win over the conclude — the synthesis message stays,
      // and the queued message restarts a full sequential round.
      let interruptFired = false;
      mockSynthesisTurn(conversationId, async () => {
        if (interruptFired) return;
        interruptFired = true;
        await processMessageTurnBased(
          userId,
          conversationId,
          createMockMessage(2, "Wait — one more thing"),
          broadcastFn,
        );
      });

      const userMessage = createMockMessage(1, "Plan my week");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      for (let i = 1; i <= 4; i++) {
        await waitForTurns(i);
        await releaseNextTurn();
      }

      // Synthesis streams, the interrupt lands mid-stream (its steering
      // broadcast is the synchronization point), the sequence ends and
      // restarts on the queued message.
      await waitForEvent("steering");
      await waitForMode(conversationId, "processing_sequential");
      let state = getConversationState(conversationId)!;
      expect(state.wasInterrupted).toBe(false); // consumed by the restart
      expect(state.lastUserMessage!.content).toBe("Wait — one more thing");
      expect(synthesisMessages()).toHaveLength(1); // the interrupted synthesis is kept

      // The restarted round runs the full roster on the new message.
      for (let i = 5; i <= 8; i++) {
        await waitForTurns(i);
        await releaseNextTurn();
      }

      // Round 2 ends into its autonomous extension, where the Moderator
      // concludes again (no interrupt this time) — the sequence ends idle.
      await waitForMode(conversationId, "idle");
      state = getConversationState(conversationId)!;
      expect(state.mode).toBe("idle");
      expect(state.wasInterrupted).toBe(false);
      expect(synthesisMessages()).toHaveLength(2); // one per concluded round
      expect(turnNames()).toEqual(["Alice", "Bob", "Carol", "Matt", "Alice", "Bob", "Carol", "Matt"]);
      expect(assistantCount()).toBe(10); // 8 expert turns + 2 syntheses

      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });
  });
});
