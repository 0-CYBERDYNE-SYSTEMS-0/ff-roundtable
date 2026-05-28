# Farm Friend Roundtable — Monetization & OpenRouter Onboarding Plan
**Status:** PENDING APPROVAL — DO NOT EXECUTE
**Agent:** Hermes (kimi-k2.6)
**Date:** 2026-05-14

---

## 1. CURRENT STATE AUDIT

### What I Found

| Component | Current State |
|-----------|---------------|
| **API Provider** | OpenRouter (single `OPENROUTER_API_KEY` env var, server-side only) |
| **Expert Models** | Hardcoded defaults per role (deepseek-v3.2, claude-3.5-sonnet, gpt-4o, etc.) |
| **Model Selection** | ExpertSelector fetches live OpenRouter model list; user can pick any model per expert |
| **Billing** | Stripe subscription exists (`/api/create-subscription`, webhook handlers) but **DEV_MODE=true bypasses all checks** |
| **Auth** | Passport-local with bcrypt; dev login at `/api/dev-login` (developer/password) |
| **Hosting** | Local dev only (port 5001); `DEVELOPMENT_MODE = true` hardcoded in routes.ts |
| **User Schema** | `subscriptionStatus`, `stripeCustomerId`, `stripeSubscriptionId` already in DB |
| **Farm Profile** | Full persistence + weather integration (Phase 3 complete) |
| **Streaming** | WebSocket token-by-token streaming (Phase 2 complete) |

### The Core Problem
Right now, **you** (the operator) pay for every API call. Users pay you via Stripe subscription, but the app has no mechanism for users to bring their own API key. That means:
- Free users = you eat the cost
- Subscribed users = you still eat the cost (just less per user)
- No viral loop — users can't self-serve without your infra

---

## 2. THE STRATEGIC PIVOT: BYOK + SaaS HYBRID

### The Pitch to Users

> **"Use Farm Friend Roundtable FREE with your own OpenRouter key — or subscribe for hassle-free access."**

This is the **Bring Your Own Key (BYOK)** model. It works because:
1. OpenRouter has **25+ genuinely free models** (Nemotron 3 Super, Gemma 4, Qwen3, etc.)
2. OpenRouter free tier = **50 requests/day, 20 RPM** — plenty for a farmer testing the product
3. OpenRouter paid = pay-as-you-go, no monthly minimum — users only pay for what they use
4. **You are NOT the middleman for API costs** — huge margin relief

### The Funnel

```
LANDING PAGE
     ↓
SIGN UP (free, no CC)
     ↓
ONBOARDING: "Get your free OpenRouter API key in 2 minutes"
     ↓
┌─────────────────┬─────────────────┐
│   FREE TIER     │  PAID TIER      │
│   (BYOK)        │  ($X/mo)        │
│                 │                 │
│ • User's own    │ • We provide    │
│   OpenRouter key│   OpenRouter key│
│ • Free models   │ • Any model     │
│   only          │ • Priority      │
│ • 3 experts max │   streaming     │
│ • Basic farm    │ • Unlimited     │
│   profile       │   experts       │
│ • No insights   │ • Full insights │
│   export        │ • Export/markdown│
│ • Community     │ • Priority      │
│   support       │   support       │
└─────────────────┴─────────────────┘
     ↓
FREE USERS CONVERT WHEN:
• They hit the 3-expert limit
• They want premium models (Claude, GPT-4)
• They want insights export
• They don't want to manage an API key
```

---

## 3. TECHNICAL ARCHITECTURE CHANGES

### 3.1 Database Schema Additions

```sql
-- Add to users table
ALTER TABLE users ADD COLUMN openrouter_api_key TEXT;        -- encrypted
ALTER TABLE users ADD COLUMN api_key_provider TEXT DEFAULT 'platform'; -- 'platform' | 'user'
ALTER TABLE users ADD COLUMN plan_tier TEXT DEFAULT 'free';   -- 'free' | 'pro' | 'enterprise'
ALTER TABLE users ADD COLUMN max_experts INTEGER DEFAULT 3;
ALTER TABLE users ADD COLUMN allows_paid_models BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN monthly_message_quota INTEGER DEFAULT 100; -- for platform-key users
ALTER TABLE users ADD COLUMN messages_used_this_month INTEGER DEFAULT 0;
```

### 3.2 Server-Side Changes

**File: `server/routes.ts`**

Add new endpoints:
```typescript
// Save user's own OpenRouter API key (encrypted at rest)
POST /api/user/api-key
  body: { apiKey: string }
  // Encrypt with AES-256-GCM using server secret
  // Store in users.openrouter_api_key

// Get user's API key status (masked)
GET /api/user/api-key/status
  returns: { hasKey: boolean, provider: 'platform' | 'user', maskedKey: string }

// Validate an OpenRouter key (check credits, rate limits)
POST /api/validate-openrouter-key
  body: { apiKey: string }
  returns: { valid: boolean, creditsRemaining?: number, rateLimit?: string }
```

**File: `server/ai.ts`**

Modify `callOpenRouterAPI()` to accept a per-request key:
```typescript
export async function callOpenRouterAPI(
  messages: AIMessage[], 
  model: string,
  apiKey?: string  // <-- NEW: user's own key
): Promise<AIModelResponse> {
  const key = apiKey || process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("No API key available");
  // ... rest unchanged
}
```

**File: `server/orchestrator.ts`**

Pass the user's API key through the orchestrator:
```typescript
// In processNextTurn(), fetch user's key before calling expert
const user = await storage.getUser(conversation.userId);
const apiKey = user.apiKeyProvider === 'user' 
  ? decrypt(user.openrouterApiKey) 
  : process.env.OPENROUTER_API_KEY;

// Pass to getExpertResponseStream()
const expertResponse = await getExpertResponseStream(
  currentExpert, history, referenceMessageContent, files, availableRoles,
  onToken,
  apiKey  // <-- NEW
);
```

**File: `server/auth.ts`**

Update subscription middleware:
```typescript
app.use("/api/protected", (req, res, next) => {
  if (!req.isAuthenticated()) return res.status(401).json({ message: "Unauthorized" });
  
  const user = req.user as SelectUser;
  
  // FREE tier users with BYOK: allow access
  if (user.planTier === 'free' && user.apiKeyProvider === 'user') {
    return next();
  }
  
  // FREE tier users WITHOUT BYOK: block (they need to add a key or subscribe)
  if (user.planTier === 'free' && user.apiKeyProvider === 'platform') {
    return res.status(403).json({ 
      message: "Add your OpenRouter API key or subscribe to continue",
      code: "NO_API_KEY"
    });
  }
  
  // PAID users: always allow
  if (user.planTier === 'pro' || user.planTier === 'enterprise') {
    return next();
  }
  
  next();
});
```

### 3.3 Client-Side Changes

**New Component: `client/src/components/settings/OpenRouterSetupModal.tsx`**

A beautiful, step-by-step modal that:
1. Explains what OpenRouter is ("One API key = access to 400+ AI models")
2. Shows the **free models available** (Nemotron 3 Super, Gemma 4, etc.)
3. Has a **"Get Free API Key"** button → opens `https://openrouter.ai/settings/keys` in new tab
4. Provides a **paste-your-key** input with validation
5. Shows a **"Test Connection"** button that calls `/api/validate-openrouter-key`
6. On success, saves key and shows confetti + "You're all set!"

**New Component: `client/src/components/settings/SettingsPanel.tsx`**

Replaces the placeholder "Settings" dropdown item in Header.tsx:
- API Key Management (add/remove/view masked key)
- Plan & Billing (show current tier, upgrade button)
- Expert Limits (show max experts, upgrade CTA if at limit)
- Model Access (show which models are available at current tier)
- Usage Stats (messages this month, remaining quota)

**Modified: `client/src/components/layout/Header.tsx`**

Replace the placeholder Settings dropdown item with a real SettingsPanel trigger. Add a prominent **"⚡ Free with OpenRouter"** badge when user is on free tier.

**Modified: `client/src/components/roundtable/ExpertSelector.tsx`**

- If free tier + BYOK: filter model list to **free models only** (check model ID for `:free` suffix or query OpenRouter's free collection)
- If free tier + no BYOK: show "Add API key to unlock experts" CTA
- If pro tier: show all models

### 3.4 Free Model Detection

OpenRouter free models have IDs ending in `:free` or are in the `openrouter/free` collection. We can:

```typescript
// Helper to check if a model is free
function isFreeModel(modelId: string): boolean {
  return modelId.endsWith(':free') || 
         modelId.includes('nemotron') && modelId.includes('free') ||
         modelId.includes('gemma-4') && modelId.includes('free');
}

// Or fetch from OpenRouter's collections API
const freeModels = await fetch('https://openrouter.ai/api/v1/models?collection=free');
```

---

## 4. PRICING STRATEGY

### Recommended Tiers

| Feature | **Free (BYOK)** | **Pro ($19/mo)** | **Enterprise ($49/mo)** |
|---------|-----------------|------------------|------------------------|
| **API Key** | User's own | Platform-provided | Platform-provided |
| **Models** | Free models only | All models | All models + priority routing |
| **Experts** | 3 max | 8 max | Unlimited |
| **Messages/mo** | Unlimited (user pays OR) | 500 included | Unlimited |
| **Streaming** | Standard | Priority | Priority + faster |
| **Farm Profile** | Basic | Full + weather | Full + weather + historical |
| **Insights Export** | ❌ | ✅ Markdown + PDF | ✅ + custom reports |
| **File Uploads** | 5MB max | 50MB max | 100MB max |
| **Support** | Community | Email | Slack + phone |
| **White-label** | ❌ | ❌ | ✅ Custom domain |

### Why These Prices?

- **$19/mo Pro**: Covers ~$8-12 in API costs (generous usage) + $7-11 margin. Competitive with ChatGPT Plus ($20) but you get MULTIPLE experts.
- **$49/mo Enterprise**: For farm cooperatives, ag consultants, or anyone who needs unlimited. High margin.
- **Free tier is genuinely free FOR YOU** because the user brings their own key. Zero marginal cost per free user.

### Stripe Integration

Already built. Just need to:
1. Create products/prices in Stripe Dashboard:
   - Product: "Farm Friend Roundtable Pro" → Price: $19/mo recurring
   - Product: "Farm Friend Roundtable Enterprise" → Price: $49/mo recurring
2. Update `STRIPE_PRICE_ID` env var to support multiple price IDs
3. Add tier selection UI before checkout

---

## 5. HOSTING STRATEGY

### Option A: Self-Hosted (Recommended for Launch)

**Platform:** Render.com, Railway, or Fly.io

| Platform | Price | Why |
|----------|-------|-----|
| **Render** | $7/mo (Web Service) + $15/mo (PostgreSQL) | Zero-config deploy from GitHub, auto-HTTPS, easy scaling |
| **Railway** | ~$20/mo (usage-based) | Great DX, automatic env vars, PostgreSQL included |
| **Fly.io** | ~$10-15/mo | Close to metal, fast cold starts, generous free tier |
| **DigitalOcean** | $6/mo droplet + $15/mo managed PG | Most control, cheapest long-term |

**Recommended stack for launch:**
- **Render Web Service** ($7/mo) — Node.js auto-detected
- **Render PostgreSQL** ($15/mo) — managed, backups
- **Total: ~$22/mo** — you need ~2 Pro subscribers to break even

### Option B: VPS (Scale Phase)

Once you have 50+ paying users, move to:
- **Hetzner CX31** (€9.90/mo) or **DigitalOcean Droplet** ($12/mo)
- **Self-managed PostgreSQL** on same box or **Neon** (serverless PG, free tier generous)
- **Cloudflare** in front for CDN + DDoS ($0)

### Deployment Checklist

```bash
# 1. Set production env vars
NODE_ENV=production
DATABASE_URL=postgresql://...
SESSION_SECRET=<strong random>
OPENROUTER_API_KEY=<platform key for paid users>
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID_PRO=price_...
STRIPE_PRICE_ID_ENTERPRISE=price_...
ENCRYPTION_KEY=<AES key for user API keys>

# 2. Build
npm run build

# 3. Start
NODE_ENV=production node dist/index.js

# 4. Health check
curl https://your-domain.com/api/user
```

---

## 6. USER JOURNEY (THE FUNNEL)

### First-Time User Flow

```
1. Lands on marketing page
   → "Get farming advice from a team of AI experts"
   → "Free forever with your own OpenRouter key"
   
2. Clicks "Get Started Free"
   → Email + password signup (no CC)
   
3. Onboarding wizard
   → Step 1: "What's your farm name?" (farm profile)
   → Step 2: "Add your OpenRouter API key" 
      ├─ "I already have one" → paste key
      ├─ "Get a free key" → opens guide + openrouter.ai
      └─ "Skip for now" → redirect to billing (subscribe)
   → Step 3: "Pick your first expert team" (preset selection)
   
4. First roundtable conversation
   → User sends message
   → Experts respond (using user's free key)
   → "Holy shit it's alive" moment
   
5. Post-first-conversation CTA
   → "Want more experts? Upgrade to Pro"
   → "Want premium models? Upgrade to Pro"
```

### Conversion Triggers (In-App)

| Trigger | Free Tier Behavior | CTA |
|---------|-------------------|-----|
| Try to add 4th expert | Block + "Pro users get up to 8 experts" | Upgrade modal |
| Select paid model | Block + "This model requires Pro" | Upgrade modal |
| Try to export insights | Block + "Export is a Pro feature" | Upgrade modal |
| Hit 50 msgs/day (platform key) | Block + "You've hit the daily limit" | Add BYOK or upgrade |
| 7 days after signup | Email: "You're loving Roundtable — unlock more" | Discount code |

---

## 7. OPENROUTER FREE MODEL GUIDE (FOR USERS)

### What to Show in the App

**"Free Models on OpenRouter"**

These models cost $0 and work great for farming advice:

| Model | Best For | Context |
|-------|----------|---------|
| **NVIDIA Nemotron 3 Super** | General advice, complex reasoning | 262K |
| **Google Gemma 4 31B** | Multilingual, multimodal | 262K |
| **Qwen3 Coder 480B** | Technical plans, code generation | 262K |
| **MiniMax M2.5** | Document creation, spreadsheets | 197K |
| **NVIDIA Nemotron 3 Nano** | Fast responses, simple queries | 256K |

**Getting Your Key:**
1. Go to [openrouter.ai](https://openrouter.ai)
2. Sign up with Google or email
3. Go to Settings → API Keys
4. Click "Create Key"
5. Copy the key (starts with `sk-or-...`)
6. Paste it here → you're done!

**Limits:** 50 requests/day, 20 requests/minute. For unlimited, add $5 in credits to OpenRouter.

---

## 8. IMPLEMENTATION PHASES

### Phase 1: BYOK Foundation (1 session)
- [ ] Add `openrouter_api_key`, `plan_tier`, `api_key_provider` to user schema
- [ ] Create `/api/user/api-key` endpoints with encryption
- [ ] Create `/api/validate-openrouter-key` endpoint
- [ ] Modify `callOpenRouterAPI` to accept per-user key
- [ ] Update auth middleware for free-tier BYOK access
- [ ] Create `OpenRouterSetupModal` component
- [ ] Add "Get Free API Key" guide in Settings

### Phase 2: Tier Enforcement (1 session)
- [ ] Add `max_experts`, `allows_paid_models` to user schema
- [ ] Filter model list in ExpertSelector by tier
- [ ] Block expert addition beyond limit
- [ ] Block paid model selection for free tier
- [ ] Add upgrade CTAs throughout UI
- [ ] Create `SettingsPanel` with plan management

### Phase 3: Stripe Multi-Tier (1 session)
- [ ] Create Stripe products for Pro + Enterprise
- [ ] Update subscription flow to support tier selection
- [ ] Update webhook handler for tier changes
- [ ] Add billing portal integration
- [ ] Add "Manage Subscription" in Settings

### Phase 4: Deploy (1 session)
- [ ] Set up Render/Railway account
- [ ] Configure production env vars
- [ ] Set up custom domain
- [ ] Configure Stripe live mode
- [ ] Deploy + smoke test
- [ ] Remove `DEVELOPMENT_MODE = true`

---

## 9. RISK ANALYSIS

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Users don't want to get an API key | Medium | Make the guide dead-simple; offer 1-click signup with OpenRouter OAuth |
| OpenRouter free models are too slow | Low | Cache responses; show "model loading" states; Pro tier gets priority |
| Users share API keys | Low | Keys are encrypted; we can't see them; rate limits are per-key anyway |
| Stripe integration breaks | Low | Already built + tested; just need live keys |
| Hosting costs exceed revenue early | Low | $22/mo break-even at 2 Pro subscribers; free users cost $0 |
| OpenRouter changes free tier | Medium | Monitor OpenRouter announcements; have fallback model list |

---

## 10. SUCCESS METRICS

| Metric | Target (Month 1) | Target (Month 3) |
|--------|-----------------|------------------|
| Signups | 100 | 500 |
| BYOK adoption rate | 60% | 70% |
| Free → Pro conversion | 5% | 10% |
| Monthly Revenue | $100 | $1,000 |
| Churn rate | <10% | <5% |
| Support tickets/key | <0.1 | <0.05 |

---

## 11. NEXT STEPS

Reply with:
- **"approved"** or **"go"** → I start Phase 1 immediately
- **"approved for phase X only"** → I do that phase and stop
- **Changes / questions** → I revise and re-present

**My recommendation:** Approve all phases. This is the fastest path to revenue with the least risk. The BYOK model means free users cost you literally $0, and the subscription tier is pure margin.
