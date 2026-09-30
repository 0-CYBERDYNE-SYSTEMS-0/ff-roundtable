import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemStorage, PostgresStorage, type IStorage } from "../server/storage";
import { messages, openQuestions, type Message, type MessageStance, type OpenQuestion } from "../shared/schema";

type Predicate = { key: string; value: unknown };

// A deliberately narrow Drizzle-shaped fake for PostgresStorage's ledger
// methods. It exercises the storage query chains without opening a live DB.
class FakeOpenQuestionDb {
  private rows: OpenQuestion[] = [];
  private messages: Message[] = [];
  private nextId = 1;
  private nextMessageId = 1;

  insert(table: unknown) {
    if (table === messages) {
      return {
        values: (values: Partial<Message>) => ({
          returning: async () => {
            const created = {
              ...values,
              id: this.nextMessageId++,
              timestamp: new Date(1),
              artifacts: values.artifacts ?? [],
              stance: values.stance ?? null,
            } as Message;
            this.messages.push(created);
            return [{ ...created }];
          },
        }),
      };
    }
    this.assertTable(table);
    return {
      values: (values: Partial<OpenQuestion>) => {
        const builder = {
          onConflictDoNothing: (_config?: unknown) => builder,
          returning: async () => {
            const existing = this.rows.find((row) =>
              row.messageId === values.messageId && row.question === values.question,
            );
            if (existing) return [];
            const created: OpenQuestion = {
              id: this.nextId++,
              conversationId: values.conversationId!,
              messageId: values.messageId!,
              expertRole: values.expertRole!,
              question: values.question!,
              assumption: values.assumption ?? null,
              status: values.status ?? "open",
              answerMessageId: values.answerMessageId ?? null,
              createdAt: new Date(1),
            };
            this.rows.push(created);
            return [{ ...created }];
          },
        };
        return builder;
      },
    };
  }

  select() {
    return {
      from: (table: unknown) => {
        this.assertSelectTable(table);
        return {
          where: (expression: unknown) => {
            const predicates = this.predicates(expression, table);
            const sourceRows = table === messages ? this.messages : this.rows;
            const matching = () => sourceRows.filter((row) => this.matches(row, predicates));
            return {
              limit: async (limit: number) => matching().slice(0, limit).map((row) => ({ ...row })),
              orderBy: async (...orderings: unknown[]) => {
                if (table === messages) {
                  if (orderings.length !== 1) throw new Error("Postgres message history must sort by timestamp");
                  return matching()
                    .sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0) || a.id - b.id)
                    .map((row) => ({ ...row }));
                }
                if (orderings.length !== 2) {
                  throw new Error("Postgres open-question listing must sort by createdAt and id");
                }
                return matching()
                  .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) || a.id - b.id)
                  .map((row) => ({ ...row }));
              },
            };
          },
        };
      },
    };
  }

  update(table: unknown) {
    this.assertTable(table);
    return {
      set: (changes: Partial<OpenQuestion>) => ({
        where: (expression: unknown) => ({
          returning: async () => {
            const predicates = this.predicates(expression);
            const updated = this.rows.filter((row) => this.matches(row, predicates));
            for (const row of updated) Object.assign(row, changes);
            return updated.map((row) => ({ ...row }));
          },
        }),
      }),
    };
  }

  async transaction<T>(callback: (tx: this) => Promise<T>): Promise<T> {
    const rowsBefore = this.rows.map((row) => ({ ...row }));
    const messagesBefore = this.messages.map((message) => ({ ...message }));
    const nextIdBefore = this.nextId;
    const nextMessageIdBefore = this.nextMessageId;
    try {
      return await callback(this);
    } catch (error) {
      this.rows = rowsBefore;
      this.messages = messagesBefore;
      this.nextId = nextIdBefore;
      this.nextMessageId = nextMessageIdBefore;
      throw error;
    }
  }

  linkedAnswerCount() {
    return this.messages.filter((message) => message.answersQuestionId !== null && message.answersQuestionId !== undefined).length;
  }

  private assertTable(table: unknown) {
    if (table !== openQuestions) throw new Error("Fake DB only supports open_questions");
  }

  private assertSelectTable(table: unknown) {
    if (table !== openQuestions && table !== messages) throw new Error("Fake DB received an unsupported select table");
  }

  private predicates(expression: unknown, table: unknown): Predicate[] {
    const found: Predicate[] = [];
    const columns = table === messages ? messages : openQuestions;
    const walk = (node: any) => {
      const chunks = node?.queryChunks;
      if (!Array.isArray(chunks)) return;

      const columnIndex = chunks.findIndex((chunk: unknown) =>
        Object.entries(columns).some(([, column]) => column === chunk),
      );
      if (columnIndex >= 0) {
        const entry = Object.entries(columns).find(([, column]) => column === chunks[columnIndex]);
        const parameter = chunks.slice(columnIndex + 1).find((chunk: any) =>
          chunk && typeof chunk === "object" && "value" in chunk && !Array.isArray(chunk.value),
        );
        if (entry && parameter) found.push({ key: entry[0], value: parameter.value });
        return;
      }

      for (const chunk of chunks) walk(chunk);
    };
    walk(expression);
    return found;
  }

  private matches(row: object, predicates: Predicate[]) {
    return predicates.every(({ key, value }) => (row as any)[key] === value);
  }
}

function postgresStorageWithFakeDb(): IStorage {
  // Bypass the constructor so the test never creates a pool, session table,
  // or seed user. The assigned fake implements only open-question queries.
  const storage = Object.create(PostgresStorage.prototype) as PostgresStorage & { db: unknown };
  storage.db = new FakeOpenQuestionDb();
  return storage;
}

const storageCases = [
  ["MemStorage", () => new MemStorage()],
  ["PostgresStorage with fake Drizzle DB", postgresStorageWithFakeDb],
] as const;

describe.each(storageCases)("%s open question ledger", (_name, makeStorage) => {
  let storage: IStorage;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    storage = makeStorage();
  });

  afterEach(() => vi.restoreAllMocks());

  const createSourceMessage = (conversationId: number) => storage.createMessage({
    conversationId,
    userId: null,
    expertId: null,
    content: "@[User] What information should the farmer provide?\nAssuming it is not yet known.",
    role: "assistant",
    expertRole: "Agronomist",
  });

  it("round-trips structured stance and maps missing legacy stance to null", async () => {
    const stance: MessageStance = {
      stance: "conditional",
      confidence: 4,
      position: "Proceed after confirming the drainage plan.",
    };
    const withStance = await storage.createMessage({
      conversationId: 7,
      userId: null,
      expertId: 1,
      content: "I can support this plan if drainage is confirmed.",
      role: "assistant",
      expertRole: "Agronomist",
      stance,
    });
    const legacy = await storage.createMessage({
      conversationId: 7,
      userId: null,
      expertId: 2,
      content: "Legacy message without a stance.",
      role: "assistant",
      expertRole: "Soil Scientist",
    });

    expect(withStance.stance).toEqual(stance);
    expect(legacy.stance ?? null).toBeNull();

    const history = await storage.getConversationMessages(7);
    expect(history.find((message) => message.id === withStance.id)?.stance).toEqual(stance);
    expect(history.find((message) => message.id === legacy.id)?.stance ?? null).toBeNull();
  });

  it("creates, lists only open rows, and answers once idempotently", async () => {
    const source = await createSourceMessage(7);
    const input = {
      conversationId: 7,
      messageId: source.id,
      expertRole: "Agronomist",
      question: "What is the soil pH?",
      assumption: "The field may be acidic.",
    };

    const created = await storage.createOpenQuestion(input);
    expect(created).toMatchObject({ ...input, status: "open", answerMessageId: null });
    expect(created.id).toBeGreaterThan(0);
    expect(created.createdAt).toBeInstanceOf(Date);

    const otherSource = await createSourceMessage(8);
    const otherConversation = await storage.createOpenQuestion({
      ...input,
      conversationId: 8,
      messageId: otherSource.id,
      question: "What is the drainage like?",
    });
    expect(await storage.listOpenQuestions(7)).toEqual([created]);
    expect(await storage.listOpenQuestions(8)).toEqual([otherConversation]);

    const answered = await storage.answerOpenQuestion(created.id, 99);
    expect(answered).toMatchObject({ id: created.id, status: "answered", answerMessageId: 99 });
    expect(await storage.getOpenQuestion(created.id)).toEqual(answered);
    expect(await storage.listOpenQuestions(7)).toEqual([]);

    // A retry with the same answer is safe; a conflicting second answer and
    // a missing row do not change the already recorded resolution.
    expect(await storage.answerOpenQuestion(created.id, 99)).toEqual(answered);
    expect(await storage.answerOpenQuestion(created.id, 100)).toBeUndefined();
    expect(await storage.answerOpenQuestion(99999, 100)).toBeUndefined();
  });

  it("deduplicates the same source message and exact question", async () => {
    const source = await createSourceMessage(7);
    const first = await storage.createOpenQuestion({
      conversationId: 7,
      messageId: source.id,
      expertRole: "Agronomist",
      question: "What is the soil pH?",
      assumption: null,
    });
    const duplicate = await storage.createOpenQuestion({
      conversationId: 7,
      messageId: source.id,
      expertRole: "Moderator",
      question: "What is the soil pH?",
      assumption: "Different parse metadata does not replace the original row.",
    });
    const distinct = await storage.createOpenQuestion({
      conversationId: 7,
      messageId: source.id,
      expertRole: "Agronomist",
      question: "What is the soil texture?",
      assumption: null,
    });

    expect(duplicate).toEqual(first);
    expect(distinct.id).not.toBe(first.id);
    expect(await storage.listOpenQuestions(7)).toEqual([first, distinct]);
  });

  it("rejects a source message from another conversation", async () => {
    const source = await createSourceMessage(7);
    await expect(storage.createOpenQuestion({
      conversationId: 8,
      messageId: source.id,
      expertRole: "Agronomist",
      question: "What was the soil pH?",
      assumption: null,
    })).rejects.toThrow("source message must belong to the same conversation");
  });

  it("rejects a duplicate question retried under a different conversation", async () => {
    const source = await createSourceMessage(7);
    await storage.createOpenQuestion({
      conversationId: 7,
      messageId: source.id,
      expertRole: "Agronomist",
      question: "What is the soil pH?",
      assumption: null,
    });
    await expect(storage.createOpenQuestion({
      conversationId: 8,
      messageId: source.id,
      expertRole: "Agronomist",
      question: "What is the soil pH?",
      assumption: null,
    })).rejects.toThrow("source message must belong to the same conversation");
  });

  it("stores a linked answer and closes its question atomically", async () => {
    const source = await createSourceMessage(7);
    const question = await storage.createOpenQuestion({
      conversationId: 7,
      messageId: source.id,
      expertRole: "Agronomist",
      question: "What is the soil pH?",
      assumption: "The field may be acidic.",
    });
    const answerInput = {
      conversationId: 7,
      userId: 3,
      expertId: null,
      role: "user",
      content: "The test showed pH 6.4.",
      answersQuestionId: question.id,
    } as const;

    const first = await storage.createAnswerMessage(answerInput, question.id);
    expect(first).toMatchObject({
      message: { content: answerInput.content, answersQuestionId: question.id },
      question: { id: question.id, status: "answered" },
    });
    expect(first?.question.answerMessageId).toBe(first?.message.id);

    expect(await storage.createAnswerMessage(answerInput, question.id)).toBeUndefined();
    if (_name === "PostgresStorage with fake Drizzle DB") {
      expect(((storage as unknown as { db: FakeOpenQuestionDb }).db).linkedAnswerCount()).toBe(1);
    }
  });

  it("allows exactly one recovery request to claim an already-stored answer", async () => {
    const source = await createSourceMessage(7);
    const question = await storage.createOpenQuestion({
      conversationId: 7,
      messageId: source.id,
      expertRole: "Agronomist",
      question: "What is the soil pH?",
      assumption: null,
    });

    expect(await storage.claimOpenQuestionAnswer(question.id, 99)).toEqual({
      question: expect.objectContaining({ id: question.id, status: "answered", answerMessageId: 99 }),
      claimed: true,
    });
    expect(await storage.claimOpenQuestionAnswer(question.id, 99)).toEqual({
      question: expect.objectContaining({ id: question.id, status: "answered", answerMessageId: 99 }),
      claimed: false,
    });
    expect(await storage.claimOpenQuestionAnswer(question.id, 100)).toBeUndefined();
  });
});
