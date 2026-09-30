import { users, type User, type InsertUser, conversations, type Conversation, type InsertConversation, experts, type Expert, type InsertExpert, messages, type Message, type InsertMessage, openQuestions, type OpenQuestion, type InsertOpenQuestion, files, type File, type InsertFile, insights, type Insight, type InsertInsight, farmProfiles, type FarmProfile, type InsertFarmProfile, weatherCache } from "@shared/schema";
import { encryptApiKey, decryptApiKey } from "./crypto";
import createMemoryStore from "memorystore";
import session from "express-session";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, desc, asc, and } from "drizzle-orm";
import ConnectPgSimple from "connect-pg-simple";

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "";

function normalizeTurnBudget(turnBudget: number | null | undefined): number | null | undefined {
  return turnBudget === 0 ? null : turnBudget;
}

const MemoryStore = createMemoryStore(session);
const PgSessionStore = ConnectPgSimple(session);

class OpenQuestionNoLongerOpenError extends Error {}

// modify the interface with any CRUD methods
// you might need
export interface IStorage {
  // User operations
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByStripeSubscriptionId(subscriptionId: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUserStripeInfo(userId: number, stripeInfo: { stripeCustomerId: string, stripeSubscriptionId: string }): Promise<User>;
  updateSubscriptionStatus(userId: number, status: string): Promise<User>;
  getUserApiKey(userId: number): Promise<string | null>;
  setUserApiKey(userId: number, key: string): Promise<void>;
  removeUserApiKey(userId: number): Promise<void>;
  
  // Conversation operations
  createConversation(conversation: InsertConversation): Promise<Conversation>;
  getConversation(id: number): Promise<Conversation | undefined>;
  getUserConversations(userId: number): Promise<Conversation[]>;
  // Partial update (G6/G13): only provided keys change. Null clears the
  // charter or turn budget; omitted keys stay untouched.
  // G7: `orchestratorState` joins the allowlist so the orchestrator can
  // persist its survivable snapshot at turn boundaries.
  updateConversation(id: number, updates: Partial<Pick<Conversation, "title" | "charter" | "orchestratorState" | "turnBudget">>): Promise<Conversation | undefined>;
  
  // Expert operations
  createExpert(expert: InsertExpert): Promise<Expert>;
  getExpertById(expertId: number): Promise<Expert | undefined>;
  getConversationExperts(conversationId: number): Promise<Expert[]>;
  updateExpert(expertId: number, updates: Partial<Expert>): Promise<Expert>;
  
  // Message operations
  createMessage(message: InsertMessage): Promise<Message>;
  getConversationMessages(conversationId: number): Promise<Message[]>;

  // Open question ledger (G12)
  createOpenQuestion(question: InsertOpenQuestion): Promise<OpenQuestion>;
  listOpenQuestions(conversationId: number): Promise<OpenQuestion[]>;
  getOpenQuestion(id: number): Promise<OpenQuestion | undefined>;
  answerOpenQuestion(id: number, answerMessageId: number): Promise<OpenQuestion | undefined>;
  claimOpenQuestionAnswer(id: number, answerMessageId: number): Promise<{ question: OpenQuestion; claimed: boolean } | undefined>;
  createAnswerMessage(message: InsertMessage, questionId: number): Promise<{ message: Message; question: OpenQuestion } | undefined>;
  
  // File operations
  createFile(file: InsertFile): Promise<File>;
  getConversationFiles(conversationId: number): Promise<File[]>;
  
  // Insight operations
  createInsight(insight: InsertInsight): Promise<Insight>;
  getConversationInsights(conversationId: number): Promise<Insight[]>;

  // Farm profile operations
  getFarmProfile(userId: number): Promise<FarmProfile | undefined>;
  upsertFarmProfile(userId: number, profile: Partial<Omit<InsertFarmProfile, "userId">>): Promise<FarmProfile>;

  // Weather cache operations
  getCachedWeather(lat: string, lng: string): Promise<{ data: any; fetchedAt: Date } | undefined>;
  cacheWeather(lat: string, lng: string, data: any): Promise<void>;

  // Session store
  sessionStore: session.Store;
}

// ─── In-Memory Storage (Dev Fallback) ────────────────────────────────────────

export class MemStorage implements IStorage {
  private users: Map<number, User>;
  private conversations: Map<number, Conversation>;
  private experts: Map<number, Expert>;
  private messages: Map<number, Message>;
  private openQuestions: Map<number, OpenQuestion>;
  private files: Map<number, File>;
  private insights: Map<number, Insight>;
  
  sessionStore: session.Store;
  private userId: number;
  private conversationId: number;
  private expertId: number;
  private messageId: number;
  private openQuestionId: number;
  private fileId: number;
  private insightId: number;

  constructor() {
    this.users = new Map();
    this.conversations = new Map();
    this.experts = new Map();
    this.messages = new Map();
    this.openQuestions = new Map();
    this.files = new Map();
    this.insights = new Map();
    
    this.userId = 1;
    this.conversationId = 1;
    this.expertId = 1;
    this.messageId = 1;
    this.openQuestionId = 1;
    this.fileId = 1;
    this.insightId = 1;
    
    this.sessionStore = new MemoryStore({
      checkPeriod: 86400000 // prune expired entries every 24h
    });
    
    // Create a development user for easy login
    this.addDevelopmentUser();
  }
  
  // Initialize a development user account
  private addDevelopmentUser() {
    // This is only for development purposes
    const devUser: User = {
      id: this.userId++,
      username: 'developer',
      email: 'dev@example.com',
      password: 'dev:password',
      // Dev account bypasses tier gates: enterprise = no expert-count or
      // paid-model restrictions during local development/testing.
      tier: 'enterprise',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: 'active',
      openRouterKey: null,
      createdAt: new Date()
    };
    
    this.users.set(devUser.id, devUser);
    console.log('Development user created: username=developer, password=password');
  }

  // User operations
  async getUser(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async getUserByStripeSubscriptionId(subscriptionId: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.stripeSubscriptionId === subscriptionId,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = this.userId++;
    const now = new Date();
    const user: User = { 
      ...insertUser, 
      id, 
      tier: insertUser.tier ?? null,
      stripeCustomerId: null, 
      stripeSubscriptionId: null,
      subscriptionStatus: "inactive",
      openRouterKey: null,
      createdAt: now
    };
    this.users.set(id, user);
    return user;
  }
  
  async updateUserStripeInfo(userId: number, stripeInfo: { stripeCustomerId: string, stripeSubscriptionId: string }): Promise<User> {
    const user = await this.getUser(userId);
    if (!user) throw new Error(`User with ID ${userId} not found`);
    
    const updatedUser: User = {
      ...user,
      stripeCustomerId: stripeInfo.stripeCustomerId,
      stripeSubscriptionId: stripeInfo.stripeSubscriptionId
    };

    this.users.set(userId, updatedUser);
    return updatedUser;
  }
  
  async updateSubscriptionStatus(userId: number, status: string): Promise<User> {
    const user = await this.getUser(userId);
    if (!user) throw new Error(`User with ID ${userId} not found`);
    
    const updatedUser: User = {
      ...user,
      subscriptionStatus: status
    };
    
    this.users.set(userId, updatedUser);
    return updatedUser;
  }

  async getUserApiKey(userId: number): Promise<string | null> {
    const user = await this.getUser(userId);
    if (!user || !user.openRouterKey) return null;
    if (!ENCRYPTION_KEY) {
      console.error("[BYOK] ENCRYPTION_KEY not configured — cannot decrypt user API key");
      return null;
    }
    try {
      return decryptApiKey(user.openRouterKey, ENCRYPTION_KEY);
    } catch (err) {
      console.error("[BYOK] Failed to decrypt user API key:", (err as Error).message);
      return null;
    }
  }

  async setUserApiKey(userId: number, key: string): Promise<void> {
    if (!ENCRYPTION_KEY) {
      throw new Error("ENCRYPTION_KEY not configured");
    }
    const encrypted = encryptApiKey(key, ENCRYPTION_KEY);
    const user = await this.getUser(userId);
    if (!user) throw new Error(`User with ID ${userId} not found`);
    const updatedUser: User = { ...user, openRouterKey: encrypted };
    this.users.set(userId, updatedUser);
  }

  async removeUserApiKey(userId: number): Promise<void> {
    const user = await this.getUser(userId);
    if (!user) throw new Error(`User with ID ${userId} not found`);
    const updatedUser: User = { ...user, openRouterKey: null };
    this.users.set(userId, updatedUser);
  }

  // Conversation operations
  async createConversation(insertConversation: InsertConversation): Promise<Conversation> {
    const id = this.conversationId++;
    const now = new Date();
    // G7: the orchestrator snapshot is server-owned — a fresh conversation
    // always starts stateless, whatever the (loosely jsonb-typed) insert
    // payload carries.
    const { orchestratorState: _ignoredSnapshot, ...rest } = insertConversation;
    const conversation: Conversation = {
      ...rest,
      id,
      title: insertConversation.title ?? "New Conversation",
      charter: insertConversation.charter ?? null,
      orchestratorState: null,
      turnBudget: insertConversation.turnBudget === undefined
        ? 25
        : normalizeTurnBudget(insertConversation.turnBudget) ?? null,
      createdAt: now,
    };
    this.conversations.set(id, conversation);
    return conversation;
  }
  
  async getConversation(id: number): Promise<Conversation | undefined> {
    return this.conversations.get(id);
  }
  
  async getUserConversations(userId: number): Promise<Conversation[]> {
    return Array.from(this.conversations.values())
      .filter(conversation => conversation.userId === userId)
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  }

  async updateConversation(id: number, updates: Partial<Pick<Conversation, "title" | "charter" | "orchestratorState" | "turnBudget">>): Promise<Conversation | undefined> {
    const conversation = this.conversations.get(id);
    if (!conversation) return undefined;

    // Explicit undefined-checks (not a plain spread) so omitted keys keep
    // their current values while explicit null clears a nullable value.
    const updated: Conversation = {
      ...conversation,
      ...(updates.title !== undefined && { title: updates.title }),
      ...(updates.charter !== undefined && { charter: updates.charter }),
      ...(updates.orchestratorState !== undefined && { orchestratorState: updates.orchestratorState }),
      ...(updates.turnBudget !== undefined && { turnBudget: normalizeTurnBudget(updates.turnBudget) }),
    };

    this.conversations.set(id, updated);
    return updated;
  }
  
  // Expert operations
  async createExpert(insertExpert: InsertExpert): Promise<Expert> {
    const id = this.expertId++;
    const expert: Expert = {
      ...insertExpert,
      id,
      customInstructions: insertExpert.customInstructions ?? null,
      avatarUrl: insertExpert.avatarUrl ?? null
    };
    this.experts.set(id, expert);
    return expert;
  }
  
  async getExpertById(expertId: number): Promise<Expert | undefined> {
    return this.experts.get(expertId);
  }

  async getConversationExperts(conversationId: number): Promise<Expert[]> {
    return Array.from(this.experts.values())
      .filter(expert => expert.conversationId === conversationId);
  }

  async updateExpert(expertId: number, updates: Partial<Expert>): Promise<Expert> {
    const expert = this.experts.get(expertId);
    if (!expert) throw new Error(`Expert with ID ${expertId} not found`);

    const updatedExpert: Expert = {
      ...expert,
      ...updates,
      id: expert.id, // Ensure ID is not changed
      conversationId: expert.conversationId // Ensure conversationId is not changed
    };

    this.experts.set(expertId, updatedExpert);
    return updatedExpert;
  }
  
  // Message operations
  private createMessageRecord(insertMessage: InsertMessage): Message {
    const id = this.messageId++;
    const now = new Date();
    const message: Message = {
      id,
      conversationId: insertMessage.conversationId,
      expertId: insertMessage.expertId ?? null,
      userId: insertMessage.userId ?? null,
      content: insertMessage.content,
      role: insertMessage.role,
      expertName: insertMessage.expertName ?? null,
      expertRole: insertMessage.expertRole ?? null,
      artifacts: Array.isArray(insertMessage.artifacts) ? insertMessage.artifacts as Message["artifacts"] : [],
      // G4 mentions: pass the parsed @-tag list through (null when unset).
      mentions: Array.isArray(insertMessage.mentions) ? insertMessage.mentions : null,
      // G5 synthesis: pass the closing-synthesis flag through (null when unset).
      isSynthesis: insertMessage.isSynthesis ?? null,
      answersQuestionId: insertMessage.answersQuestionId ?? null,
      // G15 stance: legacy and non-expert messages have no stance.
      stance: insertMessage.stance ?? null,
      timestamp: now,
    };
    this.messages.set(id, message);
    return message;
  }

  async createMessage(insertMessage: InsertMessage): Promise<Message> {
    return this.createMessageRecord(insertMessage);
  }
  
  async getConversationMessages(conversationId: number): Promise<Message[]> {
    return Array.from(this.messages.values())
      .filter(message => message.conversationId === conversationId)
      .sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0));
  }

  // ── Open question ledger operations ────────────────────────────────────────

  async createOpenQuestion(insertQuestion: InsertOpenQuestion): Promise<OpenQuestion> {
    const sourceMessage = this.messages.get(insertQuestion.messageId);
    if (!sourceMessage || sourceMessage.conversationId !== insertQuestion.conversationId) {
      throw new Error("Open question source message must belong to the same conversation.");
    }

    const existing = Array.from(this.openQuestions.values()).find(
      (question) => question.messageId === insertQuestion.messageId && question.question === insertQuestion.question,
    );
    if (existing) return existing;

    const openQuestion: OpenQuestion = {
      id: this.openQuestionId++,
      conversationId: insertQuestion.conversationId,
      messageId: insertQuestion.messageId,
      expertRole: insertQuestion.expertRole,
      question: insertQuestion.question,
      assumption: insertQuestion.assumption ?? null,
      status: "open",
      answerMessageId: null,
      createdAt: new Date(),
    };
    this.openQuestions.set(openQuestion.id, openQuestion);
    return openQuestion;
  }

  async listOpenQuestions(conversationId: number): Promise<OpenQuestion[]> {
    return Array.from(this.openQuestions.values())
      .filter((question) => question.conversationId === conversationId && question.status === "open")
      .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) || a.id - b.id);
  }

  async getOpenQuestion(id: number): Promise<OpenQuestion | undefined> {
    return this.openQuestions.get(id);
  }

  async answerOpenQuestion(id: number, answerMessageId: number): Promise<OpenQuestion | undefined> {
    const existing = this.openQuestions.get(id);
    if (!existing) return undefined;
    if (existing.status === "answered") {
      return existing.answerMessageId === answerMessageId ? existing : undefined;
    }

    const answered: OpenQuestion = { ...existing, status: "answered", answerMessageId };
    this.openQuestions.set(id, answered);
    return answered;
  }

  async claimOpenQuestionAnswer(
    id: number,
    answerMessageId: number,
  ): Promise<{ question: OpenQuestion; claimed: boolean } | undefined> {
    const existing = this.openQuestions.get(id);
    if (!existing) return undefined;
    if (existing.status === "answered") {
      return existing.answerMessageId === answerMessageId ? { question: existing, claimed: false } : undefined;
    }
    const question: OpenQuestion = { ...existing, status: "answered", answerMessageId };
    this.openQuestions.set(id, question);
    return { question, claimed: true };
  }

  async createAnswerMessage(
    insertMessage: InsertMessage,
    questionId: number,
  ): Promise<{ message: Message; question: OpenQuestion } | undefined> {
    const existing = this.openQuestions.get(questionId);
    if (!existing || existing.status !== "open" || existing.conversationId !== insertMessage.conversationId) {
      return undefined;
    }

    // All map updates happen in this synchronous segment, so concurrent
    // requests in this process cannot both claim the same open question.
    const message = this.createMessageRecord({ ...insertMessage, answersQuestionId: questionId });
    const question: OpenQuestion = { ...existing, status: "answered", answerMessageId: message.id };
    this.openQuestions.set(questionId, question);
    return { message, question };
  }
  
  // File operations
  async createFile(insertFile: InsertFile): Promise<File> {
    const id = this.fileId++;
    const now = new Date();
    const file: File = { ...insertFile, id, uploadedAt: now };
    this.files.set(id, file);
    return file;
  }
  
  async getConversationFiles(conversationId: number): Promise<File[]> {
    return Array.from(this.files.values())
      .filter(file => file.conversationId === conversationId)
      .sort((a, b) => (b.uploadedAt?.getTime() ?? 0) - (a.uploadedAt?.getTime() ?? 0));
  }
  
  // Insight operations
  async createInsight(insertInsight: InsertInsight): Promise<Insight> {
    const id = this.insightId++;
    const now = new Date();
    const insight: Insight = { ...insertInsight, id, points: insertInsight.points ?? [], createdAt: now };
    this.insights.set(id, insight);
    return insight;
  }
  
  async getConversationInsights(conversationId: number): Promise<Insight[]> {
    return Array.from(this.insights.values())
      .filter(insight => insight.conversationId === conversationId)
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  }

  // Farm profile operations (MemStorage)
  private farmProfiles: Map<number, FarmProfile> = new Map();

  async getFarmProfile(userId: number): Promise<FarmProfile | undefined> {
    return this.farmProfiles.get(userId);
  }

  async upsertFarmProfile(userId: number, profile: Partial<Omit<InsertFarmProfile, "userId">>): Promise<FarmProfile> {
    // Merge with existing so partial PUTs preserve unspecified fields.
    const existing = this.farmProfiles.get(userId);
    const merged = { ...(existing ?? {}), ...profile } as InsertFarmProfile;
    const now = new Date();
    const fp: FarmProfile = {
      id: existing?.id || (this.insightId++),
      userId,
      farmName: merged.farmName ?? "",
      location: merged.location ?? "",
      lat: merged.lat ?? null,
      lng: merged.lng ?? null,
      acres: merged.acres ?? 0,
      crops: merged.crops ?? [],
      soilType: merged.soilType ?? "",
      waterSource: merged.waterSource ?? "",
      climateZone: merged.climateZone ?? "",
      hardinessZone: merged.hardinessZone ?? "",
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.farmProfiles.set(userId, fp);
    return fp;
  }

  // Weather cache (MemStorage)
  private weatherCache: Map<string, { data: any; fetchedAt: Date }> = new Map();

  async getCachedWeather(lat: string, lng: string): Promise<{ data: any; fetchedAt: Date } | undefined> {
    return this.weatherCache.get(`${lat},${lng}`);
  }

  async cacheWeather(lat: string, lng: string, data: any): Promise<void> {
    this.weatherCache.set(`${lat},${lng}`, { data, fetchedAt: new Date() });
  }
}

// ─── PostgreSQL Storage (Production) ─────────────────────────────────────────

export class PostgresStorage implements IStorage {
  private pool: Pool;
  private db: ReturnType<typeof drizzle>;
  sessionStore: session.Store;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
    });

    this.db = drizzle(this.pool, {
      schema: { users, conversations, experts, messages, openQuestions, files, insights, farmProfiles, weatherCache },
    });

    this.sessionStore = new PgSessionStore({
      pool: this.pool,
      createTableIfMissing: true,
    });

    console.log(`PostgresStorage initialized with database: ${databaseUrl.replace(/\/\/.*@/, "//***@")}`);

    // Seed development user if not present
    this.seedDevelopmentUser();
  }

  private async seedDevelopmentUser() {
    try {
      const existing = await this.getUserByUsername("developer");
      if (!existing) {
        await this.createUser({
          username: "developer",
          password: "dev:password", // Dev-only — this gets caught by backward-compat in comparePasswords
          email: "dev@example.com",
        });
        // Set subscription to active for dev
        await this.db
          .update(users)
          .set({ subscriptionStatus: "active" })
          .where(eq(users.username, "developer"));
        console.log("Development user seeded: username=developer, password=password");
      }
    } catch (err) {
      console.warn("Failed to seed development user:", (err as Error).message);
    }
  }

  // ── User operations ────────────────────────────────────────────────────────

  async getUser(id: number): Promise<User | undefined> {
    const result = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return result[0];
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    return result[0];
  }

  async getUserByStripeSubscriptionId(subscriptionId: string): Promise<User | undefined> {
    const result = await this.db.select().from(users).where(eq(users.stripeSubscriptionId, subscriptionId)).limit(1);
    return result[0];
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const result = await this.db.insert(users).values(insertUser).returning();
    return result[0];
  }

  async updateUserStripeInfo(userId: number, stripeInfo: { stripeCustomerId: string; stripeSubscriptionId: string }): Promise<User> {
    const result = await this.db
      .update(users)
      .set({
        stripeCustomerId: stripeInfo.stripeCustomerId,
        stripeSubscriptionId: stripeInfo.stripeSubscriptionId,
      })
      .where(eq(users.id, userId))
      .returning();

    if (!result[0]) throw new Error(`User with ID ${userId} not found`);
    return result[0];
  }

  async updateSubscriptionStatus(userId: number, status: string): Promise<User> {
    const result = await this.db
      .update(users)
      .set({ subscriptionStatus: status })
      .where(eq(users.id, userId))
      .returning();

    if (!result[0]) throw new Error(`User with ID ${userId} not found`);
    return result[0];
  }

  async getUserApiKey(userId: number): Promise<string | null> {
    const user = await this.getUser(userId);
    if (!user || !user.openRouterKey) return null;
    if (!ENCRYPTION_KEY) {
      console.error("[BYOK] ENCRYPTION_KEY not configured — cannot decrypt user API key");
      return null;
    }
    try {
      return decryptApiKey(user.openRouterKey, ENCRYPTION_KEY);
    } catch (err) {
      console.error("[BYOK] Failed to decrypt user API key:", (err as Error).message);
      return null;
    }
  }

  async setUserApiKey(userId: number, key: string): Promise<void> {
    if (!ENCRYPTION_KEY) {
      throw new Error("ENCRYPTION_KEY not configured");
    }
    const encrypted = encryptApiKey(key, ENCRYPTION_KEY);
    await this.db
      .update(users)
      .set({ openRouterKey: encrypted })
      .where(eq(users.id, userId));
  }

  async removeUserApiKey(userId: number): Promise<void> {
    await this.db
      .update(users)
      .set({ openRouterKey: null })
      .where(eq(users.id, userId));
  }

  // ── Conversation operations ────────────────────────────────────────────────

  async createConversation(insertConversation: InsertConversation): Promise<Conversation> {
    // G7: the orchestrator snapshot is server-owned — a fresh conversation
    // always starts stateless, whatever the (loosely jsonb-typed) insert
    // payload carries.
    const { orchestratorState: _ignoredSnapshot, ...values } = insertConversation;
    const normalizedValues = {
      ...values,
      turnBudget: values.turnBudget === undefined
        ? 25
        : normalizeTurnBudget(values.turnBudget) ?? null,
    };
    const result = await this.db.insert(conversations).values(normalizedValues).returning();
    return result[0];
  }

  async getConversation(id: number): Promise<Conversation | undefined> {
    const result = await this.db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    return result[0];
  }

  async getUserConversations(userId: number): Promise<Conversation[]> {
    return this.db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, userId))
      .orderBy(desc(conversations.createdAt));
  }

  async updateConversation(id: number, updates: Partial<Pick<Conversation, "title" | "charter" | "orchestratorState" | "turnBudget">>): Promise<Conversation | undefined> {
    // Only allow updating title, charter, the G7 orchestrator snapshot, and
    // the G13 turn budget. Omitted keys stay untouched; explicit null clears.
    const allowed: Partial<Pick<Conversation, "title" | "charter" | "orchestratorState" | "turnBudget">> = {
      ...(updates.title !== undefined && { title: updates.title }),
      ...(updates.charter !== undefined && { charter: updates.charter }),
      ...(updates.orchestratorState !== undefined && { orchestratorState: updates.orchestratorState }),
      ...(updates.turnBudget !== undefined && { turnBudget: normalizeTurnBudget(updates.turnBudget) }),
    };

    const result = await this.db
      .update(conversations)
      .set(allowed)
      .where(eq(conversations.id, id))
      .returning();

    return result[0];
  }

  // ── Expert operations ──────────────────────────────────────────────────────

  async createExpert(insertExpert: InsertExpert): Promise<Expert> {
    const result = await this.db.insert(experts).values(insertExpert).returning();
    return result[0];
  }

  async getExpertById(expertId: number): Promise<Expert | undefined> {
    const result = await this.db.select().from(experts).where(eq(experts.id, expertId)).limit(1);
    return result[0];
  }

  async getConversationExperts(conversationId: number): Promise<Expert[]> {
    return this.db
      .select()
      .from(experts)
      .where(eq(experts.conversationId, conversationId));
  }

  async updateExpert(expertId: number, updates: Partial<Expert>): Promise<Expert> {
    // Only allow updating name, model, systemPrompt, customInstructions, avatarUrl
    const allowed = {
      ...(updates.name !== undefined && { name: updates.name }),
      ...(updates.model !== undefined && { model: updates.model }),
      ...(updates.systemPrompt !== undefined && { systemPrompt: updates.systemPrompt }),
      ...(updates.customInstructions !== undefined && { customInstructions: updates.customInstructions }),
      ...(updates.avatarUrl !== undefined && { avatarUrl: updates.avatarUrl }),
    };

    const result = await this.db
      .update(experts)
      .set(allowed)
      .where(eq(experts.id, expertId))
      .returning();

    if (!result[0]) throw new Error(`Expert with ID ${expertId} not found`);
    return result[0];
  }

  // ── Message operations ─────────────────────────────────────────────────────

  async createMessage(insertMessage: InsertMessage): Promise<Message> {
    // The spread carries every column (incl. the G4 mentions jsonb and the
    // G5 is_synthesis flag) through the camelCase -> snake_case mapping;
    // unset optional columns are omitted.
    const values = { ...insertMessage, artifacts: insertMessage.artifacts || [] };
    const result = await this.db.insert(messages).values(values).returning();
    const raw = result[0];
    // Drizzle returns artifacts as unknown — cast to Artifact[]
    return {
      ...raw,
      artifacts: (raw.artifacts || []) as Message["artifacts"],
      stance: raw.stance ?? null,
    } as Message;
  }

  async getConversationMessages(conversationId: number): Promise<Message[]> {
    const result = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.timestamp);

    return result.map((m) => ({
      ...m,
      artifacts: (m.artifacts || []) as Message["artifacts"],
      stance: m.stance ?? null,
    })) as Message[];
  }

  // ── Open question ledger operations ────────────────────────────────────────

  async createOpenQuestion(insertQuestion: InsertOpenQuestion): Promise<OpenQuestion> {
    const sourceMessage = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(
        eq(messages.id, insertQuestion.messageId),
        eq(messages.conversationId, insertQuestion.conversationId),
      ))
      .limit(1);
    if (!sourceMessage[0]) {
      throw new Error("Open question source message must belong to the same conversation.");
    }

    const inserted = await this.db
      .insert(openQuestions)
      .values({
        conversationId: insertQuestion.conversationId,
        messageId: insertQuestion.messageId,
        expertRole: insertQuestion.expertRole,
        question: insertQuestion.question,
        assumption: insertQuestion.assumption ?? null,
        status: "open",
        answerMessageId: null,
      })
      .onConflictDoNothing({ target: [openQuestions.messageId, openQuestions.question] })
      .returning();
    if (inserted[0]) return inserted[0];

    const existing = await this.db
      .select()
      .from(openQuestions)
      .where(and(
        eq(openQuestions.messageId, insertQuestion.messageId),
        eq(openQuestions.question, insertQuestion.question),
      ))
      .limit(1);
    if (!existing[0]) throw new Error("Open question insert conflicted but the existing row was not found");
    return existing[0];
  }

  async listOpenQuestions(conversationId: number): Promise<OpenQuestion[]> {
    return this.db
      .select()
      .from(openQuestions)
      .where(and(
        eq(openQuestions.conversationId, conversationId),
        eq(openQuestions.status, "open"),
      ))
      .orderBy(asc(openQuestions.createdAt), asc(openQuestions.id));
  }

  async getOpenQuestion(id: number): Promise<OpenQuestion | undefined> {
    const result = await this.db
      .select()
      .from(openQuestions)
      .where(eq(openQuestions.id, id))
      .limit(1);
    return result[0];
  }

  async answerOpenQuestion(id: number, answerMessageId: number): Promise<OpenQuestion | undefined> {
    const updated = await this.db
      .update(openQuestions)
      .set({ status: "answered", answerMessageId })
      .where(and(eq(openQuestions.id, id), eq(openQuestions.status, "open")))
      .returning();
    if (updated[0]) return updated[0];

    const existing = await this.getOpenQuestion(id);
    if (existing?.status === "answered" && existing.answerMessageId === answerMessageId) return existing;
    return undefined;
  }

  async claimOpenQuestionAnswer(
    id: number,
    answerMessageId: number,
  ): Promise<{ question: OpenQuestion; claimed: boolean } | undefined> {
    const updated = await this.db
      .update(openQuestions)
      .set({ status: "answered", answerMessageId })
      .where(and(eq(openQuestions.id, id), eq(openQuestions.status, "open")))
      .returning();
    if (updated[0]) return { question: updated[0], claimed: true };

    const existing = await this.getOpenQuestion(id);
    if (existing?.status === "answered" && existing.answerMessageId === answerMessageId) {
      return { question: existing, claimed: false };
    }
    return undefined;
  }

  async createAnswerMessage(
    insertMessage: InsertMessage,
    questionId: number,
  ): Promise<{ message: Message; question: OpenQuestion } | undefined> {
    try {
      return await this.db.transaction(async (tx) => {
        const matchingQuestion = await tx
          .select()
          .from(openQuestions)
          .where(and(
            eq(openQuestions.id, questionId),
            eq(openQuestions.conversationId, insertMessage.conversationId),
            eq(openQuestions.status, "open"),
          ))
          .limit(1);
        if (!matchingQuestion[0]) return undefined;

        const inserted = await tx
          .insert(messages)
          .values({ ...insertMessage, answersQuestionId: questionId, artifacts: insertMessage.artifacts || [] })
          .returning();
        const rawMessage = inserted[0];
        const message: Message = {
          ...rawMessage,
          artifacts: (rawMessage.artifacts || []) as Message["artifacts"],
        } as Message;

        const updated = await tx
          .update(openQuestions)
          .set({ status: "answered", answerMessageId: message.id })
          .where(and(
            eq(openQuestions.id, questionId),
            eq(openQuestions.conversationId, insertMessage.conversationId),
            eq(openQuestions.status, "open"),
          ))
          .returning();
        if (!updated[0]) {
          // Raising inside the transaction rolls back the just-inserted
          // message, preventing an answer that nobody processed.
          throw new OpenQuestionNoLongerOpenError();
        }
        return { message, question: updated[0] };
      });
    } catch (error) {
      if (error instanceof OpenQuestionNoLongerOpenError) return undefined;
      throw error;
    }
  }

  // ── File operations ────────────────────────────────────────────────────────

  async createFile(insertFile: InsertFile): Promise<File> {
    const result = await this.db.insert(files).values(insertFile).returning();
    return result[0];
  }

  async getConversationFiles(conversationId: number): Promise<File[]> {
    return this.db
      .select()
      .from(files)
      .where(eq(files.conversationId, conversationId))
      .orderBy(desc(files.uploadedAt));
  }

  // ── Insight operations ─────────────────────────────────────────────────────

  async createInsight(insertInsight: InsertInsight): Promise<Insight> {
    const result = await this.db.insert(insights).values(insertInsight).returning();
    return result[0];
  }

  async getConversationInsights(conversationId: number): Promise<Insight[]> {
    return this.db
      .select()
      .from(insights)
      .where(eq(insights.conversationId, conversationId))
      .orderBy(desc(insights.createdAt));
  }

  // ── Farm profile operations ────────────────────────────────────────────────

  async getFarmProfile(userId: number): Promise<FarmProfile | undefined> {
    const result = await this.db
      .select()
      .from(farmProfiles)
      .where(eq(farmProfiles.userId, userId))
      .limit(1);
    return result[0];
  }

  async upsertFarmProfile(userId: number, profile: Partial<Omit<InsertFarmProfile, "userId">>): Promise<FarmProfile> {
    // Check if a profile already exists for this user
    const existing = await this.getFarmProfile(userId);

    if (existing) {
      // Update existing — merge with current row so partial PUTs
      // preserve fields the client didn't send.
      const result = await this.db
        .update(farmProfiles)
        .set({
          ...existing,
          ...profile,
          userId: userId,
          updatedAt: new Date(),
        })
        .where(eq(farmProfiles.userId, userId))
        .returning();
      return result[0];
    } else {
      // Insert new
      const result = await this.db
        .insert(farmProfiles)
        .values({
          ...profile,
          userId: userId,
          updatedAt: new Date(),
        })
        .returning();
      return result[0];
    }
  }

  // ── Weather cache operations ───────────────────────────────────────────────

  // Returns the last entry regardless of age (plus fetchedAt) so callers can
  // implement stale-while-revalidate; freshness is the caller's decision.
  async getCachedWeather(lat: string, lng: string): Promise<{ data: any; fetchedAt: Date } | undefined> {
    const result = await this.db
      .select()
      .from(weatherCache)
      .where(and(eq(weatherCache.lat, lat), eq(weatherCache.lng, lng)))
      .orderBy(desc(weatherCache.fetchedAt))
      .limit(1);

    const entry = result[0];
    if (!entry) return undefined;

    return { data: entry.data, fetchedAt: entry.fetchedAt ?? new Date(0) };
  }

  async cacheWeather(lat: string, lng: string, data: any): Promise<void> {
    // Delete old entries for this lat/lng first
    await this.db
      .delete(weatherCache)
      .where(and(eq(weatherCache.lat, lat), eq(weatherCache.lng, lng)));

    // Insert fresh cache entry
    await this.db
      .insert(weatherCache)
      .values({
        lat,
        lng,
        data,
        fetchedAt: new Date(),
      });
  }
}

// ─── Storage Factory ─────────────────────────────────────────────────────────

function createStorage(): IStorage {
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      const pgStorage = new PostgresStorage(dbUrl);
      console.log("✅ Using PostgreSQL storage");
      return pgStorage;
    } catch (err) {
      console.warn("⚠️  PostgreSQL connection failed, falling back to in-memory storage:", (err as Error).message);
    }
  }
  console.log("ℹ️  No DATABASE_URL set — using in-memory storage (data lost on restart)");
  return new MemStorage();
}

export const storage = createStorage();

// Export for health checks
export async function checkDatabaseConnection(): Promise<boolean> {
  if (storage instanceof PostgresStorage) {
    try {
      const result = await (storage as any).pool.query("SELECT 1");
      return result.rows[0]?.["?column?"] === 1;
    } catch {
      return false;
    }
  }
  return true; // MemStorage is always "connected"
}
