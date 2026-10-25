import { catalogAvatar } from "@shared/expert-catalog";
import { billingErrorResponse, billingUnavailable } from "./billing-errors";
import type { Express, Request, Response } from "express";
import express from "express";
import { createServer, type Server } from "http";
import { storage, DeliverableConflictError } from "./storage";
import { setupAuth } from "./auth";
import { callOpenRouterAPI, callPerplexityAPI, generateSystemPrompt, getExpertResponse, generateInsights } from "./ai";
import { processMessageTurnBased, InteractionOrchestrator, getConversationState, getFarmerFileIntent, persistAutonomySettings, restorePausedFromSnapshot, isConversationBusy, discardConversationState } from "./orchestrator";
import { encryptApiKey, decryptApiKey, maskApiKey } from "./crypto";
import multer from "multer";
import path from "path";
import fs from "fs";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import Stripe from "stripe";
import { WebSocketServer, type RawData } from "ws";
import { InsertConversation, InsertExpert, InsertMessage, Message, type File, insertFarmProfileSchema } from "@shared/schema";
import { z } from "zod";
import { extractMentions } from "@shared/mentions";
import { buildVCalendar } from "@shared/ics";
import { calendarEventsSchema, type CalendarDraft } from "@shared/calendar-draft";
import { inspectCalendar } from "./calendar-files";
import { extractScheduleRows, parseIsoDate, nextMondayFrom, resolveRowStartDate, buildRowSummary, resolveScheduleAnchor, findConversationAnchor, planFileTexts, calendarDisplayName, finalizeCalendarEvents, findFrostAnchor } from "@shared/schedule-extract";
import { generateComprehensiveMarkdown } from './export-utils';
import { getWeatherForFarm, formatWeatherContext } from './weather';
import { isDuplicateUserSubmission } from './text-similarity';
import { format } from 'date-fns';
import { TIERS, getTierLimits, isPaidModel } from './tiers';
import { getModelCatalog } from "./model-catalog";
import { checkMessageAllowance, currentUsagePeriod, isHouseKeyAllowedModel, HOUSE_KEY_PAID_MODEL_ALLOWLIST, UsageCapError, monthlyAiBudgetUsd, BUDGET_EXHAUSTED_NOTICE, BUDGET_FALLBACK_MODEL, FREE_MAX_TURNS, FREE_MAX_MESSAGE_CHARS, FREE_MESSAGES_PER_MINUTE, FREE_MESSAGES_PER_DAY } from './usage-caps';
import { FREE_EXPERT_MODELS, isFreeExpertModel } from "@shared/free-plan";
import { assertFreeCapacity } from "./free-capacity";
import { randomUUID } from "crypto";

class OpenQuestionAnswerConflictError extends Error {}
const rememberedAnswerTurnStarts = new Map<number, number>();
const ANSWER_TURN_RETRY_DEDUPE_MS = 60_000;

function authorizedFileDownloadUrl(file: Pick<File, "conversationId" | "id">): string {
  return `/api/protected/conversations/${file.conversationId}/files/${file.id}/download`;
}

function clientFileRecord(file: File) {
  return { ...file, fileUrl: authorizedFileDownloadUrl(file) };
}

function getStoredUploadPath(file: File): string | undefined {
  if (!file.fileUrl.startsWith("/uploads/")) return undefined;
  const filename = file.fileUrl.slice("/uploads/".length);
  if (!filename || path.basename(filename) !== filename) return undefined;
  return path.join(process.cwd(), "uploads", filename);
}

function isRetrievalOnlyRequest(content: string): boolean {
  const intent = getFarmerFileIntent(content);
  return intent === "retrieve" || (intent === "no_file" && /\b(?:link|download)\b/i.test(content));
}

function buildStoredDeliverableReply(content: string, files: File[]): string {
  if (files.length === 0) {
    return "I couldn't find a saved deliverable in this conversation yet. You can open the Files pane to check, or ask the council to create one.";
  }

  const lowerContent = content.toLowerCase();
  const requestedKind = ["sop", "calendar", "spreadsheet", "csv", "chart", "plan", "budget", "script"]
    .find(kind => lowerContent.includes(kind));
  const matchingKind = requestedKind
    ? files.filter(file => file.filename.toLowerCase().includes(requestedKind))
    : files;
  const currentKindMatches = matchingKind.filter(file => file.deliverableId);
  const kindMatches = currentKindMatches.length > 0 ? currentKindMatches : matchingKind;
  const ordered = [...kindMatches].sort(
    (a, b) => (b.uploadedAt?.getTime() ?? 0) - (a.uploadedAt?.getTime() ?? 0),
  );
  if (ordered.length === 0) {
    const available = [...files].sort((a, b) => (b.uploadedAt?.getTime() ?? 0) - (a.uploadedAt?.getTime() ?? 0));
    return `I couldn't find a saved ${requestedKind} to link. Here are the current saved deliverables instead:\n\n${available.map(file => `- [${file.filename}](${authorizedFileDownloadUrl(file)})`).join("\n")}`;
  }
  const latestRequested = /\b(?:latest|most recent|current)\b/.test(lowerContent);
  const selected = ordered.length === 1 || latestRequested ? [ordered[0]] : ordered;
  const intro = selected.length === 1
    ? "Here is the saved deliverable:"
    : "I found these saved deliverables. Choose the one you meant: ";
  const links = selected.map(file => {
    const version = file.version == null ? "" : ` (v${file.version}${file.supersededAt ? ", superseded" : ", current"})`;
    return `- [${file.filename}](${authorizedFileDownloadUrl(file)})${version}`;
  });
  return `${intro}\n\n${links.join("\n")}`;
}

function answerTurnWasRecentlyDispatched(messageId: number): boolean {
  const dispatchedAt = rememberedAnswerTurnStarts.get(messageId);
  if (dispatchedAt === undefined) return false;
  if (Date.now() - dispatchedAt > ANSWER_TURN_RETRY_DEDUPE_MS) {
    rememberedAnswerTurnStarts.delete(messageId);
    return false;
  }
  return true;
}

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

// G6/G13: body for PUT /api/protected/conversations/:id — update title,
// council charter, and optional turn budget. Strict: unknown fields are
// rejected, not silently dropped.
// Title caps at 500 chars (the length the create path already accepts);
// charter caps hard at 2,000 chars.
const updateConversationSchema = z.object({
  title: z.string().trim().min(1, "Title cannot be empty").max(500, "Title must be at most 500 characters").optional(),
  charter: z.string().max(2000, "Charter must be at most 2,000 characters").nullable().optional(),
  turnBudget: z.number().int().min(0, "Turn budget must be 0 or an integer from 1 to 100").max(100, "Turn budget must be at most 100").nullable().optional(),
});

// Extract and VERIFY the express-session id from a WS upgrade request's
// Cookie header. express-session signs the value as `s:<sessionId>.<signature>`
// where signature = base64(HMAC-SHA256(secret, sessionId)) with trailing "="
// padding stripped (cookie-signature's sign()). The signature must be
// verified, never merely stripped — a leaked or guessed raw session id must
// not be enough to mint an authenticated socket. `cookie-signature` is a
// transitive dep of express-session but ships no type declarations, so the
// equivalent check is hand-rolled with node:crypto and compared with
// timingSafeEqual. Mirrors cookie-signature's unsign(): the sid/signature
// split happens at the LAST dot of the signed portion.
function getVerifiedSessionIdFromUpgradeRequest(req: { headers: { cookie?: string } }): string | null {
  const secret = process.env.SESSION_SECRET;
  // No secret configured means express-session signed cookies with a random
  // per-process string we cannot reproduce — fail closed.
  if (!secret) return null;

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
    const signed = value.slice(2);
    const dot = signed.lastIndexOf(".");
    if (dot === -1) return null;
    const sid = signed.slice(0, dot);
    const providedSignature = signed.slice(dot + 1);
    if (!sid || !providedSignature) return null;

    const expectedSignature = createHmac("sha256", secret)
      .update(sid)
      .digest("base64")
      .replace(/=+$/, "");
    const expected = Buffer.from(expectedSignature);
    const provided = Buffer.from(providedSignature);
    // timingSafeEqual throws on length mismatch; unequal length is already a
    // failed verification.
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      return null;
    }
    return sid;
  }
  return null;
}

export async function registerRoutes(app: Express): Promise<Server> {
  app.get("/api/models", async (_req, res) => {
    try {
      const models = await getModelCatalog();
      res.set("Cache-Control", "public, max-age=600").json(models);
    } catch (error) {
      console.error("Model catalog fetch failed:", (error as Error).message);
      res.set("Cache-Control", "no-store").status(502).json({ message: "AI models are temporarily unavailable. Please try again shortly." });
    }
  });

  // Liveness/readiness for docker-compose and uptime checks (README-SELF-HOST).
  app.get("/api/health", async (_req, res) => {
    let database: "ok" | "memory" | "error" = process.env.DATABASE_URL ? "ok" : "memory";
    if (database === "ok") {
      try { await storage.getUser(0); } catch { database = "error"; }
    }
    res.status(database === "error" ? 503 : 200).json({ status: database === "error" ? "degraded" : "ok", database, uptimeSeconds: Math.round(process.uptime()) });
  });

  // Setup authentication routes
  setupAuth(app);

  // Keep historical /uploads links working, but resolve them through their
  // file record so an authenticated user must own the parent conversation.
  app.get("/uploads/:filename", async (req, res) => {
    try {
      if (!req.isAuthenticated()) return res.status(401).json({ message: "Authentication required" });
      const filename = path.basename(req.params.filename);
      const file = await storage.getFileByUrl(`/uploads/${filename}`);
      if (!file) return res.status(404).json({ message: "File not found" });
      const conversation = await storage.getConversation(file.conversationId);
      if (!conversation || conversation.userId !== req.user!.id) return res.status(404).json({ message: "File not found" });
      const filePath = getStoredUploadPath(file);
      if (!filePath) return res.status(404).json({ message: "File not found" });
      res.setHeader("Content-Type", file.fileType);
      res.download(filePath, file.filename, error => {
        if (error && !res.headersSent) res.status(404).json({ message: "File not found" });
      });
    } catch {
      if (!res.headersSent) res.status(404).json({ message: "File not found" });
    }
  });

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
          const testModel = devConfig.experts[0]?.model || "nvidia/nemotron-3-super-120b-a12b:free";

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
  // noServer + explicit routing: `new WebSocketServer({ server, path })` answers
  // EVERY other upgrade on this http server with 400, which killed Vite's dev
  // HMR socket (client then fell back to wss://localhost:undefined). Only /ws
  // is handled here; other upgrades (Vite HMR at /vite-hmr) are left alone.
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try { pathname = new URL(req.url ?? "", "http://localhost").pathname; } catch { /* malformed */ }
    if (pathname !== "/ws") return;
    // Diagnostics (no secrets): which upgrades reach /ws and whether a session cookie came with them.
    console.log(`[WS] upgrade ${pathname}${(req.url ?? "").includes("?") ? "?…" : ""} cookie=${/(?:^|;\s*)connect\.sid=/.test(req.headers.cookie ?? "") ? "yes" : "no"}`);
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
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
    const sid = getVerifiedSessionIdFromUpgradeRequest(req);

    if (!sid) {
      console.log(`[WS] 4401: ${req.headers.cookie?.includes("connect.sid=") ? "session cookie signature did not verify (SESSION_SECRET " + (process.env.SESSION_SECRET ? "set" : "missing") + ")" : "no session cookie on upgrade"}`);
      rejectUnauthenticated();
      return;
    }

    // Frames can arrive while the session-store lookup is still in flight —
    // with the pg store that lookup is a real round-trip, and a subscribe
    // sent immediately after the handshake would otherwise be dropped (no
    // message listener attached yet). Queue every early frame and drain it
    // in order once the socket is authenticated.
    const earlyFrames: RawData[] = [];
    let authenticatedMessageHandler: ((message: RawData) => void) | null = null;
    ws.on("message", (message) => {
      if (authenticatedMessageHandler) {
        authenticatedMessageHandler(message);
      } else {
        earlyFrames.push(message);
      }
    });

    storage.sessionStore.get(sid, (err: any, session: any) => {
      // The socket may have closed while the store lookup was in flight.
      if (ws.readyState !== 1) return;

      const userId = session?.passport?.user;
      if (err || userId == null) {
        console.log(`[WS] 4401: ${err ? "session store error" : "session has no logged-in user"}`);
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

      const handleMessage = (message: RawData) => {
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
                    maxAutonomousTurns: state.maxAutonomousTurns,
                    ...(state.mode !== "idle" ? {
                      expertTurnsConsumed: state.totalAutonomousTurnsTaken,
                      expertTurnsRemaining: Math.max(0, state.maxAutonomousTurns - state.totalAutonomousTurnsTaken),
                    } : {})
                  }));
                } else {
                  // G7: no live in-memory state — the snapshot stored on the
                  // row (already loaded for the ownership check) is the only
                  // remaining truth. A processing_*/autonomous snapshot is a
                  // dead turn chain from before a restart: correct the badge
                  // to idle instead of letting the client assume nothing.
                  // Paused is real recoverable state: show the Paused badge —
                  // the next message's cold-start path restores it for real.
                  // Storage is intentionally not mutated here; the next
                  // message's cold-start path owns snapshot corrections.
                  // isAutonomousEnabled/maxAutonomousTurns are intentionally
                  // OMITTED: they are not part of the snapshot, and hardcoding
                  // a value here would flip the client's Enabled/Disabled
                  // badge on every reconnect (the client guards both fields
                  // with a typeof check and keeps its current value when
                  // they're absent). The real values arrive with the next
                  // live state_update.
                  const snapshot = conversation.orchestratorState;
                  if (snapshot && (snapshot.mode === "processing_sequential" || snapshot.mode === "autonomous")) {
                    ws.send(JSON.stringify({
                      type: "state_update",
                      conversationId,
                      mode: "idle"
                    }));
                  } else if (snapshot && snapshot.mode === "paused") {
                    ws.send(JSON.stringify({
                      type: "state_update",
                      conversationId,
                      mode: "paused"
                    }));
                  }
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
      };

      authenticatedMessageHandler = handleMessage;
      // Drain any frames that arrived during the session lookup, in order.
      for (const frame of earlyFrames.splice(0)) {
        handleMessage(frame);
      }
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
              maxAutonomousTurns: data.maxAutonomousTurns,
              expertTurnsConsumed: data.expertTurnsConsumed,
              expertTurnsRemaining: data.expertTurnsRemaining,
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
          // Steering remains reserved for explicit `/new` restarts.
          else if (data.type === "steering") {
            client.send(JSON.stringify({
              type: "steering",
              conversationId
            }));
          }
          // Busy farmer messages stay in the current flow; these events drive
          // the subtle queued indicator in the chat composer.
          else if (data.type === "message_queued" || data.type === "message_picked_up") {
            client.send(JSON.stringify({
              type: data.type,
              conversationId,
              messageId: data.messageId,
            }));
          }
          // The question panel refetches its conversation-scoped ledger when
          // an open question is created or answered.
          else if (data.type === "open_questions_updated") {
            client.send(JSON.stringify({
              type: "open_questions_updated",
              conversationId,
            }));
          }
          // Handle G5 conclusion: the Moderator ended the round; the closing
          // synthesis turn streams next.
          else if (data.type === "concluding") {
            client.send(JSON.stringify({
              type: "concluding",
              conversationId
            }));
          }
          // Handle G8 degradation notices: informational only (e.g. the
          // Moderator's routing call failed and the council falls back to
          // round-robin). Never blocks processing.
          else if (data.type === "notice") {
            client.send(JSON.stringify({
              type: "notice",
              conversationId,
              message: data.message
            }));
          }
          // Handle G9 next-speaker preview: who is about to speak, sent just
          // before their expert_stream_start.
          else if (data.type === "next_speaker") {
            client.send(JSON.stringify({
              type: "next_speaker",
              conversationId,
              expertId: data.expertId,
              expertRole: data.expertRole
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

  async function resolveAnswerQuestion(
    conversationId: number,
    requestedId: unknown,
  ): Promise<{ questionId: number | null } | { status: number; message: string }> {
    if (requestedId === undefined || requestedId === null) {
      const openQuestions = await storage.listOpenQuestions(conversationId);
      return { questionId: openQuestions.length === 1 ? openQuestions[0].id : null };
    }

    if (typeof requestedId !== "number" || !Number.isSafeInteger(requestedId) || requestedId <= 0) {
      return { status: 400, message: "answersQuestionId must be a positive integer." };
    }

    const question = await storage.getOpenQuestion(requestedId);
    if (!question || question.conversationId !== conversationId) {
      return { status: 404, message: "Open question not found." };
    }
    return { questionId: question.id };
  }

  async function assertMessageAllowance(userId: number, roundtableKey?: string): Promise<void> {
    const user = await storage.getUser(userId);
    if ((user?.tier || "free") === "free") {
      await assertFreeCapacity();
      const denial = await storage.consumeFreeMessageAllowance(userId, new Date(), roundtableKey);
      if (denial) throw new UsageCapError(denial);
      return;
    }
    const usage = await storage.getMonthlyUsage(userId, currentUsagePeriod());
    const denial = checkMessageAllowance(user?.tier, usage.messageCount);
    if (denial) throw new UsageCapError(denial);
  }

  async function recordUserMessage(userId: number): Promise<void> {
    // Free allowance is reserved atomically before any work is dispatched.
    if (((await storage.getUser(userId))?.tier || "free") === "free") return;
    try {
      await storage.incrementMonthlyMessages(userId, currentUsagePeriod());
    } catch (err) {
      console.error("[CAPS] failed to record message usage:", (err as Error).message);
    }
  }

  function sendUsageCapError(res: Response, error: UsageCapError) {
    const { status, ...body } = error.denial;
    return res.status(status).json(body);
  }

  /** Pro on the house key may only pick allowlisted paid models (BYOK may pick any). */
  async function houseKeyModelDenied(userId: number, tier: string, model: string): Promise<boolean> {
    if (tier !== "pro" || isHouseKeyAllowedModel(model)) return false;
    return !(await storage.getUserApiKey(userId));
  }

  async function storeAndProcessUserMessage(
    userId: number,
    conversationId: number,
    content: string,
    answersQuestionId: number | null,
  ): Promise<{ message: Message; created: boolean }> {
    const startProcessing = (message: Message, questionId?: number) => {
      if (questionId !== undefined && answerTurnWasRecentlyDispatched(message.id)) return;
      if (questionId !== undefined) {
        rememberedAnswerTurnStarts.set(message.id, Date.now());
        if (rememberedAnswerTurnStarts.size > 1024) {
          const oldest = rememberedAnswerTurnStarts.keys().next().value;
          if (oldest !== undefined) rememberedAnswerTurnStarts.delete(oldest);
        }
      }
      const processing = processMessageTurnBased(userId, conversationId, message, broadcastToConversation);
      void processing.catch(error => {
        if (questionId !== undefined) rememberedAnswerTurnStarts.delete(message.id);
        console.error("Error during turn-based processing initiation:", error);
        broadcastToConversation(conversationId, {
          type: "error",
          message: "Failed to start expert processing.",
        });
      });
    };

    const existingMessages = await storage.getConversationMessages(conversationId);
    const answerAlreadyInFlightOrHandled = (message: Message): boolean => {
      if (answerTurnWasRecentlyDispatched(message.id)) return true;
      const currentState = getConversationState(conversationId);
      const liveSequence = currentState && ["processing_sequential", "autonomous", "paused"].includes(currentState.mode);
      if (liveSequence && (
        (currentState.lastUserMessage?.id ?? -1) >= message.id ||
        (currentState.pendingUserMessage?.id ?? -1) >= message.id
      )) return true;
      // G7 deliberately recovers dead turn chains to idle. If a real expert
      // response is already stored after this answer, do not replay a finished
      // (or already-partially-finished) discussion on an exact HTTP retry.
      return existingMessages.some(existing => existing.role === "assistant" && existing.id > message.id);
    };
    const lastExistingMessage = existingMessages[existingMessages.length - 1] ?? null;
    const priorLinkedAnswer = answersQuestionId === null
      ? undefined
      : [...existingMessages].reverse().find(message =>
          message.role === "user" && message.answersQuestionId === answersQuestionId,
        );
    const isExactLinkedAnswerRetry = priorLinkedAnswer !== undefined &&
      content.trim() === priorLinkedAnswer.content.trim();

    if (isExactLinkedAnswerRetry) {
      const questionBeforeRetry = await storage.getOpenQuestion(answersQuestionId!);
      if (!questionBeforeRetry) {
        throw new OpenQuestionAnswerConflictError("The selected open question is no longer available to answer.");
      }
      if (questionBeforeRetry.status === "answered" && questionBeforeRetry.answerMessageId !== priorLinkedAnswer!.id) {
        throw new OpenQuestionAnswerConflictError("The selected open question was answered by a different message.");
      }

      if (questionBeforeRetry.status === "open") {
        const answerClaim = await storage.claimOpenQuestionAnswer(answersQuestionId!, priorLinkedAnswer!.id);
        if (!answerClaim) {
          throw new OpenQuestionAnswerConflictError("The selected open question is no longer available to answer.");
        }
        if (answerClaim.claimed) {
          broadcastToConversation(conversationId, priorLinkedAnswer!);
          broadcastToConversation(conversationId, { type: "open_questions_updated" });
          if (!answerAlreadyInFlightOrHandled(priorLinkedAnswer!)) {
            startProcessing(priorLinkedAnswer!, answersQuestionId!);
          }
        }
      } else if (!answerAlreadyInFlightOrHandled(priorLinkedAnswer!)) {
        // Covers a commit whose acknowledgement failed before its route
        // could dispatch G11. A retry starts it if no live or completed turn
        // is visible; completed/dead chains follow the G7 recovery rules.
        startProcessing(priorLinkedAnswer!, answersQuestionId!);
      }
      return { message: priorLinkedAnswer!, created: false };
    }

    if (answersQuestionId === null && isDuplicateUserSubmission(content, lastExistingMessage, false)) {
      console.log(`Duplicate user submission detected in conversation ${conversationId} — skipping processing.`);
      return { message: lastExistingMessage!, created: false };
    }

    // Pricing caps: a "message" = one farmer message (see server/usage-caps.ts).
    if (((await storage.getUser(userId))?.tier || "free") === "free" && content.length > FREE_MAX_MESSAGE_CHARS) {
      throw new UsageCapError({ status: 429, code: "free_message_too_long", message: `Please keep Free questions under ${FREE_MAX_MESSAGE_CHARS} characters, or upgrade to Pro.`, upgradeUrl: "/subscribe" });
    }
    await assertMessageAllowance(userId, `conversation:${conversationId}`);

    const conversationExperts = await storage.getConversationExperts(conversationId);
    const userMessage: InsertMessage = {
      conversationId,
      userId,
      expertId: null,
      content,
      role: "user",
      mentions: extractMentions(content, conversationExperts.map(expert => expert.role), conversationExperts),
      answersQuestionId,
    };
    let storedMessage: Message;
    if (answersQuestionId !== null) {
      const result = await storage.createAnswerMessage(userMessage, answersQuestionId);
      if (!result) {
        throw new OpenQuestionAnswerConflictError("The selected open question is no longer available to answer.");
      }
      storedMessage = result.message;
    } else {
      storedMessage = await storage.createMessage(userMessage);
    }
    await recordUserMessage(userId);

    // Broadcast the saved answer itself for transcript compatibility, then
    // signal subscribers to refresh the question list after its status change.
    broadcastToConversation(conversationId, storedMessage);
    if (answersQuestionId !== null) {
      broadcastToConversation(conversationId, { type: "open_questions_updated" });
    }

    if (isRetrievalOnlyRequest(content)) {
      const currentDeliverables = await storage.getCurrentDeliverableFiles(conversationId);
      const legacyGeneratedFiles = (await storage.getConversationFiles(conversationId))
        .filter(file => file.uploadedBy.toLowerCase() !== "user" && !file.deliverableId)
        .sort((a, b) => (b.uploadedAt?.getTime() ?? 0) - (a.uploadedAt?.getTime() ?? 0));
      const candidates = [...currentDeliverables, ...legacyGeneratedFiles];
      const experts = await storage.getConversationExperts(conversationId);
      const moderator = experts.find(expert => expert.role.trim().toLowerCase() === "moderator");
      const retrievalReply = await storage.createMessage({
        conversationId,
        userId: null,
        expertId: moderator?.id ?? null,
        content: buildStoredDeliverableReply(content, candidates),
        role: "assistant",
        expertName: moderator?.name ?? "Roundtable",
        expertRole: moderator?.role ?? "Moderator",
      });
      broadcastToConversation(conversationId, retrievalReply);

      // If a council chain is already active, let the orchestrator record this
      // latest farmer instruction so queued File Creator work is suppressed.
      // Idle retrievals are answered from storage without any provider call.
      const state = getConversationState(conversationId);
      if (state && ["processing_sequential", "autonomous", "paused"].includes(state.mode)) {
        startProcessing(storedMessage, answersQuestionId ?? undefined);
      }
    } else {
      startProcessing(storedMessage, answersQuestionId ?? undefined);
    }

    return { message: storedMessage, created: true };
  }

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
      { const r = billingUnavailable("Stripe integration not configured"); return res.status(r.status).json(r.body); }
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
        });
      }

      // The client chooses an interval only; price ids stay server-side.
      const interval = req.body?.interval ?? "month";
      if (interval !== "month" && interval !== "year") {
        return res.status(400).json({ message: 'interval must be "month" or "year"' });
      }
      const priceId = interval === "year" ? process.env.STRIPE_PRICE_ID_PRO_ANNUAL : (process.env.STRIPE_PRICE_ID_PRO || process.env.STRIPE_PRICE_ID);
      if (!priceId) {
        { const r = billingUnavailable(interval === "year" ? "Stripe annual Pro price ID not configured" : "Stripe Pro price ID not configured"); return res.status(r.status).json(r.body); }
      }

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        client_reference_id: String(user.id),
        metadata: { userId: String(user.id) },
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${req.headers.origin || process.env.ALLOWED_ORIGIN || "http://localhost:5173"}/dashboard?checkout=success`,
        cancel_url: `${req.headers.origin || process.env.ALLOWED_ORIGIN || "http://localhost:5173"}/pricing?checkout=cancel`,
      });

      res.json({ url: session.url });
    } catch (error: any) {
      console.error("Stripe checkout error:", error);
      { const r = billingErrorResponse(error, "create-checkout-session"); res.status(r.status).json(r.body); }
    }
  });

  // Cancel subscription
  app.post("/api/cancel-subscription", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }
    if (!stripe) {
      { const r = billingUnavailable("Stripe integration not configured"); return res.status(r.status).json(r.body); }
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
      { const r = billingErrorResponse(error, "cancel-subscription"); res.status(r.status).json(r.body); }
    }
  });

  // Stripe subscription endpoints (legacy/retired — UI uses /api/create-checkout-session)
  app.post("/api/create-subscription", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Authentication required" });
    }
    
    if (!stripe) {
      { const r = billingUnavailable("Stripe integration not configured"); return res.status(r.status).json(r.body); }
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
      // Retired: the UI now uses /api/create-checkout-session. Kept only for
      // old clients; uses the same Pro price. STRIPE_PRICE_ID is a deprecated fallback.
      const PRICE_ID = process.env.STRIPE_PRICE_ID_PRO || process.env.STRIPE_PRICE_ID;
      if (!PRICE_ID) {
        { const r = billingUnavailable("Stripe price ID not configured"); return res.status(r.status).json(r.body); }
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
      { const r = billingErrorResponse(error, "create-subscription"); res.status(r.status).json(r.body); }
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
      case "checkout.session.completed":
        try {
          const session = event.data.object as Stripe.Checkout.Session;
          const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
          const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
          if (session.mode !== "subscription" || !customerId || !subscriptionId) break;

          let user;
          for (const reference of [session.client_reference_id, session.metadata?.userId]) {
            const userId = Number(reference);
            if (Number.isSafeInteger(userId) && userId > 0) {
              user = await storage.getUser(userId);
              if (user) break;
            }
          }
          user ??= await storage.getUserByStripeCustomerId(customerId);
          if (!user) {
            return res.status(500).json({ message: "Checkout user not found" });
          }
          if (user.tier === "pro" && user.subscriptionStatus === "active" &&
              user.stripeCustomerId === customerId && user.stripeSubscriptionId === subscriptionId) break;

          await storage.updateUserStripeInfo(user.id, {
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            tier: "pro",
            subscriptionStatus: "active",
          });
        } catch (error) {
          console.error("Error processing checkout.session.completed:", error);
          return res.status(500).json({ message: "Checkout activation failed" });
        }
        break;

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
      const usage = await storage.getMonthlyUsage(req.user!.id, tier === "free" ? `free:roundtables:${currentUsagePeriod()}` : currentUsagePeriod());
      res.json({
        tier,
        limits,
        usage: { period: currentUsagePeriod(), messages: usage.messageCount, unit: tier === "free" ? "roundtables" : "messages" },
        freeLimits: { perMinute: FREE_MESSAGES_PER_MINUTE, perDay: FREE_MESSAGES_PER_DAY, maxTurns: FREE_MAX_TURNS },
        // True once house-key paid calls are falling back to free models.
        aiBudgetExhausted: tier === "pro" && !user?.openRouterKey && usage.aiSpendUsd >= monthlyAiBudgetUsd(tier),
        aiBudgetNotice: BUDGET_EXHAUSTED_NOTICE,
        // Paid models usable on the house key (Pro); any model works with BYOK.
        houseKeyModels: HOUSE_KEY_PAID_MODEL_ALLOWLIST,
        hasOwnKey: Boolean(user?.openRouterKey),
      });
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
        title,
        ...(((await storage.getUser(userId))?.tier || "free") === "free" ? { turnBudget: FREE_MAX_TURNS } : {}),
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

  // Update a conversation's title, council charter, and/or turn budget
  // (G6/G13). Ownership is
  // enforced exactly like the sibling protected conversation routes (a
  // mismatched or missing conversation is a 404 — no existence leak).
  app.put("/api/protected/conversations/:id", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);

      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      const parsed = updateConversationSchema.strict().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid conversation update", errors: parsed.error.flatten() });
      }
      if (Object.keys(parsed.data).length === 0) {
        return res.status(400).json({ message: "Nothing to update: provide a title, charter, or turn budget" });
      }

      const updates = parsed.data.turnBudget === 0
        ? { ...parsed.data, turnBudget: null }
        : parsed.data;
      if (updates.turnBudget !== undefined && ((await storage.getUser(req.user!.id))?.tier || "free") === "free") {
        updates.turnBudget = Math.min(updates.turnBudget ?? FREE_MAX_TURNS, FREE_MAX_TURNS);
      }
      const updatedConversation = await storage.updateConversation(conversationId, updates);
      if (!updatedConversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      if (updates.turnBudget !== undefined) {
        await persistAutonomySettings(conversationId, { maxAutonomousTurns: updates.turnBudget });
      }

      res.json(updatedConversation);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  
  // Delete a conversation and everything in it. Refused while a discussion
  // is running; same 404-on-mismatch ownership rule as the sibling routes.
  app.delete("/api/protected/conversations/:id", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);

      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      if (isConversationBusy(conversationId)) {
        return res.status(409).json({ message: "Wait for the discussion to finish before deleting this conversation." });
      }

      const conversationFiles = await storage.getConversationFiles(conversationId);
      await discardConversationState(conversationId);
      await storage.deleteConversation(conversationId);
      // Best-effort: the rows are gone, so a leftover file must not fail the request.
      for (const file of conversationFiles) {
        const filePath = getStoredUploadPath(file);
        if (filePath) await fs.promises.unlink(filePath).catch(() => {});
      }
      res.status(204).end();
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
      
      const { name } = req.body;
      // Keep allowlisted Free picks; distribute missing picks across the lineup.
      const requestedModel = typeof req.body.model === "string" ? req.body.model.trim() : "";
      const model = tier === "free" && !requestedModel ? FREE_EXPERT_MODELS[existingExperts.filter(e => e.role !== "Moderator").length % 3] : requestedModel || req.body.model;
      const role = typeof req.body.role === "string" ? req.body.role.trim().slice(0, 60) : "";
      if (!role || /^(user|farmer)$/i.test(role)) {
        return res.status(400).json({ message: "Choose a valid expert role." });
      }
      if (existingExperts.some(e => e.role.toLowerCase() === role.toLowerCase())) {
        return res.status(409).json({ message: `A ${role} is already at the table.` });
      }
      const customInstructions = typeof req.body.customInstructions === "string" && req.body.customInstructions.trim()
        ? req.body.customInstructions.trim().slice(0, 2000)
        : null;
      // Built-in roles always get the bundled avatar; custom roles get the custom badge.
      const avatarUrl = catalogAvatar(role);

      // Only the three included expert models may be selected on Free.
      if (tier === "free" && !isFreeExpertModel(model)) {
        return res.status(403).json({
          code: "TIER_LIMIT_MODEL",
          message: "Choose Claude Haiku 5.5, MiniMax M3.1 Flash or GLM 5.3 Flash on Free, or upgrade to Pro.",
        });
      }
      if (await houseKeyModelDenied(req.user!.id, tier, model)) {
        return res.status(403).json({
          code: "MODEL_REQUIRES_OWN_KEY",
          message: `Pro includes ${HOUSE_KEY_PAID_MODEL_ALLOWLIST.join(", ")} and free models. Add your own OpenRouter key to use other models.`,
        });
      }
      
      const expert: InsertExpert = {
        conversationId,
        name,
        role,
        model,
        systemPrompt: generateSystemPrompt({ role, customInstructions } as any),
        avatarUrl,
        customInstructions,
      };
      
      const createdExpert = tier === "free"
        ? await storage.createExpertWithinLimit(expert, limits.maxExperts)
        : await storage.createExpert(expert);
      if (!createdExpert) {
        return res.status(403).json({ code: "TIER_LIMIT_EXPERTS", message: "Free roundtables support up to 3 experts. Upgrade to Pro for up to 8.", upgradeUrl: "/subscribe" });
      }
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

  // Remove an expert from a conversation. Refused while a discussion is
  // running, since the turn loop holds the roster in memory.
  app.delete("/api/protected/conversations/:conversationId/experts/:expertId", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.conversationId);
      const expertId = parseInt(req.params.expertId);
      const conversation = await storage.getConversation(conversationId);

      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      const expert = await storage.getExpertById(expertId);
      if (!expert || expert.conversationId !== conversationId) {
        return res.status(404).json({ message: "Expert not found" });
      }
      if (isConversationBusy(conversationId)) {
        return res.status(409).json({ message: "Wait for the discussion to finish before removing an expert." });
      }

      await storage.deleteExpert(expertId);
      // Idle state caches the roster; drop it so the next message rebuilds it.
      await discardConversationState(conversationId);
      // A persisted paused snapshot indexes the old roster; clear it so
      // resume cannot restore a stale expert index.
      await storage.updateConversation(conversationId, { orchestratorState: null });
      res.status(204).end();
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

      // Enforce the same exact Free allowlist on settings updates.
      if (model !== undefined) {
        const user = await storage.getUser(req.user!.id);
        const tier = user?.tier || "free";
        if (tier === "free" && !isFreeExpertModel(model)) {
          return res.status(403).json({
            code: "TIER_LIMIT_MODEL",
            message: "Choose an included Free expert model or upgrade to Pro.",
          });
        }
        if (await houseKeyModelDenied(req.user!.id, tier, model)) {
          return res.status(403).json({
            code: "MODEL_REQUIRES_OWN_KEY",
            message: `Pro includes ${HOUSE_KEY_PAID_MODEL_ALLOWLIST.join(", ")} and free models. Add your own OpenRouter key to use other models.`,
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
  app.get("/api/protected/conversations/:id/open-questions", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);
      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      const questions = await storage.listOpenQuestions(conversationId);
      return res.json(questions);
    } catch (error: any) {
      return res.status(500).json({ message: error.message || "Internal server error" });
    }
  });

  app.post("/api/protected/conversations/:id/messages", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);
      
      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      const userId = req.user!.id;
      const { content, answersQuestionId } = req.body ?? {};
      const resolution = await resolveAnswerQuestion(conversationId, answersQuestionId);
      if ("status" in resolution) {
        return res.status(resolution.status).json({ message: resolution.message });
      }

      // An explicit answer to a different question is a different submission
      // even if its prose repeats the previous message. Ordinary duplicate
      // messages retain the existing F2 duplicate gate.
      const result = await storeAndProcessUserMessage(
        userId,
        conversationId,
        content,
        resolution.questionId,
      );

      return res.status(result.created ? 201 : 200).json(result.message);
    } catch (error: any) {
      console.error("Error in POST /messages:", error);
      if (error instanceof UsageCapError) return sendUsageCapError(res, error);
      if (error instanceof OpenQuestionAnswerConflictError) {
        return res.status(409).json({ message: error.message });
      }
      return res.status(500).json({ message: error.message || "Internal server error" });
    }
  });

  app.post("/api/protected/conversations/:id/open-questions/:questionId/answer", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);
      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      const questionId = Number(req.params.questionId);
      if (!Number.isSafeInteger(questionId) || questionId <= 0) {
        return res.status(400).json({ message: "Invalid question id." });
      }
      const { content } = req.body ?? {};
      if (typeof content !== "string" || content.trim().length === 0) {
        return res.status(400).json({ message: "An answer is required." });
      }

      const resolution = await resolveAnswerQuestion(conversationId, questionId);
      if ("status" in resolution) {
        return res.status(resolution.status).json({ message: resolution.message });
      }

      const result = await storeAndProcessUserMessage(
        req.user!.id,
        conversationId,
        content,
        resolution.questionId,
      );
      return res.status(result.created ? 201 : 200).json(result.message);
    } catch (error: any) {
      console.error("Error answering an open question:", error);
      if (error instanceof UsageCapError) return sendUsageCapError(res, error);
      if (error instanceof OpenQuestionAnswerConflictError) {
        return res.status(409).json({ message: error.message });
      }
      return res.status(500).json({ message: error.message || "Internal server error" });
    }
  });

  // Explicit topic restart. Ordinary messages join the active council flow;
  // only this endpoint retains the interrupt-and-restart behavior.
  app.post("/api/protected/conversations/:id/restart", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);
      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      const requestedTopic = typeof req.body?.topic === "string"
        ? req.body.topic.trim()
        : typeof req.body?.content === "string"
          ? req.body.content.trim()
          : "";
      const history = await storage.getConversationMessages(conversationId);
      const previousUserMessage = [...history].reverse().find(message => message.role === "user") ?? null;
      if (!requestedTopic && !previousUserMessage) {
        return res.status(400).json({ message: "A topic is required to start a discussion." });
      }

      let restartMessage: Message;
      if (requestedTopic) {
        if (((await storage.getUser(req.user!.id))?.tier || "free") === "free" && requestedTopic.length > FREE_MAX_MESSAGE_CHARS) {
          throw new UsageCapError({ status: 429, code: "free_message_too_long", message: `Please keep Free questions under ${FREE_MAX_MESSAGE_CHARS} characters, or upgrade to Pro.`, upgradeUrl: "/subscribe" });
        }
        await assertMessageAllowance(req.user!.id, `restart:${conversationId}:${randomUUID()}`);
        const conversationExperts = await storage.getConversationExperts(conversationId);
        restartMessage = await storage.createMessage({
          conversationId,
          userId: req.user!.id,
          expertId: null,
          content: requestedTopic,
          role: "user",
          mentions: extractMentions(requestedTopic, conversationExperts.map(expert => expert.role)),
        });
        await recordUserMessage(req.user!.id);
        broadcastToConversation(conversationId, restartMessage);
      } else {
        // Bare `/new` repeats the latest farmer topic as an explicit fresh
        // run without adding an empty/command-only message to the transcript.
        if (((await storage.getUser(req.user!.id))?.tier || "free") === "free") {
          await assertMessageAllowance(req.user!.id, `restart:${conversationId}:${randomUUID()}`);
        }
        restartMessage = previousUserMessage!;
      }

      processMessageTurnBased(
        req.user!.id,
        conversationId,
        restartMessage,
        broadcastToConversation,
        { restart: true },
      ).catch(error => {
        console.error("Error during explicit conversation restart:", error);
        broadcastToConversation(conversationId, {
          type: "error",
          message: "Failed to restart expert processing.",
        });
      });

      res.status(requestedTopic ? 201 : 200).json(restartMessage);
    } catch (error: any) {
      if (error instanceof UsageCapError) return sendUsageCapError(res, error);
      console.error("Error in POST /restart:", error);
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
      
      res.status(201).json(clientFileRecord(file));
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
      
      res.status(201).json(clientFileRecord(file));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
  
  app.get("/api/protected/conversations/:id/files/:fileId/download", async (req, res) => {
    try {
      if (!req.isAuthenticated()) return res.status(401).json({ message: "Authentication required" });
      const conversationId = Number(req.params.id);
      const fileId = Number(req.params.fileId);
      if (!Number.isSafeInteger(conversationId) || !Number.isSafeInteger(fileId)) {
        return res.status(404).json({ message: "File not found" });
      }
      const conversation = await storage.getConversation(conversationId);
      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "File not found" });
      }
      const file = await storage.getFileById(fileId);
      if (!file || file.conversationId !== conversationId) {
        return res.status(404).json({ message: "File not found" });
      }
      const filePath = getStoredUploadPath(file);
      if (!filePath) return res.status(404).json({ message: "File not found" });
      res.setHeader("Content-Type", file.fileType);
      res.download(filePath, file.filename, error => {
        if (error && !res.headersSent) res.status(404).json({ message: "File not found" });
      });
    } catch {
      if (!res.headersSent) res.status(404).json({ message: "File not found" });
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
      res.json(files.map(clientFileRecord));
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

  // Reviewed calendars use the existing versioned-file store in both storage backends.
  const calendarRequestSchema = z.object({
    events: calendarEventsSchema,
    expectedCurrentFileId: z.number().int().positive().nullable(),
    sourceFileId: z.number().int().positive().optional(),
  });

  app.get("/api/protected/conversations/:id/calendar", async (req, res) => {
    try {
      const conversationId = Number(req.params.id);
      const conversation = await storage.getConversation(conversationId);
      if (!conversation || conversation.userId !== req.user!.id) return res.status(404).json({ message: "Conversation not found" });
      let sourceFileId = req.query.fileId === undefined ? undefined : Number(req.query.fileId);
      if (sourceFileId !== undefined && (!Number.isSafeInteger(sourceFileId) || sourceFileId <= 0)) return res.status(422).json({ message: "Invalid calendar file" });
      let source = sourceFileId === undefined ? undefined : await storage.getFileById(sourceFileId);
      if (sourceFileId !== undefined && (!source || source.conversationId !== conversationId || !source.filename.toLowerCase().endsWith(".ics"))) return res.status(404).json({ message: "Calendar not found" });
      const reviewed = sourceFileId === undefined ? await storage.getCurrentDeliverableFile(conversationId, "farmer-calendar") : undefined;
      if (sourceFileId === undefined && !reviewed) {
        source = (await storage.getConversationFiles(conversationId))
          .filter(file => !file.supersededAt && file.uploadedBy.toLowerCase() !== "user" && file.filename.toLowerCase().endsWith(".ics"))
          .sort((a, b) => (b.uploadedAt?.getTime() ?? 0) - (a.uploadedAt?.getTime() ?? 0) || b.id - a.id)[0];
        sourceFileId = source?.id;
      }
      const deliverableId = source?.deliverableId?.startsWith("farmer-calendar") ? source.deliverableId : `farmer-calendar${sourceFileId ? `-${sourceFileId}` : ""}`;
      const current = reviewed ?? await storage.getCurrentDeliverableFile(conversationId, deliverableId);
      const saved = current ?? source;
      if (saved) {
        const filePath = getStoredUploadPath(saved);
        if (!filePath) return res.status(404).json({ message: "Calendar file unavailable" });
        const inspected = inspectCalendar(await fs.promises.readFile(filePath, "utf8"));
        const draft: CalendarDraft = { ...inspected, calendarName: conversation.title ?? "Roundtable", currentFileId: current?.id ?? null, sourceFileId, version: current?.version ?? null };
        return res.json(draft);
      }
      const todayIso = new Date().toISOString().slice(0, 10);
      const planMessages = await storage.getConversationMessages(conversationId);
      // Week 1: the farmer's chosen start, else the plan's stated anchor (next occurrence), else today.
      const planFiles = await storage.getConversationFiles(conversationId);
      // Week 1: explicit/frost anchor, else requested season, else today (gate C r6).
      const autoAnchor = resolveScheduleAnchor(findConversationAnchor(planMessages, todayIso, planFileTexts(planFiles)), todayIso);
      const anchor = typeof req.query.start === "string" && req.query.start ? parseIsoDate(req.query.start) : autoAnchor;
      if (!anchor) return res.status(422).json({ message: "Invalid start date" });
      const rows = extractScheduleRows(planMessages, planFiles, undefined, todayIso);
      // An empty schedule is a normal state, not an error: 200 keeps the sidebar's
      // background preview from logging a 422 for every plan-less conversation.
      if (!rows.length) return res.json({ events: [], empty: true, calendarName: conversation.title ?? "Roundtable", currentFileId: null, version: null, message: "No schedulable items found. Ask the council for a dated plan first." });
      const draft: CalendarDraft = {
        events: finalizeCalendarEvents(rows.map((row, index) => ({ uid: `${conversationId}-${index}@farmfriend-roundtable`, summary: buildRowSummary(row), startDate: resolveRowStartDate(row, anchor), description: row.description })), [...planMessages.map(m => m.content), ...planFileTexts(planFiles)].map(t => findFrostAnchor(String(t ?? ""), todayIso)).find(Boolean)),
        calendarName: calendarDisplayName(conversation.title, planMessages, planFiles), currentFileId: null, version: null,
      };
      return res.json({ ...draft, anchor, autoAnchor });
    } catch {
      return res.status(422).json({ message: "This calendar could not be opened. Check that it is a valid ICS file with event start dates." });
    }
  });

  app.put("/api/protected/conversations/:id/calendar", async (req, res) => {
    let filePath: string | undefined;
    try {
      const conversationId = Number(req.params.id);
      const conversation = await storage.getConversation(conversationId);
      if (!conversation || conversation.userId !== req.user!.id) return res.status(404).json({ message: "Conversation not found" });
      const parsed = calendarRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(422).json({ message: "Calendar requires 1–200 events with unique IDs, titles up to 75 characters, valid dates, and descriptions up to 4,000 characters." });
      const { events, expectedCurrentFileId, sourceFileId } = parsed.data;
      const source = sourceFileId ? await storage.getFileById(sourceFileId) : undefined;
      if (sourceFileId && (!source || source.conversationId !== conversationId || !source.filename.toLowerCase().endsWith(".ics"))) return res.status(404).json({ message: "Calendar not found" });
      const deliverableId = source?.deliverableId?.startsWith("farmer-calendar") ? source.deliverableId : `farmer-calendar${sourceFileId ? `-${sourceFileId}` : ""}`;
      const current = await storage.getCurrentDeliverableFile(conversationId, deliverableId);
      if ((current?.id ?? null) !== expectedCurrentFileId) return res.status(409).json({ message: "A newer calendar revision exists. Close and reopen the preview before saving." });
      const filename = "reviewed-calendar.ics";
      const diskName = `${randomBytes(16).toString("hex")}-${filename}`;
      filePath = path.join(process.cwd(), "uploads", diskName);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, buildVCalendar(events, conversation.title ?? "Roundtable"), "utf8");
      const saved = await storage.saveDeliverableVersion({ conversationId, filename, fileUrl: `/uploads/${diskName}`, fileType: "text/calendar", uploadedBy: "Farmer" }, {
        deliverableId, generationRequestId: randomBytes(16).toString("hex"), mode: current ? "revise" : "create", expectedCurrentFileId: current?.id, constraints: { format: "ics" },
      });
      if (!saved.created) {
        await fs.promises.unlink(filePath);
        filePath = undefined;
        return res.status(409).json({ message: "A newer calendar revision exists. Close and reopen the preview before saving." });
      }
      filePath = undefined;
      return res.json({ currentFileId: saved.file.id, version: saved.file.version, downloadUrl: authorizedFileDownloadUrl(saved.file) });
    } catch (error) {
      if (filePath) await fs.promises.unlink(filePath).catch(() => {});
      return res.status(error instanceof DeliverableConflictError ? 409 : 500).json({ message: error instanceof DeliverableConflictError ? "A newer calendar revision exists. Close and reopen the preview before saving." : "Calendar could not be saved." });
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
      let anchor = "";
      if (startParam) {
        const parsed = parseIsoDate(startParam);
        if (!parsed) {
          return res.status(422).json({ error: "Invalid start date. Use YYYY-MM-DD." });
        }
        anchor = parsed;
      }

      const messages = await storage.getConversationMessages(conversationId);
      const files = await storage.getConversationFiles(conversationId);
      const todayIso = new Date().toISOString().slice(0, 10);
      if (!startParam) anchor = resolveScheduleAnchor(findConversationAnchor(messages, todayIso, planFileTexts(files)), todayIso);

      const rows = extractScheduleRows(messages, files, undefined, todayIso);
      if (rows.length === 0) {
        return res.status(422).json({
          error: "No schedulable items found in this conversation. Ask an expert for a week-by-week plan first.",
        });
      }

      const events = finalizeCalendarEvents(rows.map((row, index) => ({
        uid: `${conversationId}-${index}@farmfriend-roundtable`,
        summary: buildRowSummary(row),
        startDate: resolveRowStartDate(row, anchor),
        description: row.description,
      })), [...messages.map(m => String(m.content ?? "")), ...planFileTexts(files)].map(t => findFrostAnchor(t, todayIso)).find(Boolean));

      if (req.query.preview === "1") {
        const scheduleVersions = files
          .filter((file) => !file.supersededAt && file.uploadedBy.startsWith("Expert:") && file.filename.toLowerCase().endsWith(".md"))
          .map((file) => file.version)
          .filter((version): version is number => Number.isInteger(version));
        const startDate = events.map((event) => event.startDate).sort()[0];
        return res.json({
          eventCount: events.length,
          startDate,
          year: Number(startDate.slice(0, 4)),
          timeZone: "All-day dates (timezone-neutral)",
          scheduleVersion: scheduleVersions.length ? `v${Math.max(...scheduleVersions)}` : "Current conversation schedule",
        });
      }

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
      const conversation = await storage.getConversation(conversationId);
      if (!conversation || conversation.userId !== req.user!.id) {
          res.status(403).json({ message: "Forbidden" });
          return null;
      }
      const state = getConversationState(conversationId);
      if (!state) {
          res.status(404).json({ message: "Conversation state not found or not initialized." });
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
      const conversationId = parseInt(req.params.id);
      // Ownership gate first — the same checks getOrchestratorForRequest
      // applies, but WITHOUT its missing-state 404: a paused snapshot on the
      // row is recoverable below, and this endpoint must answer exactly once.
      const conversation = await storage.getConversation(conversationId);
      if (!conversation) {
        res.status(404).json({ message: "Conversation state not found or not initialized." });
        return;
      }
      if (conversation.userId !== req.user!.id) {
        res.status(403).json({ message: "Forbidden" });
        return;
      }

      if (!getConversationState(conversationId)) {
        // No live in-memory state. A paused snapshot persisted on the row is
        // real, recoverable state (the server restarted while the council was
        // parked): rebuild the live paused state from it, then run the normal
        // resume below. Anything else keeps the 404.
        const restored = await restorePausedFromSnapshot(conversationId, broadcastToConversation);
        if (!restored) {
          res.status(404).json({ message: "Conversation state not found or not initialized." });
          return;
        }
      }

      new InteractionOrchestrator(conversationId).resume();
      res.status(200).json({ message: "Resume signal sent." });
      
    } catch (error: any) {
      console.error("Error in POST /resume:", error);
      res.status(500).json({ message: error.message || "Internal server error" });
    }
  });

  app.post("/api/protected/conversations/:id/autonomous/enable", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);
      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      const body = req.body && typeof req.body === "object" ? req.body : {};
      const hasMaxTurns = Object.prototype.hasOwnProperty.call(body, "maxTurns");
      let maxTurns = body.maxTurns;
      if (hasMaxTurns && maxTurns !== null && maxTurns !== 0 &&
          (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100)) {
        return res.status(400).json({ message: "maxTurns must be null, 0, or an integer from 1 to 100." });
      }

      if (((await storage.getUser(req.user!.id))?.tier || "free") === "free") {
        maxTurns = Math.min(maxTurns || FREE_MAX_TURNS, FREE_MAX_TURNS);
        await storage.updateConversation(conversationId, { turnBudget: maxTurns });
        await persistAutonomySettings(conversationId, { maxAutonomousTurns: maxTurns });
      }

      if (hasMaxTurns) {
        await storage.updateConversation(conversationId, { turnBudget: maxTurns === 0 ? null : maxTurns });
      }
      await persistAutonomySettings(conversationId, {
        isAutonomousEnabled: true,
        ...(hasMaxTurns ? { maxAutonomousTurns: maxTurns === 0 ? null : maxTurns } : {}),
      });
      res.status(200).json({ message: "Autonomous mode enabled." });
      
    } catch (error: any) {
      console.error("Error in POST /autonomous/enable:", error);
      res.status(500).json({ message: error.message || "Internal server error" });
    }
  });

  app.post("/api/protected/conversations/:id/autonomous/disable", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const conversation = await storage.getConversation(conversationId);
      if (!conversation || conversation.userId !== req.user!.id) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      await persistAutonomySettings(conversationId, { isAutonomousEnabled: false });
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
