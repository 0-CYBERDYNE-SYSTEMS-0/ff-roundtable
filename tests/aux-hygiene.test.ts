/**
 * G8 — Aux-call hygiene tests
 *
 * Covers:
 *  - G8/G10 resolveAuxModel precedence: configured Moderator model →
 *    DEFAULT_AUX_MODEL → first expert's model → null; whitespace-only values
 *    count as empty; results are trimmed.
 *  - Moderator routing degradation: a null verdict (provider failure /
 *    invalid verdict / no resolvable aux model) falls back to round-robin in
 *    roster order and broadcasts exactly ONE "notice" per sequence — even
 *    across multiple autonomous turns — and re-arms for the next sequence.
 *    A successful verdict broadcasts no notice.
 *
 * Mirrors tests/orchestrator.test.ts idioms (vi.mock of server/ai at the
 * module boundary). The REAL resolveAuxModel is loaded through
 * vi.importActual so the pure resolver can be unit-tested in the same file
 * whose ai-module mock serves the orchestrator behavior tests. Each test
 * uses a unique conversationId to avoid module-level state pollution.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

// ── Mock storage and AI modules BEFORE importing orchestrator ──
const mockGetConversation = vi.hoisted(() => vi.fn());
const mockUpdateConversation = vi.hoisted(() => vi.fn());
const mockGetConversationMessages = vi.hoisted(() => vi.fn());
const mockGetConversationExperts = vi.hoisted(() => vi.fn());
const mockGetConversationFiles = vi.hoisted(() => vi.fn());
const mockCreateMessage = vi.hoisted(() => vi.fn());

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

import {
  InteractionOrchestrator,
  getConversationState,
  processMessageTurnBased,
} from "../server/orchestrator";
import type { Expert, Message } from "../shared/schema";

// The real ai module (bypasses the mock above) — for the pure resolver only.
const { resolveAuxModel } = await vi.importActual<typeof import("../server/ai")>("../server/ai");

// ── Helpers ──
function createMockExpert(id: number, name: string, role: string, conversationId = 1): Expert {
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

function createMockMessage(id: number, content: string): Message {
  return {
    id,
    conversationId: 1,
    expertId: null,
    userId: 1,
    content,
    role: "user",
    expertName: null,
    expertRole: null,
    artifacts: [],
    mentions: null,
    timestamp: new Date(),
  };
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Unique conversation ID counter to avoid state pollution
let convIdCounter = 800;
function nextConvId(): number {
  return convIdCounter++;
}

// ─────────────────────────────────────────────────────────────────
// G8/G10 — resolveAuxModel (pure resolver, real ai module)
// ─────────────────────────────────────────────────────────────────

describe("G8/G10 resolveAuxModel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers the Moderator's model over env and first expert", () => {
    vi.stubEnv("DEFAULT_AUX_MODEL", "env/default-model");
    expect(resolveAuxModel("mod/model", "first/model")).toBe("mod/model");
    // Trimmed result for sloppily stored slugs.
    expect(resolveAuxModel("  mod/model  ", "first/model")).toBe("mod/model");
  });

  it("uses DEFAULT_AUX_MODEL before the first expert when no Moderator model is configured", () => {
    vi.stubEnv("DEFAULT_AUX_MODEL", "env/default-model");
    expect(resolveAuxModel(null, "first/model")).toBe("env/default-model");
    expect(resolveAuxModel(undefined, "first/model")).toBe("env/default-model");
    expect(resolveAuxModel("", "first/model")).toBe("env/default-model");
    expect(resolveAuxModel("   ", "first/model")).toBe("env/default-model");
  });

  it("falls back to the first expert's model when Moderator and env are empty", () => {
    vi.stubEnv("DEFAULT_AUX_MODEL", "");
    expect(resolveAuxModel(null, "first/model")).toBe("first/model");
    expect(resolveAuxModel(undefined, "  first/model  ")).toBe("first/model");
  });

  it("returns null when nothing resolves", () => {
    vi.stubEnv("DEFAULT_AUX_MODEL", "");
    expect(resolveAuxModel(null, null)).toBeNull();
    expect(resolveAuxModel(undefined, undefined)).toBeNull();
    expect(resolveAuxModel("", "   ")).toBeNull();
  });

  it("treats whitespace-only values as empty at every precedence tier", () => {
    vi.stubEnv("DEFAULT_AUX_MODEL", "   ");
    // Whitespace moderator → env, but env is whitespace-only too → first expert.
    expect(resolveAuxModel("  ", "first/model")).toBe("first/model");
    // Nothing but whitespace anywhere → null (caller must skip the aux call).
    vi.stubEnv("DEFAULT_AUX_MODEL", "");
    expect(resolveAuxModel("  ", "   ")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// G8 — Moderator degradation notice (orchestrator behavior)
// ─────────────────────────────────────────────────────────────────

describe("G8 moderator degradation notice", () => {
  const userId = 1;
  const broadcastFn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // Default verdict: every Moderator consultation FAILS (null) — the
    // success case overrides this inside its test.
    mockGetModeratorNextSpeakerSuggestion.mockResolvedValue(null);
    mockGenerateInsights.mockResolvedValue(undefined);
    mockGenerateClosingSynthesis.mockResolvedValue(undefined);
  });

  // The orchestrator drives turn chains via setImmediate and keeps logging
  // after the last test's waits expire. Drain pending work so the worker
  // doesn't tear down mid-log (same rationale as tests/orchestrator.test.ts).
  afterAll(async () => {
    await waitFor(500);
  });

  // Moderator-council fixture: 3 active experts and a configured Moderator.
  // The Moderator routes the autonomous extension but does not take an
  // ordinary expert turn. Unique response content keeps redundancy out of
  // play.
  function setupModeratorRound(conversationId: number) {
    const roster: Expert[] = [
      createMockExpert(1, "Alice", "Agronomist", conversationId),
      createMockExpert(2, "Bob", "Soil Scientist", conversationId),
      createMockExpert(3, "Carol", "Weather Expert", conversationId),
      createMockExpert(4, "Matt", "Moderator", conversationId),
    ];
    mockGetConversationExperts.mockResolvedValue(roster);
    mockGetConversationFiles.mockResolvedValue([]);

    const messages: Message[] = [];
    let messageId = 80_000 + conversationId * 100;
    mockGetConversationMessages.mockImplementation((cid: number) =>
      Promise.resolve(messages.filter((m) => m.conversationId === cid)),
    );
    mockCreateMessage.mockImplementation((msg: Partial<Message>) => {
      const stored = { ...msg, id: messageId++, timestamp: new Date() } as Message;
      messages.push(stored);
      return Promise.resolve(stored);
    });

    let contentCounter = 0;
    mockGetExpertResponseStream.mockImplementation(async (expert: Expert) => ({
      conversationId: expert.conversationId,
      expertId: expert.id,
      userId: null,
      content: `Distinct answer ${++contentCounter} from ${expert.name}`,
      role: "assistant",
      expertName: expert.name,
      expertRole: expert.role,
      artifacts: [],
    }));

    const turnNames = () =>
      mockGetExpertResponseStream.mock.calls
        .filter((c) => c[0].conversationId === conversationId)
        .map((c) => c[0].name);

    const notices = () =>
      broadcastFn.mock.calls
        .filter((c) => c[0] === conversationId && c[1]?.type === "notice")
        .map((c) => c[1]);

    // Wait (bounded) until the conversation settles back to idle, then let
    // trailing events/insights land.
    const waitForIdle = async (timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const s = getConversationState(conversationId);
        if (s && s.mode === "idle") {
          await waitFor(150);
          return;
        }
        await waitFor(10);
      }
      throw new Error(`Timed out waiting for idle on conversation ${conversationId}`);
    };

    return { roster, turnNames, notices, waitForIdle };
  }

  const NOTICE_MESSAGE = "Moderator unavailable — speaking in round-robin.";

  it("falls back to round-robin with exactly one notice per sequence when the Moderator call fails", async () => {
    const conversationId = nextConvId();
    const { turnNames, notices, waitForIdle } = setupModeratorRound(conversationId);

    const userMessage = createMockMessage(1, "Plan my week");
    await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);
    // Tight cap: the autonomous extension runs exactly 2 turns.
    new InteractionOrchestrator(conversationId).enableAutonomous(2);

    await waitForIdle();

    // Round-robin order preserved: three active experts, then the 2-turn
    // autonomous extension continues from the top of the active roster.
    expect(turnNames()).toEqual(["Alice", "Bob", "Carol", "Alice", "Bob"]);

    // The Moderator was consulted before BOTH autonomous turns and returned
    // null both times — yet the notice went out exactly once.
    expect(mockGetModeratorNextSpeakerSuggestion).toHaveBeenCalledTimes(2);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toEqual({
      type: "notice",
      conversationId,
      message: NOTICE_MESSAGE,
    });

    // The sequence still ends normally: idle + insights cleanup.
    const state = getConversationState(conversationId)!;
    expect(state.mode).toBe("idle");
    expect(state.currentExpertIndex).toBe(-1);
    expect(state.totalAutonomousTurnsTaken).toBe(0);
    expect(mockGenerateInsights).toHaveBeenCalledWith(conversationId, expect.any(Function));
  });

  it("broadcasts no notice when the Moderator suggestion succeeds", async () => {
    const conversationId = nextConvId();
    const { turnNames, notices, waitForIdle } = setupModeratorRound(conversationId);

    // A successful verdict ('RoundRobin' is a valid answer, as is any roster
    // role) — degraded-round-robin never applies.
    mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("RoundRobin");

    const userMessage = createMockMessage(1, "Plan my week");
    await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);
    new InteractionOrchestrator(conversationId).enableAutonomous(1);

    await waitForIdle();

    // The Moderator WAS consulted (autonomous extension ran) and answered.
    expect(mockGetModeratorNextSpeakerSuggestion).toHaveBeenCalledTimes(1);
    expect(turnNames()).toEqual(["Alice", "Bob", "Carol", "Alice"]);
    expect(notices()).toHaveLength(0);
    expect(getConversationState(conversationId)!.mode).toBe("idle");
  });

  it("re-arms the notice for a new sequence (one notice per sequence, not per conversation)", async () => {
    const conversationId = nextConvId();
    const { notices, waitForIdle } = setupModeratorRound(conversationId);

    // Sequence 1: 3 sequential + 1 autonomous turn → one notice.
    const userMessage1 = createMockMessage(1, "First question");
    await processMessageTurnBased(userId, conversationId, userMessage1, broadcastFn);
    new InteractionOrchestrator(conversationId).enableAutonomous(1);
    await waitForIdle();
    expect(notices()).toHaveLength(1);

    // Sequence 2: a fresh message after idle restarts the sequence; the
    // Moderator fails again → the notice fires once more (reset worked).
    const userMessage2 = createMockMessage(2, "Second question");
    await processMessageTurnBased(userId, conversationId, userMessage2, broadcastFn);
    await waitForIdle();

    expect(notices()).toHaveLength(2);
    expect(notices()[1]).toEqual({
      type: "notice",
      conversationId,
      message: NOTICE_MESSAGE,
    });
    expect(getConversationState(conversationId)!.mode).toBe("idle");
  });
});
