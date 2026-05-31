# Security Audit — FarmFriend Roundtable PRO

**Audit Date:** 2026-05-30  
**Branch:** `validation-plan`  
**Scope:** Full codebase review (server, client, shared schema, configuration)  
**Severity Scale:**
| Rating | Definition |
|---------|------------|
| 🔴 **Critical** | Immediate exploitation; data breach, full bypass of access controls |
| 🟠 **High** | Serious exploit path; significant data exposure or privilege escalation |
| 🟡 **Medium** | Notable weakness; requires chaining or specific conditions to exploit |
| 🟢 **Low** | Best-practice violation; hardening opportunity |
| ⚪ **Info** | Observation, not an active risk |

---

## 1. Hardcoded `DEVELOPMENT_MODE=true`
**Severity:** 🔴 Critical

### Locations
| File | Line | Declaration |
|------|------|-------------|
| `server/routes.ts` | 48 | `const DEVELOPMENT_MODE = true;` |
| `client/src/pages/auth-page.tsx` | 34 | `const DEVELOPMENT_MODE = true;` |
| `client/src/pages/subscribe-page.tsx` | 15 | `const DEVELOPMENT_MODE = true;` |
| `client/src/lib/protected-route.tsx` | 8 | `const DEVELOPMENT_MODE = true;` |

> **Note:** `server/auth.ts` line 12 correctly uses `process.env.NODE_ENV !== "production"`. This is the pattern all four files above should adopt.

### Impact
These four hardcoded booleans are NOT conditional on the environment. They remain `true` even when `NODE_ENV=production` is set. The consequences cascade through the entire application:

- **`server/routes.ts:48`** — Enables the entire `/api/dev-login`, `/api/dev/quick-setup`, `/api/dev/update-models`, and `/api/dev/test-artifacts` endpoints unconditionally (see Issue #2).
- **`server/auth.ts:156`** — The subscription-check middleware on all `/api/protected/*` routes is bypassed because `routes.ts:891` checks `if (DEVELOPMENT_MODE)` (the hardcoded `true`, not the auth.ts version). Every authenticated user gets free access to all features regardless of Stripe subscription status.
- **`client/src/lib/protected-route.tsx:8`** — Client-side subscription gate is skipped; the app never redirects unsubscribed users to `/subscribe`.
- **`client/src/pages/subscribe-page.tsx:15`** — Stripe payment UI is disabled/hidden; users see a "Development mode — subscription bypassed" message instead of the payment form.
- **`client/src/pages/auth-page.tsx:34`** — The "Quick Dev Login" button is always rendered in the UI.

### Remediation
1. Replace every instance of `const DEVELOPMENT_MODE = true;` with:
   ```typescript
   const DEVELOPMENT_MODE = process.env.NODE_ENV !== "production";
   ```
2. On the client side, use a build-time define injection via Vite:
   ```typescript
   // vite.config.ts
   define: {
     'import.meta.env.DEV_MODE': JSON.stringify(process.env.NODE_ENV !== 'production')
   }
   ```
3. After making the change, verify that `NODE_ENV=production npm start` disables all dev pathways.

---

## 2. Dev Login Endpoint Exposure
**Severity:** 🔴 Critical

### Locations
| Endpoint | File / Line | Trigger |
|----------|-------------|---------|
| `POST /api/dev-login` | `server/routes.ts:56` | `DEVELOPMENT_MODE=true` (hardcoded) |
| `POST /api/dev/quick-setup` | `server/routes.ts:80` | `devConfig.enabled=true` |
| `POST /api/dev/update-models/:id` | `server/routes.ts:118` | `devConfig.enabled=true` |
| `POST /api/dev/test-artifacts/:id` | `server/routes.ts:892` | `DEVELOPMENT_MODE=true` (hardcoded) |

### Impact
**`/api/dev-login`** — Any caller can POST to this endpoint (no credentials, no body required) and instantly authenticate as the `developer` user (username: `developer`, password: `password`). The `developer` user is seeded with `subscriptionStatus: 'active'`, granting full access to all protected features.

**`/api/dev/quick-setup`** — Creates a conversation with all experts from `dev-config.json` with one request. Requires prior authentication but the dev-login endpoint provides that trivially.

**`/api/dev/update-models`** — Modifies expert models in a conversation. Requires authentication + conversation ownership, but dev user can access this.

**`/api/dev/test-artifacts`** — Creates arbitrary test messages with artifacts into any conversation, broadcast to all WebSocket clients.

The `dev-config.json` file has `"enabled": true`, enabling the quick-setup and update-models routes on top of `DEVELOPMENT_MODE`.

### Remediation
1. Remove all four dev endpoints from the production build path entirely. Use an `if (process.env.NODE_ENV !== 'production')` guard.
2. Delete `dev-config.json` or set `"enabled": false` before deployment.
3. Remove the hardcoded `developer` user seed from `PostgresStorage.seedDevelopmentUser()` (line 336) and `MemStorage.addDevelopmentUser()` (line 99) — or guard them behind `NODE_ENV !== 'production'`.
4. Rotate the developer user's password and remove the `dev:` / `simple:` prefix backward-compatibility path in `comparePasswords()` (auth.ts:30-35), which allows plaintext password comparison.

---

## 3. API Key Handling
**Severity:** 🟠 High

### Locations
| Key | Where Used | File |
|-----|-----------|------|
| `OPENROUTER_API_KEY` | All AI model calls | `server/ai.ts:213,282` |
| `PERPLEXITY_API_KEY` | Research/web search | `server/ai.ts:365` |
| `STRIPE_SECRET_KEY` | Stripe customer/subscription API | `server/routes.ts:39-45` |
| `OWM_API_KEY` | OpenWeatherMap API | `server/weather.ts:53` |
| `SESSION_SECRET` | Session signing | `server/auth.ts:51-56` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook verification | `server/routes.ts:355` |

### Findings
1. **No key encryption at rest** — All API keys are read directly from `process.env` with no encryption layer. The `.env` file on disk contains plaintext secrets.
2. **No key validation on startup** — The server starts without verifying that required keys are present or valid. Missing `STRIPE_SECRET_KEY` logs a warning but continues. Missing `OPENROUTER_API_KEY` only throws at request time.
3. **No key rotation mechanism** — Keys are static environment variables with no support for rotation without restart.
4. **OpenRouter key exposed in request** — The `OPENROUTER_API_KEY` is sent as a `Bearer` token to an external API (openrouter.ai). While this is expected for a proxy API, there is no mechanism to validate per-user API keys (BYOK — "Bring Your Own Key").
5. **Session secret fallback insecure** — If `SESSION_SECRET` is not set (line 52-56), a `randomBytes(32).toString("hex")` value is generated at runtime. Every server restart invalidates all sessions. If running multiple instances, each has a different secret.
6. **Warning message logs user DB credentials** — `storage.ts:330` logs the database URL with only a cursory `replace(/\/\/.*@/, "//***@")`. This regex is fragile and may leak credentials in error logs.

### Remediation
1. Use a secrets manager (HashiCorp Vault, AWS Secrets Manager, Doppler) instead of `.env` files in production.
2. Add startup validation: refuse to start if `OPENROUTER_API_KEY` or other required keys are missing in production.
3. Always set a persistent `SESSION_SECRET` in production.
4. Sanitize ALL connection strings from logs, not just `DATABASE_URL`.
5. Implement BYOK support with per-user encrypted API key storage (as outlined in `MONETIZATION_PLAN.md`).

---

## 4. Session Management
**Severity:** 🟠 High

### Location
`server/auth.ts:55-64` — Session configuration

### Findings
1. **Cookie missing `httpOnly` flag** — The session cookie (line 60-63) sets `maxAge` and `secure` but does NOT set `httpOnly: true`. JavaScript running in the browser can read the session cookie, making it vulnerable to XSS-based session theft.
2. **Cookie missing `sameSite` flag** — No `sameSite` attribute is set (defaults to `Lax` in modern browsers, but explicitly setting `sameSite: "strict"` or `"lax"` is a best practice that prevents CSRF).
3. **Session secret not persistent** — As noted above, the fallback to `randomBytes(32)` (line 56) regenerates the secret on every restart, invalidating all sessions. If no `SESSION_SECRET` env var is set in production, users are logged out on every deploy.
4. **Session maxAge is 30 days** — This is generous; consider a shorter default with refresh tokens.
5. **No session regeneration on login** — After successful authentication via Passport, the session ID is not regenerated (no `req.session.regenerate()`), making the application theoretically vulnerable to session fixation attacks.
6. **No concurrent session detection** — A user can have unlimited simultaneous sessions from different devices/IPs with no way to detect or revoke them.

### Remediation
```typescript
cookie: {
  maxAge: 24 * 60 * 60 * 1000, // 24 hours (reduce from 30 days)
  secure: process.env.NODE_ENV === "production",
  httpOnly: true,              // ADD
  sameSite: "strict",          // ADD
}
```
Additionally:
- Set a persistent `SESSION_SECRET` environment variable.
- Regenerate session after login: `req.session.regenerate(() => { req.login(user, ...) })`.
- Store session metadata (IP, user-agent) for anomaly detection.

---

## 5. Rate Limiting Coverage
**Severity:** 🟡 Medium

### Current State
| Endpoint | Rate Limited? | Configuration |
|----------|---------------|---------------|
| `POST /api/login` | ✅ Yes | 5 attempts / 15 min / IP |
| `POST /api/register` | ❌ No | — |
| `POST /api/protected/conversations/:id/messages` | ❌ No | — |
| `POST /api/protected/conversations/:id/files` | ❌ No | — |
| `POST /api/dev-login` | ❌ No | — |
| `POST /api/webhook` | ❌ No | — |
| All AI/LLM proxy routes | ❌ No | — |

### Impact
- **Registration abuse** — An attacker can create unlimited user accounts via `/api/register` with no throttling.
- **AI cost exhaustion** — Without rate limiting on message endpoints, an authenticated user (or attacker with a stolen session) can send unlimited messages to AI models, racking up API costs through OpenRouter.
- **File upload DoS** — No rate limit on file uploads; an attacker can exhaust disk space.
- **Brute force on dev-login** — If the dev-login endpoint is inadvertently exposed (see Issue #2), there's no rate limit to slow brute force attacks (though the endpoint doesn't require credentials anyway).

### Remediation
1. Add rate limiting to the registration endpoint:
   ```typescript
   const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 3, ... });
   app.post("/api/register", registerLimiter, ...);
   ```
2. Add per-user rate limiting on AI message endpoints (e.g., 20 requests per minute per user).
3. Add rate limiting on file uploads (e.g., 10 uploads per hour per user).
4. Consider a global rate limiter as a catch-all for unlisted routes.
5. Use `express-rate-limit` with Redis/Memcached store for distributed deployments (the default in-memory store won't work across multiple instances).

---

## 6. File Upload Validation
**Severity:** 🟠 High

### Location
`server/routes.ts:30-35, 636-673, 676-715`

### Current Multer Configuration
```typescript
const upload = multer({
  dest: path.join(process.cwd(), "uploads"),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});
```

### Findings
1. **No file type filtering** — Multer accepts ANY file type. An attacker can upload executable scripts (`.php`, `.js`, `.sh`, `.exe`), HTML files with embedded JavaScript, or other malicious content.
2. **No extension allowlist** — The `fileFilter` option is unused; any file extension is accepted.
3. **Files served from `uploads/` directory** — The `fileUrl` is stored as `/uploads/<filename>`. If the Express static middleware or Vite serves this directory, uploaded scripts could be executed by navigating to their URL. (Check: Is `/uploads` served statically? The `server/vite.ts` serves from `dist/public` or uses Vite middleware, but the uploads directory may be accessible through the Express middleware chain.)
4. **Path traversal in file generation** — The `POST /api/protected/conversations/:id/generate-file` endpoint (line 676) sanitizes filenames with `.replace(/[^a-zA-Z0-9_.-]/g, "_")` (line 689), which is good. However, the generated file path is `path.join(uploadsDir, uniqueFileName)` — since `uniqueFileName` is prefixed with `randomBytes(8)`, path traversal is mitigated. But the content (`req.body.content`, line 700) is written directly to disk with no validation of what's being written.
5. **No file content validation** — Uploaded files are stored and their path is recorded. There's no virus scanning, no content-type verification against magic bytes, and no size check beyond the 10MB limit.
6. **No upload ownership enforcement on retrieval** — While the upload endpoint checks conversation ownership, the file record is stored with a public URL path. Files are not scoped by user at the filesystem level.

### Remediation
1. Add a `fileFilter` to multer that allows only specific MIME types and extensions:
   ```typescript
   const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'text/plain', 
                          'text/csv', 'application/pdf', 'application/json'];
   const upload = multer({
     fileFilter: (req, file, cb) => {
       if (allowedMimes.includes(file.mimetype)) cb(null, true);
       else cb(new Error('File type not allowed'));
     }
   });
   ```
2. Store uploads outside the web root (e.g., `/data/uploads/`), not under `process.cwd()`.
3. Serve uploaded files through an authenticated endpoint rather than as static files:
   ```typescript
   app.get("/api/files/:id", authenticate, async (req, res) => {
     // Verify user owns the conversation containing this file
     // Stream the file from the secure storage directory
   });
   ```
4. Add content scanning (e.g., ClamAV) for uploaded files in production.
5. Validate `req.body.content` in the generate-file endpoint — enforce size limits and reject binary/executable content.
6. Add rate limiting on file upload endpoints (see Issue #5).

---

## 7. WebSocket Security
**Severity:** 🔴 Critical

### Location
`server/routes.ts:157-274` (server-side), `client/src/lib/websocket-utils.ts` (client-side)

### Findings
1. **No authentication on WebSocket connections** — The WebSocket server (`wss`) accepts ALL connections without any authentication check. The `connection` event handler (line 165) immediately sends a welcome message. There is no token validation, no session cookie check, no origin verification.
2. **No authorization on broadcasts** — The `broadcastToConversation()` function (line 192) sends data to **ALL connected WebSocket clients**, regardless of which conversation or user the data belongs to. Every connected client receives every message from every conversation. This is a massive information disclosure vulnerability.
3. **No origin validation** — Any website can open a WebSocket connection to `wss://<host>/ws` and receive all broadcast data, including AI expert responses, user messages, and conversation metadata.
4. **No rate limiting** — A client can flood the WebSocket with messages; the server logs them but does not disconnect abusive clients.
5. **No heartbeat/ping mechanism** — Stale connections are not detected or cleaned up.
6. **No TLS enforcement** — While the client code (websocket-utils.ts:12) detects `https:` and uses `wss:`, the server does not enforce or require secure WebSocket connections.

### Impact
Any user (or non-user) can:
- Connect to the WebSocket and receive real-time streaming of ALL conversations, AI model responses, farm profiles, and insights — across ALL users of the application.
- Potentially inject messages (if the server processes incoming WebSocket messages beyond logging).

### Remediation
1. **Authenticate WebSocket connections** by checking the session cookie during the upgrade handshake:
   ```typescript
   const wss = new WebSocketServer({ 
     server: httpServer,
     path: "/ws",
     verifyClient: (info, cb) => {
       // Parse session cookie from info.req.headers.cookie
       // Verify against session store
       // cb(true) or cb(false, 401, "Unauthorized")
     }
   });
   ```
2. **Implement connection-to-conversation mapping.** Have the client send a `{ type: "subscribe", conversationId: N }` message upon connection. Store a `Map<WebSocket, Set<conversationId>>` on the server. Modify `broadcastToConversation()` to only send to clients subscribed to that conversation ID.
3. **Verify conversation ownership** when a client subscribes: ensure the authenticated user owns conversation `N`.
4. Add origin header validation.
5. Implement per-connection rate limiting and heartbeat/pong.

---

## 8. Stripe Webhook Validation
**Severity:** 🟡 Medium (in production), currently not fully functional

### Location
`server/routes.ts:352-419`

### Findings
1. **Raw body not preserved** — Stripe's `constructEvent()` requires the **raw, unparsed request body** to verify the webhook signature. However, `express.json()` middleware (`server/index.ts:7`) parses the body BEFORE the route handler receives it. This means `req.body` is a parsed JavaScript object, not the raw buffer. The signature verification at line 364 will **fail silently or throw**, making the webhook endpoint non-functional. Stripe webhook events will never be processed.
2. **Broken user lookup** — The webhook handler (lines 381-383, 402-404) attempts to find the user by iterating: `[...Array(100)].map((_, i) => storage.getUser(i)).filter(Boolean)`. This only checks user IDs 0-99. In PostgreSQL with auto-increment, user IDs start at 1 and can exceed 100 quickly. Even worse, `getUser(i)` for non-existent IDs returns `undefined`, so the array will be mostly `undefined` values. This is a fundamentally broken approach.
3. **No idempotency handling** — Stripe may deliver the same event multiple times. The handler does not track processed event IDs, so `invoice.payment_succeeded` could update the subscription status redundantly (low risk, but best practice is to log processed events).
4. **Hardcoded Stripe API version** — `apiVersion: "2023-10-16"` (line 41) is hardcoded and may become deprecated.

### Remediation
1. Preserve the raw body for the webhook route:
   ```typescript
   // In index.ts, before express.json():
   app.use('/api/webhook', express.raw({ type: 'application/json' }));
   // Then express.json() for all other routes
   ```
2. Replace the broken user lookup with a proper query by `stripeSubscriptionId`:
   ```typescript
   // In storage, add a method:
   async getUserByStripeSubscriptionId(subscriptionId: string): Promise<User | undefined> {
     const result = await this.db.select().from(users)
       .where(eq(users.stripeSubscriptionId, subscriptionId)).limit(1);
     return result[0];
   }
   ```
3. Add idempotency: store processed `event.id` values in a database table and skip duplicates.
4. Update to the latest Stripe API version and consider using `stripe.webhooks.constructEvent()` with dynamic versioning.

---

## 9. Database Query Injection Risks
**Severity:** 🟢 Low

### Location
`server/storage.ts` (all PostgresStorage methods)

### Assessment
The codebase uses **Drizzle ORM** with **parameterized queries** throughout. All database operations in `PostgresStorage` use the query builder pattern (e.g., `db.select().from(users).where(eq(users.id, id))`), which generates parameterized SQL. This is the correct approach and eliminates SQL injection risk for Drizzle-generated queries.

However, the following concerns exist:

1. **`checkDatabaseConnection()` uses raw SQL** — Line 618: `(storage as any).pool.query("SELECT 1")`. This is a static query with no user input, so it's safe. But if raw queries are added in the future, they must use parameterized placeholders.

2. **No input validation on API endpoints** — While Drizzle prevents SQL injection, many API endpoints pass `req.body` directly to storage methods without Zod validation:
   - `POST /api/protected/conversations` — `req.body.title` used directly
   - `POST /api/protected/conversations/:id/experts` — `req.body.name`, `role`, `model`, `avatarUrl` used directly
   - `PUT /api/protected/farm-profile` — entire `req.body` passed to `upsertFarmProfile()`
   - `PATCH /api/experts/:expertId` — `req.body.name`, `model`, `customInstructions` used directly

   While these don't create SQL injection (Drizzle handles escaping), they allow arbitrary string data (e.g., script tags, excessively long strings) into the database, which could lead to stored XSS or denial of service via oversized data.

3. **Artifact content is stored as JSON** — The `messages.artifacts` column (JSON type) stores AI-generated content. If the AI generates malicious HTML/JavaScript that's later rendered unsafely, this becomes a stored XSS vector. The frontend does use DOMPurify (see `ArtifactDisplay.tsx:19`), which mitigates this.

### Remediation
1. Apply Zod validation schemas to ALL API endpoints that accept user input. The schema definitions already exist in `shared/schema.ts` — use them.
2. Add `maxLength` constraints on text fields via Zod.
3. Validate the `model` field in expert creation to ensure it matches an allowlist of known model IDs.
4. Never introduce raw SQL string concatenation — always use Drizzle's parameterized query builder or `pool.query($1, [param])`.

---

## 10. CORS Configuration
**Severity:** 🟠 High (for production)

### Location
`server/index.ts` — Entry point for Express app

### Current State
**No CORS middleware is installed or configured.** The `cors` npm package is NOT listed as a dependency in `package.json`. There are zero references to CORS anywhere in the codebase.

The server binds to `0.0.0.0` (line 66: `host: "0.0.0.0"`), meaning it accepts connections from any network interface.

### Impact
- **No browser-request restriction** — In a standard deployment where the frontend and API are on the same origin, CORS may not be strictly necessary for same-origin requests. However, if the API is ever accessed cross-origin (e.g., from a different subdomain, during development with Vite's HMR on a different port, or by third-party integrations), the browser will block requests and the application will fail silently.
- **Overly permissive or undefined behavior** — Without CORS headers, the browser's default same-origin policy applies. But if someone adds a permissive CORS config (e.g., `Access-Control-Allow-Origin: *`), it opens the API to cross-site request forgery and data exfiltration from any origin.
- **Missing security headers** — Beyond CORS, the server lacks:
  - `Content-Security-Policy` (prevents XSS)
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Strict-Transport-Security` (HSTS)
  - `Referrer-Policy`
  - `Permissions-Policy`

### Remediation
1. Install and configure `cors`:
   ```bash
   npm install cors
   npm install -D @types/cors
   ```
2. Add a restrictive CORS policy:
   ```typescript
   import cors from 'cors';
   app.use(cors({
     origin: process.env.ALLOWED_ORIGINS?.split(',') || 'http://localhost:5001',
     credentials: true,
     methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
     allowedHeaders: ['Content-Type', 'Authorization'],
   }));
   ```
3. Install `helmet` for security headers:
   ```bash
   npm install helmet
   ```
   ```typescript
   import helmet from 'helmet';
   app.use(helmet({
     contentSecurityPolicy: false, // Or configure properly for your SPA
   }));
   ```

---

## Summary of Findings

| # | Issue | Severity | Action Required |
|---|-------|----------|-----------------|
| 1 | Hardcoded `DEVELOPMENT_MODE=true` (4 files) | 🔴 Critical | Replace with env-conditional check |
| 2 | Dev login endpoint exposed | 🔴 Critical | Gate behind `NODE_ENV !== 'production'` or remove entirely |
| 3 | API keys unencrypted, no validation | 🟠 High | Use secrets manager; validate on startup |
| 4 | Session cookies lack httpOnly/sameSite; no session regeneration | 🟠 High | Add `httpOnly`, `sameSite`, regenerate on login |
| 5 | Rate limiting only on login endpoint | 🟡 Medium | Add limits to register, AI messages, file uploads |
| 6 | File uploads: no type filtering, served from web root | 🟠 High | Add fileFilter, store outside web root, serve via auth endpoint |
| 7 | WebSocket: no auth, broadcasts to ALL clients | 🔴 Critical | Authenticate connections; implement per-conversation subscriptions |
| 8 | Stripe webhook: raw body not preserved; broken user lookup | 🟡 Medium | Use express.raw(); add proper `getUserByStripeSubscriptionId` query |
| 9 | No input validation on API endpoints (not SQLi, but data integrity) | 🟢 Low | Apply Zod schemas to all endpoints |
| 10 | No CORS, no helmet, no security headers | 🟠 High | Add cors + helmet with restrictive policies |

### Additional Observations
- **Backward-compatible plaintext passwords** — `auth.ts:30-35` supports `dev:` and `simple:` password prefixes that bypass bcrypt. These should be removed in production.
- **Verbose debug logging** — Multiple `console.log('[DEBUG]')` calls in `ai.ts` log internal API request details. In production, these could leak model names, prompt structures, and timing information to logs.
- **Unvalidated redirect in Vite middleware** — `vite.ts:44` uses `app.use("*", ...)` with `req.originalUrl` to serve the SPA. While not a traditional open redirect (it serves HTML, not a 302), it could be used for phishing if combined with reflected content.
- **No Content Security Policy** — The frontend renders AI-generated HTML content (via DOMPurify). A CSP header would provide defense-in-depth against XSS.
- **No dependency vulnerability scanning** — No `npm audit` or Snyk/Dependabot integration was observed in the project configuration.
