import { users, type User, type InsertUser, conversations, type Conversation, type InsertConversation, experts, type Expert, type InsertExpert, messages, type Message, type InsertMessage, files, type File, type InsertFile, insights, type Insight, type InsertInsight, farmProfiles, type FarmProfile, type InsertFarmProfile, weatherCache } from "@shared/schema";
import { encryptApiKey, decryptApiKey } from "./crypto";
import createMemoryStore from "memorystore";
import session from "express-session";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, desc, and } from "drizzle-orm";
import ConnectPgSimple from "connect-pg-simple";

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "";

const MemoryStore = createMemoryStore(session);
const PgSessionStore = ConnectPgSimple(session);

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
  
  // Expert operations
  createExpert(expert: InsertExpert): Promise<Expert>;
  getExpertById(expertId: number): Promise<Expert | undefined>;
  getConversationExperts(conversationId: number): Promise<Expert[]>;
  updateExpert(expertId: number, updates: Partial<Expert>): Promise<Expert>;
  
  // Message operations
  createMessage(message: InsertMessage): Promise<Message>;
  getConversationMessages(conversationId: number): Promise<Message[]>;
  
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
  private files: Map<number, File>;
  private insights: Map<number, Insight>;
  
  sessionStore: session.Store;
  private userId: number;
  private conversationId: number;
  private expertId: number;
  private messageId: number;
  private fileId: number;
  private insightId: number;

  constructor() {
    this.users = new Map();
    this.conversations = new Map();
    this.experts = new Map();
    this.messages = new Map();
    this.files = new Map();
    this.insights = new Map();
    
    this.userId = 1;
    this.conversationId = 1;
    this.expertId = 1;
    this.messageId = 1;
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
    const conversation: Conversation = {
      ...insertConversation,
      id,
      title: insertConversation.title ?? "New Conversation",
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
  async createMessage(insertMessage: InsertMessage): Promise<Message> {
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
      timestamp: now,
    };
    this.messages.set(id, message);
    return message;
  }
  
  async getConversationMessages(conversationId: number): Promise<Message[]> {
    return Array.from(this.messages.values())
      .filter(message => message.conversationId === conversationId)
      .sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0));
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
      schema: { users, conversations, experts, messages, files, insights, farmProfiles, weatherCache },
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
    const result = await this.db.insert(conversations).values(insertConversation).returning();
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
    const values = { ...insertMessage, artifacts: insertMessage.artifacts || [] };
    const result = await this.db.insert(messages).values(values).returning();
    const raw = result[0];
    // Drizzle returns artifacts as unknown — cast to Artifact[]
    return {
      ...raw,
      artifacts: (raw.artifacts || []) as Message["artifacts"],
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
    })) as Message[];
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
