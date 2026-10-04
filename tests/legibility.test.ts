/**
 * G9 — Legibility tests (next-speaker preview + carried-forward context)
 *
 * Covers:
 *  - Event ordering: each direct-autonomous turn broadcasts
 *    {type:"next_speaker"} with the upcoming expert's identity IMMEDIATELY
 *    BEFORE its expert_stream_start.
 *  - buildPriorDecisionsBlock (pure): null when nothing usable, latest
 *    insight wins (id, then createdAt), points joined as bullets under the
 *    PRIOR DECISIONS header, oversized blocks truncated.
 *  - Injection: the real getExpertResponseStream / getExpertResponse place a
 *    PRIOR DECISIONS system message (latest insight's points) between the
 *    history and the final user message — and omit it entirely when the
 *    conversation has no insights.
 *
 * Mock seams (mirroring tests/orchestrator.test.ts idioms):
 *  - ../server/ai is mocked at the module boundary for the orchestrator
 *    behavior test;
 *  - the REAL ai module is loaded via vi.importActual for the helper and
 *    injection tests, with ../server/ai-providers mocked so the captured
 *    messages array is the seam (no HTTP, no keys).
 * Each test uses a unique conversationId to avoid module-level state pollution.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// ── Mock storage, AI, and provider modules BEFORE importing orchestrator ──
const mockGetConversation = vi.hoisted(() => vi.fn());
const mockUpdateConversation = vi.hoisted(() => vi.fn());
const mockGetConversationMessages = vi.hoisted(() => vi.fn());
const mockGetConversationExperts = vi.hoisted(() => vi.fn());
const mockGetConversationFiles = vi.hoisted(() => vi.fn());
const mockCreateMessage = vi.hoisted(() => vi.fn());
const mockGetConversationInsights = vi.hoisted(() => vi.fn());

const mockGetExpertResponseStream = vi.hoisted(() => vi.fn());
const mockGenerateInsights = vi.hoisted(() => vi.fn());
const mockGetModeratorNextSpeakerSuggestion = vi.hoisted(() => vi.fn());
const mockGenerateClosingSynthesis = vi.hoisted(() => vi.fn());

// Provider-level seam for the REAL ai module (via vi.importActual): ai.ts
// calls getProvider(model).chat/.chatStream(messages, model, ...).
const mockProviderChat = vi.hoisted(() => vi.fn());
const mockProviderChatStream = vi.hoisted(() => vi.fn());

vi.mock("../server/storage", () => ({
  storage: {
    getConversation: mockGetConversation,
    updateConversation: mockUpdateConversation,
    getConversationMessages: mockGetConversationMessages,
    getConversationExperts: mockGetConversationExperts,
    getConversationFiles: mockGetConversationFiles,
    getConversationInsights: mockGetConversationInsights,
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

vi.mock("../server/ai-providers", () => ({
  getProvider: () => ({ chat: mockProviderChat, chatStream: mockProviderChatStream }),
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

// The real ai module (bypasses the ai mock; its provider calls hit the
// ai-providers mock above).
const realAi = await vi.importActual<typeof import("../server/ai")>("../server/ai");

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
let convIdCounter = 1600;
function nextConvId(): number {
  return convIdCounter++;
}

// ─────────────────────────────────────────────────────────────────
// G9 — next_speaker preview event ordering (orchestrator behavior)
// ─────────────────────────────────────────────────────────────────

describe("G9 next_speaker preview", () => {
  const userId = 1;
  const broadcastFn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetModeratorNextSpeakerSuggestion.mockResolvedValue(null);
    mockGenerateInsights.mockResolvedValue(undefined);
    mockGenerateClosingSynthesis.mockResolvedValue(undefined);
  });

  // Drain pending setImmediate chains so the worker doesn't tear down
  // mid-log (same rationale as tests/orchestrator.test.ts).
  afterAll(async () => {
    await waitFor(500);
  });

  it("previews the routed first responder immediately before streaming when autonomy is disabled", async () => {
    const conversationId = nextConvId();
    const roster = [
      createMockExpert(1, "Alice", "Agronomist", conversationId),
      createMockExpert(2, "Bob", "Soil Scientist", conversationId),
      createMockExpert(3, "Carol", "Weather Expert", conversationId),
    ];
    mockGetConversationExperts.mockResolvedValue(roster);
    mockGetConversationFiles.mockResolvedValue([]);
    mockGetConversationInsights.mockResolvedValue([]);

    const messages: Message[] = [];
    let messageId = 160_000 + conversationId * 100;
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

    const userMessage = createMockMessage(1, "Plan my week");
    await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);
    // A fresh idle message starts directly in autonomous mode. Disabling
    // autonomy still permits its first routed responder, then returns idle.
    new InteractionOrchestrator(conversationId).disableAutonomous();

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const s = getConversationState(conversationId);
      if (s && s.mode === "idle") break;
      await waitFor(10);
    }
    await waitFor(150);

    const events = broadcastFn.mock.calls
      .filter((c) => c[0] === conversationId)
      .map((c) => c[1]);
    const previews = events.filter((e) => e.type === "next_speaker");
    const starts = events.filter((e) => e.type === "expert_stream_start");

    // The first routed responder is previewed once; there is no sequential
    // roll-call and disabled autonomy stops after that response.
    expect(previews).toHaveLength(1);
    expect(starts).toHaveLength(1);

    // Acceptance: each next_speaker is IMMEDIATELY followed by the matching
    // expert_stream_start (same expertId).
    events.forEach((event, i) => {
      if (event.type === "next_speaker") {
        expect(event.conversationId).toBe(conversationId);
        expect(events[i + 1]?.type).toBe("expert_stream_start");
        expect(events[i + 1]?.expertId).toBe(event.expertId);
      }
    });

    expect(previews.map((e) => e.expertRole)).toEqual(["Agronomist"]);
    const modes = events.filter((event) => event.type === "state_update").map((event) => event.mode);
    expect(modes).not.toContain("processing_sequential");
    expect(modes).toContain("autonomous");
    expect(modes[modes.length - 1]).toBe("idle");
    expect(getConversationState(conversationId)!.mode).toBe("idle");
  });

  it("previews every direct autonomous speaker immediately before streaming for four turns", async () => {
    const conversationId = nextConvId();
    const roster = [
      createMockExpert(1, "Alice", "Agronomist", conversationId),
      createMockExpert(2, "Bob", "Soil Scientist", conversationId),
      createMockExpert(3, "Carol", "Weather Expert", conversationId),
    ];
    mockGetConversationExperts.mockResolvedValue(roster);
    mockGetConversationFiles.mockResolvedValue([]);
    mockGetConversationInsights.mockResolvedValue([]);
    mockGetModeratorNextSpeakerSuggestion.mockResolvedValue("RoundRobin");

    const messages: Message[] = [];
    let messageId = 160_000 + conversationId * 100;
    mockGetConversationMessages.mockImplementation((cid: number) =>
      Promise.resolve(messages.filter((message) => message.conversationId === cid)),
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

    const userMessage = createMockMessage(1, "Plan my week");
    messages.push({ ...userMessage, conversationId });
    await processMessageTurnBased(userId, conversationId, userMessage, broadcastFn);
    new InteractionOrchestrator(conversationId).enableAutonomous(4);

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const state = getConversationState(conversationId);
      if (state && state.mode === "idle") break;
      await waitFor(10);
    }
    await waitFor(150);

    const events = broadcastFn.mock.calls
      .filter((call) => call[0] === conversationId)
      .map((call) => call[1]);
    const previews = events.filter((event) => event.type === "next_speaker");
    const starts = events.filter((event) => event.type === "expert_stream_start");
    const expectedRoles = ["Agronomist", "Soil Scientist", "Weather Expert", "Agronomist"];

    expect(previews).toHaveLength(4);
    expect(starts).toHaveLength(4);
    expect(previews.map((event) => event.expertRole)).toEqual(expectedRoles);
    expect(starts.map((event) => event.expertRole)).toEqual(expectedRoles);

    // Each preview is the immediately preceding event for its matching start.
    const previewEvents = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === "next_speaker");
    expect(previewEvents).toHaveLength(starts.length);
    for (const { event, index } of previewEvents) {
      expect(event.conversationId).toBe(conversationId);
      expect(events[index + 1]?.type).toBe("expert_stream_start");
      expect(events[index + 1]?.expertId).toBe(event.expertId);
      expect(events[index + 1]?.expertRole).toBe(event.expertRole);
    }
    expect(getConversationState(conversationId)!.mode).toBe("idle");
  });
});

// ─────────────────────────────────────────────────────────────────
// G9 — buildPriorDecisionsBlock (pure helper, real ai module)
// ─────────────────────────────────────────────────────────────────

describe("G9 buildPriorDecisionsBlock", () => {
  const HEADER =
    "PRIOR DECISIONS (settled in an earlier round — do not re-litigate; build on these):";

  it("returns null when there are no usable insights", () => {
    expect(realAi.buildPriorDecisionsBlock([])).toBeNull();
    expect(realAi.buildPriorDecisionsBlock([{ title: "Empty", points: [] }])).toBeNull();
    expect(
      realAi.buildPriorDecisionsBlock([{ title: "Blank", points: ["", "   "] }]),
    ).toBeNull();
  });

  it("uses the LATEST insight when several exist (id, then createdAt fallback)", () => {
    const byId = realAi.buildPriorDecisionsBlock([
      { title: "Old", points: ["old settled decision"], id: 1 },
      { title: "New", points: ["new settled decision"], id: 2 },
    ]);
    expect(byId).toContain("new settled decision");
    expect(byId).not.toContain("old settled decision");

    const byCreatedAt = realAi.buildPriorDecisionsBlock([
      { title: "Older", points: ["stale point"], createdAt: new Date("2026-01-01") },
      { title: "Newer", points: ["fresh point"], createdAt: new Date("2026-06-01") },
    ]);
    expect(byCreatedAt).toContain("fresh point");
    expect(byCreatedAt).not.toContain("stale point");
  });

  it("joins the points as bullets under the PRIOR DECISIONS header", () => {
    const block = realAi.buildPriorDecisionsBlock([
      { title: "Round 1", points: ["point one", "point two"], id: 3 },
    ]);
    expect(block).toBe(`${HEADER}\n- point one\n- point two`);
  });

  it("truncates oversized blocks", () => {
    const huge = " irrigation".repeat(400); // ~4400 chars, one bullet
    const block = realAi.buildPriorDecisionsBlock([
      { title: "Big", points: [huge], id: 9 },
    ])!;
    expect(block).toContain("PRIOR DECISIONS");
    expect(block).toContain("[Content Truncated]");
    // 1200 truncated chars + the truncation marker.
    expect(block.length).toBeLessThanOrEqual(1200 + 30);
  });
});

// ─────────────────────────────────────────────────────────────────
// G9 — PRIOR DECISIONS injection into expert turns (real ai module,
// provider-level seam)
// ─────────────────────────────────────────────────────────────────

describe("G9 prior-decisions injection", () => {
  const INSIGHT = {
    id: 7,
    conversationId: 1,
    title: "Round 1 takeaways",
    points: ["Lime the north field in spring", "Retest soil after harvest"],
    createdAt: new Date("2026-06-01"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConversationFiles.mockResolvedValue([]);
    mockGetConversationMessages.mockResolvedValue([]);
    mockProviderChat.mockResolvedValue({ message: { role: "assistant", content: "ok" } });
    mockProviderChatStream.mockResolvedValue({
      message: { role: "assistant", content: "ok" },
    });
  });

  it("injects the PRIOR DECISIONS system message before the final user message (streaming path)", async () => {
    const conversationId = nextConvId();
    const expert = createMockExpert(1, "Alice", "Agronomist", conversationId);
    mockGetConversationInsights.mockResolvedValue([{ ...INSIGHT, conversationId }]);

    await realAi.getExpertResponseStream(expert, [], "What about the north field?", [], [
      "Agronomist",
    ], () => {});

    expect(mockProviderChatStream).toHaveBeenCalledTimes(1);
    const messages = mockProviderChatStream.mock.calls[0][0] as import("../server/ai").AIMessage[];
    const priorIdx = messages.findIndex(
      (m) => m.role === "system" && String(m.content).includes("PRIOR DECISIONS"),
    );
    expect(priorIdx).toBeGreaterThan(-1);
    expect(String(messages[priorIdx].content)).toContain("Lime the north field in spring");
    expect(String(messages[priorIdx].content)).toContain("Retest soil after harvest");
    // Positioned after the history slice and immediately before the final
    // user message.
    expect(priorIdx).toBe(messages.length - 2);
    expect(messages[messages.length - 1].role).toBe("user");
  });

  it("injects nothing when the conversation has no insights (streaming path)", async () => {
    const conversationId = nextConvId();
    const expert = createMockExpert(1, "Alice", "Agronomist", conversationId);
    mockGetConversationInsights.mockResolvedValue([]);

    await realAi.getExpertResponseStream(expert, [], "Question", [], ["Agronomist"], () => {});

    const messages = mockProviderChatStream.mock.calls[0][0] as import("../server/ai").AIMessage[];
    expect(
      messages.some(
        (m) => m.role === "system" && String(m.content).includes("PRIOR DECISIONS"),
      ),
    ).toBe(false);
    expect(messages[messages.length - 1].role).toBe("user");
  });

  it("injects the block in the legacy non-streaming path too", async () => {
    const conversationId = nextConvId();
    const expert = createMockExpert(1, "Alice", "Agronomist", conversationId);
    mockGetConversationInsights.mockResolvedValue([{ ...INSIGHT, conversationId }]);

    await realAi.getExpertResponse(expert, [], "Question", [], ["Agronomist"]);

    expect(mockProviderChat).toHaveBeenCalledTimes(1);
    const messages = mockProviderChat.mock.calls[0][0] as import("../server/ai").AIMessage[];
    const priorIdx = messages.findIndex(
      (m) => m.role === "system" && String(m.content).includes("PRIOR DECISIONS"),
    );
    expect(priorIdx).toBeGreaterThan(-1);
    expect(String(messages[priorIdx].content)).toContain("Lime the north field in spring");
    expect(priorIdx).toBe(messages.length - 2);
    expect(messages[messages.length - 1].role).toBe("user");
  });
});
