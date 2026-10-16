import { describe, it, expect, vi } from "vitest";

process.env.DATABASE_URL = "";
process.env.SESSION_SECRET = "vitest-deliverable-secret";
process.env.NODE_ENV = "test";

const { mockProviderChat, mockProviderChatStream } = vi.hoisted(() => ({
  mockProviderChat: vi.fn(),
  mockProviderChatStream: vi.fn(),
}));
vi.mock("../server/ai-providers", () => ({
  getProvider: vi.fn(() => ({ chat: mockProviderChat, chatStream: mockProviderChatStream })),
}));

import { storage } from "../server/storage";
import { getExpertResponseStream, commitPendingDeliverable, discardPendingDeliverable } from "../server/ai";

const doc = "Here is the plan.\n```deliverable\ntitle: Drying Plan\n---\n## Steps\n1. Dry to 15% before binning.\n```\nSTANCE: agree | 4 | Dry first";

async function turn(convId: number, role: string) {
  const expert: any = { id: 1, conversationId: convId, name: role, role, model: "x/y:free", systemPrompt: "", avatarUrl: null };
  const response = { message: { role: "assistant", content: doc } };
  mockProviderChatStream.mockResolvedValue(response);
  return getExpertResponseStream(expert, [], "plan?", [], [role], () => {});
}

describe("deliverables are saved only for accepted turns", () => {
  it("discarded turn leaves no file; committed turn saves v1 and fills the line", async () => {
    const convo = await storage.createConversation({ userId: 1, title: "docs" });
    const dropped = await turn(convo.id, "Crop Specialist");
    discardPendingDeliverable(dropped);
    expect(await storage.getConversationFiles(convo.id)).toHaveLength(0);

    const kept = await turn(convo.id, "Farm Finance Advisor");
    expect(kept.content).toContain("{{deliverable}}");
    await commitPendingDeliverable(kept);
    expect(kept.content).toContain("Created deliverable **Drying Plan** (v1)");
    expect(kept.content).not.toMatch(/STANCE|\{\{deliverable\}\}/);
    const files = await storage.getConversationFiles(convo.id);
    expect(files).toHaveLength(1);

    const revised = await turn(convo.id, "Farm Finance Advisor");
    await commitPendingDeliverable(revised);
    expect(revised.content).toContain("Updated deliverable **Drying Plan** (v2)");
  });
});
