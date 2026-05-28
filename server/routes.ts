import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth } from "./auth";
import { callOpenRouterAPI, callPerplexityAPI, generateSystemPrompt, getExpertResponse, generateInsights } from "./ai";
import { processMessageTurnBased, InteractionOrchestrator, getConversationState } from "./orchestrator";
import multer from "multer";
import path from "path";
import fs from "fs";
import { randomBytes } from "crypto";
import Stripe from "stripe";
import { WebSocketServer } from "ws";
import { InsertConversation, InsertExpert, InsertMessage, Message } from "@shared/schema";
import { generateComprehensiveMarkdown } from './export-utils';
import { getWeatherForFarm, formatWeatherContext } from './weather';
import { format } from 'date-fns';

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

// Development mode flag - set to true for easier authentication
const DEVELOPMENT_MODE = true;

export async function registerRoutes(app: Express): Promise<Server> {
  // Setup authentication routes
  setupAuth(app);
  
  // Special development login endpoint
  if (DEVELOPMENT_MODE) {
    app.post("/api/dev-login", async (req, res) => {
      try {
        // Try to get the development user
        const devUser = await storage.getUserByUsername("developer");
        
        if (!devUser) {
          return res.status(404).json({ message: "Development user not found" });
        }
        
        // Log the user in directly
        req.login(devUser, (err) => {
          if (err) return res.status(500).json({ message: "Login failed", error: err.message });
          return res.status(200).json(devUser);
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
              systemPrompt: generateSystemPrompt({ role: expert.role } as Expert, undefined)
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
  
  wss.on("connection", (ws) => {
    console.log("WebSocket client connected");
    
    // Send an initial connection confirmation
    ws.send(JSON.stringify({
      type: "connection", 
      data: { status: "connected" }
    }));
    
    ws.on("message", (message) => {
      try {
        console.log("Received WebSocket message:", message.toString());
      } catch (error) {
        console.error("Error processing WebSocket message:", error);
      }
    });
    
    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });
    
    ws.on("close", () => {
      console.log("WebSocket client disconnected");
    });
  });
  
  // Create a broadcast function
  const broadcastToConversation = (conversationId: number, data: any) => {
    wss.clients.forEach((client) => {
      if (client.readyState === 1) { // OPEN
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
          // Handle error messages
          else if (data.type === "message_error") {
            client.send(JSON.stringify({
              type: "message_error",
              conversationId,
              message: {
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
  
  // Stripe subscription endpoints
  app.post("/api/create-subscription", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }
    
    if (!stripe) {
      return res.status(500).json({ message: "Stripe integration not configured" });
    }
    
    try {
      const user = req.user;
      
      // If user already has active subscription
      if (user.stripeSubscriptionId && user.subscriptionStatus === "active") {
        const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
        return res.json({
          subscriptionId: subscription.id,
          clientSecret: subscription.latest_invoice?.payment_intent?.client_secret || null,
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
        clientSecret: subscription.latest_invoice?.payment_intent?.client_secret || null,
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
      event = stripe.webhooks.constructEvent(
        req.body,
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
            // Get all users and find the one with matching subscription ID
            const allUsers = await Promise.all(
              [...Array(100)].map((_, i) => storage.getUser(i)).filter(Boolean)
            );
            
            const user = allUsers.find(u => u && u.stripeSubscriptionId === invoice.subscription);
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
          
          // Get all users and find the one with matching subscription ID
          const allUsers = await Promise.all(
            [...Array(100)].map((_, i) => storage.getUser(i)).filter(Boolean)
          );
          
          const user = allUsers.find(u => u && u.stripeSubscriptionId === subscription.id);
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
  
  // Conversation endpoints
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
      
      const { name, role, model, avatarUrl } = req.body;
      
      const expert: InsertExpert = {
        conversationId,
        name,
        role,
        model,
        systemPrompt: generateSystemPrompt(role),
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
      const updates: Partial<Expert> = {};

      if (name !== undefined) updates.name = name;
      if (model !== undefined) updates.model = model;
      if (customInstructions !== undefined) updates.customInstructions = customInstructions;

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
        const weatherData = await getWeatherForFarm(profile.lat, profile.lng);
        if (weatherData) {
          weather = formatWeatherContext(weatherData);
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
      const profile = await storage.upsertFarmProfile(userId, req.body);
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
        conversation,
        messages,
        experts,
        insights,
        files
      });

      // Generate filename
      const safeTitle = conversation.title
        .replace(/[^a-z0-9]/gi, '-')
        .toLowerCase()
        .substring(0, 50);
      const date = format(conversation.createdAt, 'yyyy-MM-dd');
      const filename = `roundtable-${safeTitle}-${date}.md`;

      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.send(markdown);
    } catch (error: any) {
      console.error("Export error:", error);
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
      try {
        const conversationId = parseInt(req.params.conversationId);
        
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
  app.get("/api/protected/farm-profile", async (req, res) => {
    try {
      const userId = req.user!.id;
      const profile = await storage.getFarmProfile(userId);
      
      // Try to get weather if profile has coords
      let weatherSummary: string | null = null;
      if (profile?.lat && profile?.lng) {
        try {
          const { getWeather } = await import("./weather");
          const weather = await getWeather(profile.lat, profile.lng);
          if (weather) {
            const { formatWeatherForPrompt } = await import("./weather");
            weatherSummary = formatWeatherForPrompt(weather);
          }
        } catch {}
      }
      
      res.json({ profile: profile || null, weather: weatherSummary });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.put("/api/protected/farm-profile", async (req, res) => {
    try {
      const userId = req.user!.id;
      const profile = await storage.upsertFarmProfile(userId, req.body);
      res.json(profile);
    } catch (error: any) {
      console.error("Error saving farm profile:", error);
      res.status(500).json({ message: error.message });
    }
  });

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

      if (!weather) {
        return res.json({ available: false, message: "Weather data unavailable. Check OWM_API_KEY or try again later." });
      }

      res.json({
        available: true,
        summary: formatWeatherForPrompt(weather),
        data: weather,
      });
    } catch (error: any) {
      console.error("Weather fetch error:", error);
      res.status(500).json({ message: error.message });
    }
  });

  return httpServer;
}
