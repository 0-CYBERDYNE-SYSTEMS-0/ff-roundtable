# Production Sprint — SPEC & CONTRACT

**Branch:** `prod-sprint` (from `main` @ `9935b7e`)
**Agent:** Hermes (deepseek-v4-pro via opencode-go)
**Status:** PENDING APPROVAL — DO NOT EXECUTE

---

## TL;DR What We're Building

Three phases, delivered in order. Each phase independently verifiable. Foundation → UX multiplier → Moat.

| Phase | What | Impact |
|-------|------|--------|
| 1 | PostgreSQL persistence + proper auth | Goes from demo → deployable |
| 2 | Streaming expert responses via WebSocket | Goes from "is it broken?" → "holy shit it's alive" |
| 3 | Farm profiles + weather integration | Goes from generic chatbot → agricultural product |

---

## Phase 1 — Persistence & Production Readiness

### What Changes

**1a. Database**
- Create `farm_roundtable_dev` database on local PostgreSQL 16
- Implement `PostgresStorage` class implementing `IStorage`
- Write Drizzle migration SQL, push schema
- Swap `storage` import from MemStorage → PostgresStorage based on `DATABASE_URL` env var
- Keep MemStorage as fallback for dev without DB

**1b. Auth Hardening**
- Replace `dev:password` with bcrypt hashing
- Add login rate limiting (express-rate-limit, 5 attempts/15min per IP)
- Session secret required from env (no more random fallback)

**1c. Config**
- Create `.env.example` with all required vars documented
- Create `scripts/setup-db.sh` to create DB + push schema
- Add `npm run db:setup` script

### Verification
```bash
# 1. Start fresh — no data
npm run db:setup
npm run dev

# 2. Register a user, create conversation, add experts, send messages
# 3. Kill server, restart — all data persists
# 4. Login with wrong password 6 times — rate limited
# 5. Check passwords in DB are bcrypt hashes, not dev:password
```

### Files Touched
- `server/storage.ts` — add PostgresStorage class (~150 lines)
- `server/routes.ts` — swap storage import  
- `server/auth.ts` — bcrypt + rate limiting
- `shared/schema.ts` — no changes needed
- `.env.example` — new
- `scripts/setup-db.sh` — new
- `drizzle.config.ts` — update for local DB
- `package.json` — add db:setup script

---

## Phase 2 — Streaming Expert Responses

### What Changes

**2a. Server: Streaming AI Calls**
- New `callOpenRouterAPIStream()` function using `fetch` + `ReadableStream`
- Parses SSE chunks (`data: {"choices":[{"delta":{"content":"..."}}]}`)
- Yields tokens via async generator
- Falls back to non-streaming if streaming fails

**2b. Server: WebSocket Streaming Protocol**
- New WS message type: `expert_stream_token` — single token with expert context
- New WS message type: `expert_stream_done` — signals expert finished (final message with artifacts)
- Orchestrator broadcasts `expert_stream_start` before first token (expertId, expertName, expertRole)
- Client receives tokens and renders them in real-time

**2c. Client: Streaming UI**
- ChatInterface handles `expert_stream_start` — creates empty message bubble with animation
- Appends tokens to the bubble as they arrive
- On `expert_stream_done` — finalizes message, extracts artifacts, renders markdown
- Typing indicator (animated dots) on expert card when that expert is currently streaming
- No layout shift — bubble dimensions stable during streaming

### Verification
```bash
npm run dev
# Send a message to the roundtable
# Watch first expert's response appear TOKEN BY TOKEN in real-time
# Expert card shows "typing..." indicator
# Second expert starts after first finishes
# No page jumps, smooth transitions
```

### Files Touched
- `server/ai.ts` — add `callOpenRouterAPIStream()`, keep original as fallback
- `server/orchestrator.ts` — integrate streaming, broadcast start/token/done
- `server/routes.ts` — no changes needed (orchestrator handles broadcasting)
- `client/src/lib/websocket-utils.ts` — add streaming message types
- `client/src/pages/home-page.tsx` — handle streaming WS events
- `client/src/components/chat/ChatInterface.tsx` — streaming message bubble
- `client/src/components/roundtable/ExpertCard.tsx` — typing indicator

---

## Phase 3 — Farm Profiles & Weather Intelligence

### What Changes

**3a. Farm Profile**
- New `farm_profiles` table (userId, farmName, location, lat, lng, acres, crops[], soilType, waterSource, climateZone, hardinessZone)
- New API routes: `GET/PUT /api/protected/farm-profile`
- Onboarding modal on first login (or when no profile exists)
- Farm profile injected into expert system prompts as "FARMER CONTEXT" block
- Experts now give personalized advice: "Based on your 50 acres of corn in loam soil in Zone 6b..."

**3b. Weather Integration**
- OpenWeatherMap OneCall API 3.0 (free tier: 1,000 calls/day)
- New `weather_cache` table (lat, lng, data, fetched_at) — cache for 30 minutes
- Weather context injected into expert prompts: "Current conditions at the farm: 72°F, partly cloudy, wind 12mph NW. 5-day forecast: rain expected Thursday."
- Experts can reference real weather when discussing irrigation, planting, pest pressure
- `OWM_API_KEY` env var (optional — experts degrade gracefully without it)

**3c. Expert Personalization**
- `generateSystemPrompt()` accepts optional `FarmProfile`
- Adds farm context block after base prompt
- Expert roles get farm-specific guidance (e.g., Soil Scientist sees soil type, Irrigation Engineer sees water source)

### Verification
```bash
npm run dev
# First login → see farm profile onboarding modal
# Fill it out: "Green Acres Farm, Iowa, 200 acres corn+soy, clay loam, irrigation wells, Zone 5b"
# Ask "what should I be doing this week given the weather?"
# Expert responses reference actual current weather from OpenWeatherMap
# Expert responses reference YOUR farm's specific crops, soil, acreage
# Ask "what's my biggest pest risk right now?" — Pest Management expert knows your crops + weather
```

### Files Touched
- `shared/schema.ts` — add farm_profiles + weather_cache tables
- `server/storage.ts` — add PostgresStorage farm profile methods
- `server/routes.ts` — add farm profile + weather routes
- `server/ai.ts` — farm-aware system prompts, weather injection
- `server/weather.ts` — new: OpenWeatherMap client + cache
- `client/src/pages/home-page.tsx` — profile check on load
- `client/src/components/farm/FarmProfileModal.tsx` — new: onboarding form
- `client/src/components/farm/FarmContextBadge.tsx` — new: shows current farm/weather in header
- `.env.example` — add OWM_API_KEY

---

## Contract Terms

**I will:**
1. Execute phases in order (1 → 2 → 3)
2. Commit after each phase with clear messages
3. Verify each phase works before moving to the next
4. Run typecheck after each phase (`npm run check`)
5. Not delete or break existing functionality
6. Keep MemStorage as fallback so existing dev flow still works
7. Write clean, documented, testable code
8. Use sub-agents for parallelizable work within phases
9. Flag blockers immediately — don't silently struggle

**I won't:**
1. Touch Stripe integration (beyond env config)
2. Change the orchestrator's core state machine logic
3. Remove any existing features
4. Push to remote or deploy without explicit approval
5. Install global packages or modify system config outside this project

---

## Estimated Scope

| Phase | Lines Changed | Risk | Time Estimate |
|-------|--------------|------|---------------|
| 1 | ~250 new + ~50 modified | Low | ~1 session |
| 2 | ~300 new + ~150 modified | Medium (streaming is tricky) | ~1-2 sessions |
| 3 | ~400 new + ~100 modified | Medium (external API dep) | ~1-2 sessions |

---

**⛔ STOP — AWAITING APPROVAL**

Reply with:
- "approved" or "go" → I start Phase 1 immediately
- "approved for phase X only" → I do that phase and stop
- Changes / questions → I revise and re-present
