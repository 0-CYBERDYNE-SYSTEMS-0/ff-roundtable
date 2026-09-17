import { pgTable, text, serial, integer, boolean, timestamp, json, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  email: text("email").notNull(),
  tier: text("tier").default("free"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  subscriptionStatus: text("subscription_status").default("inactive"),
  openRouterKey: text("open_router_key"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  title: text("title").default("New Conversation"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const experts = pgTable("experts", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id),
  name: text("name").notNull(),
  role: text("role").notNull(),
  model: text("model").notNull(),
  systemPrompt: text("system_prompt").notNull(),
  customInstructions: text("custom_instructions"),
  avatarUrl: text("avatar_url"),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id),
  expertId: integer("expert_id").references(() => experts.id),
  userId: integer("user_id").references(() => users.id),
  content: text("content").notNull(),
  role: text("role").notNull(),
  expertName: text("expert_name"),
  expertRole: text("expert_role"),
  artifacts: json("artifacts").default([]),
  // G4: roles @-tagged in this message, parsed once on creation (user
  // messages in routes.ts, expert messages in ai.ts) and routed on by the
  // orchestrator. Nullable: legacy rows have no value.
  mentions: jsonb("mentions").$type<string[]>(),
  // G5: true for the Moderator's closing synthesis message that ends a
  // roundtable ('Conclude'). Nullable: legacy rows have no value.
  isSynthesis: boolean("is_synthesis"),
  timestamp: timestamp("timestamp").defaultNow(),
});

export const files = pgTable("files", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id),
  filename: text("filename").notNull(),
  fileUrl: text("file_url").notNull(),
  fileType: text("file_type").notNull(),
  uploadedBy: text("uploaded_by").notNull(),
  uploadedAt: timestamp("uploaded_at").defaultNow(),
});

export const insights = pgTable("insights", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id),
  title: text("title").notNull(),
  points: text("points").notNull().array(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Farm profile — user's actual agricultural operation
export const farmProfiles = pgTable("farm_profiles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique().references(() => users.id),
  farmName: text("farm_name").notNull().default("My Farm"),
  location: text("location").notNull().default(""),
  lat: text("lat"),
  lng: text("lng"),
  acres: integer("acres").default(0),
  crops: text("crops").array().default([]),
  soilType: text("soil_type").default(""),
  waterSource: text("water_source").default(""),
  climateZone: text("climate_zone").default(""),
  hardinessZone: text("hardiness_zone").default(""),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Weather cache — cached OpenWeatherMap responses (30-min TTL)
export const weatherCache = pgTable("weather_cache", {
  id: serial("id").primaryKey(),
  lat: text("lat").notNull(),
  lng: text("lng").notNull(),
  data: json("data").notNull(),
  fetchedAt: timestamp("fetched_at").defaultNow(),
});

// Artifact type definition
export const artifactSchema = z.object({
  type: z.enum(["html", "json", "table", "chart", "code"]),
  title: z.string(),
  content: z.string(),
  language: z.string().optional(),
});

export type Artifact = z.infer<typeof artifactSchema>;

// Schemas
export const insertUserSchema = createInsertSchema(users, {
  tier: z.enum(["free", "pro", "enterprise"]).optional(),
}).omit({
  id: true,
  stripeCustomerId: true,
  stripeSubscriptionId: true,
  subscriptionStatus: true,
  openRouterKey: true,
  createdAt: true,
});

export const insertConversationSchema = createInsertSchema(conversations).omit({
  id: true,
  createdAt: true,
});

export const insertExpertSchema = createInsertSchema(experts).omit({
  id: true,
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  timestamp: true,
});

export const insertFileSchema = createInsertSchema(files).omit({
  id: true,
  uploadedAt: true,
});

export const insertInsightSchema = createInsertSchema(insights).omit({
  id: true,
  createdAt: true,
});

export const insertFarmProfileSchema = createInsertSchema(farmProfiles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Types
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type Conversation = typeof conversations.$inferSelect;

export type InsertExpert = z.infer<typeof insertExpertSchema>;
export type Expert = typeof experts.$inferSelect;

// drizzle-zod's inferred jsonb shape does not line up with the column's
// $type<string[]> on the insert path — pin mentions to the canonical type.
export type InsertMessage = Omit<z.infer<typeof insertMessageSchema>, 'mentions' | 'isSynthesis'> & {
  mentions?: string[] | null;
  // G5: pinned like mentions so object literals can omit the nullable flag.
  isSynthesis?: boolean | null;
};
// Extend Message type to properly type artifacts as Artifact[]
// (and keep the nullable G4/G5 columns optional for object literals)
export type Message = Omit<typeof messages.$inferSelect, 'artifacts' | 'mentions' | 'isSynthesis'> & {
  artifacts?: Artifact[];
  mentions?: string[] | null;
  isSynthesis?: boolean | null;
};

export type InsertFile = z.infer<typeof insertFileSchema>;
export type File = typeof files.$inferSelect;

export type InsertInsight = z.infer<typeof insertInsightSchema>;
export type Insight = typeof insights.$inferSelect;

export type InsertFarmProfile = z.infer<typeof insertFarmProfileSchema>;
export type FarmProfile = typeof farmProfiles.$inferSelect;
