import { describe, expect, it } from "vitest";
import { MemStorage, PostgresStorage, DeliverableConflictError } from "../server/storage";

const request = (generationRequestId: string, mode: "create" | "revise", expectedCurrentFileId?: number) => ({
  deliverableId: "nitrogen-sop",
  generationRequestId,
  mode,
  expectedCurrentFileId,
  constraints: {},
});

describe("canonical deliverable storage", () => {
  it("deduplicates generation retries and retains superseded versions", async () => {
    const storage = new MemStorage();
    const conversation = await storage.createConversation({ userId: 1, title: "Nitrogen plan" });
    const input = {
      conversationId: conversation.id,
      filename: "nitrogen-sop.md",
      fileUrl: "/uploads/version-1-nitrogen-sop.md",
      fileType: "text/markdown",
      uploadedBy: "Expert: File Creator",
    };

    const first = await storage.saveDeliverableVersion(input, request("run-1", "create"));
    const createRetry = await storage.saveDeliverableVersion(input, request("run-1", "create"));
    const repeatedCreate = await storage.saveDeliverableVersion(
      { ...input, fileUrl: "/uploads/unneeded-duplicate.md" },
      request("run-2", "create"),
    );

    expect(first).toMatchObject({ created: true, file: { version: 1, supersededAt: null } });
    expect(createRetry).toEqual({ file: first.file, created: false });
    expect(repeatedCreate).toEqual({ file: first.file, created: false });

    const revised = await storage.saveDeliverableVersion(
      { ...input, fileUrl: "/uploads/version-2-nitrogen-sop.md" },
      request("run-3", "revise", first.file.id),
    );
    const revisionRetry = await storage.saveDeliverableVersion(
      { ...input, fileUrl: "/uploads/unneeded-retry.md" },
      request("run-3", "revise", first.file.id),
    );

    expect(revised).toMatchObject({
      created: true,
      file: { version: 2, supersedesFileId: first.file.id, supersededAt: null },
    });
    expect(revisionRetry).toEqual({ file: revised.file, created: false });
    expect((await storage.getFileById(first.file.id))?.supersededAt).toBeInstanceOf(Date);
    expect(await storage.getCurrentDeliverableFile(conversation.id, "nitrogen-sop")).toEqual(revised.file);
    expect((await storage.getConversationFiles(conversation.id)).map(file => file.version).sort()).toEqual([1, 2]);
  });

  it("rejects a stale revision without replacing the current file", async () => {
    const storage = new MemStorage();
    const conversation = await storage.createConversation({ userId: 1, title: "Nitrogen plan" });
    const file = await storage.saveDeliverableVersion({
      conversationId: conversation.id,
      filename: "nitrogen-sop.md",
      fileUrl: "/uploads/nitrogen-sop.md",
      fileType: "text/markdown",
      uploadedBy: "Expert: File Creator",
    }, request("run-1", "create"));

    await expect(storage.saveDeliverableVersion({
      conversationId: conversation.id,
      filename: "nitrogen-sop.md",
      fileUrl: "/uploads/stale-revision.md",
      fileType: "text/markdown",
      uploadedBy: "Expert: File Creator",
    }, request("run-2", "revise", file.file.id + 1))).rejects.toBeInstanceOf(DeliverableConflictError);

    expect(await storage.getCurrentDeliverableFile(conversation.id, "nitrogen-sop")).toEqual(file.file);
    expect(await storage.getConversationFiles(conversation.id)).toHaveLength(1);
  });

  it("returns the committed version when a concurrent revision retry sees a stale-current conflict", async () => {
    const savedRevision = {
      id: 8,
      conversationId: 5,
      filename: "nitrogen-sop.md",
      fileUrl: "/uploads/nitrogen-sop-v2.md",
      fileType: "text/markdown",
      uploadedBy: "Expert: File Creator",
      deliverableId: "nitrogen-sop",
      generationRequestId: "run-2",
      version: 2,
      supersedesFileId: 7,
      supersededAt: null,
      uploadedAt: new Date(),
    };
    const db = {
      transaction: async () => { throw new DeliverableConflictError("The deliverable changed before this revision could be saved."); },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [savedRevision],
          }),
        }),
      }),
    };
    const storage = Object.create(PostgresStorage.prototype) as PostgresStorage & { db: typeof db };
    storage.db = db;

    await expect(storage.saveDeliverableVersion({
      conversationId: 5,
      filename: "nitrogen-sop.md",
      fileUrl: "/uploads/retry.md",
      fileType: "text/markdown",
      uploadedBy: "Expert: File Creator",
    }, request("run-2", "revise", 7))).resolves.toEqual({ file: savedRevision, created: false });
  });
});
