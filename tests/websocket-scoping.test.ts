/**
 * WebSocket Authentication & Conversation Scoping Tests (G3)
 *
 * Covers:
 *  - /ws upgrade without a valid session is closed with 4401 (no broadcasts)
 *  - Authenticated socket subscribes to its own conversation and receives
 *    scoped broadcasts (user message echo + expert stream events + state
 *    updates) driven by POSTing a message through the real route + real
 *    orchestrator
 *  - A socket subscribed to conversation A receives nothing for conversation B
 *    (second conversation of the same user)
 *  - Subscribing to ANOTHER user's conversation yields subscribe_denied
 *  - Re-subscribing (reconnect path) replays the orchestrator state snapshot
 *
 * Uses a REAL http listener (ephemeral port) so real `ws` clients can connect
 * with session cookies captured from HTTP register responses. Forces
 * MemStorage; mocks only the AI layer (mirroring tests/orchestrator.test.ts).
 *
 * WS harness note: incoming frames can arrive in the same TCP chunk as the
 * 101 handshake, in which case the ws client emits "message" synchronously
 * right after "open". Message recorders are therefore attached at socket
 * construction (never after awaiting "open") so no frame is ever dropped.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import type { Server } from "http";
import WebSocket from "ws";

// ── Force MemStorage BEFORE any server imports ──
process.env.DATABASE_URL = "";
process.env.SESSION_SECRET = "vitest-ws-scoping-secret";
process.env.NODE_ENV = "test";
process.env.LOGIN_RATELIMIT_MAX = "1000";

// ── Mock the AI layer only: the real orchestrator must run so state updates
// and stream events are broadcast through the real routes pipeline. ──
const { mockGetExpertResponseStream, mockGenerateInsights, mockGetModeratorNextSpeakerSuggestion } =
  vi.hoisted(() => ({
    mockGetExpertResponseStream: vi.fn(),
    mockGenerateInsights: vi.fn(),
    mockGetModeratorNextSpeakerSuggestion: vi.fn(),
  }));

vi.mock("../server/ai", () => ({
  generateSystemPrompt: vi.fn().mockReturnValue("You are a helpful agricultural expert."),
  callOpenRouterAPI: vi.fn(),
  callPerplexityAPI: vi.fn(),
  getExpertResponse: vi.fn(),
  getExpertResponseStream: mockGetExpertResponseStream,
  generateInsights: mockGenerateInsights,
  getModeratorNextSpeakerSuggestion: mockGetModeratorNextSpeakerSuggestion,
}));

import { registerRoutes } from "../server/routes";
import { getConversationState } from "../server/orchestrator";
import { storage } from "../server/storage";

// ── Helpers ──
function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A connected client with a durable record of every parsed frame received.
interface TestClient {
  ws: WebSocket;
  received: any[];
}

function connect(wsUrl: string, cookie?: string): Promise<TestClient> {
  // The recorder is attached BEFORE the handshake so no frame can be dropped
  // (see the harness note at the top of this file).
  const ws = new WebSocket(wsUrl, { headers: cookie ? { cookie } : undefined });
  const received: any[] = [];
  ws.on("message", (data) => {
    try {
      received.push(JSON.parse(data.toString()));
    } catch {
      /* ignore non-JSON */
    }
  });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, received }));
    ws.once("error", reject);
  });
}

// Resolve once a matching frame has been recorded (polls the durable record).
async function nextMessage(
  client: TestClient,
  predicate: (data: any) => boolean,
  timeoutMs = 5000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = client.received.find(predicate);
    if (match) return match;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for a matching WebSocket message. Received so far: ${JSON.stringify(client.received)}`,
      );
    }
    await waitFor(10);
  }
}

// Resolve with the close code; watcher is attached at construction so a close
// racing the handshake is never missed.
function closeOf(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.once("error", reject);
  });
}

async function api(
  baseUrl: string,
  method: string,
  path: string,
  { cookie, body }: { cookie?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function registerUser(baseUrl: string, username: string): Promise<string> {
  const res = await api(baseUrl, "POST", "/api/register", {
    body: { username, password: "testpass123", email: `${username}@example.com` },
  });
  expect(res.status).toBe(201);
  const setCookie = res.headers.getSetCookie();
  const sid = setCookie.find((c) => c.startsWith("connect.sid="));
  expect(sid).toBeTruthy();
  return sid!.split(";")[0];
}

async function createConversation(baseUrl: string, cookie: string, title: string) {
  const res = await api(baseUrl, "POST", "/api/protected/conversations", {
    cookie,
    body: { title },
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function addExpert(baseUrl: string, cookie: string, conversationId: number) {
  const res = await api(baseUrl, "POST", `/api/protected/conversations/${conversationId}/experts`, {
    cookie,
    body: { name: "Dr. Stream", role: "Agronomist", model: "test/model:free" },
  });
  expect(res.status).toBe(201);
  return res.json();
}

function waitForConversationMode(conversationId: number, mode: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      if (getConversationState(conversationId)?.mode === mode) return resolve();
      if (Date.now() > deadline) {
        return reject(new Error(`Timed out waiting for mode "${mode}" on conversation ${conversationId}`));
      }
      setTimeout(poll, 10);
    })();
  });
}

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════

describe("WebSocket scoping (G3)", () => {
  let server: Server;
  let baseUrl = "";
  let wsUrl = "";
  let cookieA = "";
  let cookieB = "";
  let convoA1: any; // user A, conversation 1 (subscribed)
  let convoA2: any; // user A, conversation 2 (NOT subscribed)
  let clientA: TestClient;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    server = await registerRoutes(app);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsUrl = `ws://127.0.0.1:${address.port}/ws`;

    // Mocked AI: stream a couple of tokens, return a stored-able message.
    let turnCounter = 0;
    mockGetExpertResponseStream.mockImplementation(
      async (expert: any, _history: any, _ref: any, _files: any, _roles: any, onToken: (t: string) => void) => {
        onToken("Mock ");
        onToken(`turn ${++turnCounter}`);
        return {
          conversationId: expert.conversationId,
          expertId: expert.id,
          userId: null,
          content: `Response from ${expert.name} (turn ${turnCounter})`,
          role: "assistant",
          expertName: expert.name,
          expertRole: expert.role,
        };
      },
    );
    mockGenerateInsights.mockResolvedValue(undefined);
    mockGetModeratorNextSpeakerSuggestion.mockResolvedValue(null);

    cookieA = await registerUser(baseUrl, "wsscoping-a");
    cookieB = await registerUser(baseUrl, "wsscoping-b");

    convoA1 = await createConversation(baseUrl, cookieA, "A subscribed conversation");
    await addExpert(baseUrl, cookieA, convoA1.id);
    convoA2 = await createConversation(baseUrl, cookieA, "A other conversation");
    await addExpert(baseUrl, cookieA, convoA2.id);

    clientA = await connect(wsUrl, cookieA);
    await nextMessage(clientA, (m) => m.type === "connection");

    clientA.ws.send(JSON.stringify({ type: "subscribe", conversationId: convoA1.id }));
    await nextMessage(clientA, (m) => m.type === "subscribed" && m.conversationId === convoA1.id);
  });

  afterAll(async () => {
    if (clientA?.ws?.readyState === WebSocket.OPEN) clientA.ws.close(1000, "test done");
    // Let pending orchestrator setImmediate chains drain before teardown.
    await waitFor(300);
    (server as any).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("closes unauthenticated upgrades with 4401 and sends no messages", async () => {
    const noCookie = await connect(wsUrl);
    const closed = await closeOf(noCookie.ws);
    expect(closed.code).toBe(4401);
    expect(closed.reason).toBe("Unauthenticated");
    expect(noCookie.received).toEqual([]);

    // A well-formed but unknown session id must be rejected the same way.
    const badSid = await connect(wsUrl, "connect.sid=s:doesnotexist.forgery");
    const badClosed = await closeOf(badSid.ws);
    expect(badClosed.code).toBe(4401);
  });

  it("delivers scoped broadcasts to a subscribed socket (POST message drives the flow)", async () => {
    // Drive broadcasts through the real REST route: the stored user message is
    // broadcast immediately, then the real orchestrator (with mocked AI)
    // streams expert turns and ends with a state_update(idle).
    const res = await api(baseUrl, "POST", `/api/protected/conversations/${convoA1.id}/messages`, {
      cookie: cookieA,
      body: { content: "What cover crop for zone 6?" },
    });
    expect(res.status).toBe(201);

    // 1. Own user message echoed back.
    const userEcho = await nextMessage(
      clientA,
      (m) => m.type === "messages_updated" && m.conversationId === convoA1.id && m.message?.role === "user",
    );
    expect(userEcho.message.content).toBe("What cover crop for zone 6?");

    // 2. Expert streaming events for the subscribed conversation.
    const streamStart = await nextMessage(
      clientA,
      (m) => m.type === "expert_stream_start" && m.conversationId === convoA1.id,
    );
    expect(streamStart.expertName).toBe("Dr. Stream");
    await nextMessage(clientA, (m) => m.type === "expert_stream_token" && m.conversationId === convoA1.id);
    await nextMessage(
      clientA,
      (m) =>
        m.type === "expert_stream_done" &&
        m.conversationId === convoA1.id &&
        m.message?.role === "assistant",
    );

    // 3. The round reaches idle (full scoped sequence delivered).
    await waitForConversationMode(convoA1.id, "idle");
    await nextMessage(clientA, (m) => m.type === "state_update" && m.conversationId === convoA1.id && m.mode === "idle");
  });

  it("does not deliver events for a conversation the socket did not subscribe to", async () => {
    // clientA is subscribed only to convoA1. A full round runs on convoA2
    // (same user) — none of its broadcasts may reach clientA.
    const res = await api(baseUrl, "POST", `/api/protected/conversations/${convoA2.id}/messages`, {
      cookie: cookieA,
      body: { content: "Unsubscribed conversation message" },
    });
    expect(res.status).toBe(201);

    // Wait until the convoA2 round is fully over (its final broadcasts have
    // been attempted) before asserting absence.
    await waitForConversationMode(convoA2.id, "idle");
    await waitFor(200); // Grace for any in-flight ws deliveries.

    const leaked = clientA.received.filter((m) => m.conversationId === convoA2.id);
    expect(leaked).toEqual([]);
  });

  it("denies subscribing to another user's conversation", async () => {
    const clientB = await connect(wsUrl, cookieB);
    try {
      await nextMessage(clientB, (m) => m.type === "connection");
      clientB.ws.send(JSON.stringify({ type: "subscribe", conversationId: convoA1.id }));
      const reply = await nextMessage(
        clientB,
        (m) => m.type === "subscribe_denied" || m.type === "subscribed",
      );
      expect(reply.type).toBe("subscribe_denied");
      expect(reply.conversationId).toBe(convoA1.id);
    } finally {
      clientB.ws.close(1000, "test done");
    }
  });

  it("replays orchestrator state on resubscribe (reconnect path)", async () => {
    // convoA1's round finished earlier; its idle state persists server-side.
    expect(getConversationState(convoA1.id)?.mode).toBe("idle");

    const clientA2 = await connect(wsUrl, cookieA);
    try {
      await nextMessage(clientA2, (m) => m.type === "connection");
      clientA2.ws.send(JSON.stringify({ type: "subscribe", conversationId: convoA1.id }));

      // Ack first, then the replayed state snapshot.
      const ack = await nextMessage(clientA2, (m) => m.type === "subscribed" && m.conversationId === convoA1.id);
      expect(ack.conversationId).toBe(convoA1.id);
      const replay = await nextMessage(
        clientA2,
        (m) => m.type === "state_update" && m.conversationId === convoA1.id,
      );
      expect(replay.mode).toBe("idle");
      expect(typeof replay.isAutonomousEnabled).toBe("boolean");
      expect(typeof replay.maxAutonomousTurns).toBe("number");
    } finally {
      clientA2.ws.close(1000, "test done");
    }
  });

  it("closes 4401 on a cookie with a valid session id but a forged signature", async () => {
    // Capture a REAL session cookie by registering a user, then tamper only
    // the HMAC. Stripping the signature must not be enough to authenticate.
    const cookie = await registerUser(baseUrl, "wsscoping-forged");
    const signed = cookie.replace("connect.sid=", "");
    const dot = signed.lastIndexOf(".");
    expect(dot).toBeGreaterThan(0);
    const forged = `connect.sid=${signed.slice(0, dot + 1)}FORGED_SIGNATURE`;

    const client = await connect(wsUrl, forged);
    const closed = await closeOf(client.ws);
    expect(closed.code).toBe(4401);
    expect(closed.reason).toBe("Unauthenticated");
    expect(client.received).toEqual([]);
  });

  it("processes a subscribe that arrives before the session lookup completes (async store)", async () => {
    // The pg-backed session store resolves its lookup on a later tick. A
    // client that subscribes immediately after the handshake sends its frame
    // before the server attached the authenticated message handler — the
    // frame must be buffered and honored, not dropped.
    const originalGet = storage.sessionStore.get.bind(storage.sessionStore);
    (storage.sessionStore as any).get = (sid: string, cb: (err: any, session: any) => void) => {
      setTimeout(() => originalGet(sid, cb), 25);
    };
    try {
      const client = await connect(wsUrl, cookieA);
      try {
        // Sent while the (delayed) lookup is still in flight.
        client.ws.send(JSON.stringify({ type: "subscribe", conversationId: convoA1.id }));
        const ack = await nextMessage(
          client,
          (m) => m.type === "subscribed" && m.conversationId === convoA1.id,
        );
        expect(ack.conversationId).toBe(convoA1.id);
      } finally {
        client.ws.close(1000, "test done");
      }
    } finally {
      (storage.sessionStore as any).get = originalGet;
    }
  });
});
