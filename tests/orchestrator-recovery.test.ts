/**
 * Orchestrator Recovery Tests (G7 — Survivable orchestrator state)
 *
 * Covers:
 *  - Snapshot persistence at TURN BOUNDARIES ONLY: a full mocked round writes
 *    exactly the semantic transitions idle → processing_sequential (start)
 *    → per-turn boundaries → autonomous → idle (natural end), and internal
 *    flips (turnInFlight, turnChainScheduled, streak/history mutations) never
 *    write. Writes are serialized per conversation in enqueue order.
 *  - Cold-start reconstruction: a persisted autonomous snapshot (a dead loop
 *    from before a restart) recovers to idle with a warning and starts a
 *    normal fresh round — no steering, correct event order.
 *  - Cold-start paused restore: a persisted paused snapshot restores the
 *    paused badge (state_update), then the message takes the implicit
 *    resume-and-restart path and the round starts on it.
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
}));

import {
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
  // complete round is 3 sequential turns + 6 autonomous turns (experts * 2)
  // with no redundancy early-stop and no mention routing.
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
  function persistRow(conversationId: number, orchestratorState: unknown) {
    mockGetConversation.mockResolvedValue({
      id: conversationId,
      userId,
      title: "Recovered conversation",
      charter: null,
      orchestratorState,
      createdAt: new Date(),
    });
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

  // Wait until the full 9-turn round settled back to idle, then let trailing
  // snapshot writes (microtask-chained) land.
  async function drainFullRound(conversationId: number) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const s = getConversationState(conversationId);
      if (s && s.mode === "idle" && assistantCount() >= 9) break;
      await waitFor(10);
    }
    await waitFor(200);
  }

  // The exact turn-boundary write sequence of one full round:
  // init (idle) → sequence start (ps) → 3 per-turn boundaries (ps) →
  // sequential→autonomous transition → 6 autonomous turn boundaries →
  // natural end (idle). Nothing else writes.
  const FULL_ROUND_SNAPSHOT_MODES = [
    "idle",
    "processing_sequential",
    "processing_sequential",
    "processing_sequential",
    "processing_sequential",
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

    await processMessageTurnBased(
      userId,
      conversationId,
      createMockMessage(3, "Roundtable, go"),
      broadcastFn,
    );
    await drainFullRound(conversationId);

    const modes = persistedSnapshots().map((s) => s.mode);
    expect(modes).toEqual(FULL_ROUND_SNAPSHOT_MODES);

    // Strict start/end alternation == write N+1 never started before write N
    // resolved, i.e. the per-conversation promise chain serialized them.
    const expectedEvents = modes.flatMap((m) => [`start:${m}`, `end:${m}`]);
    expect(events).toEqual(expectedEvents);
  });

  it("cold-starts normally when no snapshot row exists", async () => {
    const conversationId = nextConvId();
    setupFullRound(conversationId);
    // beforeEach default: getConversation → undefined (no row at all)

    await processMessageTurnBased(
      userId,
      conversationId,
      createMockMessage(4, "Fresh start"),
      broadcastFn,
    );
    await drainFullRound(conversationId);

    expect(mockGetConversation).toHaveBeenCalledWith(conversationId);
    expect(persistedSnapshots().map((s) => s.mode)).toEqual(FULL_ROUND_SNAPSHOT_MODES);
    expect(getConversationState(conversationId)?.mode).toBe("idle");
  });

  // ─────────────────────────────────────────────────────────────────
  // (a) Kill-mid-round: persisted autonomous snapshot (dead loop)
  // ─────────────────────────────────────────────────────────────────

  it("recovers a persisted autonomous snapshot to idle and starts a normal fresh round", async () => {
    const conversationId = nextConvId();
    setupFullRound(conversationId);
    persistRow(conversationId, {
      mode: "autonomous",
      currentExpertIndex: 2,
      totalAutonomousTurnsTaken: 3,
      wasInterrupted: false,
      pausedFromMode: null,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let warnedAboutDeadLoop = false;
    try {
      await processMessageTurnBased(
        userId,
        conversationId,
        createMockMessage(5, "Hello after the crash"),
        broadcastFn,
      );
      warnedAboutDeadLoop = warnSpy.mock.calls.some((args) =>
        args.join(" ").includes("Recovering to idle"),
      );
      await drainFullRound(conversationId);
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

    // No steering event: the message started a fresh round, it did not
    // interrupt a live sequence.
    expect(
      broadcastFn.mock.calls.some(
        (c) => c[0] === conversationId && (c[1] as any)?.type === "steering",
      ),
    ).toBe(false);

    // Normal fresh round ran to completion: sequential → autonomous → idle.
    const modes = updates.map((u) => u.mode);
    expect(modes).toContain("processing_sequential");
    expect(modes).toContain("autonomous");
    expect(modes[modes.length - 1]).toBe("idle");
    expect(getConversationState(conversationId)?.mode).toBe("idle");
    expect(assistantCount()).toBe(9);
  });

  // ─────────────────────────────────────────────────────────────────
  // (b) Paused restore + implicit resume-and-restart
  // ─────────────────────────────────────────────────────────────────

  it("restores a persisted paused snapshot, then implicitly resumes and restarts on the message", async () => {
    const conversationId = nextConvId();
    setupFullRound(conversationId);
    persistRow(conversationId, {
      mode: "paused",
      currentExpertIndex: 1,
      totalAutonomousTurnsTaken: 2,
      wasInterrupted: false,
      pausedFromMode: "autonomous",
    });

    await processMessageTurnBased(
      userId,
      conversationId,
      createMockMessage(6, "Waking the council"),
      broadcastFn,
    );
    await drainFullRound(conversationId);

    const updates = stateUpdates(conversationId);

    // 1. idle   — initializeConversationState broadcast
    // 2. paused — restored via updateConversationState (client badge shows
    //             Paused after the restart, with pausedFromMode "autonomous")
    // 3. idle   — the implicit resume-and-restart reset
    // 4. processing_sequential — the round started on the message
    expect(updates[0]).toMatchObject({ mode: "idle" });
    expect(updates[1]).toMatchObject({ mode: "paused" });
    expect(updates[2]).toMatchObject({ mode: "idle" });
    expect(updates[3]).toMatchObject({ mode: "processing_sequential" });
    expect(updates[updates.length - 1]).toMatchObject({ mode: "idle" });

    // The restored paused state was itself persisted (and the round then
    // wrote fresh snapshots through the existing paths).
    const modes = persistedSnapshots().map((s) => s.mode);
    expect(modes[0]).toBe("idle");
    expect(modes[1]).toBe("paused");
    expect(modes[modes.length - 1]).toBe("idle");

    // The restart ran a full fresh round on the message.
    expect(assistantCount()).toBe(9);
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
      await processMessageTurnBased(
        userId,
        conversationId,
        createMockMessage(7, "The round must survive"),
        broadcastFn,
      );
      await drainFullRound(conversationId);
    } finally {
      errorSpy.mockRestore();
    }

    expect(getConversationState(conversationId)?.mode).toBe("idle");
    expect(assistantCount()).toBe(9); // full round still ran
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
      await processMessageTurnBased(
        userId,
        conversationId,
        createMockMessage(8, "The chain must not poison"),
        broadcastFn,
      );
      await drainFullRound(conversationId);
    } finally {
      errorSpy.mockRestore();
    }

    // Every snapshot write of the full round — including writes #2 and #3 —
    // reached storage: the exact 13-write turn-boundary sequence, unbroken.
    expect(mockUpdateConversation).toHaveBeenCalledTimes(FULL_ROUND_SNAPSHOT_MODES.length);
    expect(persistedSnapshots().map((s) => s.mode)).toEqual(FULL_ROUND_SNAPSHOT_MODES);

    // The round itself was unaffected by the failed write.
    expect(getConversationState(conversationId)?.mode).toBe("idle");
    expect(assistantCount()).toBe(9);
  });
});
