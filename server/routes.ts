import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth } from "./auth";
import { callOpenRouterAPI, processUserMessage, generateInsights, callPerplexityAPI, generateSystemPrompt } from "./ai";
import multer from "multer";
import path from "path";
import fs from "fs";
import { randomBytes } from "crypto";
import Stripe from "stripe";
import { WebSocketServer } from "ws";
import { InsertConversation, InsertExpert, InsertMessage } from "@shared/schema";

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
    apiVersion: "2023-10-16",
  });
} else {
  console.warn("No STRIPE_SECRET_KEY provided. Stripe functionality will be unavailable.");
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Setup authentication routes
  setupAuth(app);
  
  const httpServer = createServer(app);
  
  // Initialize WebSocket server for real-time expert responses
  const wss = new WebSocketServer({ server: httpServer });
  
  wss.on("connection", (ws) => {
    ws.on("message", (message) => {
      console.log("Received WebSocket message:", message.toString());
    });
    
    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });
  });
  
  // Create a broadcast function
  const broadcastToConversation = (conversationId: number, data: any) => {
    wss.clients.forEach((client) => {
      if (client.readyState === 1) { // OPEN
        client.send(JSON.stringify({
          type: "message",
          conversationId,
          data
        }));
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
        const invoice = event.data.object;
        if (invoice.subscription) {
          // Find user by subscription ID and update status
          const users = Array.from(storage.users);
          const user = users.find(u => u.stripeSubscriptionId === invoice.subscription);
          if (user) {
            await storage.updateSubscriptionStatus(user.id, "active");
          }
        }
        break;
        
      case "customer.subscription.deleted":
      case "customer.subscription.updated":
        const subscription = event.data.object;
        // Find user by subscription ID and update status
        const users = Array.from(storage.users);
        const user = users.find(u => u.stripeSubscriptionId === subscription.id);
        if (user) {
          const status = subscription.status === "active" ? "active" : "inactive";
          await storage.updateSubscriptionStatus(user.id, status);
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
      
      // Store user message and process it asynchronously
      const userMessage: InsertMessage = {
        conversationId,
        userId,
        expertId: null,
        content,
        role: "user"
      };
      
      const storedMessage = await storage.createMessage(userMessage);
      
      // Start asynchronous processing of expert responses
      processUserMessage(userId, conversationId, content)
        .then(async (expertResponses) => {
          // Store each expert response
          for (const response of expertResponses) {
            const storedResponse = await storage.createMessage(response);
            broadcastToConversation(conversationId, storedResponse);
          }
          
          // Generate insights after processing expert responses
          generateInsights(conversationId)
            .then(() => {
              // Broadcast updated insights
              storage.getConversationInsights(conversationId)
                .then(insights => {
                  broadcastToConversation(conversationId, { 
                    type: "insights", 
                    insights 
                  });
                });
            });
        })
        .catch(error => {
          console.error("Error processing message:", error);
        });
      
      // Return the user message immediately
      res.status(201).json(storedMessage);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
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
      
      const messages = await storage.getConversationMessages(conversationId);
      const experts = await storage.getConversationExperts(conversationId);
      
      // Build markdown content
      let markdown = `# Farm Friend Roundtable: ${conversation.title}\n\n`;
      markdown += `Date: ${conversation.createdAt.toISOString().split("T")[0]}\n\n`;
      
      markdown += "## Experts\n\n";
      for (const expert of experts) {
        markdown += `- **${expert.name}** (${expert.role})\n`;
      }
      
      markdown += "\n## Conversation\n\n";
      
      for (const message of messages) {
        if (message.userId) {
          markdown += `### You:\n\n${message.content}\n\n`;
        } else if (message.expertId) {
          const expert = experts.find(e => e.id === message.expertId);
          if (expert) {
            markdown += `### ${expert.name} (${expert.role}):\n\n${message.content}\n\n`;
          }
        }
      }
      
      res.setHeader("Content-Disposition", `attachment; filename="conversation-${conversationId}.md"`);
      res.setHeader("Content-Type", "text/markdown");
      res.send(markdown);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  return httpServer;
}
