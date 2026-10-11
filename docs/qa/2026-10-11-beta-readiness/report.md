# Beta readiness live QA

| Field | Value |
|---|---|
| Date | 2026-10-11 |
| App | `http://localhost:5001` |
| Browser session | `beta-readiness-20261011` |
| Initial code revision | `454977f` |
| OpenRouter spend ceiling | `$2.00 total` |

## Preflight

No paid model call has been made yet. OpenRouter's read-only model catalog listed all four requested models: `z-ai/glm-5.3-flash`, `deepseek/deepseek-v4.1-flash`, `xiaomi/mimo-v2.6-flash`, and `openai/gpt-6-luna`. The app's Perplexity key is absent, so Research Analyst requests use the OpenRouter path covered by the spend cap.

The test account was first registered on Free. Its paid-model filter correctly hides the reference models; this is expected tier gating, not a catalog defect ([captured picker](screenshots/precondition-free-tier-model-picker.png)). A separate fictional QA account was locally flagged Pro for model-picker testing; no subscription, checkout, or payment was created. Restore its local tier after validation.

The fictional Iowa profile and uploaded fixture are for QA only. The fixture labels the fertilizer quotes as fictional and records weather as unavailable. Do not treat its figures as current prices or a field recommendation. Videos were not captured because `ffmpeg` is unavailable; use the screenshots and live persisted records as evidence.

## Acceptance status before live run

| Requirement | Status | Evidence |
|---|---|---|
| BETA-01 Routing and bounded work | BLOCKED — live run pending | — |
| BETA-02 Canonical deliverables | BLOCKED — live run pending | — |
| BETA-03 Evidence and calculation consistency | BLOCKED — live review pending | — |
| BETA-04 Questions and final handoff | BLOCKED — live run pending | — |
| BETA-05 Calendar dates and plan consistency | BLOCKED — live export/import pending | — |
| BETA-06 Failure recovery and capability status | BLOCKED — fault scenarios pending | — |
| BETA-07 Continuity and deliverable breadth | BLOCKED — broader journeys pending | — |

