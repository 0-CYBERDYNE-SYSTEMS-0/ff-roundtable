import type { Express, Request, Response } from "express";
import express from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth } from "./auth";
import { callOpenRouterAPI, callPerplexityAPI, generateSystemPrompt, getExpertResponse, generateInsights } from "./ai";
import { processMessageTurnBased, InteractionOrchestrator, getConversationState } from "./orchestrator";
import { encryptApiKey, decryptApiKey, maskApiKey } from "./crypto";
import multer from "multer";
import path from "path";
import fs from "fs";
import { randomBytes } from "crypto";
import Stripe from "stripe";
import { WebSocketServer } from "ws";
import { InsertConversation, InsertExpert, InsertMessage, Message, insertFarmProfileSchema } from "@shared/schema";
import { buildVCalendar } from "@shared/ics";
import { extractScheduleRows, parseIsoDate, nextMondayFrom, resolveRowStartDate, buildRowSummary } from "@shared/schedule-extract";
import { generateComprehensiveMarkdown } from './export-utils';
import { getWeatherForFarm, formatWeatherContext } from './weather';
import { isDuplicateUserSubmission } from './text-similarity';
import { format } from 'date-fns';
import { TIERS, getTierLimits, isPaidModel } from './tiers';

// Load dev config
let devConfig: any = null;
try {
  const devConfigPath = path.join(process.cwd(), "server", "dev-config.json");
  if (fs.existsSync(devConfigPath)) {
    devConfig = JSON.parse(fs.readFileSync(devConfigPath, "utf-8"));
  }
} catch (e) {
  console.warn("Could not load dev-config.json");
}

// Initialize file upload middleware
const upload = multer({
  dest: path.join(process.cwd(), "uploads"),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

// Stripe setup
let stripe: Stripe | null = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: "2023-10-16" as any, // Type assertion to fix type mismatch
  });
} else {
  console.warn("No STRIPE_SECRET_KEY provided. Stripe functionality will be unavailable.");
}

// Stripe's expanded invoice is typed as a string-or-object union. Keep the
// legacy expanded payment_intent response shape while narrowing that union.
function getSubscriptionClientSecret(subscription: Stripe.Subscription): string | null {
  const invoice = subscription.latest_invoice;
  if (!invoice || typeof invoice === "string") return null;

  const expandedInvoice = invoice as Stripe.Invoice & {
    payment_intent?: string | Stripe.PaymentIntent | null;
  };
  const paymentIntent = expandedInvoice.payment_intent;
  return paymentIntent && typeof paymentIntent !== "string"
    ? paymentIntent.client_secret
    : null;
}

// Development mode flag - uses NODE_ENV to determine dev vs production
const DEVELOPMENT_MODE = process.env.NODE_ENV !== "production";

// Extract the express-session id from a WS upgrade request's Cookie header.
// The transitive `cookie` dependency ships no type declarations, so the one
// cookie we need is parsed by hand. express-session signs the value as
// `s:<sessionId>.<signature>` — both wrapper parts must be stripped before
// the raw id can be looked up in the session store.
function getSessionIdFromUpgradeRequest(req: { headers: { cookie?: string } }): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== "connect.sid") continue;
    let value: string;
    try {
      value = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
    if (!value.startsWith("s:")) return null;
    const sid = value.slice(2).split(".")[0];
    return sid || null;
  }
  return null;
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Setup authentication routes
  setupAuth(app);

  // Serve uploaded conversation files. Must be registered before the SPA
  // catch-all so download links resolve to real files (auth-gated).
  app.use(
    "/uploads",
    (req, res, next) => {
      if (!req.isAuthenticated()) {
        return res.status(401).json({ message: "Authentication required" });
      }
      next();
    },
    express.static(path.join(process.cwd(), "uploads"))
  );

  // Special development login endpoint
  if (DEVELOPMENT_MODE) {
    app.post("/api/dev-login", async (req, res) => {
      // Hard gate: never allow dev endpoints in production
      if (process.env.NODE_ENV === "production") {
        return res.status(404).json({ message: "Not found" });
      }
      try {
        // Try to get the development user
        const devUser = await storage.getUserByUsername("developer");
        
        if (!devUser) {
          return res.status(404).json({ message: "Development user not found" });
        }
        
        // Log the user in directly
        req.login(devUser, (err) => {
          if (err) return res.status(500).json({ message: "Login failed", error: err.message });
          const { password, ...safeUser } = devUser;
          return res.status(200).json({ ...safeUser, password: "***" });
        });
      } catch (error: any) {
        console.error("Dev login error:", error);
        res.status(500).json({ message: "Development login failed", error: error.message });
      }
    });
    
    console.log("Development login endpoint registered at /api/dev-login");
    
    // Quick setup endpoint for testing
    if (devConfig && devConfig.enabled) {
      app.post("/api/dev/quick-setup", async (req, res) => {
        // Hard gate: never allow dev endpoints in production
        if (process.env.NODE_ENV === "production") {
          return res.status(404).json({ message: "Not found" });
        }
        try {
          const userId = req.user?.id;
          if (!userId) {
            return res.status(401).json({ message: "Not authenticated" });
          }

          // Create conversation
          const conversation = await storage.createConversation({
            userId,
            title: "Quick Test Roundtable"
          });

          // Add all experts from config — each with their assigned model
          const expertPromises = devConfig.experts.map((expert: any) =>
            storage.createExpert({
              conversationId: conversation.id,
              name: expert.name,
              role: expert.role,
              model: expert.model, // Use each expert's specific model from dev-config
              avatarUrl: expert.avatarUrl,
              systemPrompt: generateSystemPrompt({ role: expert.role } as any, undefined)
            })
          );

          await Promise.all(expertPromises);

          res.json({
            conversationId: conversation.id,
            expertCount: devConfig.experts.length
          });
        } catch (error: any) {
          console.error("Dev quick setup error:", error);
          res.status(500).json({ message: error.message });
        }
      });

      // Endpoint to update all experts in a conversation to use test model
      app.post("/api/dev/update-models/:conversationId", async (req, res) => {
        // Hard gate: never allow dev endpoints in production
        if (process.env.NODE_ENV === "production") {
          return res.status(404).json({ message: "Not found" });
        }
        try {
          const userId = req.user?.id;
          if (!userId) {
            return res.status(401).json({ message: "Not authenticated" });
          }

          const conversationId = parseInt(req.params.conversationId);
          const conversation = await storage.getConversation(conversationId);

          if (!conversation || conversation.userId !== userId) {
            return res.status(404).json({ message: "Conversation not found" });
          }

          const experts = await storage.getConversationExperts(conversationId);
          const testModel = devConfig.experts[0]?.model || "deepseek/deepseek-v4-flash:free";

          // Update all experts to use the test model
          const updatePromises = experts.map((expert) =>
            storage.updateExpert(expert.id, { model: testModel })
          );

          await Promise.all(updatePromises);

          res.json({
            message: "All experts updated to use test model",
            expertCount: experts.length,
            model: testModel
          });
        } catch (error: any) {
          console.error("Dev update models error:", error);
          res.status(500).json({ message: error.message });
        }
      });
    }
  }
  
  const httpServer = createServer(app);
  
  // Initialize WebSocket server for real-time expert responses
  const wss = new WebSocketServer({ 
    server: httpServer,
    path: "/ws" // Specify a path for WebSocket connections
  });
  
  console.log("WebSocket server initialized on path: /ws");
  
  wss.on("connection", (ws, req) => {
    console.log("WebSocket client connected");

    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });

    ws.on("close", () => {
      console.log("WebSocket client disconnected");
    });

    // G3: authenticate the upgrade against the same express-session store the
    // HTTP routes use. Without this, every connected socket receives every
    // conversation's streaming tokens.
    const rejectUnauthenticated = () => ws.close(4401, "Unauthenticated");
    const sid = getSessionIdFromUpgradeRequest(req);

    if (!sid) {
      rejectUnauthenticated();
      return;
    }

    storage.sessionStore.get(sid, (err: any, session: any) => {
      // The socket may have closed while the store lookup was in flight.
      if (ws.readyState !== 1) return;

      const userId = session?.passport?.user;
      if (err || userId == null) {
        rejectUnauthenticated();
        return;
      }

      (ws as any).userId = userId;
      (ws as any).subscriptions = new Set<number>();

      // Send an initial connection confirmation
      ws.send(JSON.stringify({
        type: "connection",
        data: { status: "connected" }
      }));

      ws.on("message", (message) => {
        try {
          let parsed: any;
          try {
            parsed = JSON.parse(message.toString());
          } catch {
            return; // Not JSON — ignore silently.
          }

          if (parsed?.type === "subscribe" && Number.isInteger(parsed.conversationId)) {
            const conversationId = parsed.conversationId;
            storage.getConversation(conversationId).then((conversation) => {
              if (conversation && conversation.userId === (ws as any).userId) {
                (ws as any).subscriptions.add(conversationId);
                ws.send(JSON.stringify({ type: "subscribed", conversationId }));
                // Replay the current orchestrator state so reconnects restore
                // the mode badge without a refetch.
                const state = getConversationState(conversationId);
                if (state) {
                  ws.send(JSON.stringify({
                    type: "state_update",
                    conversationId,
                    mode: state.mode,
                    isAutonomousEnabled: state.isAutonomousEnabled,
                    maxAutonomousTurns: state.maxAutonomousTurns
                  }));
                }
              } else {
                ws.send(JSON.stringify({ type: "subscribe_denied", conversationId }));
              }
            }).catch((error) => {
              console.error("Error handling WebSocket subscribe:", error);
            });
          } else if (parsed?.type === "unsubscribe" && Number.isInteger(parsed.conversationId)) {
            (ws as any).subscriptions.delete(parsed.conversationId);
          }
          // Everything else is ignored silently.
        } catch (error) {
          console.error("Error processing WebSocket message:", error);
        }
      });
    });
  });
  
  // Create a broadcast function. G3: send only to sockets that subscribed to
  // this conversation (ownership was verified at subscribe time).
  const broadcastToConversation = (conversationId: number, data: any) => {
    wss.clients.forEach((client) => {
      if (client.readyState === 1 && (client as any).subscriptions?.has(conversationId)) { // OPEN
        try {
          // Handle state_update messages (mode, autonomous status)
          if (data.type === "state_update") {
            client.send(JSON.stringify({
              type: "state_update",
              conversationId,
              mode: data.mode,
              isAutonomousEnabled: data.isAutonomousEnabled,
              maxAutonomousTurns: data.maxAutonomousTurns
            }));
          }
          // Handle streaming events
          else if (data.type === "expert_stream_start") {
            client.send(JSON.stringify({
              type: "expert_stream_start",
              conversationId,
              expertId: data.expertId,
              expertName: data.expertName,
              expertRole: data.expertRole,
            }));
          }
          else if (data.type === "expert_stream_token") {
            client.send(JSON.stringify({
              type: "expert_stream_token",
              conversationId,
              expertId: data.expertId,
              token: data.token,
            }));
          }
          else if (data.type === "expert_stream_done") {
            client.send(JSON.stringify({
              type: "expert_stream_done",
              conversationId,
              expertId: data.expertId,
              message: data.message,
            }));
          }
          // Handle insights updates
          else if (data.type === "insights") {
            client.send(JSON.stringify({
              type: "insights",
              conversationId
            }));
          }
          // Handle steering acknowledgments: a message arrived during an
          // active sequence; the current expert finishes, then the round
          // restarts on the new message.
          else if (data.type === "steering") {
            client.send(JSON.stringify({
              type: "steering",
              conversationId
            }));
          }
          // Handle error messages
          else if (data.type === "message_error") {
            // Prefer the persisted error message (survives refetch); fall back
            // to a synthetic frame when only error text is available.
            const persisted = data.message && typeof data.message === "object" && data.message.id
              ? data.message
              : null;
            client.send(JSON.stringify({
              type: "message_error",
              conversationId,
              expertId: data.expertId,
              expertName: data.expertName,
              message: persisted ?? {
                id: Date.now(),
                conversationId,
                content: `(Error generating response: ${data.message || 'Unknown error'})`,
                role: "assistant",
                expertId: data.expertId,
                expertName: data.expertName,
                expertRole: null,
                userId: null,
                timestamp: new Date()
              }
            }));
          }
          // Handle pipeline errors (message stays but processing must stop)
          else if (data.type === "error") {
            client.send(JSON.stringify({
              type: "error",
              conversationId,
              message: data.message || "Something went wrong."
            }));
          }
          // Handle regular messages (Message objects)
          else if (data.id && data.conversationId !== undefined && data.content) {
            client.send(JSON.stringify({
              type: "messages_updated",
              conversationId,
              message: data
            }));
          }
          // Fallback for unknown types
          else {
            console.warn("Unknown broadcast data type:", data);
          }
        } catch (error) {
          console.error("Error broadcasting message:", error);
        }
      }
    });
  };
  
  // Check Subscription Status
  app.get("/api/subscription-status", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ subscribed: false, message: "Not authenticated" });
    }
    
    const user = req.user;
    return res.json({ 
      subscribed: user.subscriptionStatus === "active",
      status: user.subscriptionStatus
    });
  });
  
  // Stripe Checkout session for Pro tier
  app.post("/api/create-checkout-session", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }
    if (!stripe) {
      return res.status(500).json({ message: "Stripe integration not configured" });
    }
    try {
      const user = req.user;
      let customerId = user.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          name: user.username,
        });
        customerId = customer.id;
        await storage.updateUserStripeInfo(user.id, {
          stripeCustomerId: customerId,
          stripeSubscriptionId: user.stripeSubscriptionId || "",
        });
      }

      const priceId = process.env.STRIPE_PRICE_ID_PRO;
      if (!priceId) {
        return res.status(500).json({ message: "Stripe Pro price ID not configured" });
      }

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${req.headers.origin || process.env.ALLOWED_ORIGIN || "http://localhost:5173"}/dashboard?checkout=success`,
        cancel_url: `${req.headers.origin || process.env.ALLOWED_ORIGIN || "http://localhost:5173"}/pricing?checkout=cancel`,
      });

      res.json({ url: session.url });
    } catch (error: any) {
      console.error("Stripe checkout error:", error);
      res.status(500).json({ message: error.message });
    }
  });

  // Cancel subscription
  app.post("/api/cancel-subscription", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }
    if (!stripe) {
      return res.status(500).json({ message: "Stripe integration not configured" });
    }
    try {
      const user = req.user;
      if (!user.stripeSubscriptionId) {
        return res.status(400).json({ message: "No active subscription" });
      }
      await stripe.subscriptions.cancel(user.stripeSubscriptionId);
      // Downgrade tier back to free
      const updated = await storage.updateSubscriptionStatus(user.id, "inactive");
      // Also need to update tier — storage method only updates subscriptionStatus, so we need a new method
      // For now, update via direct storage call if available, or use existing stripe info update
      res.json({ message: "Subscription cancelled", tier: "free" });
    } catch (error: any) {
      console.error("Stripe cancel error:", error);
      res.status(500).json({ message: error.message });
    }
  });

  // Stripe subscription endpoints (legacy — keep for backward compat)
  app.post("/api/create-subscription", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }
    
    if (!stripe) {
      return res.status(500).json({ message: "Stripe integration not configured" });
    }
    
    try {
      const user = req.user;

      // If the user already has a subscription on record, retrieve it instead
      // of creating a duplicate (payment may still be incomplete — that's ok,
      // the client uses the clientSecret to finish checkout).
      if (user.stripeSubscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
        return res.json({
          subscriptionId: subscription.id,
          clientSecret: getSubscriptionClientSecret(subscription),
        });
      }
      
      // Create or get Stripe customer
      let customerId = user.stripeCustomerId;
      
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          name: user.username,
        });
        customerId = customer.id;
      }
      
      // Create subscription
      const PRICE_ID = process.env.STRIPE_PRICE_ID;
      if (!PRICE_ID) {
        return res.status(500).json({ message: "Stripe price ID not configured" });
      }
      
      const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: PRICE_ID }],
        payment_behavior: "default_incomplete",
        payment_settings: { save_default_payment_method: "on_subscription" },
        expand: ["latest_invoice.payment_intent"],
      });
      
      // Update user with Stripe info
      await storage.updateUserStripeInfo(user.id, {
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id
      });
      
      res.json({
        subscriptionId: subscription.id,
        clientSecret: getSubscriptionClientSecret(subscription),
      });
    } catch (error: any) {
      console.error("Stripe error:", error);
      res.status(500).json({ message: error.message });
    }
  });
  
  // Stripe webhook handler
  app.post("/api/webhook", async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    
    if (!stripe || !endpointSecret || !sig) {
      return res.status(400).json({ message: "Missing Stripe configuration" });
    }
    
    let event;

    try {
      // Signature verification requires the exact raw bytes Stripe sent.
      event = stripe.webhooks.constructEvent(
        (req as any).rawBody ?? req.body,
        sig,
        endpointSecret
      );
    } catch (err: any) {
      console.error(`Webhook Error: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    // Handle subscription events
    switch (event.type) {
      case "invoice.payment_succeeded":
        try {
          const invoice = event.data.object as any; // Type assertion to avoid TS errors
          if (invoice.subscription) {
            // Look the user up by their stored subscription id — scanning ids
            // 0-99 breaks activation once the app has more than 100 users.
            const user = await storage.getUserByStripeSubscriptionId(invoice.subscription);
            if (user) {
              await storage.updateSubscriptionStatus(user.id, "active");
              console.log(`Updated user ${user.id} subscription to active`);
            }
          }
        } catch (error) {
          console.error("Error processing invoice.payment_succeeded:", error);
        }
        break;

      case "customer.subscription.deleted":
      case "customer.subscription.updated":
        try {
          const subscription = event.data.object as any; // Type assertion to avoid TS errors

          const user = await storage.getUserByStripeSubscriptionId(subscription.id);
          if (user) {
            const status = subscription.status === "active" ? "active" : "inactive";
            await storage.updateSubscriptionStatus(user.id, status);
            console.log(`Updated user ${user.id} subscription to ${status}`);
          }
        } catch (error) {
          console.error(`Error processing ${event.type}:`, error);
        }
        break;
    }
    
    res.json({ received: true });
  });
  
  // Get user tier and limits
  app.get("/api/user/tier", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }
    try {
      const user = await storage.getUser(req.user!.id);
      const tier = user?.tier || "free";
      const limits = getTierLimits(tier);
      res.json({ tier, limits });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  app.post("/api/protected/conversations", async (req, res) => {
    try {
      const userId = req.user!.id;
      const title = req.body.title || "New Conversation";
      
      const conversation: InsertConversation = {
        userId,
        title
      };
      
      const createdConversation = await storage.createConversation(conversation);
      res.status(201).json(createdConversation);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  
  app.get("/api/protected/conversations", async (req, res) => {
    try {
      const userId = req.user!.id;
      const conversations = await storage.getUserConversations(userId);
      res.json(conversations);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  
  app.get("/api/protected/conversations/:id", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);
      
      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      res.json(conversation);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  
  // Expert endpoints
  app.post("/api/protected/conversations/:id/experts", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);
      
      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      const user = await storage.getUser(req.user!.id);
      const tier = user?.tier || "free";
      const limits = getTierLimits(tier);

      // Check expert count limit
      const existingExperts = await storage.getConversationExperts(conversationId);
      if (existingExperts.length >= limits.maxExperts) {
        return res.status(403).json({
          code: "TIER_LIMIT_EXPERTS",
          limit: limits.maxExperts,
          message: `Your ${limits.name} tier allows up to ${limits.maxExperts} experts.`,
        });
      }
      
      const { name, role, model, avatarUrl } = req.body;

      // Check paid model restriction for free tier
      if (tier === "free" && isPaidModel(model)) {
        return res.status(403).json({
          code: "TIER_LIMIT_MODEL",
          message: "Upgrade to Pro for paid models",
        });
      }
      
      const expert: InsertExpert = {
        conversationId,
        name,
        role,
        model,
        systemPrompt: generateSystemPrompt({ role } as any),
        avatarUrl
      };
      
      const createdExpert = await storage.createExpert(expert);
      res.status(201).json(createdExpert);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  
  app.get("/api/protected/conversations/:id/experts", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);

      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      const experts = await storage.getConversationExperts(conversationId);
      res.json(experts);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Update expert settings
  app.patch("/api/experts/:expertId", async (req, res) => {
    try {
      if (!req.isAuthenticated()) {
        return res.status(401).json({ message: "Authentication required" });
      }
      const expertId = parseInt(req.params.expertId);
      const expert = await storage.getExpertById(expertId);

      if (!expert) {
        return res.status(404).json({ message: "Expert not found" });
      }

      // Verify user owns this conversation
      const conversation = await storage.getConversation(expert.conversationId);
      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(403).json({ message: "Not authorized to update this expert" });
      }

      const { name, model, customInstructions } = req.body;
      const updates: Partial<any> = {};

      if (name !== undefined) updates.name = name;
      if (model !== undefined) updates.model = model;
      if (customInstructions !== undefined) updates.customInstructions = customInstructions;

      // Enforce the same paid-model restriction as expert creation — without
      // this, free-tier users can upgrade any expert's model via the settings
      // modal and bypass the gate entirely.
      if (model !== undefined) {
        const user = await storage.getUser(req.user!.id);
        const tier = user?.tier || "free";
        if (tier === "free" && isPaidModel(model)) {
          return res.status(403).json({
            code: "TIER_LIMIT_MODEL",
            message: "Upgrade to Pro for paid models",
          });
        }
      }

      const updatedExpert = await storage.updateExpert(expertId, updates);
      res.json(updatedExpert);
    } catch (error: any) {
      console.error("Error updating expert:", error);
      res.status(500).json({ message: error.message });
    }
  });

  // Farm Profile endpoints
  // GET farm profile for current user
  app.get("/api/protected/farm-profile", async (req, res) => {
    try {
      const userId = req.user!.id;
      const profile = await storage.getFarmProfile(userId);
      
      let weather: string | null = null;
      if (profile && profile.lat && profile.lng) {
        const weatherResult = await getWeatherForFarm(profile.lat, profile.lng);
        if (weatherResult.ok) {
          weather = formatWeatherContext(weatherResult.data);
        }
      }
      
      res.json({ profile: profile || null, weather });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // PUT (upsert) farm profile
  app.put("/api/protected/farm-profile", async (req, res) => {
    try {
      const userId = req.user!.id;
      // Validate and whitelist — req.body must never be spread straight into
      // storage or clients could inject id/createdAt/arbitrary columns.
      const parsed = insertFarmProfileSchema.omit({ userId: true }).partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid farm profile data", errors: parsed.error.flatten() });
      }
      const profile = await storage.upsertFarmProfile(userId, parsed.data);
      res.json(profile);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Message endpoints
  app.post("/api/protected/conversations/:id/messages", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);
      
      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      const userId = req.user!.id;
      const { content } = req.body;

      // F2 duplicate-submission gate: an identical resend with nothing new
      // (last message is this same user text, no new files) must not store a
      // second copy or re-trigger the full expert fan-out. Everything else —
      // including a repeat asked after expert replies — processes normally.
      const existingMessages = await storage.getConversationMessages(conversationId);
      const lastExistingMessage = existingMessages[existingMessages.length - 1] ?? null;
      if (isDuplicateUserSubmission(content, lastExistingMessage, false)) {
        console.log(`Duplicate user submission detected in conversation ${conversationId} — skipping processing.`);
        return res.status(200).json(lastExistingMessage);
      }

      // Store user message
      const userMessage: InsertMessage = {
        conversationId,
        userId,
        expertId: null,
        content,
        role: "user"
      };
      const storedMessage: Message = await storage.createMessage(userMessage);

      // Broadcast the user message immediately via WebSocket
      broadcastToConversation(conversationId, storedMessage);

      // Start *turn-based* asynchronous processing of expert responses
      processMessageTurnBased(
        userId, 
        conversationId, 
        storedMessage,
        broadcastToConversation
      ).catch(error => {
        console.error("Error during turn-based processing initiation:", error);
        broadcastToConversation(conversationId, {
            type: "error",
            message: "Failed to start expert processing."
        });
      });
      
      // Return the stored user message immediately
      res.status(201).json(storedMessage);
    } catch (error: any) {
      console.error("Error in POST /messages:", error);
      res.status(500).json({ message: error.message || "Internal server error" });
    }
  });
  
  app.get("/api/protected/conversations/:id/messages", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);
      
      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      const messages = await storage.getConversationMessages(conversationId);
      res.json(messages);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  
  // File upload endpoint
  app.post("/api/protected/conversations/:id/files", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }
      
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);
      
      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      // Create file record
      const file = await storage.createFile({
        conversationId,
        filename: req.file.originalname,
        fileUrl: `/uploads/${req.file.filename}`,
        fileType: req.file.mimetype,
        uploadedBy: "user"
      });
      
      // Update conversation with file upload message
      const fileMessage: InsertMessage = {
        conversationId,
        userId: req.user!.id,
        expertId: null,
        content: `[Uploaded file: ${req.file.originalname}](/uploads/${req.file.filename})`,
        role: "user"
      };
      
      await storage.createMessage(fileMessage);
      
      res.status(201).json(file);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  
  // File creation endpoint
  app.post("/api/protected/conversations/:id/generate-file", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);
      
      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      const { fileType, fileName, content } = req.body;
      
      // Generate unique file name
      const uniqueId = randomBytes(8).toString("hex");
      const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const uniqueFileName = `${uniqueId}-${sanitizedFileName}`;
      
      // Create directory if it doesn't exist
      const uploadsDir = path.join(process.cwd(), "uploads");
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      
      // Write file
      const filePath = path.join(uploadsDir, uniqueFileName);
      fs.writeFileSync(filePath, content);
      
      // Create file record
      const file = await storage.createFile({
        conversationId,
        filename: sanitizedFileName,
        fileUrl: `/uploads/${uniqueFileName}`,
        fileType: fileType || "text/plain",
        uploadedBy: "ai"
      });
      
      res.status(201).json(file);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  
  // Get files for conversation
  app.get("/api/protected/conversations/:id/files", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);
      
      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      const files = await storage.getConversationFiles(conversationId);
      res.json(files);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  
  // Insights endpoints
  app.get("/api/protected/conversations/:id/insights", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);
      
      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      const insights = await storage.getConversationInsights(conversationId);
      res.json(insights);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  
  // Generate insights manually
  app.post("/api/protected/conversations/:id/generate-insights", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);
      
      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      await generateInsights(conversationId);
      
      const insights = await storage.getConversationInsights(conversationId);
      res.json(insights);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  
  // Export markdown conversation
  app.get("/api/protected/conversations/:id/export", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);

      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      // Fetch all data
      const messages = await storage.getConversationMessages(conversationId);
      const experts = await storage.getConversationExperts(conversationId);
      const insights = await storage.getConversationInsights(conversationId);
      const files = await storage.getConversationFiles(conversationId);

      // Generate comprehensive markdown
      const markdown = generateComprehensiveMarkdown({
        conversation: {
          title: conversation.title ?? "New Conversation",
          createdAt: conversation.createdAt ?? new Date(0),
        },
        messages,
        experts,
        insights,
        files
      });

      // Generate filename
      const safeTitle = (conversation.title ?? "New Conversation")
        .replace(/[^a-z0-9]/gi, '-')
        .toLowerCase()
        .substring(0, 50);
      const date = format(conversation.createdAt ?? new Date(0), 'yyyy-MM-dd');
      const filename = `roundtable-${safeTitle}-${date}.md`;

      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.send(markdown);
    } catch (error: any) {
      console.error("Export error:", error);
      res.status(500).json({ message: error.message });
    }
  });

  // Export conversation schedule as an .ics calendar (week-by-week all-day events)
  app.get("/api/protected/conversations/:id/export.ics", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);

      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      // Anchor date: ?start=YYYY-MM-DD (validated) or the next Monday, strictly
      // after today's UTC date (a Monday anchors to the following Monday).
      const startParam = typeof req.query.start === "string" ? req.query.start : "";
      let anchor: string;
      if (startParam) {
        const parsed = parseIsoDate(startParam);
        if (!parsed) {
          return res.status(422).json({ error: "Invalid start date. Use YYYY-MM-DD." });
        }
        anchor = parsed;
      } else {
        anchor = nextMondayFrom(new Date());
      }

      const messages = await storage.getConversationMessages(conversationId);
      const files = await storage.getConversationFiles(conversationId);

      const rows = extractScheduleRows(messages, files);
      if (rows.length === 0) {
        return res.status(422).json({
          error: "No schedulable items found in this conversation. Ask an expert for a week-by-week plan first.",
        });
      }

      const events = rows.map((row, index) => ({
        uid: `${conversationId}-${index}@farmfriend-roundtable`,
        summary: buildRowSummary(row),
        startDate: resolveRowStartDate(row, anchor),
        description: row.description,
      }));

      const ics = buildVCalendar(events, conversation.title ?? "New Conversation");

      const safeTitle = (conversation.title ?? "New Conversation")
        .replace(/[^a-z0-9]/gi, '-')
        .toLowerCase()
        .substring(0, 50);
      const date = format(conversation.createdAt ?? new Date(0), 'yyyy-MM-dd');
      const filename = `roundtable-${safeTitle}-${date}.ics`;

      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.send(ics);
    } catch (error: any) {
      console.error("ICS export error:", error);
      res.status(500).json({ message: error.message });
    }
  });

  // --- Helper function to get orchestrator instance (or handle missing state) ---
  const getOrchestratorForRequest = async (req: Request, res: Response): Promise<InteractionOrchestrator | null> => {
      const conversationId = parseInt(req.params.id);
      const state = getConversationState(conversationId);
      if (!state) {
          res.status(404).json({ message: "Conversation state not found or not initialized." });
          return null;
      }
      const conversation = await storage.getConversation(conversationId);
      if (!conversation || conversation.userId !== req.user!.id) {
          res.status(403).json({ message: "Forbidden" });
          return null;
      }
      return new InteractionOrchestrator(conversationId);
  };
  
  // --- Orchestrator Control Endpoints ---

  app.post("/api/protected/conversations/:id/pause", async (req, res) => {
    try {
      const orchestrator = await getOrchestratorForRequest(req, res);
      if (!orchestrator) return;
      
      orchestrator.pause();
      res.status(200).json({ message: "Pause signal sent." });

    } catch (error: any) {
      console.error("Error in POST /pause:", error);
      res.status(500).json({ message: error.message || "Internal server error" });
    }
  });

  app.post("/api/protected/conversations/:id/resume", async (req, res) => {
    try {
      const orchestrator = await getOrchestratorForRequest(req, res);
      if (!orchestrator) return;

      orchestrator.resume();
      res.status(200).json({ message: "Resume signal sent." });
      
    } catch (error: any) {
      console.error("Error in POST /resume:", error);
      res.status(500).json({ message: error.message || "Internal server error" });
    }
  });

  app.post("/api/protected/conversations/:id/autonomous/enable", async (req, res) => {
    try {
      const orchestrator = await getOrchestratorForRequest(req, res);
      if (!orchestrator) return; 

      // Optional: Get maxTurns from request body
      const { maxTurns } = req.body; // e.g., { "maxTurns": 10 }
      const maxTurnsNum = (typeof maxTurns === 'number' && maxTurns >= 0) ? maxTurns : undefined;

      orchestrator.enableAutonomous(maxTurnsNum);
      res.status(200).json({ message: "Autonomous mode enabled." });
      
    } catch (error: any) {
      console.error("Error in POST /autonomous/enable:", error);
      res.status(500).json({ message: error.message || "Internal server error" });
    }
  });

  app.post("/api/protected/conversations/:id/autonomous/disable", async (req, res) => {
    try {
      const orchestrator = await getOrchestratorForRequest(req, res);
      if (!orchestrator) return; 

      orchestrator.disableAutonomous();
      res.status(200).json({ message: "Autonomous mode disabled." });
      
    } catch (error: any) {
      console.error("Error in POST /autonomous/disable:", error);
      res.status(500).json({ message: error.message || "Internal server error" });
    }
  });

  // TEST ENDPOINT - Development only
  if (DEVELOPMENT_MODE) {
    app.post("/api/dev/test-artifacts/:conversationId", async (req, res) => {
      // Hard gate: never allow dev endpoints in production
      if (process.env.NODE_ENV === "production") {
        return res.status(404).json({ message: "Not found" });
      }
      try {
        if (!req.isAuthenticated()) {
          return res.status(401).json({ message: "Not authenticated" });
        }
        const conversationId = parseInt(req.params.conversationId);
        const conversation = await storage.getConversation(conversationId);
        if (!conversation || conversation.userId !== req.user!.id) {
          return res.status(404).json({ message: "Conversation not found" });
        }
        
        // Create a test message with various artifacts
        const testMessage = {
          id: Date.now(),
          conversationId,
          expertId: 1,
          userId: null,
          content: "Here are the test artifacts you requested:",
          role: "assistant",
          expertName: "Test Expert",
          expertRole: "Test Role",
          timestamp: new Date(),
          artifacts: [
            {
              type: "json",
              title: "Crop Rotation Plan",
              content: JSON.stringify({
                farmName: "Green Acres",
                totalAcres: 50,
                years: [
                  {
                    year: 2025,
                    fields: [
                      {
                        fieldId: "A",
                        acres: 16.7,
                        crop: "Corn",
                        soilType: "Loam",
                        nutrients: { nitrogen: "High", phosphorus: "Medium" }
                      },
                      {
                        fieldId: "B",
                        acres: 16.7,
                        crop: "Soybeans",
                        soilType: "Clay Loam",
                        nutrients: { nitrogen: "Low", phosphorus: "High" }
                      }
                    ]
                  }
                ]
              }, null, 2),
              language: "json"
            },
            {
              type: "table",
              title: "Soil Analysis Results",
              content: "| Field | pH | Nitrogen | Phosphorus | Potassium |\n|-------|-----|----------|------------|----------|\n| A | 6.5 | High | Medium | Low |\n| B | 6.8 | Low | High | Medium |\n| C | 7.0 | Medium | Medium | High |"
            }
          ]
        };
        
        // Directly add to storage
        const createdMessage = await storage.createMessage({
          conversationId,
          expertId: testMessage.expertId,
          userId: null,
          content: testMessage.content,
          role: testMessage.role,
          expertName: testMessage.expertName,
          expertRole: testMessage.expertRole
        });
        
        // Manually set artifacts (since InsertMessage schema doesn't include them)
        (createdMessage as any).artifacts = testMessage.artifacts;
        
        // Broadcast via WebSocket
        broadcastToConversation(conversationId, createdMessage);
        
        res.status(201).json(createdMessage);
      } catch (error: any) {
        console.error("Error creating test artifacts:", error);
        res.status(500).json({ message: error.message });
      }
    });
  }

  // Farm Profile endpoints
  // Weather endpoint
  app.get("/api/protected/weather", async (req, res) => {
    try {
      const userId = req.user!.id;
      const profile = await storage.getFarmProfile(userId);

      if (!profile || !profile.lat || !profile.lng) {
        return res.json({ available: false, message: "Farm location not set. Add your farm profile to get weather data." });
      }

      const { getWeather, formatWeatherForPrompt } = await import("./weather");
      const weather = await getWeather(profile.lat, profile.lng);

      if (!weather.ok) {
        return res.json({ available: false, reason: weather.reason, message: weather.message });
      }

      res.json({
        available: true,
        summary: formatWeatherForPrompt(weather.data),
        data: weather.data,
      });
    } catch (error: any) {
      console.error("Weather fetch error:", error);
      res.status(500).json({ message: error.message });
    }
  });

  // ── BYOK API Key endpoints ───────────────────────────────────────────────────

  // POST /api/user/api-key — save user's OpenRouter key
  app.post("/api/user/api-key", async (req, res) => {
    try {
      if (!req.isAuthenticated()) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { apiKey } = req.body;
      if (!apiKey || typeof apiKey !== "string") {
        return res.status(400).json({ message: "apiKey is required" });
      }

      // Validate key format (OpenRouter keys start with "sk-or-" or "sk-")
      if (!apiKey.startsWith("sk-or-") && !apiKey.startsWith("sk-")) {
        return res.status(400).json({ message: "Invalid API key format. Key must start with 'sk-or-' or 'sk-'" });
      }

      await storage.setUserApiKey(req.user!.id, apiKey);

      res.json({
        masked: maskApiKey(apiKey),
        message: "API key saved successfully",
      });
    } catch (error: any) {
      console.error("Error saving API key:", error.message);
      res.status(500).json({ message: error.message });
    }
  });

  // GET /api/user/api-key/status — return masked key status
  app.get("/api/user/api-key/status", async (req, res) => {
    try {
      if (!req.isAuthenticated()) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const user = await storage.getUser(req.user!.id);
      const hasKey = !!user?.openRouterKey;
      let masked: string | null = null;

      if (hasKey && user?.openRouterKey) {
        try {
          const decrypted = await storage.getUserApiKey(req.user!.id);
          if (decrypted) {
            masked = maskApiKey(decrypted);
          }
        } catch {
          masked = "***";
        }
      }

      res.json({ hasKey, masked });
    } catch (error: any) {
      console.error("Error checking API key status:", error.message);
      res.status(500).json({ message: error.message });
    }
  });

  // DELETE /api/user/api-key — remove stored key
  app.delete("/api/user/api-key", async (req, res) => {
    try {
      if (!req.isAuthenticated()) {
        return res.status(401).json({ message: "Authentication required" });
      }

      await storage.removeUserApiKey(req.user!.id);
      res.json({ message: "API key removed successfully" });
    } catch (error: any) {
      console.error("Error removing API key:", error.message);
      res.status(500).json({ message: error.message });
    }
  });

  // POST /api/validate-openrouter-key — validate a key without storing
  app.post("/api/validate-openrouter-key", async (req, res) => {
    try {
      if (!req.isAuthenticated()) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { apiKey } = req.body;
      if (!apiKey || typeof apiKey !== "string") {
        return res.status(400).json({ message: "apiKey is required" });
      }

      // Validate key format
      if (!apiKey.startsWith("sk-or-") && !apiKey.startsWith("sk-")) {
        return res.status(400).json({ valid: false, error: "Invalid API key format. Key must start with 'sk-or-' or 'sk-'" });
      }

      // Make a minimal OpenRouter API call to validate
      const response = await fetch("https://openrouter.ai/api/v1/auth/key", {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "HTTP-Referer": "https://farm-friend-roundtable.replit.app",
          "X-Title": "Farm Friend Roundtable",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (response.ok) {
        res.json({ valid: true });
      } else {
        const errorText = await response.text();
        console.log(`[BYOK] Key validation failed: ${response.status} ${errorText}`);
        res.json({ valid: false, error: `OpenRouter rejected the key (${response.status})` });
      }
    } catch (error: any) {
      console.error("Error validating API key:", error.message);
      res.status(500).json({ valid: false, error: error.message });
    }
  });

  return httpServer;
}
