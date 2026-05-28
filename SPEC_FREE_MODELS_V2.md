# SPEC: Free Model Ecosystem v2 — Dev Config Overhaul
**Status:** PENDING APPROVAL — DO NOT EXECUTE
**Agent:** Hermes (kimi-k2.6)
**Date:** 2026-05-14
**Scope:** Replace single `deepseek/deepseek-v3.2` default with 8 diverse free-tier models, each mapped to optimal expert roles.

---

## 1. The 8 Free Models — Research Summary

| # | Model ID | Parameters | Context | Strengths | Best For |
|---|----------|-----------|---------|-----------|----------|
| 1 | `inclusionai/ring-2.6-1t:free` | 1T total / 63B active | 262K | **Agent workflows, coding, tool use, adaptive reasoning** (PinchBench, GAIA2) | File Creator, Research Analyst |
| 2 | `nvidia/nemotron-3-super-120b-a12b:free` | 120B / 12B active (MoE) | 262K | **Multi-agent apps, long-context coherence, cross-doc reasoning, 50%+ faster tokens** | Moderator, complex multi-expert discussions |
| 3 | `minimax/minimax-m2.5:free` | SOTA LLM | 197K | **Real-world productivity, Office doc generation, SWE-Bench 80.2%, browsing** | File Creator, documentation, reports |
| 4 | `z-ai/glm-4.5-air:free` | MoE compact | 131K | **Agent apps, hybrid thinking/non-thinking modes, tool use** | General agriculture queries, versatile |
| 5 | `arcee-ai/trinity-large-thinking:free` | Reasoning model | — | **Strong reasoning, agentic workloads, PinchBench** | Research Analyst, complex problem solving |
| 6 | `deepseek/deepseek-v4-flash:free` | 284B / 13B active | **1M** | **Fast inference, 1M context, coding, chat, agents** | Crop Specialist, Soil Scientist (long docs) |
| 7 | `google/gemma-4-31b-it:free` | 30.7B dense | 262K | **Multimodal (text+image), 256K context, 140+ languages, coding, reasoning** | Imagery Specialist, multilingual farms |
| 8 | *(reserved)* | — | — | Fallback / future addition | — |

**Key Insight:** All 8 are `:free` suffix models on OpenRouter. The 50 req/day limit is **per-account total across all free models** (not per-model). This means a user with a BYOK setup gets 50 total requests/day across all 8 models combined. For dev/demo purposes this is fine; for production SaaS we'll need the Pro tier or user-funded credits.

---

## 2. Model-to-Expert Role Mapping

| Expert Role | Assigned Model | Rationale |
|-------------|---------------|-----------|
| **Soil Scientist** | `deepseek/deepseek-v4-flash:free` | 1M context = can ingest entire soil reports, long historical data |
| **Crop Specialist** | `google/gemma-4-31b-it:free` | Multimodal = can analyze crop images, disease photos |
| **Irrigation Engineer** | `z-ai/glm-4.5-air:free` | Hybrid thinking mode = quick calcs or deep analysis on demand |
| **Pest Management** | `arcee-ai/trinity-large-thinking:free` | Strong reasoning = diagnostic problem-solving for pest ID |
| **Meteorologist** | `deepseek/deepseek-v4-flash:free` | 1M context = can process long weather histories, climate data |
| **File Creator** | `minimax/minimax-m2.5:free` | Office doc generation specialty = reports, plans, Excel files |
| **Research Analyst** | `inclusionai/ring-2.6-1t:free` | Agent workflows + tool use = best for research tasks |
| **Imagery Specialist** | `google/gemma-4-31b-it:free` | Multimodal (text+image) = analyze satellite/drone imagery |
| **Moderator** | `nvidia/nemotron-3-super-120b-a12b:free` | Multi-agent coherence = manages conversation flow across experts |

---

## 3. Files to Modify

### 3.1 `server/dev-config.json` (COMPLETE REWRITE)
```json
{
  "enabled": true,
  "models": {
    "soil_scientist": "deepseek/deepseek-v4-flash:free",
    "crop_specialist": "google/gemma-4-31b-it:free",
    "irrigation_engineer": "z-ai/glm-4.5-air:free",
    "pest_management": "arcee-ai/trinity-large-thinking:free",
    "meteorologist": "deepseek/deepseek-v4-flash:free",
    "file_creator": "minimax/minimax-m2.5:free",
    "research_analyst": "inclusionai/ring-2.6-1t:free",
    "imagery_specialist": "google/gemma-4-31b-it:free",
    "moderator": "nvidia/nemotron-3-super-120b-a12b:free"
  },
  "experts": [
    {
      "name": "Dr. Sarah Chen",
      "role": "Soil Scientist",
      "model": "deepseek/deepseek-v4-flash:free",
      "avatarUrl": "https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
    },
    {
      "name": "James Patterson",
      "role": "Crop Specialist",
      "model": "google/gemma-4-31b-it:free",
      "avatarUrl": "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?ixlib=rb-1.2.1&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
    },
    {
      "name": "Dr. Maria Rodriguez",
      "role": "Irrigation Engineer",
      "model": "z-ai/glm-4.5-air:free",
      "avatarUrl": "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?ixlib=rb-1.2.1&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
    },
    {
      "name": "Research Scout",
      "role": "Research Analyst",
      "model": "inclusionai/ring-2.6-1t:free",
      "avatarUrl": "https://images.unsplash.com/photo-1551836022-d5d88e9218df?ixlib=rb-1.2.1&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
    }
  ]
}
```

### 3.2 `client/src/components/roundtable/ExpertSelector.tsx`
**Changes:**
- Update `defaultModel` for each expert in `availableExperts` array (lines 48-112)
- Update `FALLBACK_MODELS` array (lines 26-34) to include the 8 free models as primary fallbacks
- Add `:free` suffix handling in model validation logic

**Specific line changes:**
```typescript
// Line 48: Soil Scientist
defaultModel: "deepseek/deepseek-v4-flash:free",

// Line 56: Crop Specialist  
defaultModel: "google/gemma-4-31b-it:free",

// Line 64: Irrigation Engineer
defaultModel: "z-ai/glm-4.5-air:free",

// Line 71: Pest Management
defaultModel: "arcee-ai/trinity-large-thinking:free",

// Line 78: Meteorologist
defaultModel: "deepseek/deepseek-v4-flash:free",

// Line 85: File Creator
defaultModel: "minimax/minimax-m2.5:free",

// Line 93: Research Analyst
defaultModel: "inclusionai/ring-2.6-1t:free",

// Line 100: Imagery Specialist
defaultModel: "google/gemma-4-31b-it:free",

// Line 108: Moderator
defaultModel: "nvidia/nemotron-3-super-120b-a12b:free",
```

### 3.3 `server/routes.ts` (Lines 94-95)
**Current:**
```typescript
const testModel = "deepseek/deepseek-v3.2";
```
**Change to:**
```typescript
const testModel = "deepseek/deepseek-v4-flash:free";
```

Also update lines 135 and 139 where `testModel` is used for the dev update-models endpoint.

### 3.4 `server/ai.ts` — Model Validation (Lines 209-272)
**Add:** Validate that `:free` models are accepted. Currently the code doesn't reject models based on suffix, but we should add a warning log when free models are used in production to remind about rate limits.

**Add after line 211:**
```typescript
if (model.includes(':free')) {
  console.warn(`[DEBUG] Using free-tier model ${model}. Subject to OpenRouter free-tier rate limits (50 req/day).`);
}
```

---

## 4. Verification Steps (Contract)

| # | Verification | Method |
|---|-------------|--------|
| 1 | dev-config.json loads without parse errors | `cat server/dev-config.json | python3 -m json.tool` |
| 2 | All 8 model IDs are valid OpenRouter free models | Cross-reference with openrouter.ai/models?q=free |
| 3 | ExpertSelector shows correct default models | Browser dev tools → React Components → inspect defaultModel props |
| 4 | Quick setup uses v4-flash instead of v3.2 | Network tab → POST /api/dev/quick-setup → check response |
| 5 | Free model warning appears in server logs | `grep "free-tier model" server/logs` |
| 6 | All 4 dev-config experts have unique models | No two experts share the same model ID |
| 7 | Model fallback logic includes free variants | Disconnect from OpenRouter API → verify fallback models load |

---

## 5. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Free model rate limit (50/day) | Demo/testing hits limit quickly | Document clearly; Pro tier uses paid models; BYOK users fund their own |
| Model availability changes | OpenRouter removes free models | Keep fallback list updated; monitor OpenRouter API |
| `:free` models slower/less reliable | UX degradation | Pro tier uses premium models; free tier is clearly labeled "Beta/Development" |
| Context window mismatches | Some models have 131K vs 1M | Map long-context roles (Soil Scientist, Meteorologist) to 1M models |

---

## 6. Monetization Alignment

This spec directly supports the BYOK → SaaS monetization strategy:

- **Free tier (BYOK):** Users bring their own OpenRouter key → use these 8 free models → 50 req/day limit → friction builds desire for unlimited
- **Pro tier ($19/mo):** We provide managed API keys → premium models (non-free) → unlimited usage → no rate limits
- **Dev mode:** These 8 models are the default for development, making the free tier feel generous and capable

The diversity of models (coding, multimodal, reasoning, long-context) showcases the platform's sophistication even on the free tier.

---

## 7. Approval Checklist

- [ ] TD approves the 8-model selection
- [ ] TD approves the expert-to-model mapping
- [ ] TD confirms dev-config.json structure (models map + experts array)
- [ ] TD approves proceeding to implementation

**Awaiting approval. Do not execute.**
