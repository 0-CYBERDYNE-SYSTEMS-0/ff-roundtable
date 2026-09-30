/**
 * Orchestrator Recovery Tests (G7 — Survivable orchestrator state)
 *
 * Covers:
 *  - Snapshot persistence at TURN BOUNDARIES ONLY: a full mocked round writes
 *    exactly the semantic transitions idle → autonomous (start) → per-turn
 *    boundaries → idle (natural end), and internal flips (turnInFlight,
 *    turnChainScheduled, streak/history mutations) never write. Writes are
 *    serialized per conversation in enqueue order.
 *  - Cold-start reconstruction: a persisted autonomous snapshot (a dead loop
 *    from before a restart) recovers to idle with a warning and starts a
 *    direct-autonomous run — no queued-message event, correct event order.
 *  - Cold-start paused restore: a persisted paused snapshot restores the
 *    paused badge (state_update), then a message resumes from the saved mode
 *    and sequence counters in place.
 *  - Snapshot write failures never break the turn loop.
 *
 * Uses vitest with vi.mock for storage and AI dependencies, mirroring the
 * idioms of tests/orchestrator.test.ts. Each test uses a unique
 * conversationId to avoid module-level state pollution.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

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

import {
  InteractionOrchestrator,
  getConversationState,
  processMessageTurnBased,
  restorePausedFromSnapshot,
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
let convIdCounter = 500;
function nextConvId(): number {
  return convIdCounter++;
}

describe("Orchestrator recovery (G7 snapshots)", () => {
  const userId = 1;
  const broadcastFn = vi.fn();

  const experts: Expert[] = [
    createMockExpert(1, "Alice", "Agronomist"),
    createMockExpert(2, "Bob", "Soil Scientist"),
    createMockExpert(3, "Carol", "Weather Expert"),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConversation.mockResolvedValue(undefined);
    mockUpdateConversation.mockResolvedValue(undefined);
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

  // Full-round fixtures: 3 experts, immediate unique-content responses, so a
  // fresh direct-autonomous run is 6 turns (experts * 2) with no redundancy
  // early-stop and no mention routing.
  function setupFullRound(conversationId: number) {
    mockGetConversationExperts.mockResolvedValue(
      experts.map((e) => ({ ...e, conversationId })),
    );
    mockGetConversationFiles.mockResolvedValue([]);

    const messages: Message[] = [];
    let messageId = 50_000 + conversationId * 100;
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
      content: `Distinct point ${++contentCounter} from ${expert.name} (conv ${expert.conversationId})`,
      role: "assistant",
      expertName: expert.name,
      expertRole: expert.role,
      artifacts: [],
    }));
  }

  // A persisted conversation row with the given snapshot (or none).
  function persistRow(conversationId: number, orchestratorState: unknown, turnBudget?: number | null) {
    mockGetConversation.mockResolvedValue({
      id: conversationId,
      userId,
      title: "Recovered conversation",
      charter: null,
      orchestratorState,
      ...(turnBudget !== undefined && { turnBudget }),
      createdAt: new Date(),
    });
  }

  async function startSixTurnRun(conversationId: number, message: Message) {
    await processMessageTurnBased(userId, conversationId, message, broadcastFn);
    new InteractionOrchestrator(conversationId).enableAutonomous(6);
  }

  // Snapshots handed to storage.updateConversation, in call order.
  const persistedSnapshots = (): Array<Record<string, unknown>> =>
    mockUpdateConversation.mock.calls
      .map((c) => (c[1] as any)?.orchestratorState)
      .filter((s) => s && typeof s === "object");

  const stateUpdates = (conversationId: number) =>
    broadcastFn.mock.calls
      .filter((c) => c[0] === conversationId && (c[1] as any)?.type === "state_update")
      .map((c) => c[1] as any);

  const assistantCount = () =>
    mockCreateMessage.mock.calls.filter((c) => (c[0] as any)?.role === "assistant").length;

  // Wait until the expected remaining autonomous turns settle back to idle,
  // then let trailing snapshot writes (microtask-chained) land.
  async function drainAutonomousRun(conversationId: number, expectedAssistantTurns = 6) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const s = getConversationState(conversationId);
      if (s && s.mode === "idle" && assistantCount() >= expectedAssistantTurns) break;
      await waitFor(10);
    }
    await waitFor(200);
  }

  // The exact write sequence of one fresh six-turn run: init (idle) →
  // autonomous start → explicit cap update to six → 6 turn boundaries →
  // natural end (idle). Both the cap change and turn boundaries are semantic
  // snapshot changes; internal-only flips still never write.
  const FULL_ROUND_SNAPSHOT_MODES = [
    "idle",
    "autonomous",
    "autonomous",
    "autonomous",
    "autonomous",
    "autonomous",
    "autonomous",
    "autonomous",
    "autonomous",
    "idle",
  ];

  // ─────────────────────────────────────────────────────────────────
  // (c) Turn-boundary persistence + per-conversation serialization
  // ─────────────────────────────────────────────────────────────────

  it("persists snapshots exactly at semantic turn boundaries, serialized per conversation", async () => {
    const conversationId = nextConvId();
    setupFullRound(conversationId);
    persistRow(conversationId, null); // stored snapshot present but null

    // Serialization proof: make the FIRST write the slowest. If writes were
    // fired concurrently instead of chained, a later write would start (and
    // finish) before the first resolved and the start/end events would
    // interleave.
    const events: string[] = [];
    let firstWrite = true;
    mockUpdateConversation.mockImplementation(async (_id: number, updates: any) => {
      const mode = updates?.orchestratorState?.mode ?? "unknown";
      events.push(`start:${mode}`);
      if (firstWrite) {
        firstWrite = false;
        await waitFor(60);
      }
      events.push(`end:${mode}`);
      return undefined;
    });

    await startSixTurnRun(conversationId, createMockMessage(3, "Roundtable, go"));
    await drainAutonomousRun(conversationId);

    const modes = persistedSnapshots().map((s) => s.mode);
    expect(modes).toEqual(FULL_ROUND_SNAPSHOT_MODES);

    // Strict start/end alternation == write N+1 never started before write N
    // resolved, i.e. the per-conversation promise chain serialized them.
    const expectedEvents = modes.flatMap((m) => [`start:${m}`, `end:${m}`]);
    expect(events).toEqual(expectedEvents);
  });

  it("cold-starts directly in autonomous mode when no snapshot row exists", async () => {
    const conversationId = nextConvId();
    setupFullRound(conversationId);
    // beforeEach default: getConversation → undefined (no row at all)

    await startSixTurnRun(conversationId, createMockMessage(4, "Fresh start"));
    await drainAutonomousRun(conversationId);

    expect(mockGetConversation).toHaveBeenCalledWith(conversationId);
    expect(persistedSnapshots().map((s) => s.mode)).toEqual(FULL_ROUND_SNAPSHOT_MODES);
    expect(getConversationState(conversationId)?.mode).toBe("idle");
  });

  it.each([
    ["missing", undefined, 25],
    ["saved numeric", 17, 17],
    ["let it run", null, 100],
    ["legacy zero", 0, 100],
    ["over-ceiling stored value", 140, 100],
  ] as const)("initializes the runtime budget from %s conversation setting", async (_label, savedBudget, expectedBudget) => {
    const conversationId = nextConvId();
    setupFullRound(conversationId);
    persistRow(conversationId, null, savedBudget);

    await processMessageTurnBased(userId, conversationId, createMockMessage(40, "Budget initialization"), broadcastFn);
    // Park before the first setImmediate turn so this assertion covers the
    // initialized setting without running an entire 100-turn sequence.
    new InteractionOrchestrator(conversationId).pause();

    expect(getConversationState(conversationId)?.maxAutonomousTurns).toBe(expectedBudget);
    await waitFor(30);
  });

  it("enforces the saved numeric budget as the runtime expert-turn ceiling", async () => {
    const conversationId = nextConvId();
    setupFullRound(conversationId);
    persistRow(conversationId, null, 2);

    await processMessageTurnBased(userId, conversationId, createMockMessage(41, "Use the saved budget"), broadcastFn);
    await drainAutonomousRun(conversationId, 2);

    expect(assistantCount()).toBe(2);
    expect(getConversationState(conversationId)?.mode).toBe("idle");
    expect(getConversationState(conversationId)?.maxAutonomousTurns).toBe(2);
  });

  it("lets the council run under the hard 100-turn ceiling when the saved budget is null", async () => {
    const conversationId = nextConvId();
    setupFullRound(conversationId);
    persistRow(conversationId, null, null);

    await processMessageTurnBased(userId, conversationId, createMockMessage(42, "Let it run"), broadcastFn);
    await drainAutonomousRun(conversationId, 100);

    expect(assistantCount()).toBe(100);
    expect(getConversationState(conversationId)?.mode).toBe("idle");
    expect(getConversationState(conversationId)?.maxAutonomousTurns).toBe(100);
  });

  it("passes the upcoming turn position and effective budget to the Moderator", async () => {
    const conversationId = nextConvId();
    setupFullRound(conversationId);
    persistRow(conversationId, null, 2);
    mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("Conclude");

    await processMessageTurnBased(userId, conversationId, createMockMessage(43, "Route by budget"), broadcastFn);
    await drainAutonomousRun(conversationId, 1);

    expect(mockGetModeratorNextSpeakerSuggestion.mock.calls[0]?.[4]).toEqual({
      turnNumber: 1,
      turnBudget: 2,
    });
    expect(mockGetModeratorNextSpeakerSuggestion.mock.calls[1]?.[4]).toEqual({
      turnNumber: 2,
      turnBudget: 2,
    });
    expect(getConversationState(conversationId)?.mode).toBe("idle");
  });

  // ─────────────────────────────────────────────────────────────────
  // (a) Kill-mid-round: persisted autonomous snapshot (dead loop)
  // ─────────────────────────────────────────────────────────────────

  it.each(["processing_sequential", "autonomous"] as const)(
    "recovers a persisted %s snapshot to idle and starts a direct-autonomous run",
    async (mode) => {
    const conversationId = nextConvId();
    setupFullRound(conversationId);
    persistRow(conversationId, {
      mode,
      currentExpertIndex: 2,
      totalAutonomousTurnsTaken: 3,
      wasInterrupted: false,
      pausedFromMode: null,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let warnedAboutDeadLoop = false;
    try {
      await startSixTurnRun(conversationId, createMockMessage(5, "Hello after the crash"));
      warnedAboutDeadLoop = warnSpy.mock.calls.some((args) =>
        args.join(" ").includes("Recovering to idle"),
      );
      await drainAutonomousRun(conversationId);
    } finally {
      warnSpy.mockRestore();
    }

    expect(warnedAboutDeadLoop).toBe(true);

    // The corrected idle snapshot was persisted first, superseding the
    // stale autonomous one from the dead process.
    const snapshots = persistedSnapshots();
    expect(snapshots[0]).toMatchObject({ mode: "idle" });

    // Badge correction: the first state_update is the honest idle state
    // (initializeConversationState), never the dead autonomous mode.
    const updates = stateUpdates(conversationId);
    expect(updates[0]).toMatchObject({ mode: "idle", isAutonomousEnabled: true });

    // No queue event: the message arrived into an idle recovered state.
    expect(
      broadcastFn.mock.calls.some(
        (c) => c[0] === conversationId && (c[1] as any)?.type === "message_queued",
      ),
    ).toBe(false);

    // The message starts autonomous directly, with no sequential phase.
    const modes = updates.map((u) => u.mode);
    expect(modes).not.toContain("processing_sequential");
    expect(modes).toContain("autonomous");
    expect(modes[modes.length - 1]).toBe("idle");
    expect(getConversationState(conversationId)?.mode).toBe("idle");
    expect(assistantCount()).toBe(6);
    },
  );

  it("recovers a dead autonomous snapshot to idle while retaining its settings", async () => {
    const conversationId = nextConvId();
    setupFullRound(conversationId);
    persistRow(conversationId, {
      mode: "autonomous",
      currentExpertIndex: 2,
      totalAutonomousTurnsTaken: 3,
      wasInterrupted: false,
      pausedFromMode: null,
      isAutonomousEnabled: false,
      maxAutonomousTurns: 8,
    }, 25);

    await processMessageTurnBased(userId, conversationId, createMockMessage(44, "Continue after recovery"), broadcastFn);
    await drainAutonomousRun(conversationId, 1);

    expect(getConversationState(conversationId)).toMatchObject({
      mode: "idle",
      isAutonomousEnabled: false,
      maxAutonomousTurns: 8,
    });
    expect(assistantCount()).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────
  // (b) Paused restore + resume in place
  // ─────────────────────────────────────────────────────────────────

  it("restores a persisted paused snapshot, then resumes in place on the message", async () => {
    const conversationId = nextConvId();
    setupFullRound(conversationId);
    persistRow(conversationId, {
      mode: "paused",
      currentExpertIndex: 1,
      totalAutonomousTurnsTaken: 2,
      wasInterrupted: false,
      pausedFromMode: "autonomous",
    });

    await startSixTurnRun(conversationId, createMockMessage(6, "Waking the council"));
    await drainAutonomousRun(conversationId, 4);

    const updates = stateUpdates(conversationId);

    // 1. idle   — initializeConversationState broadcast
    // 2. paused    — restored via updateConversationState
    // 3. autonomous — resumed in place; mode and counters are not reset
    expect(updates[0]).toMatchObject({ mode: "idle" });
    expect(updates[1]).toMatchObject({ mode: "paused" });
    expect(updates[2]).toMatchObject({ mode: "autonomous" });
    expect(updates.map((update) => update.mode)).not.toContain("processing_sequential");
    expect(updates[updates.length - 1]).toMatchObject({ mode: "idle" });

    // The restored paused state was itself persisted (and the round then
    // wrote fresh snapshots through the existing paths).
    const modes = persistedSnapshots().map((s) => s.mode);
    expect(modes[0]).toBe("idle");
    expect(modes[1]).toBe("paused");
    expect(persistedSnapshots()[2]).toMatchObject({
      mode: "autonomous",
      currentExpertIndex: 1,
      totalAutonomousTurnsTaken: 2,
    });
    expect(modes[modes.length - 1]).toBe("idle");

    // Two prior autonomous turns remain counted; only the remaining four run.
    expect(assistantCount()).toBe(4);
    expect(getConversationState(conversationId)?.mode).toBe("idle");
  });

  it("round-trips saved autonomy and turn budget through a paused snapshot", async () => {
    const conversationId = nextConvId();
    setupFullRound(conversationId);
    persistRow(conversationId, {
      mode: "paused",
      currentExpertIndex: 1,
      totalAutonomousTurnsTaken: 2,
      wasInterrupted: false,
      pausedFromMode: "autonomous",
      isAutonomousEnabled: false,
      maxAutonomousTurns: 44,
    }, 12);

    expect(await restorePausedFromSnapshot(conversationId, broadcastFn)).toBe(true);
    const restored = getConversationState(conversationId)!;
    expect(restored.mode).toBe("paused");
    expect(restored.isAutonomousEnabled).toBe(false);
    // The paused snapshot records the effective configured cap and wins over
    // the conversation row's current default (which can differ after a save).
    expect(restored.maxAutonomousTurns).toBe(44);

    await waitFor(30);
    expect(persistedSnapshots().at(-1)).toMatchObject({
      mode: "paused",
      isAutonomousEnabled: false,
      maxAutonomousTurns: 44,
    });
  });

  it("restores legacy paused snapshots without G13 settings using safe defaults", async () => {
    const conversationId = nextConvId();
    setupFullRound(conversationId);
    persistRow(conversationId, {
      mode: "paused",
      currentExpertIndex: 0,
      totalAutonomousTurnsTaken: 1,
      wasInterrupted: false,
      pausedFromMode: "autonomous",
    });

    expect(await restorePausedFromSnapshot(conversationId, broadcastFn)).toBe(true);
    expect(getConversationState(conversationId)).toMatchObject({
      mode: "paused",
      isAutonomousEnabled: true,
      maxAutonomousTurns: 25,
    });
  });

  it("maps a paused processing_sequential phase to autonomous on restore", async () => {
    const conversationId = nextConvId();
    setupFullRound(conversationId);
    persistRow(conversationId, {
      mode: "paused",
      currentExpertIndex: 1,
      totalAutonomousTurnsTaken: 1,
      wasInterrupted: false,
      pausedFromMode: "processing_sequential",
    });

    await startSixTurnRun(conversationId, createMockMessage(8, "Continue the paused council"));
    await drainAutonomousRun(conversationId, 5);

    expect(persistedSnapshots()[1]).toMatchObject({
      mode: "paused",
      pausedFromMode: "autonomous",
    });
    expect(getConversationState(conversationId)?.mode).toBe("idle");
  });

  // ─────────────────────────────────────────────────────────────────
  // Storage failures never break the turn loop
  // ─────────────────────────────────────────────────────────────────

  it("keeps the round alive when every snapshot write fails", async () => {
    const conversationId = nextConvId();
    setupFullRound(conversationId);
    mockUpdateConversation.mockRejectedValue(new Error("storage down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await startSixTurnRun(conversationId, createMockMessage(7, "The round must survive"));
      await drainAutonomousRun(conversationId);
    } finally {
      errorSpy.mockRestore();
    }

    expect(getConversationState(conversationId)?.mode).toBe("idle");
    expect(assistantCount()).toBe(6); // full autonomous run still ran
    expect(persistedSnapshots().length).toBeGreaterThan(0); // writes were attempted
  });

  it("still reaches storage for every later write after an earlier write rejects", async () => {
    const conversationId = nextConvId();
    setupFullRound(conversationId);
    persistRow(conversationId, null);

    // Write #1 rejects; every later write succeeds. A poisoned chain would
    // short-circuit on the rejected predecessor and never call storage again.
    let writes = 0;
    mockUpdateConversation.mockImplementation(async (_id: number, _updates: any) => {
      writes++;
      if (writes === 1) throw new Error("storage down for write #1");
      return undefined;
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await startSixTurnRun(conversationId, createMockMessage(8, "The chain must not poison"));
      await drainAutonomousRun(conversationId);
    } finally {
      errorSpy.mockRestore();
    }

    // Every snapshot write of the autonomous run — including writes #2 and
    // #3 — reached storage: the exact turn-boundary sequence, unbroken.
    expect(mockUpdateConversation).toHaveBeenCalledTimes(FULL_ROUND_SNAPSHOT_MODES.length);
    expect(persistedSnapshots().map((s) => s.mode)).toEqual(FULL_ROUND_SNAPSHOT_MODES);

    // The round itself was unaffected by the failed write.
    expect(getConversationState(conversationId)?.mode).toBe("idle");
    expect(assistantCount()).toBe(6);
  });
});
