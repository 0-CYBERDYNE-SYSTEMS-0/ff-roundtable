import { users, type User, type InsertUser, conversations, type Conversation, type InsertConversation, experts, type Expert, type InsertExpert, messages, type Message, type InsertMessage, files, type File, type InsertFile, insights, type Insight, type InsertInsight } from "@shared/schema";
import * as expressSession from "express-session";
import createMemoryStore from "memorystore";
import connectPgSimple from "connect-pg-simple";
import { eq, desc } from "drizzle-orm";
import { pool, db } from "./db";

// Create session stores
const MemoryStore = createMemoryStore(expressSession.default || expressSession);
const PostgresSessionStore = connectPgSimple(expressSession.default || expressSession);

// Storage interface
export interface IStorage {
  // User operations
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUserStripeInfo(userId: number, stripeInfo: { stripeCustomerId: string, stripeSubscriptionId: string }): Promise<User>;
  updateSubscriptionStatus(userId: number, status: string): Promise<User>;
  
  // Conversation operations
  createConversation(conversation: InsertConversation): Promise<Conversation>;
  getConversation(id: number): Promise<Conversation | undefined>;
  getUserConversations(userId: number): Promise<Conversation[]>;
  
  // Expert operations
  createExpert(expert: InsertExpert): Promise<Expert>;
  getConversationExperts(conversationId: number): Promise<Expert[]>;
  
  // Message operations
  createMessage(message: InsertMessage): Promise<Message>;
  getConversationMessages(conversationId: number): Promise<Message[]>;
  
  // File operations
  createFile(file: InsertFile): Promise<File>;
  getConversationFiles(conversationId: number): Promise<File[]>;
  
  // Insight operations
  createInsight(insight: InsertInsight): Promise<Insight>;
  getConversationInsights(conversationId: number): Promise<Insight[]>;
  
  // Session store
  sessionStore: expressSession.Store;
}

// In-memory storage implementation
export class MemStorage implements IStorage {
  private users: Map<number, User>;
  private conversations: Map<number, Conversation>;
  private experts: Map<number, Expert>;
  private messages: Map<number, Message>;
  private files: Map<number, File>;
  private insights: Map<number, Insight>;
  
  sessionStore: expressSession.Store;
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
    
    console.log("Using in-memory storage");
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

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = this.userId++;
    const now = new Date();
    const user: User = { 
      ...insertUser, 
      id, 
      stripeCustomerId: null, 
      stripeSubscriptionId: null,
      subscriptionStatus: "inactive",
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
      stripeSubscriptionId: stripeInfo.stripeSubscriptionId,
      subscriptionStatus: "active"
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

  // Conversation operations
  async createConversation(insertConversation: InsertConversation): Promise<Conversation> {
    const id = this.conversationId++;
    const now = new Date();
    const conversation: Conversation = { 
      ...insertConversation, 
      id, 
      createdAt: now,
      title: insertConversation.title || "New Conversation" 
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
      .sort((a, b) => {
        const timeA = a.createdAt?.getTime() || 0;
        const timeB = b.createdAt?.getTime() || 0;
        return timeB - timeA;
      });
  }
  
  // Expert operations
  async createExpert(insertExpert: InsertExpert): Promise<Expert> {
    const id = this.expertId++;
    const expert: Expert = { 
      ...insertExpert, 
      id,
      avatarUrl: insertExpert.avatarUrl || null
    };
    this.experts.set(id, expert);
    return expert;
  }
  
  async getConversationExperts(conversationId: number): Promise<Expert[]> {
    return Array.from(this.experts.values())
      .filter(expert => expert.conversationId === conversationId);
  }
  
  // Message operations
  async createMessage(insertMessage: InsertMessage): Promise<Message> {
    const id = this.messageId++;
    const now = new Date();
    const message: Message = { 
      ...insertMessage, 
      id, 
      timestamp: now,
      userId: insertMessage.userId || null,
      expertId: insertMessage.expertId || null
    };
    this.messages.set(id, message);
    return message;
  }
  
  async getConversationMessages(conversationId: number): Promise<Message[]> {
    return Array.from(this.messages.values())
      .filter(message => message.conversationId === conversationId)
      .sort((a, b) => {
        const timeA = a.timestamp?.getTime() || 0;
        const timeB = b.timestamp?.getTime() || 0;
        return timeA - timeB;
      });
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
      .sort((a, b) => {
        const timeA = a.uploadedAt?.getTime() || 0;
        const timeB = b.uploadedAt?.getTime() || 0;
        return timeB - timeA;
      });
  }
  
  // Insight operations
  async createInsight(insertInsight: InsertInsight): Promise<Insight> {
    const id = this.insightId++;
    const now = new Date();
    const insight: Insight = { 
      ...insertInsight, 
      id, 
      createdAt: now,
      points: insertInsight.points || null
    };
    this.insights.set(id, insight);
    return insight;
  }
  
  async getConversationInsights(conversationId: number): Promise<Insight[]> {
    return Array.from(this.insights.values())
      .filter(insight => insight.conversationId === conversationId)
      .sort((a, b) => {
        const timeA = a.createdAt?.getTime() || 0;
        const timeB = b.createdAt?.getTime() || 0;
        return timeB - timeA;
      });
  }
}

// Database storage implementation
export class DatabaseStorage implements IStorage {
  private db: typeof db;
  private pool: typeof pool;
  sessionStore: expressSession.Store;

  constructor() {
    // Use the imported db and pool
    this.db = db;
    this.pool = pool;
    
    // Initialize session store with pool
    this.sessionStore = new PostgresSessionStore({
      pool: this.pool,
      createTableIfMissing: true
    });
    
    console.log("Database connection initialized");
  }

  // User operations
  async getUser(id: number): Promise<User | undefined> {
    const results = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return results[0];
  }
  
  async getUserByUsername(username: string): Promise<User | undefined> {
    const results = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    return results[0];
  }

  async createUser(user: InsertUser): Promise<User> {
    const results = await this.db.insert(users).values(user).returning();
    return results[0];
  }

  async updateUserStripeInfo(userId: number, stripeInfo: { stripeCustomerId: string, stripeSubscriptionId: string }): Promise<User> {
    const results = await this.db
      .update(users)
      .set({
        stripeCustomerId: stripeInfo.stripeCustomerId,
        stripeSubscriptionId: stripeInfo.stripeSubscriptionId,
        subscriptionStatus: "active"
      })
      .where(eq(users.id, userId))
      .returning();
    return results[0];
  }

  async updateSubscriptionStatus(userId: number, status: string): Promise<User> {
    const results = await this.db
      .update(users)
      .set({
        subscriptionStatus: status
      })
      .where(eq(users.id, userId))
      .returning();
    return results[0];
  }

  // Conversation operations
  async createConversation(conversation: InsertConversation): Promise<Conversation> {
    const results = await this.db.insert(conversations).values(conversation).returning();
    return results[0];
  }

  async getConversation(id: number): Promise<Conversation | undefined> {
    const results = await this.db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    return results[0];
  }

  async getUserConversations(userId: number): Promise<Conversation[]> {
    return await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, userId))
      .orderBy(desc(conversations.createdAt));
  }

  // Expert operations
  async createExpert(expert: InsertExpert): Promise<Expert> {
    const results = await this.db.insert(experts).values({
      ...expert,
      avatarUrl: expert.avatarUrl || null
    }).returning();
    return results[0];
  }

  async getConversationExperts(conversationId: number): Promise<Expert[]> {
    return await this.db
      .select()
      .from(experts)
      .where(eq(experts.conversationId, conversationId));
  }

  // Message operations
  async createMessage(message: InsertMessage): Promise<Message> {
    const results = await this.db.insert(messages).values({
      ...message,
      userId: message.userId || null,
      expertId: message.expertId || null
    }).returning();
    return results[0];
  }

  async getConversationMessages(conversationId: number): Promise<Message[]> {
    return await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.timestamp);
  }

  // File operations
  async createFile(file: InsertFile): Promise<File> {
    const results = await this.db.insert(files).values(file).returning();
    return results[0];
  }

  async getConversationFiles(conversationId: number): Promise<File[]> {
    return await this.db
      .select()
      .from(files)
      .where(eq(files.conversationId, conversationId))
      .orderBy(desc(files.uploadedAt));
  }

  // Insight operations
  async createInsight(insight: InsertInsight): Promise<Insight> {
    const results = await this.db.insert(insights).values({
      ...insight,
      points: insight.points || null
    }).returning();
    return results[0];
  }

  async getConversationInsights(conversationId: number): Promise<Insight[]> {
    return await this.db
      .select()
      .from(insights)
      .where(eq(insights.conversationId, conversationId))
      .orderBy(desc(insights.createdAt));
  }
}

// Initialize storage with database, fallback to memory storage if database connection fails
let storage: IStorage;

try {
  if (process.env.DATABASE_URL) {
    storage = new DatabaseStorage();
    console.log("Using PostgreSQL database storage");
  } else {
    throw new Error("DATABASE_URL not provided");
  }
} catch (error) {
  console.error("Failed to initialize database storage, falling back to memory storage:", error);
  storage = new MemStorage();
}

export { storage };