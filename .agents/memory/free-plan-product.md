---
name: Free trial product
description: Final user decision on Free access and cost controls, overriding earlier paid-only instructions.
---
People can sign up and try the app without paying. New accounts enter on Free, using the existing limits of 3 experts, 100 messages per month, and free models. Public pricing offers Free, Pro ($10/month or $96/year), and Enterprise.

**Why:** The user explicitly called this the FINAL DECISION, overriding the earlier paid-only correction.

**How to apply:** Preserve the visual redesign and existing Pro checkout, Stripe webhook, login/session, and billing behavior. Protect house-key costs and abuse boundaries for Free users rather than reinstating a paid paywall. An existing complimentary internal Pro account should remain unchanged.

Free reasoning models need enough room to return visible answers; do not reduce their output budget purely as a cost safeguard when provider pricing is already constrained to zero.

**Why:** Live tests exhausted output budgets during hidden reasoning, sometimes returning no visible content even with low reasoning effort and a higher Moderator allowance. Other catalog-listed Free models returned upstream rate-limit/provider errors. Catalog presence and a successful short expert answer do not prove the Moderator will work.

**How to apply:** When tuning Free routing or output limits, verify both an actual expert answer and a substantive closing Moderator answer at zero reported cost, not just catalog presence, accepted messages, truncation notices, or mocked provider responses.
