import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, chat, chatStream } = vi.hoisted(() => ({
  store: {
    getConversationMessages: vi.fn(), getConversationExperts: vi.fn(),
    listOpenQuestions: vi.fn(), getConversation: vi.fn(), getUser: vi.fn(),
    createMessage: vi.fn(), createInsight: vi.fn(),
  },
  chat: vi.fn(), chatStream: vi.fn(),
}));
vi.mock("../server/storage", () => ({ storage: store }));
vi.mock("../server/ai-providers", () => ({
  getProvider: () => ({ chat, chatStream }),
}));
import { generateClosingSynthesis, generateInsights, callPerplexityAPI } from "../server/ai";
import { hasFreeVerdictTable } from "../server/free-synthesis";

const ledger = { Soil: { stance: "conditional" as const, confidence: 4 as const, position: "Test first." } };
const validClosing = "## Verdict\nCheck the soil first.\n\n| Expert | Stance | Confidence | Position |\n| --- | --- | --- | --- |\n| Soil | conditional | 4 | Test first. |";
const response = (content: string) => ({ message: { role: "assistant", content } });
const moderator = { id: null, conversationId: 1, role: "Moderator", name: "Moderator", model: "xiaomi/mimo-v2.6-pro", systemPrompt: "" };

describe("Free structured output repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chat.mockReset(); chatStream.mockReset();
    store.getConversationMessages.mockResolvedValue([
      { role: "user", content: "Yellow corn?" },
      { role: "assistant", content: "Test nitrogen.", expertName: "Soil" },
      { role: "assistant", content: "Check drainage.", expertName: "Water" },
    ]);
    store.getConversationExperts.mockResolvedValue([{ role: "Soil", model: "anthropic/claude-haiku-5.5" }]);
    store.listOpenQuestions.mockResolvedValue([]);
    store.getConversation.mockResolvedValue({ id: 1, userId: 7, charter: null });
    store.getUser.mockResolvedValue({ id: 7, tier: "free" });
    store.createMessage.mockImplementation(async m => ({ id: 1, ...m }));
    store.createInsight.mockResolvedValue({ id: 1 });
  });
  it("denies an ownerless auxiliary Perplexity call before looking up a key", async () => {
    await expect(callPerplexityAPI("query")).rejects.toMatchObject({ denial: { code: "ai_user_required" } });
  });
  it("retries malformed closing structure once on Haiku, then emits only the validated synthesis", async () => {
    chatStream.mockResolvedValueOnce(response("Malformed response without a table."))
      .mockResolvedValueOnce(response(validClosing));
    const broadcast = vi.fn();
    await generateClosingSynthesis(1, moderator, broadcast, ledger);
    expect(chatStream).toHaveBeenCalledTimes(2);
    expect(chatStream.mock.calls[1][5]).toMatchObject({
      purpose: "auxiliary", freeModelOverride: "anthropic/claude-haiku-5.5",
    });
    expect(store.createMessage.mock.calls[0][0].content).toBe(validClosing);
    expect(broadcast.mock.calls.filter(c => c[1].type === "expert_stream_token").map(c => c[1].token)).toEqual([validClosing]);
  });
  it("does not retry an already valid closing", async () => {
    chatStream.mockResolvedValue(response(validClosing));
    await generateClosingSynthesis(1, moderator, vi.fn(), ledger);
    expect(chatStream).toHaveBeenCalledOnce();
  });
  it("rejects a bare table header or missing expert rows as malformed", () => {
    expect(hasFreeVerdictTable("## Verdict\n| Expert | Stance | Confidence | Position |", ledger)).toBe(false);
    expect(hasFreeVerdictTable(validClosing.replace("| Soil |", "| Other |"), ledger)).toBe(false);
  });
  it("repairs invalid insights on the explicit Haiku fallback and stores real results", async () => {
    chat.mockResolvedValueOnce(response("not json"))
      .mockResolvedValueOnce(response('{"title":"Field checks","points":["Test nitrogen.","Check drainage."]}'));
    await generateInsights(1);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1][4]).toMatchObject({
      purpose: "auxiliary", freeModelOverride: "anthropic/claude-haiku-5.5",
    });
    expect(store.createInsight).toHaveBeenCalledWith({
      conversationId: 1, title: "Field checks", points: ["Test nitrogen.", "Check drainage."],
    });
  });
  it("does not invent insights when both structured attempts are invalid", async () => {
    chat.mockResolvedValue(response('{"title":"Bad","points":[null]}'));
    await generateInsights(1);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(store.createInsight).not.toHaveBeenCalled();
  });
});
