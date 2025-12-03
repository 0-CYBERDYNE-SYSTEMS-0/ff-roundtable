import { users, type User, type InsertUser, conversations, type Conversation, type InsertConversation, experts, type Expert, type InsertExpert, messages, type Message, type InsertMessage, files, type File, type InsertFile, insights, type Insight, type InsertInsight } from "@shared/schema";
import createMemoryStore from "memorystore";
import session from "express-session";

const MemoryStore = createMemoryStore(session);

// modify the interface with any CRUD methods
// you might need
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
  
  // Session store
  sessionStore: session.SessionStore;
}

export class MemStorage implements IStorage {
  private users: Map<number, User>;
  private conversations: Map<number, Conversation>;
  private experts: Map<number, Expert>;
  private messages: Map<number, Message>;
  private files: Map<number, File>;
  private insights: Map<number, Insight>;
  
  sessionStore: session.SessionStore;
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
      password: 'dev:password', // Simple dev format: "password"
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: 'active', // Auto-subscribed for development
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
    const conversation: Conversation = { ...insertConversation, id, createdAt: now };
    this.conversations.set(id, conversation);
    return conversation;
  }
  
  async getConversation(id: number): Promise<Conversation | undefined> {
    return this.conversations.get(id);
  }
  
  async getUserConversations(userId: number): Promise<Conversation[]> {
    return Array.from(this.conversations.values())
      .filter(conversation => conversation.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  
  // Expert operations
  async createExpert(insertExpert: InsertExpert): Promise<Expert> {
    const id = this.expertId++;
    const expert: Expert = { ...insertExpert, id };
    this.experts.set(id, expert);
    return expert;
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
  async createMessage(insertMessage: InsertMessage & { artifacts?: any[] }): Promise<Message> {
    const id = this.messageId++;
    const now = new Date();
    const message: Message = { ...insertMessage, id, timestamp: now, artifacts: insertMessage.artifacts || [] };
    this.messages.set(id, message);
    return message;
  }
  
  async getConversationMessages(conversationId: number): Promise<Message[]> {
    return Array.from(this.messages.values())
      .filter(message => message.conversationId === conversationId)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
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
      .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
  }
  
  // Insight operations
  async createInsight(insertInsight: InsertInsight): Promise<Insight> {
    const id = this.insightId++;
    const now = new Date();
    const insight: Insight = { ...insertInsight, id, createdAt: now };
    this.insights.set(id, insight);
    return insight;
  }
  
  async getConversationInsights(conversationId: number): Promise<Insight[]> {
    return Array.from(this.insights.values())
      .filter(insight => insight.conversationId === conversationId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
}

export const storage = new MemStorage();
