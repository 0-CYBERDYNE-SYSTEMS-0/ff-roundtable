# FarmFriend Roundtable PRO — Comprehensive Validation Plan

**Branch:** `validation-plan`
**Status:** ACTIVE
**Last Updated:** 2026-05-30
**Scope:** End-to-end test coverage, security audit, performance benchmarking, CI/CD integration

---

## Table of Contents

1. [Current Test Coverage Audit](#1-current-test-coverage-audit)
2. [Missing Test Coverage Areas](#2-missing-test-coverage-areas)
3. [Test Implementation Priorities](#3-test-implementation-priorities)
4. [Validation Criteria per Feature](#4-validation-criteria-per-feature)
5. [Security Validation Checklist](#5-security-validation-checklist)
6. [Performance & Load Testing Plan](#6-performance--load-testing-plan)
7. [CI/CD Integration Plan](#7-cicd-integration-plan)
8. [DEVELOPMENT_MODE Removal Checklist](#8-development_mode-removal-checklist)
9. [Pre-Deployment Gate Criteria](#9-pre-deployment-gate-criteria)

---

## 1. Current Test Coverage Audit

### 1.1 Existing Tests

| Test File | Test Count | Framework | Scope | Status |
|-----------|-----------|-----------|-------|--------|
| `tests/billing.test.ts` | **28 tests** | Vitest + Supertest | Stripe billing E2E | ✅ PASSING |

### 1.2 Billing Test Breakdown (28 tests)

```
tests/billing.test.ts
├── GET /api/subscription-status (3 tests)
│   ├── returns 401 when not authenticated
│   ├── returns status 'active' for pre-seeded developer user
│   └── returns status 'inactive' for newly registered user
├── POST /api/create-subscription (6 tests)
│   ├── returns 401 when not authenticated
│   ├── returns 500 when Stripe customer creation fails
│   ├── returns 500 when price ID is missing in environment
│   ├── creates subscription for new user (happy path)
│   ├── retrieves existing subscription when already active
│   └── handles Stripe API errors gracefully
├── POST /api/webhook (8 tests)
│   ├── preserves webhook idempotency with replay protection
│   ├── returns 400 when signature is missing
│   ├── verifies webhook signature correctly
│   ├── returns 400 for invalid signature
│   ├── handles invoice.payment_succeeded event
│   ├── handles customer.subscription.deleted event
│   ├── handles customer.subscription.updated event
│   └── gracefully handles unknown event types
├── Subscription gating on /api/protected/* (3 tests)
│   ├── returns 401 for unauthenticated requests
│   ├── returns 403 for authenticated but unsubscribed user (production)
│   └── allows subscribed users to access protected routes
├── Edge Cases (4 tests)
│   ├── handles concurrent subscription creation (idempotency)
│   ├── webhook with missing subscription in payload does not crash
│   ├── webhook handles empty event data gracefully
│   └── subscription status reflects changes after creation
└── GAPS (4 SKIP markers)
    ├── SKIP: POST /api/cancel-subscription (endpoint does not exist)
    ├── SKIP: POST /api/update-subscription (endpoint does not exist)
    ├── SKIP: POST /api/create-payment-intent (endpoint does not exist)
    └── SKIP: POST /api/create-checkout-session (not implemented)
```

### 1.3 Test Infrastructure

| Component | Tool | Status |
|-----------|------|--------|
| Test runner | Vitest 4.x | ✅ Configured |
| HTTP assertions | Supertest 7.x | ✅ In use |
| Mock framework | Vitest `vi.mock` | ✅ Stripe SDK mocked |
| DB isolation | MemStorage (forced via `DATABASE_URL=""`) | ✅ |
| Config | `vitest.config.ts` with `@shared` alias | ✅ |
| Type checking | `npm run check` (tsc) | ✅ Script exists |

### 1.4 Coverage Summary

```
Covered:
  ✅ Stripe subscription creation (happy + error paths)
  ✅ Stripe webhook handling (4 event types + invalid/edge)
  ✅ Auth-gated subscription gating
  ✅ Concurrent subscription idempotency
  ✅ Subscription status transitions

NOT Covered:
  ❌ Authentication (register, login, bcrypt, rate limiting)
  ❌ Conversation CRUD (create, list, get, messages)
  ❌ Expert management (add, update, list)
  ❌ Farm profile (get, upsert, weather integration)
  ❌ WebSocket streaming protocol
  ❌ AI integration (OpenRouter, Perplexity)
  ❌ File upload/download
  ❌ Insights generation and retrieval
  ❌ Export (markdown conversation export)
  ❌ Orchestrator state machine (pause, resume, autonomous)
  ❌ Perplexity API integration
  ❌ Weather API caching (OpenWeatherMap)
  ❌ BYOK model enforcement (free/paid tier filtering)
  ❌ Dev config loading (quick-setup, update-models)
  ❌ Artifact extraction
  ❌ Password hashing (bcrypt + backward compat)
  ❌ Session management
  ❌ CORS / security headers
  ❌ Rate limiting enforcement
  ❌ Input validation (Zod schemas)
  ❌ Client-side components (React, WebSocket integration)
```

---

## 2. Missing Test Coverage Areas

### 2.1 Critical Gaps (Blocking Production)

| # | Area | Risk if Untested | Files Involved |
|---|------|-----------------|----------------|
| 1 | **Auth system** — register, login, logout, bcrypt password hashing, session persistence | Account takeover, password storage bugs | `server/auth.ts` |
| 2 | **Login rate limiting** — 5 attempts/15 min enforcement | Brute force vulnerability | `server/auth.ts:42-48` |
| 3 | **Subscription gating in production** — currently bypassed by `DEVELOPMENT_MODE` | Unpaid users accessing premium features | `server/auth.ts:150-166` |
| 4 | **BYOK API key encryption** — user API key storage and decryption | Key leakage, free tier bypass | Not yet implemented (MONETIZATION_PLAN.md §3.1) |
| 5 | **Tier enforcement** — expert limits, model filtering, upgrade gates | Revenue loss | Not yet implemented |

### 2.2 High Priority Gaps

| # | Area | Risk | Files Involved |
|---|------|------|----------------|
| 6 | **Conversation CRUD** — full lifecycle (create, list, access control) | Data loss, cross-user access | `server/routes.ts:422-462` |
| 7 | **Message sending + orchestrator** — user message → expert response flow | Core feature broken | `server/orchestrator.ts`, `server/routes.ts:572-616` |
| 8 | **Expert management** — add, update model, unauthorized modification prevention | Expert hijacking | `server/routes.ts:464-537` |
| 9 | **WebSocket streaming** — connection, token delivery, start/done messages | Streaming feature broken silently | `server/routes.ts:157-274`, `server/orchestrator.ts` |
| 10 | **Orchestrator state machine** — idle → sequential → autonomous → pause/resume transitions | Conversations hang or loop forever | `server/orchestrator.ts` |

### 2.3 Medium Priority Gaps

| # | Area | Files Involved |
|---|------|----------------|
| 11 | **Farm profile** — CRUD, weather context injection | `server/routes.ts:539-569, 971-1004` |
| 12 | **File upload** — multer, file creation, access control | `server/routes.ts:636-732` |
| 13 | **Insights** — generation, retrieval, broadcast | `server/routes.ts:735-768`, `server/ai.ts` |
| 14 | **Export** — markdown generation, date formatting | `server/routes.ts:771-810`, `server/export-utils.ts` |
| 15 | **Weather API** — cache hits/misses, error handling, format conversion | `server/weather.ts` |
| 16 | **Artifact extraction** — code blocks, JSON, charts, tables | `server/artifact-extractor.ts` |
| 17 | **Dev config** — quick-setup, update-models, test artifacts | `server/routes.ts:79-151, 891-969` |

### 2.4 Client-Side Gaps

| # | Area | Current State |
|---|------|---------------|
| 18 | **React components** — no test framework configured for client | No vitest JSDOM/browser environment |
| 19 | **WebSocket client** — connection lifecycle, reconnection | Untested |
| 20 | **Protected route** — subscription check, redirect logic | `client/src/lib/protected-route.tsx` |

---

## 3. Test Implementation Priorities

### Phase A: Blocking-Gate Tests (Must pass before production deployment)

```
Priority 1 — Auth & Security
├── TEST: POST /api/register — successful registration with bcrypt hashing
├── TEST: POST /api/register — duplicate username rejection
├── TEST: POST /api/register — password stored as bcrypt hash (not plaintext)
├── TEST: POST /api/login — successful login with proper credentials
├── TEST: POST /api/login — invalid credentials rejection
├── TEST: POST /api/login — rate limit blocks after 5 failed attempts
├── TEST: POST /api/login — rate limit resets after 15 minute window
├── TEST: POST /api/logout — session destruction
├── TEST: GET /api/user — returns authenticated user
├── TEST: GET /api/user — returns 401 for unauthenticated
├── TEST: POST /api/register — password field redacted in response (***)
├── TEST: backward compatibility — old "dev:" prefixed passwords still work
├── TEST: backward compatibility — old "simple:" prefixed passwords still work
└── TEST: SESSION_SECRET required in production (no random fallback)

Priority 2 — Subscription Gating (Production Mode)
├── TEST: authenticated + subscribed → access protected routes
├── TEST: authenticated + unsubscribed → 403 on protected routes
├── TEST: unauthenticated → 401 on protected routes
└── TEST: NODE_ENV=production disables DEVELOPMENT_MODE bypass

Priority 3 — BYOK & Tier Enforcement (from MONETIZATION_PLAN.md)
├── TEST: free tier + BYOK → allowed access
├── TEST: free tier + no BYOK → 403 with NO_API_KEY code
├── TEST: pro tier → always allowed
├── TEST: enterprise tier → always allowed
├── TEST: POST /api/user/api-key → encrypts and stores key
├── TEST: GET /api/user/api-key/status → returns masked key
├── TEST: POST /api/validate-openrouter-key → validates real key format
├── TEST: expert limit enforced (free tier: 3 max)
├── TEST: paid model blocked for free tier
└── TEST: model selector filters to :free models for free tier
```

### Phase B: Core Feature Tests

```
Priority 4 — Conversation & Messaging
├── TEST: POST /api/protected/conversations → creates conversation
├── TEST: GET /api/protected/conversations → lists user's conversations
├── TEST: GET /api/protected/conversations/:id → returns single conversation
├── TEST: GET /api/protected/conversations/:id → 404 for others' conversations
├── TEST: POST /api/protected/conversations/:id/messages → creates user message
├── TEST: GET /api/protected/conversations/:id/messages → lists messages
├── TEST: POST /api/protected/conversations/:id/experts → adds expert
├── TEST: PATCH /api/experts/:expertId → updates expert model/name
├── TEST: PATCH /api/experts/:expertId → rejects unauthorized update

Priority 5 — Orchestrator State Machine
├── TEST: processMessageTurnBased initializes state on first message
├── TEST: orchestrator transitions idle → processing_sequential
├── TEST: orchestrator processes each expert in sequence
├── TEST: orchestrator transitions sequential → autonomous when enabled
├── TEST: orchestrator stops at maxAutonomousTurns
├── TEST: orchestrator pauses mid-sequence and resumes
├── TEST: orchestrator handles interruption (new user message during processing)
├── TEST: orchestrator enables/disables autonomous mode
└── TEST: orchestrator broadcasts state_update via WebSocket

Priority 6 — WebSocket Protocol
├── TEST: WebSocket connection established at /ws
├── TEST: connection confirmation message received
├── TEST: expert_stream_start message format and timing
├── TEST: expert_stream_token message delivery
├── TEST: expert_stream_done message with final message data
├── TEST: message_error broadcast on AI failure
└── TEST: insights broadcast triggers client refresh
```

### Phase C: Integration & Data Tests

```
Priority 7 — Farm Profile + Weather
├── TEST: GET /api/protected/farm-profile → returns profile or null
├── TEST: PUT /api/protected/farm-profile → creates/updates profile
├── TEST: weather context injected into system prompt when profile has coords
├── TEST: weather cache hit (returns cached data within 30 min)
├── TEST: weather cache miss (fetches from OpenWeatherMap)
├── TEST: weather gracefully degrades when OWM_API_KEY missing
└── TEST: farm context block appears in expert prompt generation

Priority 8 — File Operations
├── TEST: POST file upload — creates file record
├── TEST: POST file upload — returns 400 when no file attached
├── TEST: GET files — lists conversation files
├── TEST: POST generate-file — creates AI-generated file
├── TEST: file access control — 404 for unauthorized conversation
└── TEST: file content reading (text-based detection)

Priority 9 — Insights & Export
├── TEST: POST generate-insights — creates insight record
├── TEST: GET insights — returns conversation insights
├── TEST: GET export — returns markdown with conversation data
├── TEST: export filename sanitization
└── TEST: artifact rendering in export
```

### Phase D: AI Integration (Mocked)

```
Priority 10 — OpenRouter Integration
├── TEST: callOpenRouterAPI — successful API call
├── TEST: callOpenRouterAPI — handles API key missing
├── TEST: callOpenRouterAPI — handles non-200 response
├── TEST: callOpenRouterAPI — handles malformed response
├── TEST: callOpenRouterAPIStream — SSE token parsing
├── TEST: callOpenRouterAPIStream — handles [DONE] signal
├── TEST: callOpenRouterAPIStream — handles connection errors
├── TEST: generateSystemPrompt — includes farm context
├── TEST: generateSystemPrompt — includes weather context
├── TEST: generateSystemPrompt — role-specific instructions
├── TEST: free model detection (:free suffix matching)
└── TEST: Perplexity API — research query

Priority 11 — Artifact Extraction
├── TEST: extracts HTML artifacts from AI response
├── TEST: extracts JSON artifacts
├── TEST: extracts chart artifacts (JSON-rendered charts)
├── TEST: extracts table artifacts
├── TEST: extracts code artifacts (js, py, ts)
├── TEST: artifact title extraction from comments
└── TEST: cleanContent returns text without artifact blocks
```

### Phase E: Client-Side (Future)

```
Priority 12 — React Component Tests
├── Research: @testing-library/react setup in vitest
├── TEST: AuthPage renders login/register forms
├── TEST: ProtectedRoute redirects unauthenticated users
├── TEST: ProtectedRoute redirects unsubscribed users (production)
├── TEST: ExpertSelector filters models by tier
├── TEST: ChatInterface handles streaming tokens
├── TEST: FarmProfileModal form validation
└── TEST: WebSocket hook connection lifecycle
```

---

## 4. Validation Criteria per Feature

### 4.1 Authentication System

| # | Criteria | Validation Method | Pass Condition |
|---|----------|-------------------|----------------|
| A1 | Passwords stored as bcrypt hashes (never plaintext) | Unit test + DB inspection | `$2a$` or `$2b$` prefix in password column |
| A2 | Login rate limited to 5 attempts per 15 minutes per IP | Integration test | 6th attempt returns 429 |
| A3 | Session persists across server restart (prod with SESSION_SECRET) | Manual test | Cookie survives restart |
| A4 | Backward compatibility: old `dev:` passwords still work | Unit test | Legacy user can log in |
| A5 | Registration returns user without password field | API test | Response has `password: "***"` |
| A6 | Cross-session isolation — user A cannot access user B's data | Integration test | 403/404 for cross-user access |

### 4.2 Billing & Subscription

| # | Criteria | Validation Method | Pass Condition |
|---|----------|-------------------|----------------|
| B1 | Stripe subscription creation creates customer + subscription | Existing test ✅ | billing.test.ts |
| B2 | Webhook updates subscription status correctly | Existing test ✅ | billing.test.ts |
| B3 | Webhook signature verification rejects invalid signatures | Existing test ✅ | billing.test.ts |
| B4 | Production mode gates /api/protected/* for unsubscribed users | New test needed | 403 response |
| B5 | Concurrent subscription requests are idempotent | Existing test ✅ | billing.test.ts |
| B6 | Subscription cancellation endpoint exists and works | **Not implemented** | Needs implementation |
| B7 | Stripe Checkout session flow works end-to-end | **Not implemented** | Needs implementation |

### 4.3 BYOK & Tier System (from MONETIZATION_PLAN.md)

| # | Criteria | Validation Method | Pass Condition |
|---|----------|-------------------|----------------|
| T1 | User can save their own OpenRouter API key | API test | Key stored encrypted |
| T2 | GET /api/user/api-key/status returns masked key | API test | e.g., `sk-or-...abc123` |
| T3 | Free tier + BYOK grants access to protected routes | Integration test | 200 on conversations |
| T4 | Free tier + no BYOK returns 403 with NO_API_KEY | Integration test | 403 + `code: "NO_API_KEY"` |
| T5 | Pro tier always grants access (platform-provided key) | Integration test | 200 on conversations |
| T6 | Expert limit enforced: free = 3 max, pro = 8 max, enterprise = unlimited | Integration test | 403 when adding beyond limit |
| T7 | Model selector filters to `:free` models for free BYOK tier | Client test | Non-free models hidden |
| T8 | OpenRouter key validation endpoint validates real keys | API test | Returns `valid: true/false` |
| T9 | Free tier cannot select paid models | Integration test | Block + upgrade CTA |

### 4.4 Conversation & Roundtable

| # | Criteria | Validation Method | Pass Condition |
|---|----------|-------------------|----------------|
| C1 | User can create, list, and view conversations | API test | CRUD operations return expected data |
| C2 | User cannot access another user's conversations | API test | 404/403 on foreign conversation |
| C3 | Messages are stored and retrieved in chronological order | API test | Sorted by timestamp ascending |
| C4 | Expert addition validates conversation ownership | API test | 403 for unauthorized expert add |

### 4.5 Orchestrator & Streaming

| # | Criteria | Validation Method | Pass Condition |
|---|----------|-------------------|----------------|
| O1 | First user message triggers sequential expert processing | Integration test | Experts respond in order |
| O2 | After sequential round, transitions to autonomous mode | Integration test | Mode changes to "autonomous" |
| O3 | Autonomous mode respects maxAutonomousTurns limit | Integration test | Stops at configured limit |
| O4 | Pause stops processing immediately (doesn't start next expert) | Integration test | Next expert not called |
| O5 | Resume continues from where it left off | Integration test | Correct expert fires next |
| O6 | New user message interrupts active processing | Integration test | `wasInterrupted` flag set |
| O7 | Streaming tokens arrive in real-time via WebSocket | Manual / E2E test | Tokens appear incrementally |
| O8 | Moderation suggestion logic (autonomous mode) | Unit test | Moderator returns valid role name |
| O9 | Expert system prompt includes farm + weather context | Unit test | Prompt contains farm data |

### 4.6 Farm Profile & Weather

| # | Criteria | Validation Method | Pass Condition |
|---|----------|-------------------|----------------|
| F1 | Farm profile CRUD works for authenticated user | API test | Profile returned/updated |
| F2 | Weather data cached for 30 minutes | Unit test | Second call within 30 min uses cache |
| F3 | Weather degrades gracefully without OWM_API_KEY | Unit test | Returns null, no crash |
| F4 | Weather context formatted correctly for AI prompt | Unit test | Contains temp, wind, forecast |
| F5 | Farm context injected into expert system prompt | Unit test | Prompt contains farm name, crops, soil |

### 4.7 File Management

| # | Criteria | Validation Method | Pass Condition |
|---|----------|-------------------|----------------|
| FL1 | File upload creates DB record + stores file | API test | Record exists, file readable |
| FL2 | File upload rejects requests with no file | API test | 400 response |
| FL3 | AI-generated file creation works | API test | File record created |
| FL4 | File listing is scoped to conversation | API test | Only conversation files returned |
| FL5 | File content truncated for large files (2000 chars) | Unit test | Truncation applied |
| FL6 | Non-text files handled gracefully | Unit test | Placeholder message returned |

### 4.8 Insights & Export

| # | Criteria | Validation Method | Pass Condition |
|---|----------|-------------------|----------------|
| I1 | Insights generated and stored per conversation | API test | Insight returned in list |
| I2 | Export produces valid markdown | API test | Content-Type: text/markdown |
| I3 | Export includes all experts, messages, artifacts, insights | Manual inspection | Comprehensive output |
| I4 | Export filename sanitized (no special chars) | Unit test | Safe filename generated |

### 4.9 AI Integration

| # | Criteria | Validation Method | Pass Condition |
|---|----------|-------------------|----------------|
| AI1 | OpenRouter API call returns valid response | Mocked API test | Correct message structure |
| AI2 | Streaming SSE parser handles all chunk patterns | Unit test | No token loss, handles [DONE] |
| AI3 | Perplexity API returns cited research | Mocked API test | Citations array present |
| AI4 | System prompt includes expert role instructions | Unit test | Role-specific text present |
| AI5 | Free model detection identifies `:free` suffix | Unit test | `isFreeModel()` returns correct |
| AI6 | API key fallback: user key → platform key | Integration test | Correct key used per call |

---

## 5. Security Validation Checklist

### 5.1 Authentication Security

| # | Check | Method | Status |
|---|-------|--------|--------|
| S1 | Passwords hashed with bcrypt (12 rounds) | Code review `auth.ts:23-24` | ✅ Implemented |
| S2 | No plaintext passwords in responses | Test: response password = `***` | Need test |
| S3 | Login rate limiting: 5 attempts / 15 minutes | Test: 6th attempt → 429 | Need test |
| S4 | Session cookies set with `httpOnly` and `secure` (prod) | Code review `auth.ts:60-63` | Need config verification |
| S5 | `trust proxy` enabled for rate limiting behind reverse proxy | Code review `auth.ts:66` | ✅ Implemented |
| S6 | `saveUninitialized: false` — no empty sessions | Code review `auth.ts:58` | ✅ Implemented |
| S7 | Session secret from env, no fallback in production | Code review `auth.ts:51-53` | ⚠️ Falls back to random |
| S8 | Passport `serializeUser` by user ID (not full object) | Code review `auth.ts:86` | ✅ Implemented |

### 5.2 Authorization Security

| # | Check | Method | Status |
|---|-------|--------|--------|
| S9 | `/api/protected/*` middleware checks auth + subscription | Code review `auth.ts:150-166` | ⚠️ Bypassed by DEVELOPMENT_MODE |
| S10 | Conversation ownership verified on every access | Code review `routes.ts` (multiple) | ✅ Implemented |
| S11 | Expert modification validates conversation ownership | Code review `routes.ts:518-522` | ✅ Implemented |
| S12 | Farm profile scoped to authenticated user | Code review (via `req.user.id`) | ✅ Implemented |

### 5.3 API Key Security (BYOK — from MONETIZATION_PLAN.md)

| # | Check | Method | Status |
|---|-------|--------|--------|
| S13 | User API keys encrypted at rest (AES-256-GCM) | Not yet implemented | ❌ Need implementation |
| S14 | Encryption key stored in env var, never in code | Design review | ❌ Need `ENCRYPTION_KEY` env |
| S15 | API key never returned in full to client (masked) | Test: status endpoint | ❌ Need implementation |
| S16 | OpenRouter key validation doesn't log full key | Code review | ❌ Need implementation |

### 5.4 Infrastructure Security

| # | Check | Method | Status |
|---|-------|--------|--------|
| S17 | CORS configured for production (not `*`) | Code review | Need verification |
| S18 | Helmet or security headers present | Code check | Not implemented |
| S19 | File upload size limited (10MB multer config) | Code review `routes.ts:33` | ✅ Implemented |
| S20 | File upload path sanitized (no directory traversal) | Code review `routes.ts:689` | ✅ Implemented |
| S21 | No secrets in client-side code | Manual scan | ⚠️ `DEVELOPMENT_MODE=true` exposed |
| S22 | Stripe webhook signature verified before processing | Code review `routes.ts:353-372` | ✅ Implemented |
| S23 | PostgreSQL connection uses SSL in production | Config check | Need verification |

### 5.5 Input Validation

| # | Check | Method | Status |
|---|-------|--------|--------|
| S24 | Zod schemas used for all API inputs | Code review `shared/schema.ts` | ✅ Defined |
| S25 | Zod schemas enforced in route handlers | Code review | ⚠️ Not consistently applied |
| S26 | SQL injection prevented (Drizzle ORM parameterization) | Architecture review | ✅ Drizzle uses parameterized queries |
| S27 | XSS prevention in message content rendering | Client code review | ⚠️ Needs DOMPurify check |
| S28 | Username/email uniqueness enforced at DB level | Schema review `schema.ts:7-9` | ✅ Unique constraint |

### 5.6 Development Mode Cleanup (CRITICAL)

| # | Check | Status |
|---|-------|--------|
| S29 | `DEVELOPMENT_MODE = true` in `server/routes.ts:48` | ❌ Must be removed for production |
| S30 | `DEVELOPMENT_MODE = true` in `server/auth.ts:12` | ❌ Must be replaced with env check |
| S31 | `DEVELOPMENT_MODE = true` in `client/src/pages/auth-page.tsx:34` | ❌ Must be removed |
| S32 | `DEVELOPMENT_MODE = true` in `client/src/pages/subscribe-page.tsx:15` | ❌ Must be removed |
| S33 | `DEVELOPMENT_MODE = true` in `client/src/lib/protected-route.tsx:8` | ❌ Must be removed |
| S34 | `POST /api/dev-login` endpoint disabled in production | ❌ Must be gated by NODE_ENV |
| S35 | `POST /api/dev/quick-setup` disabled in production | ❌ Must be gated by NODE_ENV |
| S36 | `POST /api/dev/test-artifacts` disabled in production | ❌ Must be gated by NODE_ENV |

---

## 6. Performance & Load Testing Plan

### 6.1 Performance Budget

| Metric | Target | Tool |
|--------|--------|------|
| API response time (p50) | < 200ms | k6 / autocannon |
| API response time (p95) | < 500ms | k6 / autocannon |
| WebSocket connection time | < 100ms | Custom WS bench |
| First stream token latency | < 2s (with mocked AI) | Custom timing |
| Database query time (p95) | < 50ms | PostgreSQL `pg_stat_statements` |
| Memory usage (idle) | < 256MB | Node.js heap snapshots |
| Memory usage (under load) | < 512MB | Node.js heap snapshots |

### 6.2 Load Testing Scenarios

```
Scenario 1: Authentication Load
├── 50 concurrent registrations
├── 50 concurrent logins
├── Rate limiting effectiveness under load
└── Session store performance (PostgreSQL-backed)

Scenario 2: API Read Load
├── 200 concurrent GET /api/protected/conversations
├── 200 concurrent GET /api/protected/conversations/:id/messages
├── 200 concurrent GET /api/protected/farm-profile
└── Verify: PostgreSQL connection pool handles concurrency (max: 10)

Scenario 3: API Write Load
├── 50 concurrent POST /api/protected/conversations
├── 50 concurrent POST /api/protected/conversations/:id/messages
├── 50 concurrent POST /api/protected/conversations/:id/experts
└── Verify: No data corruption, proper serial ordering

Scenario 4: WebSocket Load
├── 100 concurrent WebSocket connections
├── Broadcast messages to all connected clients
├── Streaming token delivery under load
└── Connection cleanup on disconnect

Scenario 5: Orchestrator Stress
├── 20 concurrent conversations with 5 experts each
├── Autonomous mode running for multiple conversations
├── Pause/resume during active processing
└── Memory leak detection (heap snapshots before/after)

Scenario 6: File Upload Load
├── 25 concurrent 5MB file uploads
├── Disk space monitoring
└── Upload timeout handling
```

### 6.3 Performance Test Implementation

```bash
# Install k6 (recommended load testing tool)
npm install -D @types/k6  # TypeScript types only
brew install k6            # macOS

# Key test files to create:
tests/performance/
├── auth-load.test.js       # Auth endpoint load
├── api-read-load.test.js   # GET endpoint load
├── api-write-load.test.js  # POST/PUT endpoint load
├── websocket-load.test.js  # WebSocket connection load
└── orchestrator-stress.test.js  # Orchestrator under pressure
```

### 6.4 Database Performance

```sql
-- Enable query statistics
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Key indexes to verify/add:
-- Users: username (unique index exists from schema)
-- Conversations: user_id (for getUserConversations)
-- Experts: conversation_id (for getConversationExperts)
-- Messages: conversation_id, timestamp (for ordered retrieval)
-- Files: conversation_id
-- Insights: conversation_id
-- WeatherCache: lat, lng, fetched_at (for cache lookup)
-- FarmProfiles: user_id (unique index exists from schema)
```

### 6.5 AI Response Caching Strategy

| Caching Layer | TTL | Scope |
|---------------|-----|-------|
| Identical query cache | 5 minutes | Per user + per expert + per query hash |
| Farm context (prompt prefix) | Session lifetime | Per user + per conversation |
| Weather data | 30 minutes | Per lat/lng (already implemented) |
| Model list (OpenRouter) | 1 hour | Global (reduces API calls) |

---

## 7. CI/CD Integration Plan

### 7.1 Pipeline Stages

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CI/CD PIPELINE                                │
│                                                                     │
│  [PUSH] → Stage 1 → Stage 2 → Stage 3 → Stage 4 → [DEPLOY]        │
│            Lint     Unit      Integration   Pre-deploy              │
│            & Type   Tests     Tests         Checks                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 7.2 Stage Details

#### Stage 1: Lint & Type Check (Fast — < 1 min)

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]

jobs:
  lint-and-type:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run check          # TypeScript type checking
      - run: npx tsc --noEmit       # Redundant safety check
```

#### Stage 2: Unit Tests (Fast — < 2 min)

```yaml
  unit-tests:
    needs: lint-and-type
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: farm_roundtable_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        ports: ['5432:5432']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run test -- --reporter=verbose
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/farm_roundtable_test
          SESSION_SECRET: ci-test-secret
          NODE_ENV: test
```

#### Stage 3: Integration Tests (Medium — < 5 min)

```yaml
  integration-tests:
    needs: unit-tests
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: farm_roundtable_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        ports: ['5432:5432']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run db:push   # Push schema to test DB
      - run: npx vitest run --config vitest.integration.config.ts
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/farm_roundtable_test
          SESSION_SECRET: ci-integration-secret
          NODE_ENV: test
          # Mock API keys (not hitting real services)
          OPENROUTER_API_KEY: sk-or-mock-ci-key
          STRIPE_SECRET_KEY: sk_test_mock
          STRIPE_WEBHOOK_SECRET: whsec_mock
```

#### Stage 4: Pre-Deploy Checks (Manual or on `main` branch)

```yaml
  pre-deploy:
    needs: integration-tests
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run build           # Verify build succeeds
      # Security audit
      - run: npm audit --audit-level=high
      # Check for DEVELOPMENT_MODE = true
      - run: |
          ! grep -r "DEVELOPMENT_MODE\s*=\s*true" server/ client/src/ || \
          (echo "ERROR: DEVELOPMENT_MODE=true found in production code!" && exit 1)
      # Check for hardcoded secrets
      - run: |
          npx detect-secrets scan --baseline .secrets.baseline || true
      # Bundle size check (optional)
      - run: |
          du -sh dist/ || echo "dist/ not found (non-blocking)"
```

### 7.3 Test File Organization

```
tests/
├── billing.test.ts              # Existing: Stripe billing (28 tests)
├── auth.test.ts                 # NEW: Authentication & authorization
├── conversations.test.ts        # NEW: Conversation CRUD
├── experts.test.ts              # NEW: Expert management
├── messages.test.ts             # NEW: Message sending & retrieval
├── orchestrator.test.ts         # NEW: State machine transitions
├── websocket.test.ts            # NEW: WebSocket protocol
├── farm-profile.test.ts         # NEW: Farm profile + weather
├── files.test.ts                # NEW: File upload/download
├── insights.test.ts             # NEW: Insights generation
├── export.test.ts               # NEW: Markdown export
├── ai-integration.test.ts       # NEW: OpenRouter/Perplexity (mocked)
├── byok-tier.test.ts            # NEW: BYOK & tier enforcement
├── artifacts.test.ts            # NEW: Artifact extraction
├── helpers/
│   ├── test-app.ts              # Shared test app factory
│   ├── auth-helpers.ts          # registerAndLogin, login helpers
│   └── mock-ai.ts               # AI response mocking utilities
└── performance/
    ├── auth-load.test.js
    ├── api-read-load.test.js
    ├── api-write-load.test.js
    └── websocket-load.test.js
```

### 7.4 Required npm Scripts

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "test:performance": "k6 run tests/performance/*.test.js",
    "check": "tsc --noEmit",
    "lint": "eslint . --ext .ts,.tsx",
    "audit": "npm audit --audit-level=high",
    "pre-deploy-check": "node scripts/pre-deploy-check.js"
  }
}
```

### 7.5 Coverage Thresholds

| Area | Target | Current |
|------|--------|---------|
| Overall line coverage | > 80% | ~5% (billing only) |
| Auth module | > 95% | 0% |
| Route handlers | > 85% | ~25% (billing routes only) |
| Orchestrator state machine | > 90% | 0% |
| AI integration | > 80% (mocked) | 0% |
| BYOK tier logic | > 90% | 0% (not implemented) |
| Client components | > 60% | 0% |

---

## 8. DEVELOPMENT_MODE Removal Checklist

The following must be completed before ANY production deployment.

### 8.1 Server-Side

```typescript
// server/routes.ts:48
// BEFORE:
const DEVELOPMENT_MODE = true;
// AFTER:
const DEVELOPMENT_MODE = process.env.NODE_ENV !== "production";

// server/auth.ts:12
// BEFORE:
const DEVELOPMENT_MODE = process.env.NODE_ENV !== "production";
// AFTER: (correct already — but verify it's respected)
// ✅ This one is already correct — NODE_ENV based

// server/auth.ts:156
// The middleware already checks DEVELOPMENT_MODE — verify it works in production
// ✅ if (DEVELOPMENT_MODE) { return next(); } — correctly skips in prod
```

### 8.2 Client-Side

```typescript
// client/src/pages/auth-page.tsx:34
// BEFORE: const DEVELOPMENT_MODE = true;
// AFTER:  const DEVELOPMENT_MODE = import.meta.env.DEV;

// client/src/pages/subscribe-page.tsx:15
// BEFORE: const DEVELOPMENT_MODE = true;
// AFTER:  const DEVELOPMENT_MODE = import.meta.env.DEV;

// client/src/lib/protected-route.tsx:8
// BEFORE: const DEVELOPMENT_MODE = true;
// AFTER:  const DEVELOPMENT_MODE = import.meta.env.DEV;
```

### 8.3 Dev-Only Endpoint Gating

```typescript
// All dev endpoints must be wrapped:
if (process.env.NODE_ENV !== "production") {
  // POST /api/dev-login
  // POST /api/dev/quick-setup
  // POST /api/dev/update-models/:conversationId
  // POST /api/dev/test-artifacts/:conversationId
}
```

---

## 9. Pre-Deployment Gate Criteria

### Gate 1: Test Coverage

- [ ] All Phase A tests implemented and passing
- [ ] All Phase B tests implemented and passing
- [ ] Overall line coverage > 70%
- [ ] Auth module coverage > 95%
- [ ] Billing module coverage maintained (28 tests passing)

### Gate 2: Security

- [ ] All `DEVELOPMENT_MODE = true` removed from code
- [ ] Dev endpoints gated behind `NODE_ENV !== "production"` check
- [ ] `SESSION_SECRET` required (no random fallback)
- [ ] All passwords bcrypt-hashed in DB (verified via query)
- [ ] SSL configured for PostgreSQL connections
- [ ] Stripe webhook signature verified
- [ ] npm audit passes with 0 high/critical vulnerabilities
- [ ] BYOK encryption key configured (`ENCRYPTION_KEY` env var)

### Gate 3: Performance

- [ ] API response p50 < 200ms under 50 concurrent users
- [ ] No memory leaks after 1-hour run (heap stable)
- [ ] WebSocket connections stable under 100 concurrent
- [ ] Database query plans verified (no sequential scans on indexed columns)

### Gate 4: BYOK & Tier

- [ ] BYOK API key encryption/decryption working
- [ ] Tier enforcement tested (expert limits, model filtering)
- [ ] Free tier blocked from paid models
- [ ] Upgrade CTAs functional
- [ ] Stripe multi-tier products configured (Pro $19/mo, Enterprise $49/mo)

### Gate 5: Production Config

- [ ] `.env.production` file created with all required vars
- [ ] `NODE_ENV=production` set
- [ ] `npm run build` succeeds
- [ ] `npm run start` launches without errors
- [ ] Health check endpoint returns 200
- [ ] All Stripe keys are live keys (not test mode)

---

## Appendix A: Test Environment Setup

### A.1 Required Environment Variables for Testing

```bash
# .env.test
DATABASE_URL=postgresql://test:test@localhost:5432/farm_roundtable_test
SESSION_SECRET=test-secret-not-random
NODE_ENV=test
OPENROUTER_API_KEY=sk-or-mock-test-key
STRIPE_SECRET_KEY=sk_test_mock
STRIPE_PRICE_ID=price_mock
STRIPE_WEBHOOK_SECRET=whsec_mock
OWM_API_KEY=mock-owm-key
ENCRYPTION_KEY=mock-aes-256-key-32chars!!
```

### A.2 Test Database Setup Script

```bash
#!/bin/bash
# scripts/setup-test-db.sh

createdb farm_roundtable_test 2>/dev/null
echo "Test database ready: farm_roundtable_test"

# Push schema
DATABASE_URL=postgresql://test:test@localhost:5432/farm_roundtable_test \
  npx drizzle-kit push
echo "Schema pushed to test database"
```

### A.3 Mocking Strategy

| Service | Mock Method | Reason |
|---------|------------|--------|
| Stripe SDK | `vi.mock("stripe")` | Already implemented in billing.test.ts |
| OpenRouter API | `vi.mock` fetch or nock | Avoid real API calls/costs |
| Perplexity API | `vi.mock` fetch or nock | Avoid real API calls/costs |
| OpenWeatherMap | `vi.mock` fetch or nock | Avoid rate limits |
| PostgreSQL | Set `DATABASE_URL=""` to force MemStorage | Unit test isolation |
| WebSocket | `ws` mock or in-memory event emitter | Test without network |

---

## Appendix B: Quick Reference — All API Endpoints for Testing

```
AUTH
  POST   /api/register                    # Create account
  POST   /api/login                       # Login (rate-limited)
  POST   /api/logout                      # Destroy session
  GET    /api/user                        # Current user info
  POST   /api/dev-login                   # [DEV ONLY] Quick login

STRIPE / BILLING
  GET    /api/subscription-status         # Check subscription
  POST   /api/create-subscription         # Start subscription
  POST   /api/webhook                     # Stripe webhook receiver

BYOK / TIER (planned — MONETIZATION_PLAN.md)
  POST   /api/user/api-key                # Save user's OpenRouter key
  GET    /api/user/api-key/status         # Check key status (masked)
  POST   /api/validate-openrouter-key     # Validate an OpenRouter key

CONVERSATIONS
  POST   /api/protected/conversations                    # Create
  GET    /api/protected/conversations                    # List
  GET    /api/protected/conversations/:id                # Get one
  POST   /api/protected/conversations/:id/experts        # Add expert
  GET    /api/protected/conversations/:id/experts        # List experts
  POST   /api/protected/conversations/:id/messages       # Send message
  GET    /api/protected/conversations/:id/messages       # Get messages
  POST   /api/protected/conversations/:id/files          # Upload file
  GET    /api/protected/conversations/:id/files          # List files
  POST   /api/protected/conversations/:id/generate-file  # AI gen file
  GET    /api/protected/conversations/:id/insights       # Get insights
  POST   /api/protected/conversations/:id/generate-insights  # Generate
  GET    /api/protected/conversations/:id/export         # Export markdown

ORCHESTRATOR CONTROL
  POST   /api/protected/conversations/:id/pause          # Pause processing
  POST   /api/protected/conversations/:id/resume         # Resume processing
  POST   /api/protected/conversations/:id/autonomous/enable   # Enable auto
  POST   /api/protected/conversations/:id/autonomous/disable  # Disable auto

EXPERTS
  PATCH  /api/experts/:expertId            # Update expert settings

FARM PROFILE
  GET    /api/protected/farm-profile       # Get profile + weather
  PUT    /api/protected/farm-profile       # Create/update profile

DEV ONLY (must be disabled in production)
  POST   /api/dev/quick-setup              # Create test roundtable
  POST   /api/dev/update-models/:id        # Bulk update expert models
  POST   /api/dev/test-artifacts/:id       # Create test artifact message

WEBSOCKET
  WS     /ws                               # Real-time streaming + state
```

---

## Appendix C: Risk Register

| Risk | Severity | Likelihood | Current Mitigation | Residual Risk |
|------|----------|------------|-------------------|---------------|
| `DEVELOPMENT_MODE=true` in production | **Critical** | High | Manual check required | High — no automated check |
| No auth tests | **Critical** | High | None | Critical — blocking |
| No orchestrator tests | High | Medium | None | High |
| No AI integration tests | High | Medium | None | High |
| No BYOK encryption tests | High | Medium | Not yet implemented | High |
| Memory leak in orchestrator loop | Medium | Low | Manual testing only | Medium |
| Stripe webhook idempotency failure | Medium | Low | Test covers basic case | Low |
| PostgreSQL connection pool exhaustion | Medium | Low | Pool max set to 10 | Low |
| WebSocket client disconnection handling | Medium | Medium | Not tested | Medium |
| Weather API rate limit (1k/day free) | Low | Medium | 30-min cache | Low |

---

*This validation plan is a living document. Update it as test coverage expands and new features are implemented. All gates must be met before any production deployment.*
