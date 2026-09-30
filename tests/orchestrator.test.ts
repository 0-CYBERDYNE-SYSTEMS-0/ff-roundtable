/**
 * Orchestrator Unit Tests
 *
 * Covers:
 *  - State machine: new farmer messages enter direct autonomous routing
 *  - Orchestrator routes experts by Moderator pick and round-robin fallback
 *  - Orchestrator returns to idle when its autonomous budget is exhausted
 *  - Farmer messages join the current flow without steering interrupts
 *  - Pause/resume
 *  - G5: semantic conclusion (Moderator 'Conclude' → closing synthesis,
 *    budget untouched, joined messages routed after the close)
 *  - G10: configured/synthetic Moderator is routing-only; synthetic synthesis
 *    persistence keeps its nullable expert identity
 *
 * Uses vitest with vi.mock for storage and AI dependencies.
 * Each test uses a unique conversationId to avoid module-level state pollution.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

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
  resolveAuxModel: (moderatorModel: string | null | undefined, firstExpertModel: string | null | undefined) =>
    moderatorModel?.trim() || process.env.DEFAULT_AUX_MODEL?.trim() || firstExpertModel?.trim() || null,
}));

// G7 snapshot persistence defaults: no stored snapshot, writes succeed.
// clearAllMocks() clears calls only, so these survive every test.
mockGetConversation.mockResolvedValue(undefined);
mockUpdateConversation.mockResolvedValue(undefined);
// The natural-end path calls generateInsights(...).catch(...); without a
// resolved default the mock returns undefined and every natural end threw a
// swallowed TypeError into stderr. Resolve cleanly instead.
mockGenerateInsights.mockResolvedValue(undefined);

import {
  InteractionOrchestrator,
  getConversationState,
  isUsableConversationState,
  processMessageTurnBased,
} from "../server/orchestrator";
import type { Expert, Message } from "../shared/schema";

type ModeratorIdentity = Omit<Expert, "id"> & { id: number | null };

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

  afterEach(() => {
    vi.unstubAllEnvs();
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

  // Deterministic turn gating for the G11 message-join and pause regressions:
  // every expert turn of `conversationId` parks until the test releases it.
  // Turns for other conversations (leftover chains from earlier tests) park
  // forever and can never interfere.
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

    const gates: Array<(error?: Error) => void> = [];
    const startedNames: string[] = [];
    let turnsStarted = 0;
    let contentCounter = 0;
    mockGetExpertResponseStream.mockImplementation((expert: Expert) => {
      if (expert.conversationId !== conversationId) {
        return new Promise(() => {}); // park foreign chains forever
      }
      turnsStarted++;
      startedNames.push(expert.name);
      return new Promise((resolve, reject) => {
        // Unique content per turn keeps the redundancy early-stop out of play.
        const content = `Distinct answer ${++contentCounter} from ${expert.name}`;
        gates.push((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({
            conversationId: expert.conversationId,
            expertId: expert.id,
            userId: null,
            content,
            role: "assistant",
            expertName: expert.name,
            expertRole: expert.role,
            artifacts: [],
          });
        });
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

    const rejectNextTurn = async (error = new Error("planned provider failure")) => {
      const deadline = Date.now() + 5000;
      while (gates.length === 0) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for a turn to reject");
        await waitFor(5);
      }
      gates.shift()!(error);
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
    const addUserMessageToHistory = (message: Message) => { messages.push({ ...message, conversationId }); };

    return {
      waitForTurns,
      releaseNextTurn,
      rejectNextTurn,
      drainToIdle,
      assistantCount,
      addUserMessageToHistory,
      turnNames: () => [...startedNames],
      turnsStarted: () => turnsStarted,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // State Machine: idle → autonomous
  // ─────────────────────────────────────────────────────────────────

  describe("State machine transitions", () => {
    it("starts in autonomous mode after a new farmer message", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts.map((expert) => ({ ...expert, conversationId })));
      const userMessage = createMockMessage(1, "Hello experts");

      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      const state = getConversationState(conversationId);
      expect(state).toBeDefined();
      expect(state!.mode).toBe("autonomous");
    });

    it("enters autonomous directly instead of starting a sequential roll-call", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts);
      const userMessage = createMockMessage(1, "Hello experts");

      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      const state = getConversationState(conversationId);
      expect(state!.mode).toBe("autonomous");
    });

    it("does not start a second chain when already autonomous", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts);
      const userMessage = createMockMessage(1, "Hello experts");

      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      // Try to start again while processing
      const orchestrator = new InteractionOrchestrator(conversationId);
      await orchestrator.startProcessingSequence();

      // Should remain on the existing autonomous chain, not crash.
      const state = getConversationState(conversationId);
      expect(state!.mode).toBe("autonomous");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Direct autonomous expert processing
  // ─────────────────────────────────────────────────────────────────

  describe("Direct autonomous processing", () => {
    it("uses round-robin routing when the Moderator requests it", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts.map((expert) => ({ ...expert, conversationId })));
      mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("RoundRobin");
      mockGetConversationMessages.mockResolvedValue([]);
      mockGetConversationFiles.mockResolvedValue([]);
      mockCreateMessage.mockImplementation((msg) =>
        Promise.resolve({ ...msg, id: Math.floor(Math.random() * 1000), timestamp: new Date() }),
      );

      // Each expert responds with their name
      let callCount = 0;
      mockGetExpertResponseStream.mockImplementation(async (expert: Expert) => {
        if (expert.conversationId !== conversationId) return new Promise<never>(() => {});
        callCount++;
        return {
          conversationId,
          expertId: expert.id,
          userId: null,
          content: `Distinct response ${callCount} from ${expert.name}`,
          role: "assistant",
          expertName: expert.name,
          expertRole: expert.role,
          artifacts: [],
        };
      });

      const userMessage = createMockMessage(1, "Hello experts");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);
      new InteractionOrchestrator(conversationId).enableAutonomous(6);

      // Bound this routing-order check to six autonomous turns.
      await waitFor(800);

      // The first three direct autonomous routes follow round-robin order.
      expect(mockGetExpertResponseStream).toHaveBeenCalled();
      expect(callCount).toBeGreaterThanOrEqual(3);

      const calledNames = mockGetExpertResponseStream.mock.calls
        .filter((c) => c[0].conversationId === conversationId)
        .map((c) => c[0].name);
      expect(calledNames.slice(0, 3)).toEqual(["Alice", "Bob", "Carol"]);
    });

    it("broadcasts each selected expert in round-robin order", async () => {
      const conversationId = nextConvId();
      mockGetConversationExperts.mockResolvedValue(experts.map((expert) => ({ ...expert, conversationId })));
      mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("RoundRobin");
      mockGetConversationMessages.mockResolvedValue([]);
      mockGetConversationFiles.mockResolvedValue([]);
      mockCreateMessage.mockImplementation((msg) =>
        Promise.resolve({ ...msg, id: Math.floor(Math.random() * 1000), timestamp: new Date() }),
      );

      let responseNo = 0;
      mockGetExpertResponseStream.mockImplementation(async (expert: Expert) => {
        if (expert.conversationId !== conversationId) return new Promise<never>(() => {});
        return {
          conversationId,
          expertId: expert.id,
          userId: null,
          content: `Distinct test response ${++responseNo} from ${expert.name}`,
          role: "assistant",
          expertName: expert.name,
          expertRole: expert.role,
          artifacts: [],
        };
      });

      const userMessage = createMockMessage(1, "Hello experts");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);
      new InteractionOrchestrator(conversationId).enableAutonomous(6);

      await waitFor(800);

      const streamStartCalls = broadcastFn.mock.calls.filter(
        (call) => call[0] === conversationId && call[1].type === "expert_stream_start",
      );
      // The first three stream starts reflect direct round-robin selections.
      expect(streamStartCalls.length).toBeGreaterThanOrEqual(3);
      expect(streamStartCalls.slice(0, 3).map((call) => call[1].expertName)).toEqual([
        "Alice",
        "Bob",
        "Carol",
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Stop at the end of autonomous processing
  // ─────────────────────────────────────────────────────────────────

  describe("Stop at end of autonomous processing", () => {
    it("returns to idle after the autonomous chain finishes", async () => {
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

      // The first response can naturally end the chain when contributions
      // are identical; this test checks natural cleanup, not a roll-call.
      await waitFor(800);

      const state = getConversationState(conversationId);
      expect(state!.mode).toBe("idle");
      expect(state!.currentExpertIndex).toBe(-1);
    });

    it("calls generateInsights when autonomous processing completes", async () => {
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
  // G11 message joins
  // ─────────────────────────────────────────────────────────────────

  describe("G11 message joins", () => {
    it("queues a new farmer message while the current expert remains in flight", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, addUserMessageToHistory } = setupGatedConversation(conversationId);

      const userMessage1 = createMockMessage(1, "First message");
      addUserMessageToHistory(userMessage1);
      await processMessageTurnBased(userId, conversationId, userMessage1, broadcastFn);
      await waitForTurns(1);
      expect(getConversationState(conversationId)!.turnInFlight).toBe(true);

      // Send second message while processing
      const userMessage2 = createMockMessage(2, "Second message");
      addUserMessageToHistory(userMessage2);
      await processMessageTurnBased(userId, conversationId, userMessage2, broadcastFn);

      const state = getConversationState(conversationId)!;
      expect(state.wasInterrupted).toBe(false);
      expect(state.pendingUserMessage?.content).toBe("Second message");
      expect(broadcastFn).not.toHaveBeenCalledWith(conversationId, { type: "steering" });
      expect(state.turnInFlight).toBe(true);

      // The user message joins the chain; it does not release or replace the
      // current expert's gated turn.
      expect(mockCreateMessage).not.toHaveBeenCalledWith(expect.objectContaining({ content: "Distinct answer 1 from Alice" }));
      await releaseNextTurn();
    });

    it("recovers a queued farmer message when the active expert rejects", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, rejectNextTurn, assistantCount, turnNames, addUserMessageToHistory } =
        setupGatedConversation(conversationId);
      mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("RoundRobin");

      const firstMessage = createMockMessage(1, "First question");
      addUserMessageToHistory(firstMessage);
      await processMessageTurnBased(userId, conversationId, firstMessage, broadcastFn);
      await waitForTurns(1);
      expect(getConversationState(conversationId)!.turnInFlight).toBe(true);

      const turnsBeforeJoin = getConversationState(conversationId)!.totalAutonomousTurnsTaken;
      const joinedMessage = createMockMessage(2, "Please account for the wet corner");
      addUserMessageToHistory(joinedMessage);
      await processMessageTurnBased(userId, conversationId, joinedMessage, broadcastFn);
      expect(getConversationState(conversationId)!.pendingUserMessage?.content).toBe(joinedMessage.content);
      expect(getConversationState(conversationId)!.wasInterrupted).toBe(false);
      expect(getConversationState(conversationId)!.totalAutonomousTurnsTaken).toBe(turnsBeforeJoin);

      const callsAfterJoin = broadcastFn.mock.calls.length;
      await rejectNextTurn();

      // The replacement chain picks up the still-pending farmer message and
      // starts its routed response without an idle state update in between.
      await waitForTurns(2);
      const stateDuringReplacement = getConversationState(conversationId)!;
      expect(turnNames()).toEqual(["Alice", "Bob"]);
      expect(stateDuringReplacement.mode).toBe("autonomous");
      expect(stateDuringReplacement.pendingUserMessage).toBeNull();
      expect(stateDuringReplacement.turnInFlight).toBe(true);
      expect(stateDuringReplacement.totalAutonomousTurnsTaken).toBe(turnsBeforeJoin + 1);
      expect(stateDuringReplacement.scheduledFailureAttempts).toBe(1);
      const recoveryCalls = broadcastFn.mock.calls.slice(callsAfterJoin);
      expect(recoveryCalls.some(([cid, event]) =>
        cid === conversationId && event?.type === "message_picked_up" && event.messageId === joinedMessage.id,
      )).toBe(true);
      expect(recoveryCalls.some(([cid, event]) =>
        cid === conversationId && event?.type === "state_update" && event.mode === "idle",
      )).toBe(false);

      new InteractionOrchestrator(conversationId).disableAutonomous();
      await releaseNextTurn();
      await waitForMode(conversationId, "idle");
      expect(getConversationState(conversationId)!.turnInFlight).toBe(false);
      expect(getConversationState(conversationId)!.scheduledFailureAttempts).toBe(0);
      expect(assistantCount()).toBe(2); // persisted error row plus Bob's answer
    });

    it("bounds persistent pre-turn storage failures and retains the queued farmer message", async () => {
      const conversationId = nextConvId();
      const { addUserMessageToHistory, waitForTurns, releaseNextTurn } = setupGatedConversation(conversationId);
      const userMessage = createMockMessage(1, "Remember the wet corner before advising");
      addUserMessageToHistory(userMessage);
      mockGetConversationMessages.mockImplementation((cid: number) =>
        cid === conversationId
          ? Promise.reject(new Error("planned persistent storage failure"))
          : Promise.resolve([]),
      );

      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);
      await waitForMode(conversationId, "idle");
      await waitFor(30);

      const state = getConversationState(conversationId)!;
      expect(mockGetConversationMessages.mock.calls.filter(([cid]) => cid === conversationId)).toHaveLength(3);
      expect(mockGetExpertResponseStream.mock.calls.filter(([expert]) => expert.conversationId === conversationId)).toHaveLength(0);
      expect(state.scheduledFailureAttempts).toBe(3);
      expect(state.pendingUserMessage?.content).toBe(userMessage.content);
      expect(state.pendingMentionRoutes).toEqual([]);
      expect(state.mode).toBe("idle");
      expect(state.turnChainScheduled).toBe(false);
      expect(state.turnChainRunning).toBe(false);
      expect(broadcastFn.mock.calls.some(([cid, event]) =>
        cid === conversationId && event?.type === "notice" && event.message?.includes("three consecutive errors"),
      )).toBe(true);
      expect(broadcastFn.mock.calls.some(([cid, event]) =>
        cid === conversationId && event?.type === "message_picked_up" && event.messageId === userMessage.id,
      )).toBe(false);

      // An explicit /new is the deliberate reset path after the recoverable
      // stop. The first successful routed turn then leaves the counter clear.
      mockGetConversationMessages.mockResolvedValue([]);
      mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("RoundRobin");
      const restartedMessage = createMockMessage(2, "Start over with the saved context");
      await processMessageTurnBased(userId, conversationId, restartedMessage, broadcastFn, { restart: true });
      await waitForTurns(1);
      expect(getConversationState(conversationId)!.scheduledFailureAttempts).toBe(0);
      new InteractionOrchestrator(conversationId).disableAutonomous();
      await releaseNextTurn();
      await waitForMode(conversationId, "idle");
      expect(getConversationState(conversationId)!.scheduledFailureAttempts).toBe(0);
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
  // G8 — isUsableConversationState guard (Invariant 9)
  // ─────────────────────────────────────────────────────────────────

  describe("G8 isUsableConversationState guard", () => {
    // A state object that satisfies every field-level check.
    function usableState(): Record<string, unknown> {
      return {
        conversationId: 1,
        activeExperts: experts,
        moderatorExpert: {
          id: null,
          conversationId: 1,
          name: "Moderator",
          role: "Moderator",
          model: "deepseek/deepseek-v3:free",
          systemPrompt: "You are the system Moderator.",
        },
        currentExpertIndex: 0,
        lastUserMessage: null,
        mode: "autonomous",
        broadcastFn,
        isAutonomousEnabled: true,
        maxAutonomousTurns: 6,
        totalAutonomousTurnsTaken: 0,
        wasInterrupted: false,
        pendingUserMessage: null,
        pendingMentionRoutes: [],
        farmerJustSpoke: false,
        singleTurnOnly: false,
        pausedFromMode: null,
        turnInFlight: false,
        turnChainScheduled: false,
        turnChainRunning: false,
        scheduledFailureAttempts: 0,
        lastProgressAt: Date.now(),
        sequenceExpertContents: [],
        roundExperts: experts,
        mentionPairStreak: null,
        moderatorNoticeSent: false,
      };
    }

    it("accepts a state with every field initialized", () => {
      expect(isUsableConversationState(usableState() as any)).toBe(true);
    });

    it("rejects a state missing moderatorNoticeSent even when every other check passes", () => {
      const partial = usableState();
      delete partial.moderatorNoticeSent;
      expect(isUsableConversationState(partial as any)).toBe(false);
    });

    it("rejects a state missing the G11 pending mention route queue", () => {
      const partial = usableState();
      delete partial.pendingMentionRoutes;
      expect(isUsableConversationState(partial as any)).toBe(false);
    });

    it("rejects a state missing the scheduled failure counter", () => {
      const partial = usableState();
      delete partial.scheduledFailureAttempts;
      expect(isUsableConversationState(partial as any)).toBe(false);
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

    it("stops direct autonomous routing early on a near-identical repeat", async () => {
      const conversationId = nextConvId();
      // Experts bound to THIS conversation: the mock returns
      // expert.conversationId, so leftover chains from earlier tests (whose
      // loops keep running on their own conversation IDs) can never pollute
      // this conversation's stored-message counts.
      const myExperts = experts.map((e) => ({ ...e, conversationId }));
      mockGetConversationExperts.mockResolvedValue(myExperts);
      mockGetConversationFiles.mockResolvedValue([]);
      mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("RoundRobin");
      const assistantTurns = mockHistoryBackedStorage();

      const firstRoundContents: Record<string, string> = {
        Alice: "Lime this field at two tons per acre and retest the soil in spring",
        Bob: "Tile drainage would fix the wet spot in the north corner",
        Carol: "Frost risk stays low for the next ten days in your county",
      };

      mockGetExpertResponseStream.mockImplementation(async (expert: Expert) => {
        // Turn four repeats Alice's first reply with only its final word
        // changed (0.875 similarity), exercising the existing early stop.
        const content =
          assistantTurns(conversationId) >= 3
            ? "Lime this field at two tons per acre and retest the soil in autumn"
            : firstRoundContents[expert.name];
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
      new InteractionOrchestrator(conversationId).enableAutonomous(6);

      await waitFor(800);

      // Three round-robin responses plus one redundant response; routing
      // stops before the six-turn autonomous budget.
      expect(assistantTurns(conversationId)).toBe(4);

      const state = getConversationState(conversationId);
      expect(state!.mode).toBe("idle");
      // Same cleanup as a natural end.
      expect(state!.totalAutonomousTurnsTaken).toBe(0);
      expect(mockGenerateInsights).toHaveBeenCalledWith(conversationId, expect.any(Function));
    });

    it("lets direct autonomous routing run to its cap when contributions stay distinct", async () => {
      const conversationId = nextConvId();
      const myExperts = experts.map((e) => ({ ...e, conversationId }));
      mockGetConversationExperts.mockResolvedValue(myExperts);
      mockGetConversationFiles.mockResolvedValue([]);
      mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("RoundRobin");
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
      new InteractionOrchestrator(conversationId).enableAutonomous(6);

      await waitFor(1000);

      // The six-turn autonomous budget is fully used without an initial
      // forced roster round.
      expect(assistantTurns(conversationId)).toBe(6);
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // G11 — Messages join the current discussion
  // ─────────────────────────────────────────────────────────────────

  describe("G11 message joins", () => {
    it("uses the 25-turn default and caps the let-it-run option at 100", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn } = setupGatedConversation(conversationId);
      const userMessage = createMockMessage(1, "First question");
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      expect(getConversationState(conversationId)!.maxAutonomousTurns).toBe(25);
      const orchestrator = new InteractionOrchestrator(conversationId);
      orchestrator.enableAutonomous(0);
      expect(getConversationState(conversationId)!.maxAutonomousTurns).toBe(100);
      orchestrator.enableAutonomous(101);
      expect(getConversationState(conversationId)!.maxAutonomousTurns).toBe(100);
      orchestrator.enableAutonomous(1);
      await waitForTurns(1);
      await releaseNextTurn();
      await waitForMode(conversationId, "idle");
    });

    it("finishes the current expert, routes the pending farmer message, and preserves autonomous counters", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, assistantCount, turnNames, addUserMessageToHistory } =
        setupGatedConversation(conversationId);
      mockGetModeratorNextSpeakerSuggestion
        .mockResolvedValueOnce("Agronomist")
        .mockResolvedValueOnce("Soil Scientist")
        .mockResolvedValueOnce("Weather Expert");
      new InteractionOrchestrator(conversationId).enableAutonomous(10);

      const userMessage1 = createMockMessage(1, "First question");
      addUserMessageToHistory(userMessage1);
      await processMessageTurnBased(userId, conversationId, userMessage1, broadcastFn);

      // The first route selects Alice. After she completes, Bob is in flight.
      await waitForTurns(1);
      expect(turnNames()).toEqual(["Alice"]);
      await releaseNextTurn();
      await waitForTurns(2);
      expect(turnNames()).toEqual(["Alice", "Bob"]);
      const stateBeforeJoin = getConversationState(conversationId)!;
      const turnsBeforeJoin = stateBeforeJoin.totalAutonomousTurnsTaken;
      expect(turnsBeforeJoin).toBeGreaterThan(0);

      // A new message arrives while Bob's expert turn is still gated.
      const userMessage2 = createMockMessage(2, "Clarify the watering plan");
      addUserMessageToHistory(userMessage2);
      await processMessageTurnBased(userId, conversationId, userMessage2, broadcastFn);

      let state = getConversationState(conversationId)!;
      expect(state.pendingUserMessage?.content).toBe("Clarify the watering plan");
      expect(state.wasInterrupted).toBe(false);
      expect(state.totalAutonomousTurnsTaken).toBe(turnsBeforeJoin);
      expect(state.turnInFlight).toBe(true);
      expect(broadcastFn).not.toHaveBeenCalledWith(conversationId, { type: "steering" });
      const assistantsBeforeBobFinishes = assistantCount();

      // Bob completes his existing turn. The Moderator then sees the farmer's
      // message and selects Carol without a new sequential roll-call.
      await releaseNextTurn();
      await waitForTurns(3);
      expect(turnNames()).toEqual(["Alice", "Bob", "Carol"]);
      expect(assistantCount()).toBe(assistantsBeforeBobFinishes + 1);
      state = getConversationState(conversationId)!;
      expect(state.totalAutonomousTurnsTaken).toBe(turnsBeforeJoin + 1);

      const messageAwareRoute = mockGetModeratorNextSpeakerSuggestion.mock.calls.find(
        ([moderator, history]) =>
          moderator?.conversationId === conversationId &&
          history?.some((message: Message) => message.content === "Clarify the watering plan"),
      );
      expect(messageAwareRoute).toBeDefined();
      expect(mockGetModeratorNextSpeakerSuggestion.mock.calls.some(
        ([moderator, _history, _roles, farmerJustSpoke]) =>
          moderator?.conversationId === conversationId && farmerJustSpoke === true,
      )).toBe(true);

      // Stop the chain after Carol finishes; no fresh roster round is run.
      new InteractionOrchestrator(conversationId).disableAutonomous();
      await releaseNextTurn();
      await waitForMode(conversationId, "idle");
      expect(turnNames()).toEqual(["Alice", "Bob", "Carol"]);
      expect(assistantCount()).toBe(3);
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("keeps explicit /new as a full restart with a fresh turn budget", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, assistantCount, turnNames, addUserMessageToHistory } =
        setupGatedConversation(conversationId);
      mockGetModeratorNextSpeakerSuggestion
        .mockResolvedValueOnce("Soil Scientist")
        .mockResolvedValueOnce("Weather Expert");
      new InteractionOrchestrator(conversationId).enableAutonomous(10);

      const firstTopic = createMockMessage(1, "@[Agronomist] First topic", "user", undefined, ["Agronomist"]);
      addUserMessageToHistory(firstTopic);
      await processMessageTurnBased(
        userId,
        conversationId,
        firstTopic,
        broadcastFn,
      );
      await waitForTurns(1);
      expect(turnNames()).toEqual(["Alice"]);
      await releaseNextTurn();
      await waitForTurns(2);
      expect(turnNames()).toEqual(["Alice", "Bob"]);

      const oldBudgetCount = getConversationState(conversationId)!.totalAutonomousTurnsTaken;
      expect(oldBudgetCount).toBeGreaterThan(0);

      // The composer strips `/new`; its explicit restart intent is passed to
      // the orchestrator while the old expert remains in flight.
      const newTopic = createMockMessage(2, "Switch to irrigation planning");
      addUserMessageToHistory(newTopic);
      await processMessageTurnBased(
        userId,
        conversationId,
        newTopic,
        broadcastFn,
        { restart: true },
      );
      expect(getConversationState(conversationId)!.wasInterrupted).toBe(true);

      // Bob's in-flight answer is allowed to finish; the new topic then routes
      // to the Moderator-selected expert with a fresh counter.
      await releaseNextTurn();
      await waitForTurns(3);
      expect(turnNames()).toEqual(["Alice", "Bob", "Carol"]);
      const restartedState = getConversationState(conversationId)!;
      expect(restartedState.lastUserMessage?.content).toBe("Switch to irrigation planning");
      expect(restartedState.wasInterrupted).toBe(false);
      expect(restartedState.totalAutonomousTurnsTaken).toBe(1);

      new InteractionOrchestrator(conversationId).disableAutonomous();
      await releaseNextTurn();
      await waitForMode(conversationId, "idle");
      expect(assistantCount()).toBe(3); // two old turns + one new-topic response
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // G2 — Disable Auto mid-round ends naturally (never pauses)
  // ─────────────────────────────────────────────────────────────────

  describe("G2 disableAutonomous", () => {
    it("routes one responder then ends at idle when autonomy is disabled", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, assistantCount, turnNames, addUserMessageToHistory } =
        setupGatedConversation(conversationId);

      const userMessage = createMockMessage(
        1,
        "@[Soil Scientist] Please check the drainage plan",
        "user",
        undefined,
        ["Soil Scientist"],
      );
      addUserMessageToHistory(userMessage);
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);
      // Disable before the scheduled first route so this message receives one
      // selected responder and then the flow returns to idle.
      new InteractionOrchestrator(conversationId).disableAutonomous();
      await waitForTurns(1);
      expect(turnNames()).toEqual(["Bob"]);
      expect(getConversationState(conversationId)!.singleTurnOnly).toBe(true);

      // Disabling autonomy never pauses or cancels the selected responder.
      const stateWhileFinishing = getConversationState(conversationId)!;
      expect(stateWhileFinishing.isAutonomousEnabled).toBe(false);
      expect(stateWhileFinishing.mode).not.toBe("paused");
      await releaseNextTurn();

      await waitForMode(conversationId, "idle");
      expect(getConversationState(conversationId)!.pausedFromMode).toBeNull();
      expect(turnNames()).toEqual(["Bob"]);
      expect(assistantCount()).toBe(1);
      expect(mockGenerateInsights).toHaveBeenCalledWith(conversationId, expect.any(Function));
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // G11 — A farmer message resumes a paused council in place
  // ─────────────────────────────────────────────────────────────────

  describe("G11 paused message joins", () => {
    it("keeps one routing chain when a paused message resumes during the Moderator decision", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, addUserMessageToHistory, turnNames } =
        setupGatedConversation(conversationId);

      let releaseModerator: (role: string) => void = () => {};
      let markModeratorStarted: () => void = () => {};
      const moderatorStarted = new Promise<void>((resolve) => { markModeratorStarted = resolve; });
      const firstModeratorDecision = new Promise<string>((resolve) => { releaseModerator = resolve; });
      mockGetModeratorNextSpeakerSuggestion
        .mockImplementationOnce(async () => {
          markModeratorStarted();
          return firstModeratorDecision;
        });

      const firstMessage = createMockMessage(1, "Check the field plan");
      addUserMessageToHistory(firstMessage);
      await processMessageTurnBased(userId, conversationId, firstMessage, broadcastFn);
      await moderatorStarted;

      new InteractionOrchestrator(conversationId).pause();
      expect(getConversationState(conversationId)!.mode).toBe("paused");
      const joinedMessage = createMockMessage(
        2,
        "@[Weather Expert] Please check rain timing",
        "user",
        undefined,
        ["Weather Expert"],
      );
      addUserMessageToHistory(joinedMessage);
      await processMessageTurnBased(userId, conversationId, joinedMessage, broadcastFn);

      expect(getConversationState(conversationId)!.mode).toBe("autonomous");
      expect(mockGetModeratorNextSpeakerSuggestion).toHaveBeenCalledTimes(1);
      releaseModerator("Agronomist");

      await waitForTurns(1);
      expect(turnNames()).toEqual(["Carol"]);
      expect(mockGetModeratorNextSpeakerSuggestion).toHaveBeenCalledTimes(1);
      new InteractionOrchestrator(conversationId).disableAutonomous();
      await releaseNextTurn();
      await waitForMode(conversationId, "idle");
      expect(turnNames()).toEqual(["Carol"]);
    });

    it("resumes a parked council in place and routes the mentioned expert next", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, assistantCount, turnNames, addUserMessageToHistory } =
        setupGatedConversation(conversationId);
      new InteractionOrchestrator(conversationId).enableAutonomous(8);

      const userMessage1 = createMockMessage(1, "@[Agronomist] First question", "user", undefined, ["Agronomist"]);
      addUserMessageToHistory(userMessage1);
      await processMessageTurnBased(userId, conversationId, userMessage1, broadcastFn);
      await waitForTurns(1);
      expect(turnNames()).toEqual(["Alice"]);

      const orchestrator = new InteractionOrchestrator(conversationId);
      orchestrator.pause();
      expect(getConversationState(conversationId)!.mode).toBe("paused");

      // The current expert completes and the existing flow parks.
      await releaseNextTurn();
      await waitFor(30);
      const parkedState = getConversationState(conversationId)!;
      expect(parkedState.mode).toBe("paused");
      expect(parkedState.turnInFlight).toBe(false);
      const turnsBeforeResume = parkedState.totalAutonomousTurnsTaken;

      // The message resumes the same flow and its mention selects Carol.
      const userMessage2 = createMockMessage(2, "@[Weather Expert] Please weigh in", "user", undefined, ["Weather Expert"]);
      addUserMessageToHistory(userMessage2);
      await processMessageTurnBased(userId, conversationId, userMessage2, broadcastFn);
      expect(getConversationState(conversationId)!.mode).not.toBe("idle");
      expect(broadcastFn).not.toHaveBeenCalledWith(conversationId, { type: "steering" });
      await waitForTurns(2);
      expect(turnNames()).toEqual(["Alice", "Carol"]);
      expect(getConversationState(conversationId)!.totalAutonomousTurnsTaken).toBeGreaterThanOrEqual(turnsBeforeResume);

      new InteractionOrchestrator(conversationId).disableAutonomous();
      await releaseNextTurn();
      await waitForMode(conversationId, "idle");
      expect(turnNames()).toEqual(["Alice", "Carol"]);
      expect(assistantCount()).toBe(2);
    });

    it("queues a message while paused mid-turn, then routes it after the active expert finishes", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, assistantCount, turnNames, addUserMessageToHistory } =
        setupGatedConversation(conversationId);
      new InteractionOrchestrator(conversationId).enableAutonomous(8);

      const userMessage1 = createMockMessage(1, "@[Agronomist] First question", "user", undefined, ["Agronomist"]);
      addUserMessageToHistory(userMessage1);
      await processMessageTurnBased(userId, conversationId, userMessage1, broadcastFn);
      await waitForTurns(1);
      expect(turnNames()).toEqual(["Alice"]);

      const orchestrator = new InteractionOrchestrator(conversationId);
      orchestrator.pause();

      // Message arrives while Alice is still streaming.
      const userMessage2 = createMockMessage(2, "@[Soil Scientist] Check the drainage", "user", undefined, ["Soil Scientist"]);
      addUserMessageToHistory(userMessage2);
      await processMessageTurnBased(userId, conversationId, userMessage2, broadcastFn);

      let state = getConversationState(conversationId)!;
      expect(state.turnInFlight).toBe(true);
      expect(state.pendingUserMessage?.content).toBe("@[Soil Scientist] Check the drainage");
      expect(state.wasInterrupted).toBe(false);
      expect(broadcastFn).not.toHaveBeenCalledWith(conversationId, { type: "steering" });

      const turnsBeforeJoin = state.totalAutonomousTurnsTaken;
      // The current expert completes, then the user-mentioned expert speaks
      // next in the same chain (no replay of Alice).
      await releaseNextTurn();
      await waitForTurns(2);
      expect(turnNames()).toEqual(["Alice", "Bob"]);
      state = getConversationState(conversationId)!;
      expect(state.totalAutonomousTurnsTaken).toBeGreaterThanOrEqual(turnsBeforeJoin);
      expect(assistantCount()).toBe(1);

      new InteractionOrchestrator(conversationId).disableAutonomous();
      await releaseNextTurn();
      await waitForMode(conversationId, "idle");
      expect(turnNames()).toEqual(["Alice", "Bob"]);
      expect(assistantCount()).toBe(2);
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // B-review — red-team regressions
  // ─────────────────────────────────────────────────────────────────

  describe("B-review race conditions", () => {
    it("does not double-drive direct autonomous routing when pause()+resume() land mid-turn", async () => {
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
      const { waitForTurns, releaseNextTurn, drainToIdle, assistantCount, turnsStarted, addUserMessageToHistory } =
        setupGatedConversation(conversationId);
      mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("RoundRobin");

      const userMessage = createMockMessage(
        1,
        "@[Agronomist] First question",
        "user",
        undefined,
        ["Agronomist"],
      );
      addUserMessageToHistory(userMessage);
      await processMessageTurnBased(userId, conversationId, userMessage, hookedBroadcast);
      new InteractionOrchestrator(conversationId).enableAutonomous(3);
      await waitForTurns(1); // the mentioned responder is streaming

      // Alice's turn completes; the hook fires pause+resume inside the
      // direct autonomous loop's own continuation.
      await releaseNextTurn();
      await waitForTurns(2); // exactly one follow-up turn (Bob) may start

      // A duplicate chain would start Carol while Bob is still gated — no
      // third turn may begin before Bob is released.
      await waitFor(60);
      expect(turnsStarted()).toBe(2);

      await releaseNextTurn(); // Bob
      await waitForTurns(3); // Carol
      await releaseNextTurn();

      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
      // Each selected expert ran once: the pause/resume race must not
      // double-drive concurrent autonomous chains.
      expect(assistantCount()).toBe(3);
      await waitFor(80); // a stray duplicate chain would surface as extra turns
      expect(assistantCount()).toBe(3);
      expect(turnsStarted()).toBe(3);
    });

    it("does not add a turn when a paused direct autonomous flow resumes after autonomy is disabled", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, assistantCount, turnNames, addUserMessageToHistory } =
        setupGatedConversation(conversationId);
      mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("RoundRobin");

      const userMessage = createMockMessage(
        1,
        "@[Agronomist] First question",
        "user",
        undefined,
        ["Agronomist"],
      );
      addUserMessageToHistory(userMessage);
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);
      new InteractionOrchestrator(conversationId).enableAutonomous(3);

      await waitForTurns(1);
      const orchestrator = new InteractionOrchestrator(conversationId);
      orchestrator.pause();
      await releaseNextTurn(); // Alice completes while the flow is paused
      await waitFor(30);
      expect(getConversationState(conversationId)!.mode).toBe("paused"); // parked

      // Auto off while parked, then resume: no additional responder may be
      // selected after the current in-flight expert has completed.
      orchestrator.disableAutonomous();
      orchestrator.resume();

      await waitForMode(conversationId, "idle");
      expect(turnNames()).toEqual(["Alice"]);
      expect(assistantCount()).toBe(1);
      expect(mockGenerateInsights).toHaveBeenCalledWith(conversationId, expect.any(Function));
    });

    it("finishes the active expert and ends idle when autonomy is disabled mid-turn", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, drainToIdle, assistantCount, turnNames, addUserMessageToHistory } =
        setupGatedConversation(conversationId);

      const userMessage = createMockMessage(
        1,
        "@[Agronomist] First question",
        "user",
        undefined,
        ["Agronomist"],
      );
      addUserMessageToHistory(userMessage);
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);
      await waitForTurns(1); // Alice is streaming

      new InteractionOrchestrator(conversationId).disableAutonomous();
      expect(getConversationState(conversationId)!.isAutonomousEnabled).toBe(false);
      expect(getConversationState(conversationId)!.mode).not.toBe("paused");

      await releaseNextTurn(); // Alice finishes
      await drainToIdle();
      const state = getConversationState(conversationId)!;
      expect(state.mode).toBe("idle");
      expect(turnNames()).toEqual(["Alice"]);
      expect(assistantCount()).toBe(1);
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

      const addUserMessageToHistory = (message: Message) => { messages.push({ ...message, conversationId }); };
      return { waitForTurns, releaseNextTurn, drainToIdle, turnNames: () => [...startedNames], addUserMessageToHistory };
    }

    it("routes an initial farmer mention directly and then follows an expert mention", async () => {
      const conversationId = nextConvId();
      const roster = [
        createMockExpert(1, "Alice", "Agronomist"),
        createMockExpert(2, "Bob", "Soil Scientist"),
        createMockExpert(3, "Carol", "Weather Expert"),
        createMockExpert(4, "Matt", "Moderator"),
      ];
      mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("Agronomist");
      // The Moderator stays out of ordinary turns. Carol tags the Soil
      // Scientist. The farmer's tag routes Carol first; the Moderator gets
      // the next pick before Carol's expert-origin tag can route Bob.
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames, addUserMessageToHistory } =
        setupGatedMentionConversation(conversationId, roster, (e) =>
          e.name === "Carol" ? ["Soil Scientist"] : [],
        );

      const userMessage = createMockMessage(
        1,
        "@[Weather Expert] Plan my week",
        "user",
        undefined,
        ["Weather Expert"],
      );
      addUserMessageToHistory(userMessage);
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      // No forced roll-call: the farmer's mention selects Carol first.
      await waitForTurns(1);
      expect(turnNames()).toEqual(["Carol"]);
      await releaseNextTurn();
      await waitForTurns(2);
      expect(turnNames()).toEqual(["Carol", "Alice"]);
      expect(mockGetModeratorNextSpeakerSuggestion.mock.calls.some(
        ([, , , farmerJustSpoke]) => farmerJustSpoke === true,
      )).toBe(true);
      await releaseNextTurn();
      await waitForTurns(3);
      expect(turnNames()).toEqual(["Carol", "Alice", "Bob"]);

      new InteractionOrchestrator(conversationId).disableAutonomous();
      await releaseNextTurn();
      await drainToIdle();
      expect(turnNames()).toEqual(["Carol", "Alice", "Bob"]);
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("keeps the ping-pong guard when experts repeatedly tag each other", async () => {
      const conversationId = nextConvId();
      const roster = [
        createMockExpert(1, "Alice", "Agronomist"),
        createMockExpert(2, "Bob", "Soil Scientist"),
        createMockExpert(3, "Carol", "Weather Expert"),
      ];
      mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("RoundRobin");
      // Carol always tags Bob and Bob always tags Carol — a pure ping-pong.
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames, addUserMessageToHistory } =
        setupGatedMentionConversation(conversationId, roster, (e) =>
          e.role === "Weather Expert"
            ? ["Soil Scientist"]
            : e.role === "Soil Scientist"
              ? ["Weather Expert"]
              : [],
        );

      const userMessage = createMockMessage(
        1,
        "@[Weather Expert] Discuss drainage",
        "user",
        undefined,
        ["Weather Expert"],
      );
      addUserMessageToHistory(userMessage);
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      // The farmer starts with Carol. Her expert tag waits until after the
      // Moderator pick (round-robin selects Alice), then Bob and Carol trade
      // tags until the third attempted pair hop falls back to Alice.
      await waitForTurns(1);
      expect(turnNames()[0]).toBe("Carol");
      await releaseNextTurn();
      await waitForTurns(2);
      expect(turnNames()[1]).toBe("Alice");
      await releaseNextTurn();
      await waitForTurns(3);
      expect(turnNames()[2]).toBe("Bob");
      await releaseNextTurn();
      await waitForTurns(4);
      expect(turnNames()[3]).toBe("Carol");
      await releaseNextTurn();
      await waitForTurns(5);
      expect(turnNames()[4]).toBe("Alice");

      new InteractionOrchestrator(conversationId).disableAutonomous();
      await releaseNextTurn();
      await drainToIdle();
      expect(turnNames()).toEqual(["Carol", "Alice", "Bob", "Carol", "Alice"]);
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("routes multiple farmer mentions in message text order without a forced roll-call", async () => {
      const conversationId = nextConvId();
      const roster = [
        createMockExpert(1, "Alice", "Agronomist"),
        createMockExpert(2, "Bob", "Soil Scientist"),
        createMockExpert(3, "Carol", "Weather Expert"),
      ];
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames, addUserMessageToHistory } =
        setupGatedMentionConversation(conversationId, roster, () => []);

      const userMessage = createMockMessage(
        1,
        "@[Weather Expert] and @[Soil Scientist] please weigh in",
        "user",
        undefined,
        // NOT roster order on purpose; G11 preserves text order.
        ["Weather Expert", "Soil Scientist"],
      );
      addUserMessageToHistory(userMessage);
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      // Mention order differs from roster order. No unrelated expert is
      // forced into a sequential roll-call.
      await waitForTurns(1);
      expect(turnNames()[0]).toBe("Carol");
      await releaseNextTurn();
      await waitForTurns(2);
      expect(turnNames()[1]).toBe("Bob");
      new InteractionOrchestrator(conversationId).disableAutonomous();
      await releaseNextTurn();
      await drainToIdle();
      expect(turnNames()).toEqual(["Carol", "Bob"]);
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("uses the Moderator pick when farmer mentions contain only stale or unknown roles", async () => {
      const conversationId = nextConvId();
      const roster = [
        createMockExpert(1, "Alice", "Agronomist"),
        createMockExpert(2, "Bob", "Soil Scientist"),
        createMockExpert(3, "Carol", "Weather Expert"),
      ];
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames, addUserMessageToHistory } =
        setupGatedMentionConversation(conversationId, roster, () => []);
      mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("Soil Scientist");

      const userMessage = createMockMessage(
        1,
        "@[Rocket Scientist] thoughts?",
        "user",
        undefined,
        ["Rocket Scientist"], // not in the roster — must fall back to all
      );
      addUserMessageToHistory(userMessage);
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      await waitForTurns(1);
      expect(turnNames()).toEqual(["Bob"]);
      const messageAwareRoute = mockGetModeratorNextSpeakerSuggestion.mock.calls.find(
        ([moderator, history]) =>
          moderator?.conversationId === conversationId &&
          history?.some((message: Message) => message.content === "@[Rocket Scientist] thoughts?"),
      );
      expect(messageAwareRoute).toBeDefined();

      new InteractionOrchestrator(conversationId).disableAutonomous();
      await releaseNextTurn();
      await drainToIdle();
      expect(turnNames()).toEqual(["Bob"]);
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("routes a mid-turn farmer mention next without restarting a narrowed round", async () => {
      const conversationId = nextConvId();
      const roster = [
        createMockExpert(1, "Alice", "Agronomist"),
        createMockExpert(2, "Bob", "Soil Scientist"),
        createMockExpert(3, "Carol", "Weather Expert"),
      ];
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames, addUserMessageToHistory } =
        setupGatedMentionConversation(conversationId, roster, () => []);

      const userMessage1 = createMockMessage(1, "@[Agronomist] First question", "user", undefined, ["Agronomist"]);
      addUserMessageToHistory(userMessage1);
      await processMessageTurnBased(userId, conversationId, userMessage1, broadcastFn);
      await waitForTurns(1); // Alice streaming

      // The farmer mentions Carol while Alice is still in flight.
      const userMessage2 = createMockMessage(
        2,
        "@[Weather Expert] actually just you",
        "user",
        undefined,
        ["Weather Expert"],
      );
      addUserMessageToHistory(userMessage2);
      await processMessageTurnBased(userId, conversationId, userMessage2, broadcastFn);
      const queued = getConversationState(conversationId)!;
      expect(queued.pendingUserMessage?.content).toBe("@[Weather Expert] actually just you");
      expect(queued.wasInterrupted).toBe(false);
      expect(broadcastFn).not.toHaveBeenCalledWith(conversationId, { type: "steering" });

      // Alice completes, then the one mentioned expert speaks next.
      await releaseNextTurn();
      await waitForTurns(2);
      expect(turnNames()).toEqual(["Alice", "Carol"]);
      new InteractionOrchestrator(conversationId).disableAutonomous();
      await releaseNextTurn();

      await drainToIdle();
      expect(turnNames()).toEqual(["Alice", "Carol"]);
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("asks the Moderator before an expert-origin mention when the farmer joins without a mention", async () => {
      const conversationId = nextConvId();
      const roster = [
        createMockExpert(1, "Alice", "Agronomist"),
        createMockExpert(2, "Bob", "Soil Scientist"),
        createMockExpert(3, "Carol", "Weather Expert"),
      ];
      const joinedText = "One more detail about the wet corner";
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames, addUserMessageToHistory } =
        setupGatedMentionConversation(conversationId, roster, (expert) =>
          expert.role === "Agronomist" ? ["Soil Scientist"] : [],
        );
      mockGetModeratorNextSpeakerSuggestion.mockImplementation(async (_moderator, history) =>
        history.some((message: Message) => message.content === joinedText)
          ? "Weather Expert"
          : "Agronomist",
      );

      const firstMessage = createMockMessage(1, "Initial drainage question");
      addUserMessageToHistory(firstMessage);
      await processMessageTurnBased(userId, conversationId, firstMessage, broadcastFn);
      await waitForTurns(1);
      expect(turnNames()).toEqual(["Alice"]);

      const joinedMessage = createMockMessage(2, joinedText);
      addUserMessageToHistory(joinedMessage);
      await processMessageTurnBased(userId, conversationId, joinedMessage, broadcastFn);

      // Alice finishes with an expert-origin mention for Bob. The queued
      // farmer message has no mention, so the Moderator must pick Carol next.
      await releaseNextTurn();
      await waitForTurns(2);
      expect(turnNames()).toEqual(["Alice", "Carol"]);
      expect(mockGetModeratorNextSpeakerSuggestion.mock.calls.some(
        ([, history, , farmerJustSpoke]) =>
          history.some((message: Message) => message.content === joinedText) && farmerJustSpoke === true,
      )).toBe(true);

      // End after Carol; Bob's deferred expert mention must not have pre-empted
      // the Moderator's farmer-aware pick.
      new InteractionOrchestrator(conversationId).disableAutonomous();
      await releaseNextTurn();
      await drainToIdle();
      expect(turnNames()).toEqual(["Alice", "Carol"]);
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // G5 — Semantic conclusion: Moderator 'Conclude' + closing synthesis
  // ─────────────────────────────────────────────────────────────────

  describe("G5 semantic conclusion", () => {
    // Gated conversation whose roster includes a Moderator: direct autonomous
    // routing consults the (mocked) Moderator, so a 'Conclude' verdict can be
    // exercised at an exact point in the loop.
    // Everything else mirrors setupGatedConversation above (unique content
    // per turn keeps the redundancy early-stop out of play).
    function setupGatedModeratorConversation(
      conversationId: number,
      includeRosterModerator = true,
    ) {
      const configuredModerator = createMockExpert(4, "Matt", "Moderator");
      configuredModerator.model = "test/configured-moderator-model";
      const roster: Expert[] = [
        createMockExpert(1, "Alice", "Agronomist"),
        createMockExpert(2, "Bob", "Soil Scientist"),
        createMockExpert(3, "Carol", "Weather Expert"),
        ...(includeRosterModerator ? [configuredModerator] : []),
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
      const addUserMessageToHistory = (message: Message) => { messages.push({ ...message, conversationId }); };
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
        addUserMessageToHistory,
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
        async (cid: number, moderator: ModeratorIdentity, broadcast: (c: number, data: any) => void) => {
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

    it("uses the configured roster Moderator for conclusion without an ordinary turn", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames, assistantCount, addUserMessageToHistory, synthesisMessages, events, waitForEvent } =
        setupGatedModeratorConversation(conversationId);
      mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("Conclude");
      mockSynthesisTurn(conversationId);

      const userMessage = createMockMessage(1, "@[Agronomist] Plan my week", "user", undefined, ["Agronomist"]);
      addUserMessageToHistory(userMessage);
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      // Alice is selected by the farmer; Matt is reserved for Moderator
      // routing and conclusion, never an ordinary expert turn.
      await waitForTurns(1);
      expect(turnNames()).toEqual(["Alice"]);
      await releaseNextTurn();

      // The Moderator concludes after the active experts finish; only the
      // synthesis streams under the Moderator identity.
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
      expect(startsBeforeConcluding).toHaveLength(1); // active expert only
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
      expect(stored[0].expertId).toBe(4);

      const moderatorSuggestionArgs = mockGetModeratorNextSpeakerSuggestion.mock.calls.flat();
      expect(moderatorSuggestionArgs).toContainEqual(expect.objectContaining({
        id: 4,
        role: "Moderator",
        model: "test/configured-moderator-model",
      }));
      const synthesisCall = mockGenerateClosingSynthesis.mock.calls.find(
        (call) => call[0] === conversationId,
      );
      expect(synthesisCall?.[1]).toMatchObject({
        id: 4,
        role: "Moderator",
        model: "test/configured-moderator-model",
      });

      // ...the selected active expert ran (no forced roll-call)...
      expect(turnNames()).toEqual(["Alice"]);
      expect(assistantCount()).toBe(2); // 1 expert turn + 1 synthesis

      // ...and the sequence ended through the natural-end cleanup.
      const state = getConversationState(conversationId)!;
      expect(state.mode).toBe("idle");
      expect(state.currentExpertIndex).toBe(-1);
      expect(state.totalAutonomousTurnsTaken).toBe(0);
      expect(mockGenerateInsights).toHaveBeenCalledWith(conversationId, expect.any(Function));

      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("uses a synthetic Moderator for routing and stores synthesis with a null expert FK", async () => {
      const conversationId = nextConvId();
      const {
        roster,
        waitForTurns,
        releaseNextTurn,
        drainToIdle,
        turnNames,
        assistantCount,
        synthesisMessages,
        events,
        addUserMessageToHistory,
      } = setupGatedModeratorConversation(conversationId, false);
      vi.stubEnv("DEFAULT_AUX_MODEL", "test/default-moderator-model");
      mockGetModeratorNextSpeakerSuggestion
        .mockResolvedValueOnce("Agronomist")
        .mockResolvedValue("Conclude");
      mockSynthesisTurn(conversationId);
      new InteractionOrchestrator(conversationId).enableAutonomous(2);

      expect(roster.some((expert) => expert.role === "Moderator")).toBe(false);

      const userMessage = createMockMessage(1, "Plan my week");
      addUserMessageToHistory(userMessage);
      await processMessageTurnBased(
        userId,
        conversationId,
        userMessage,
        broadcastFn,
      );

      // The synthetic Moderator selects one active expert, then concludes
      // without appearing as an ordinary expert turn.
      await waitForTurns(1);
      expect(turnNames()).toEqual(["Alice"]);
      await releaseNextTurn();
      await waitForMode(conversationId, "idle");

      expect(turnNames()).toEqual(["Alice"]);
      expect(turnNames()).not.toContain("Moderator");
      expect(mockGetModeratorNextSpeakerSuggestion).toHaveBeenCalledTimes(2);
      expect(mockGetModeratorNextSpeakerSuggestion.mock.calls.flat()).toContainEqual(
        expect.objectContaining({
          id: null,
          role: "Moderator",
          model: "test/default-moderator-model",
        }),
      );
      for (const [moderator, , availableRoles] of mockGetModeratorNextSpeakerSuggestion.mock.calls) {
        if (moderator?.conversationId === conversationId) {
          expect(availableRoles).not.toContain("Moderator");
        }
      }

      const synthesisCall = mockGenerateClosingSynthesis.mock.calls.find(
        (call) => call[0] === conversationId,
      );
      expect(synthesisCall?.[1]).toMatchObject({
        id: null,
        role: "Moderator",
        model: "test/default-moderator-model",
      });
      const stored = synthesisMessages();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        role: "assistant",
        expertId: null,
        expertRole: "Moderator",
        isSynthesis: true,
      });
      expect(events().find((event) => event.type === "expert_stream_start" && event.expertRole === "Moderator"))
        .toMatchObject({ expertId: null, expertRole: "Moderator" });
      expect(assistantCount()).toBe(2); // 1 active turn + 1 synthesis

      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("does not let the closing synthesis consume the autonomous turn budget", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames, assistantCount, addUserMessageToHistory, synthesisMessages } =
        setupGatedModeratorConversation(conversationId);
      // The Moderator routes the first autonomous turn to Alice, then calls
      // the round on the next decision.
      mockGetModeratorNextSpeakerSuggestion
        .mockResolvedValueOnce("Agronomist")
        .mockResolvedValue("Conclude");
      new InteractionOrchestrator(conversationId).enableAutonomous(2);

      // Snapshot the budget at the moment the synthesis streams: one real
      // autonomous turn (Alice) must have been billed, the synthesis none.
      let counterAtSynthesis: number | null = null;
      mockSynthesisTurn(conversationId, () => {
        counterAtSynthesis = getConversationState(conversationId)!.totalAutonomousTurnsTaken;
      });

      const userMessage = createMockMessage(1, "Plan my week");
      addUserMessageToHistory(userMessage);
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      // The Moderator selects Alice for the first autonomous turn.
      await waitForTurns(1);
      expect(turnNames()).toEqual(["Alice"]);
      await releaseNextTurn();

      // Next decision: the Moderator concludes while the budget shows one
      // used turn of two — the synthesis must not bill a second.
      await waitForMode(conversationId, "idle");

      expect(counterAtSynthesis).toBe(1);
      expect(synthesisMessages()).toHaveLength(1);
      // One autonomous expert turn + one synthesis. A synthesis billed
      // against the cap would have pushed the loop to the cap first.
      expect(turnNames()).toEqual(["Alice"]);
      expect(assistantCount()).toBe(2);
      const state = getConversationState(conversationId)!;
      expect(state.mode).toBe("idle");
      expect(state.totalAutonomousTurnsTaken).toBe(0);

      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("honors Moderator Conclude after the selected responder without a forced roll-call", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames, assistantCount, addUserMessageToHistory, synthesisMessages, events } =
        setupGatedModeratorConversation(conversationId);
      // The farmer's mention selects Alice; the Moderator may conclude after
      // that current expert finishes instead of waiting for a roster roll-call.
      mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("Conclude");
      mockSynthesisTurn(conversationId);

      const userMessage = createMockMessage(1, "@[Agronomist] Plan my week", "user", undefined, ["Agronomist"]);
      addUserMessageToHistory(userMessage);
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);
      await waitForTurns(1);
      expect(turnNames()).toEqual(["Alice"]);
      await releaseNextTurn();
      await waitForMode(conversationId, "idle");

      // The Moderator's judgment is active in autonomous flow and no extra
      // experts are forced to speak before synthesis.
      expect(mockGetModeratorNextSpeakerSuggestion).toHaveBeenCalledTimes(1);
      expect(mockGenerateClosingSynthesis).toHaveBeenCalledTimes(1);
      expect(events().some((e) => e.type === "concluding")).toBe(true);
      expect(synthesisMessages()).toHaveLength(1);
      expect(turnNames()).toEqual(["Alice"]);
      expect(assistantCount()).toBe(2);
      expect(getConversationState(conversationId)!.mode).toBe("idle");

      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("routes a message that arrives during closing synthesis after the synthesis turn finishes", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames, assistantCount, addUserMessageToHistory, synthesisMessages, waitForEvent } =
        setupGatedModeratorConversation(conversationId);
      mockGetModeratorNextSpeakerSuggestion
        .mockResolvedValueOnce("Soil Scientist")
        .mockResolvedValueOnce("Weather Expert")
        .mockResolvedValue("Conclude");

      let releaseSynthesis: () => void = () => {};
      const synthesisHeld = new Promise<void>((resolve) => { releaseSynthesis = resolve; });
      let joinedState: ReturnType<typeof getConversationState> = undefined;
      let markJoined: () => void = () => {};
      const messageJoined = new Promise<void>((resolve) => { markJoined = resolve; });
      mockSynthesisTurn(conversationId, async () => {
        const joinedMessage = createMockMessage(
          2,
          "@[Soil Scientist] Wait — one more thing",
          "user",
          undefined,
          ["Soil Scientist"],
        );
        addUserMessageToHistory(joinedMessage);
        await processMessageTurnBased(
          userId,
          conversationId,
          joinedMessage,
          broadcastFn,
        );
        joinedState = getConversationState(conversationId);
        markJoined();
        await synthesisHeld;
      });

      const initialMessage = createMockMessage(
        1,
        "@[Agronomist] Plan my week",
        "user",
        undefined,
        ["Agronomist"],
      );
      addUserMessageToHistory(initialMessage);
      await processMessageTurnBased(userId, conversationId, initialMessage, broadcastFn);

      // Route the original question through three distinct experts, then hold
      // the Moderator's closing turn while the farmer adds another fact.
      for (let i = 1; i <= 3; i++) {
        await waitForTurns(i);
        await releaseNextTurn();
      }
      await waitForEvent("concluding");
      await messageJoined;

      expect(joinedState?.pendingUserMessage?.content).toBe("@[Soil Scientist] Wait — one more thing");
      expect(joinedState?.wasInterrupted).toBe(false);
      expect(broadcastFn).not.toHaveBeenCalledWith(conversationId, { type: "steering" });
      expect(synthesisMessages()).toHaveLength(0); // still held mid-stream

      releaseSynthesis();
      await waitForTurns(4);
      expect(turnNames()).toEqual(["Alice", "Bob", "Carol", "Bob"]);
      expect(synthesisMessages()).toHaveLength(1); // the existing close completes once
      expect(mockGenerateClosingSynthesis.mock.calls.filter((call) => call[0] === conversationId)).toHaveLength(1);

      // The mentioned responder completes, then no fresh roll-call starts.
      new InteractionOrchestrator(conversationId).disableAutonomous();
      await releaseNextTurn();
      await waitForMode(conversationId, "idle");
      expect(turnNames()).toEqual(["Alice", "Bob", "Carol", "Bob"]);
      expect(assistantCount()).toBe(5); // 3 original turns + synthesis + 1 response
      expect(synthesisMessages()).toHaveLength(1);

      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("does not double-conclude when pause+resume land mid-synthesis (single synthesis stream)", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames, assistantCount, addUserMessageToHistory, synthesisMessages, events, waitForEvent } =
        setupGatedModeratorConversation(conversationId);
      mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("Conclude");

      // Hold the synthesis mid-stream with the pause already landed, so the
      // test can resume() while the closing turn is still in flight.
      let releaseSynthesis: () => void = () => {};
      const synthesisHeld = new Promise<void>((resolve) => { releaseSynthesis = resolve; });
      mockSynthesisTurn(conversationId, async () => {
        new InteractionOrchestrator(conversationId).pause();
        await synthesisHeld;
      });

      const userMessage = createMockMessage(
        1,
        "@[Agronomist] Plan my week",
        "user",
        undefined,
        ["Agronomist"],
      );
      addUserMessageToHistory(userMessage);
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      await waitForTurns(1);
      expect(turnNames()).toEqual(["Alice"]);
      await releaseNextTurn();

      // The pause landed mid-synthesis...
      await waitForEvent("concluding");
      await waitForMode(conversationId, "paused");

      // ...and resume() fires while the synthesis is still streaming. The
      // resumed chain must bow out on the in-flight synthesis turn instead of
      // re-running routing and concluding a second time.
      new InteractionOrchestrator(conversationId).resume();

      // Let the synthesis finish; the sequence must end exactly once.
      releaseSynthesis();
      await waitForMode(conversationId, "idle");

      // Exactly one concluding signal, one synthesis stream, one stored
      // synthesis row, and one insights run.
      expect(events().filter((e) => e.type === "concluding")).toHaveLength(1);
      expect(
        mockGenerateClosingSynthesis.mock.calls.filter((c) => c[0] === conversationId),
      ).toHaveLength(1);
      expect(synthesisMessages()).toHaveLength(1);
      expect(
        mockGenerateInsights.mock.calls.filter((c) => c[0] === conversationId),
      ).toHaveLength(1);

      // The selected expert ran once; no extra expert turn was billed by the
      // resumed chain.
      expect(turnNames()).toEqual(["Alice"]);
      expect(assistantCount()).toBe(2); // 1 expert turn + 1 synthesis

      const state = getConversationState(conversationId)!;
      expect(state.mode).toBe("idle");
      expect(state.wasInterrupted).toBe(false);
      expect(state.totalAutonomousTurnsTaken).toBe(0);

      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });

    it("resumes in place and routes a queued mention after a message arrives during paused synthesis", async () => {
      const conversationId = nextConvId();
      const { waitForTurns, releaseNextTurn, drainToIdle, turnNames, assistantCount, addUserMessageToHistory, synthesisMessages, events, waitForEvent } =
        setupGatedModeratorConversation(conversationId);
      mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("Conclude");

      // Hold the synthesis mid-stream with the pause landed, then deliver a
      // mention while the closing turn remains in flight.
      let releaseSynthesis: () => void = () => {};
      const synthesisHeld = new Promise<void>((resolve) => { releaseSynthesis = resolve; });
      mockSynthesisTurn(conversationId, async () => {
        new InteractionOrchestrator(conversationId).pause();
        await synthesisHeld;
      });

      const userMessage = createMockMessage(
        1,
        "@[Agronomist] Plan my week",
        "user",
        undefined,
        ["Agronomist"],
      );
      addUserMessageToHistory(userMessage);
      await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);

      await waitForTurns(1);
      expect(turnNames()).toEqual(["Alice"]);
      await releaseNextTurn();

      await waitForEvent("concluding");
      await waitForMode(conversationId, "paused");
      const joinedMessage = createMockMessage(
        2,
        "@[Soil Scientist] Wait — one more thing",
        "user",
        undefined,
        ["Soil Scientist"],
      );
      addUserMessageToHistory(joinedMessage);
      await processMessageTurnBased(
        userId,
        conversationId,
        joinedMessage,
        broadcastFn,
      );

      // The paused flow retains the new context without setting the legacy
      // steering interrupt or starting a second chain over the synthesis.
      let state = getConversationState(conversationId)!;
      expect(state.pendingUserMessage?.content).toBe("@[Soil Scientist] Wait — one more thing");
      expect(state.wasInterrupted).toBe(false);
      expect(broadcastFn).not.toHaveBeenCalledWith(conversationId, { type: "steering" });

      // With autonomy disabled, exactly one pending responder is allowed
      // after the existing close; it must not replay Alice or conclude again.
      new InteractionOrchestrator(conversationId).disableAutonomous();
      releaseSynthesis();
      await waitForTurns(2);
      expect(turnNames()).toEqual(["Alice", "Bob"]);
      await releaseNextTurn();
      await waitForMode(conversationId, "idle");

      state = getConversationState(conversationId)!;
      expect(state.mode).toBe("idle");
      expect(state.wasInterrupted).toBe(false);
      expect(state.lastUserMessage!.content).toBe("@[Soil Scientist] Wait — one more thing");

      expect(turnNames()).toEqual(["Alice", "Bob"]);
      expect(assistantCount()).toBe(3); // Alice + synthesis + one pending response
      expect(synthesisMessages()).toHaveLength(1); // no second conclusion
      expect(events().filter((e) => e.type === "concluding")).toHaveLength(1);

      await drainToIdle();
      expect(getConversationState(conversationId)!.mode).toBe("idle");
    });
  });
});
