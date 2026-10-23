---
name: Free trial product
description: Final user decision on Free access and cost controls, overriding earlier paid-only instructions.
---
People can sign up and try the app without paying. The user's later decision replaces the old 100-message/$0-model trial: Free includes 3 experts and 30 roundtables per month using the approved low-cost paid lineup. Public pricing offers Free, Pro ($10/month or $96/year), and Enterprise.

**Why:** The user explicitly approved the low-cost paid Free lineup, 30 roundtables/month, and a shared $5/day cap on 2026-10-23, overriding the earlier $0-model limits.

**How to apply:** Preserve existing Pro, checkout, Stripe webhook, login/session, and billing behavior. Keep per-day, per-minute and per-IP abuse limits. Free experts use Claude Haiku 5.5, MiniMax M3.1 Flash and GLM 5.3 Flash; moderator/synthesis/insights use MiMo V2.6 Pro with Haiku fallback. Other paid models are blocked. The global Free USD budget resets at midnight America/Los_Angeles, not UTC. An existing complimentary internal Pro account should remain unchanged.

Reasoning models need enough room to return visible answers; verify both real expert output and a substantive closing Moderator answer.

**Why:** Live tests exhausted output budgets during hidden reasoning, sometimes returning no visible content. Catalog presence and a successful short expert answer do not prove the Moderator will work.

**How to apply:** Test actual expert and Moderator answers, structured stances, and the Verdict table, not just accepted requests, truncation notices or mocked responses. Free reasoning effort must never default to max.

Unknown provider costs must retain a conservative durable reservation, rather than refunding capacity on an unverified assumption.

**Why:** Concurrent Free calls and timeouts can otherwise bypass the shared spending ceiling; missing telemetry is not proof of zero cost.

**How to apply:** Reserve atomically before dispatch, settle reported actual costs once, retain unknown charges across restarts, and fail closed if the cost ledger is unavailable.
