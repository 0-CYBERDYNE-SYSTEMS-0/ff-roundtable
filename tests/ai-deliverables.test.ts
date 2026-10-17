import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  mockProviderChat,
  mockProviderChatStream,
  mockSaveDeliverableVersion,
  mockGetCurrentDeliverableFile,
  mockGetConversation,
  mockGetConversationInsights,
} = vi.hoisted(() => ({
  mockProviderChat: vi.fn(),
  mockProviderChatStream: vi.fn(),
  mockSaveDeliverableVersion: vi.fn(),
  mockGetCurrentDeliverableFile: vi.fn(),
  mockGetConversation: vi.fn(),
  mockGetConversationInsights: vi.fn(),
}));

vi.mock("../server/ai-providers", () => ({
  getProvider: vi.fn(() => ({ chat: mockProviderChat, chatStream: mockProviderChatStream })),
}));

vi.mock("../server/storage", () => ({
  storage: {
    getConversation: mockGetConversation,
    getConversationInsights: mockGetConversationInsights,
    saveDeliverableVersion: mockSaveDeliverableVersion,
    getCurrentDeliverableFile: mockGetCurrentDeliverableFile,
  },
}));

import { getExpertResponse, getExpertResponseStream, isRetryableExpertProviderFailure } from "../server/ai";
import type { DeliverableGenerationRequest } from "../server/ai";
import type { Expert, File } from "@shared/schema";

let tempRoot: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

function makeExpert(role = "File Creator"): Expert {
  return {
    id: 14,
    conversationId: 8,
    name: "File Creator",
    role,
    model: "test/file-creator",
    systemPrompt: "Create the requested file.",
    customInstructions: null,
    avatarUrl: null,
  };
}

function makeRequest(overrides: Partial<DeliverableGenerationRequest> = {}): DeliverableGenerationRequest {
  return {
    deliverableId: "deliverable-sop-1",
    generationRequestId: "generation-1",
    mode: "create",
    constraints: {},
    ...overrides,
  };
}

function modelResponse(data: unknown) {
  return { message: { role: "assistant", content: JSON.stringify(data) } };
}

function storedVersion(file: Record<string, unknown>, version: number | null = 1): File & {
  version: number | null;
  supersededAt: Date | null;
} {
  return {
    ...file,
    id: 91,
    uploadedAt: new Date("2026-10-11T12:00:00Z"),
    version,
    supersededAt: null,
  } as File & {
    version: number | null;
    supersededAt: Date | null;
  };
}

const validMarkdown = [
  "# Nitrogen SOP",
  "",
  "## Scope",
  "For the north field.",
  "",
  "## Tasks",
  "- 2027-04-05 Collect a soil sample.",
  "- 2027-04-12 Review the result.",
].join("\n");

describe("AI deliverable generation", () => {
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "farmfriend-ai-deliverables-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempRoot);
    mockProviderChat.mockReset();
    mockProviderChatStream.mockReset();
    mockGetConversation.mockReset().mockResolvedValue(null);
    mockGetConversationInsights.mockReset().mockResolvedValue([]);
    mockGetCurrentDeliverableFile.mockReset();
    mockSaveDeliverableVersion.mockReset().mockImplementation(async (file) => ({
      file: storedVersion(file),
      created: true,
    }));
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("validates and persists Markdown once, then emits only the canonical authorized link", async () => {
    const request = makeRequest({
      constraints: {
        format: "markdown",
        maxCharacters: [...validMarkdown].length,
        requiredSections: ["Scope", "Tasks"],
        taskCount: 2,
      },
    });
    mockProviderChat.mockResolvedValue(modelResponse({
      filename: "north-field.md",
      filetype: "text/markdown",
      content: validMarkdown,
      deliverableId: "model-must-not-control-this",
      fileUrl: "https://example.invalid/fake-download",
    }));
    const emitted: string[] = [];

    const result = await getExpertResponseStream(
      makeExpert(), [], "Create the SOP", [], ["File Creator"], (token) => emitted.push(token), request,
    );

    expect(mockSaveDeliverableVersion).toHaveBeenCalledOnce();
    const [savedFile, savedRequest] = mockSaveDeliverableVersion.mock.calls[0];
    expect(savedRequest).toEqual(request);
    expect(savedFile.filename).toBe("north-field.md");
    expect(savedFile.fileType).toBe("text/markdown");
    expect(savedFile.fileUrl).toMatch(/^\/uploads\/[a-f0-9]+-north-field\.md$/);
    expect(fs.readFileSync(path.join(tempRoot, savedFile.fileUrl.slice(1)), "utf8")).toBe(validMarkdown);
    expect(mockProviderChat.mock.calls[0][0][0].content).toContain("exactly 2 top-level list entries");
    expect(result.content).toBe("Created file: north-field.md (version 1)\nDownload: /api/protected/conversations/8/files/91/download");
    expect(emitted).toEqual([result.content]);
    expect(emitted.join("")).not.toContain("model-must-not-control-this");
    expect(emitted.join("")).not.toContain("example.invalid");
  });

  it("counts Unicode code points rather than UTF-16 code units", async () => {
    const content = "a🙂b";
    const request = makeRequest({ constraints: { format: "text", maxCharacters: 3 } });
    mockProviderChat.mockResolvedValue(modelResponse({ filename: "notes.txt", filetype: "text/plain", content }));

    const result = await getExpertResponse(makeExpert(), [], "Create notes", [], ["File Creator"], request);

    expect(mockSaveDeliverableVersion).toHaveBeenCalledOnce();
    expect(result.content).toContain("Created file: notes.txt");
  });

  it("rejects an oversized draft without saving or streaming the raw JSON", async () => {
    const request = makeRequest({ constraints: { format: "markdown", maxCharacters: 4 } });
    const raw = { filename: "too-long.md", filetype: "text/markdown", content: "12345" };
    mockProviderChat.mockResolvedValue(modelResponse(raw));
    const emitted: string[] = [];

    const result = await getExpertResponseStream(
      makeExpert(), [], "Create a short file", [], ["File Creator"], (token) => emitted.push(token), request,
    );

    expect(mockSaveDeliverableVersion).not.toHaveBeenCalled();
    expect(emitted.join("")).not.toContain(JSON.stringify(raw));
    expect(result.content).toContain("limit is 4");
    expect(fs.existsSync(path.join(tempRoot, "uploads"))).toBe(false);
  });

  it.each(["streaming", "non-streaming"] as const)("keeps incomplete File Creator responses on the retry message (%s)", async (pathType) => {
    mockProviderChat.mockResolvedValue({ message: { role: "assistant", content: "" } });

    const result = pathType === "streaming"
      ? await getExpertResponseStream(
        makeExpert(), [], "Create the SOP", [], ["File Creator"], () => undefined, makeRequest(),
      )
      : await getExpertResponse(makeExpert(), [], "Create the SOP", [], ["File Creator"], makeRequest());

    expect(result.content).toMatch(/^⚠️ No complete response was received\./);
    expect(result.content).toContain("Try a shorter request or split it into smaller requests");
    expect(mockSaveDeliverableVersion).not.toHaveBeenCalled();
  });

  it.each(["streaming", "non-streaming"] as const)("redacts provider errors on the retry message (%s)", async (pathType) => {
    mockProviderChat.mockRejectedValue(new Error("private provider payload"));
    mockProviderChatStream.mockRejectedValue(new Error("private provider payload"));

    const result = pathType === "streaming"
      ? await getExpertResponseStream(
        makeExpert(), [], "Create the SOP", [], ["File Creator"], () => undefined, makeRequest(),
      )
      : await getExpertResponse(makeExpert(), [], "Create the SOP", [], ["File Creator"], makeRequest());

    expect(result.content).toMatch(/^⚠️ No complete response was received\./);
    expect(result.content).not.toContain("private provider payload");
    expect(isRetryableExpertProviderFailure(result)).toBe(true);
  });

  it.each([
    ["rate limit", Object.assign(new Error("Too Many Requests"), { status: 429 })],
    ["timeout", Object.assign(new Error("request timed out"), { name: "APIConnectionTimeoutError" })],
  ])("does not mark %s provider failures retryable", async (_label, providerError) => {
    mockProviderChat.mockRejectedValue(providerError);
    mockProviderChatStream.mockRejectedValue(providerError);

    const result = await getExpertResponseStream(
      makeExpert(), [], "Create the SOP", [], ["File Creator"], () => undefined, makeRequest(),
    );

    expect(result.content).toMatch(/^⚠️ No complete response was received\./);
    expect(isRetryableExpertProviderFailure(result)).toBe(false);
  });

  it("rejects a filename or MIME type that does not match the requested format", async () => {
    const request = makeRequest({ constraints: { format: "markdown" } });
    mockProviderChat.mockResolvedValue(modelResponse({ filename: "notes.txt", filetype: "text/plain", content: "Body" }));

    const result = await getExpertResponse(makeExpert(), [], "Create Markdown", [], ["File Creator"], request);

    expect(mockSaveDeliverableVersion).not.toHaveBeenCalled();
    expect(result.content).toContain("do not match the requested markdown format");
    expect(fs.existsSync(path.join(tempRoot, "uploads"))).toBe(false);
  });

  it("rejects missing required sections and an incorrect task count", async () => {
    const sectionRequest = makeRequest({
      constraints: { format: "markdown", requiredSections: ["Costs"] },
    });
    mockProviderChat.mockResolvedValue(modelResponse({
      filename: "north-field.md",
      filetype: "text/markdown",
      content: validMarkdown,
    }));

    const missingSection = await getExpertResponse(makeExpert(), [], "Create the SOP", [], ["File Creator"], sectionRequest);
    expect(missingSection.content).toContain("missing the required “Costs” section");
    expect(mockSaveDeliverableVersion).not.toHaveBeenCalled();

    const taskRequest = makeRequest({ constraints: { format: "markdown", taskCount: 3 } });
    const wrongTaskCount = await getExpertResponse(makeExpert(), [], "Create three tasks", [], ["File Creator"], taskRequest);
    expect(wrongTaskCount.content).toContain("has 2 task entries; 3 are required");
    expect(mockSaveDeliverableVersion).not.toHaveBeenCalled();
  });

  it("requires every requested dated task to contain a valid ISO date", async () => {
    const request = makeRequest({
      constraints: { format: "markdown", taskCount: 2, requiredSections: ["Tasks"], datedTasks: true },
    });
    mockProviderChat.mockResolvedValue(modelResponse({
      filename: "nitrogen-sop.md",
      filetype: "text/markdown",
      content: "## Tasks\n- 2027-02-29 Sample the field.\n- Review the result.",
    }));

    const result = await getExpertResponse(makeExpert(), [], "Create an SOP with two dated tasks", [], ["File Creator"], request);

    expect(result.content).toContain("Every task must include a valid ISO date");
    expect(mockSaveDeliverableVersion).not.toHaveBeenCalled();
  });

  it("does not call the model for a stale revision target", async () => {
    const request = makeRequest({ mode: "revise", expectedCurrentFileId: 92 });
    mockGetCurrentDeliverableFile.mockResolvedValue(storedVersion({
      conversationId: 8,
      filename: "north-field.md",
      fileUrl: "/uploads/old.md",
      fileType: "text/markdown",
      uploadedBy: "Expert: File Creator",
    }));

    const result = await getExpertResponse(makeExpert(), [], "Revise the SOP", [], ["File Creator"], request);

    expect(mockGetCurrentDeliverableFile).toHaveBeenCalledWith(8, request.deliverableId);
    expect(mockProviderChat).not.toHaveBeenCalled();
    expect(mockSaveDeliverableVersion).not.toHaveBeenCalled();
    expect(result.content).toContain("changed before this revision began");
  });

  it("saves an intentional revision against the checked current file", async () => {
    const request = makeRequest({ mode: "revise", expectedCurrentFileId: 91, constraints: { format: "markdown" } });
    mockGetCurrentDeliverableFile.mockResolvedValue(storedVersion({
      conversationId: 8,
      filename: "north-field.md",
      fileUrl: "/uploads/current.md",
      fileType: "text/markdown",
      uploadedBy: "Expert: File Creator",
    }));
    mockProviderChat.mockResolvedValue(modelResponse({
      filename: "north-field.md",
      filetype: "text/markdown",
      content: validMarkdown,
    }));
    mockSaveDeliverableVersion.mockImplementationOnce(async (file) => ({
      file: { ...storedVersion(file, 2), id: 92 },
      created: true,
    }));

    const result = await getExpertResponse(makeExpert(), [], "Revise the SOP", [], ["File Creator"], request);

    expect(mockSaveDeliverableVersion.mock.calls[0][1]).toEqual(request);
    expect(result.content).toContain("Revised file: north-field.md (version 2)");
    expect(result.content).toContain("/api/protected/conversations/8/files/92/download");
  });

  it("cleans up the retry artifact when storage returns an existing version", async () => {
    const request = makeRequest({ constraints: { format: "markdown" } });
    mockProviderChat.mockResolvedValue(modelResponse({
      filename: "north-field.md",
      filetype: "text/markdown",
      content: validMarkdown,
    }));
    mockSaveDeliverableVersion.mockImplementationOnce(async (file) => ({
      file: storedVersion({ ...file, fileUrl: "/uploads/already-saved.md" }, null),
      created: false,
    }));

    const result = await getExpertResponse(makeExpert(), [], "Retry the SOP", [], ["File Creator"], request);

    const [submittedFile] = mockSaveDeliverableVersion.mock.calls[0];
    expect(fs.existsSync(path.join(tempRoot, submittedFile.fileUrl.slice(1)))).toBe(false);
    expect(result.content).toContain("version 1");
    expect(result.content).toContain("/api/protected/conversations/8/files/91/download");
  });

  it("removes the new disk artifact when version persistence fails", async () => {
    const request = makeRequest({ constraints: { format: "markdown" } });
    mockProviderChat.mockResolvedValue(modelResponse({ filename: "north-field.md", filetype: "text/markdown", content: validMarkdown }));
    mockSaveDeliverableVersion.mockRejectedValue(new Error("storage failed"));

    const result = await getExpertResponse(makeExpert(), [], "Create the SOP", [], ["File Creator"], request);

    expect(mockSaveDeliverableVersion).toHaveBeenCalledOnce();
    expect(result.content).toContain("The generated file could not be saved");
    expect(result.content).not.toContain("storage failed");
    expect(fs.readdirSync(path.join(tempRoot, "uploads"))).toEqual([]);
  });

  it("returns a safe storage-write message from the streaming File Creator path", async () => {
    const request = makeRequest({ constraints: { format: "markdown" } });
    mockProviderChat.mockResolvedValue(modelResponse({ filename: "north-field.md", filetype: "text/markdown", content: validMarkdown }));
    mockSaveDeliverableVersion.mockRejectedValue(new Error("private storage payload"));
    const emitted: string[] = [];

    const result = await getExpertResponseStream(
      makeExpert(), [], "Create the SOP", [], ["File Creator"], (token) => emitted.push(token), request,
    );

    expect(result.content).toContain("The generated file could not be saved");
    expect(result.content).not.toContain("private storage payload");
    expect(emitted).toEqual([result.content]);
    expect(fs.readdirSync(path.join(tempRoot, "uploads"))).toEqual([]);
  });

  it("uses the stored file ID for attached-file links instead of exposing its storage path", async () => {
    const uploadPath = path.join(tempRoot, "uploads", "stored-plan.md");
    fs.mkdirSync(path.dirname(uploadPath), { recursive: true });
    fs.writeFileSync(uploadPath, "Existing plan content");
    const attached: File = {
      id: 12,
      conversationId: 8,
      filename: "stored-plan.md",
      fileUrl: "/uploads/stored-plan.md",
      fileType: "text/markdown",
      uploadedBy: "Expert: File Creator",
      uploadedAt: new Date("2026-10-11T12:00:00Z"),
    };
    mockProviderChat.mockResolvedValue({ message: { role: "assistant", content: "Use the stored plan." } });

    await getExpertResponse(makeExpert("Crop Specialist"), [], "Review the plan", [attached], ["Crop Specialist"]);

    const systemMessages = mockProviderChat.mock.calls[0][0].filter((message: { role: string }) => message.role === "system");
    const context = systemMessages.map((message: { content: string }) => message.content).join("\n");
    expect(context).toContain("/api/protected/conversations/8/files/12/download");
    expect(context).not.toContain("/uploads/stored-plan.md");
  });
});
