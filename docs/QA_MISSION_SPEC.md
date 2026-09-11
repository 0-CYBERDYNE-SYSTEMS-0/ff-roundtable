# QA Mission Spec — UI, Settings, Modals, Sidebars & UX

**Branch:** `qa/ui-ux-audit-fixes`
**Date:** 2026-09-10
**Team:** QA-AUDITOR-1 (modals/settings/forms), QA-AUDITOR-2 (sidebar/chat/home), lead (consolidation + fixes)
**Baseline:** `npx tsc --noEmit` clean. Tracked test suite: **16 failing** (`tests/billing.test.ts`, see QA-00). 159/175 passing.

## Objective

Run a full QA pass over the client UI — settings, modals, sidebars, chat, home page — plus the
server contracts those surfaces depend on; identify and fix every verified defect; keep the
tracked test suite green; ship as a PR to `main`.

## Severity definitions

- **P0** — broken feature, data loss, or crash.
- **P1** — significant functional/security/UX defect users will hit.
- **P2** — moderate defect or edge case.
- **P3** — minor polish.

## Findings & fix plan

### QA-00 [P1] Test harness: billing suite is red because of ESM import hoisting — `tests/billing.test.ts`
The file sets `STRIPE_SECRET_KEY` etc. via `process.env` assignments, but its static
`import { registerRoutes } from "../server/routes"` is hoisted above them, so `routes.ts`
module scope evaluates with no Stripe key (`routes.ts:41`) and every billing call 500s
"Stripe integration not configured". CI (`npm test`) is red at baseline.
**Fix:** import the server lazily (dynamic `await import`) after env setup; re-run suite.

### QA-01 [P0] Custom Instructions are never saved — silent data loss — `ExpertSettingsModal.tsx`
The modal's primary tab edits `customInstructions`, but `onSave` sends only `{ name, model }`;
the `experts` table has no `customInstructions` column; state is wiped to `""` on reopen.
**Fix:** add nullable `customInstructions` text column to `experts` (`shared/schema.ts`), round-trip
it through `PATCH /api/experts/:id`, load it in the modal effect, include it in the save payload,
and merge it into the expert's system prompt in the orchestrator. Note: run `npm run db:push` after deploy.

### QA-02 [P1] Paywall bypass: subscription flips to `active` before payment — `server/routes.ts` / `server/storage.ts`
`POST /api/create-subscription` sets `subscriptionStatus: "active"` at creation time
(`payment_behavior: "default_incomplete"`), and `/api/protected` gates only on that status.
**Fix:** store Stripe ids without flipping status; activate only in the `invoice.payment_succeeded`
webhook. Keep `tests/billing.test.ts` in sync with the corrected behavior.

### QA-03 [P1] Expert model PATCH bypasses free-tier paid-model restriction — `server/routes.ts`
Expert **creation** blocks paid models for free tier; **PATCH** `/api/experts/:id` accepts any model.
Also, models picked from dev-only free lists don't match any `<SelectItem>` and render a blank trigger.
**Fix:** apply the same `isPaidModel` tier check on PATCH; make the modal's model list tier-aware and
always include the expert's current model as an option.

### QA-04 [P1] Stripe webhook user lookup scans only ids 0–99 — `server/routes.ts`
Webhooks `[...Array(100)].map(getUser)` — with 100+ users, activation/cancellation events silently no-op.
**Fix:** look users up by `stripeCustomerId` / `stripeSubscriptionId` (new storage queries).

### QA-05 [P1] Expert settings dialog footer clipped on short screens — `ExpertSettingsModal.tsx`
`flex flex-col` loses to the base Dialog's `grid` (Tailwind emit order), so `max-h-[85vh]` +
`overflow-hidden` clips Save/Cancel on ~768px-tall viewports.
**Fix:** use an explicit grid (`grid-rows-[auto_minmax(0,1fr)_auto]`) + `min-h-0` on the tabs wrapper.

### QA-06 [P1] Free-tier model picker filters on a field OpenRouter never returns — `ExpertSelector.tsx`
`m.isFree === true` doesn't exist on API models, so free users see only `local/` models; the
recommended-experts tab bypasses the filter entirely.
**Fix:** derive free-ness from `id.endsWith(":free")` / `local/` prefix / zero pricing; pass the
filtered list + tier to the recommended tab too.

### QA-07 [P1] Uploaded files are undownloadable — `/uploads/*` never served — `server/routes.ts`
Uploads are saved to `uploads/` and stored as `/uploads/...` URLs, but nothing serves that dir;
download links return the SPA's `index.html`. The file-share feature is broken end-to-end.
**Fix:** serve `uploads/` via `express.static` inside `registerRoutes` (before the SPA catch-all),
with a logged-in check.

### QA-08 [P2] File-upload message never appears in the transcript — `home-page.tsx`
Upload success only invalidates the `files` key; the stored `[Uploaded file: …]` message isn't
broadcast or fetched. No client-side size guard either (10MB rejection arrives as raw JSON toast).
**Fix:** invalidate the messages key on upload success; add a 10MB client-side check with a friendly toast.

### QA-09 [P2] Server `type: "error"` WS events are dropped by both sides — `server/routes.ts`, `home-page.tsx`
`broadcastToConversation` has no `"error"` branch and the client switch has no `case "error"`;
pipeline failures leave `isProcessing` stuck true with pulsing skeletons forever.
**Fix:** forward `error` frames server-side; client case toasts the message and resets processing state.

### QA-10 [P2] Optimistic user message never reconciled; masked by a lossy 2s dedupe — `home-page.tsx`, `ChatInterface.tsx`
Temp `id: Date.now()` is never replaced by the stored message; ChatInterface hides duplicates by
content + 2s window (hides legit repeats, fails on slow WS).
**Fix:** return the temp id from `onMutate`, swap it for the stored message in `onSuccess`, and drop
the render-time dedupe.

### QA-11 [P2] Chat auto-scroll yanks the user down on every streaming token — `ChatInterface.tsx`
`scrollIntoView` fires on every token with no near-bottom guard; reading earlier answers while
streaming is impossible.
**Fix:** track whether the viewport is near the bottom (scroll listener) and only auto-scroll then.

### QA-12 [P2] `message_error` payload contract drift — `server/routes.ts` / `home-page.tsx`
Server nests `expertId` inside `message`; client reads it top-level, so one expert's failure clears
every expert's indicator/streaming bubble.
**Fix:** send `expertId`/`expertName` top-level (matching `expert_stream_*`); clear only that expert client-side.

### QA-13 [P2] Farm Profile modal: silent data loss on accidental close + stale error — `FarmProfileModal.tsx`
Esc/overlay closes mid-edit with no dirty guard (auto-opens during onboarding!); a failed save's
error text persists to the next open.
**Fix:** dirty flag + confirm before closing; block close while saving; clear error on open.

### QA-14 [P2] `PUT /api/protected/farm-profile` performs no validation — `server/routes.ts` / `server/storage.ts`
`req.body` is spread straight into the Drizzle set/values; `id`/`createdAt` can be injected; bad
payloads 500 raw.
**Fix:** validate with `insertFarmProfileSchema` (partial, userId omitted) and whitelist keys before storage.

### QA-15 [P2] Registration accepts a blank username → account that can never log in — `auth-page.tsx` / `server/auth.ts`
`registerSchema` keeps the drizzle-zod default `z.string()`; server does no validation.
**Fix:** require min length client-side; parse the body with the user schema + trimmed-username check server-side.

### QA-16 [P2] Model rows and category chips are click-only divs — `ExpertCard.tsx`
Keyboard users can't change an expert's model (no role/tabIndex/keydown, no focus ring).
**Fix:** render rows/chips as real `<button>`s (`aria-pressed` for chips).

### QA-17 [P3] Unhandled promise rejection on failed expert save — `ExpertSettingsModal.tsx` / `ChatInterface.tsx`
Modal try/finally without catch + ChatInterface rethrowing after toasting.
**Fix:** catch in the modal (keep it open, no double toast).

### QA-18 [P3] Duplicate farm-profile route registrations — `server/routes.ts`
`GET/PUT /api/protected/farm-profile` registered twice with divergent weather logic; second pair is dead code.
**Fix:** delete the dead pair.

### QA-19 [P3] Acres input fights the user — `FarmProfileModal.tsx`
`value={form.acres || ""}` + `parseInt` on change: typing "0" erases itself, "10.5" snaps to "10".
**Fix:** keep acres as a string in form state; parse once on save.

### QA-20 [P3] Debug `console.log` IIFEs run in the render path — `ChatInterface.tsx`
Every message render logs (with artifact payloads) — console noise, minor perf cost, content leakage.
**Fix:** delete the IIFE blocks.

### QA-21 [P3] PRO badge spam in chat bubbles — `ModelBadge.tsx`
PRO chip renders for every paid model in every message regardless of viewer tier.
**Fix:** gate the chip behind `userTier === "free"`.

### QA-22 [P3] Non-existent Tailwind classes — `ExpertCard.tsx`, `ExpertSelector.tsx`
`bg-primary-light`, `bg-primary-dark`, `bg-opacity-10` aren't defined by the theme, so selected/hover
states silently render flat.
**Fix:** replace with defined tokens (`bg-primary/10`, `hover:bg-primary/90`).

### QA-23 [P1] Stripe webhook could never verify signatures in production — `server/index.ts`
`express.json()` runs globally, so `req.body` is a parsed object; `constructEvent(req.body, ...)`
re-serializes different bytes and signature verification would always fail outside mocked tests.
**Fix:** capture `rawBody` via the json parser's `verify` callback and pass it to `constructEvent`.

### QA-24 [P2] New experts got a broken system prompt — `server/routes.ts`
Expert creation called `generateSystemPrompt(role)` with a string where an `Expert` object is
expected, producing prompts like "You are an AI expert in the role of undefined".
**Fix:** pass `{ role }` as the function expects.

### QA-25 [P2] Test-data violations surfaced by new validation — `tests/auth.test.ts`
The sequential register/login cycle test used a 5-character password, violating the app's own
client-side minimum of 6. Updated to a compliant password.

## Review-round findings (fixed after independent re-review)

### QA-26 [P2] Stale `activeConversation` in send-message mutation callbacks — `home-page.tsx`
`onSuccess`/`onError` resolved against whatever conversation was active when the mutation settled;
switching conversations mid-POST could append conversation A's message into B's cache.
**Fix:** capture `conversationId` in the `onMutate` context and use it for all settle-time cache work.

### QA-27 [P1] `npm test` exited 1 despite all tests passing — `server/orchestrator.ts`, `tests/orchestrator.test.ts`
Vitest workers closed mid-log-flush (`EnvironmentTeardownError`), failing the run and the new CI
`test` job even at 175/175.
**Fix:** the orchestrator's 37 verbose `console.log` traces now route through an opt-in `debugLog`
(`ORCH_DEBUG=1` restores them; `console.error` untouched), and the orchestrator test file drains
in-flight turn chains in `afterAll` before worker teardown.

### QA-28 [P3] Docker image build broken — `Dockerfile`
`COPY --from=builder /app/migrations ./migrations` referenced a directory that isn't tracked;
`docker build` failed at that step.
**Fix:** dropped the COPY — schema changes ship via `npm run db:push` (drizzle-kit).

## Sweep-round findings (deferred items resolved)

### QA-29 [P3] Dead code removed — `client/src/lib/ai-service.ts`, `VisualizationSidebarPanel.tsx`
Nothing imported either file. Deleted.

### QA-30 [P3] Expert error messages were cache-only — `server/orchestrator.ts`, `server/routes.ts`
The `message_error` frame synthesized a transcript entry with a `Date.now()` id, so the error
bubble vanished on the next refetch.
**Fix:** the orchestrator persists the error as a real assistant message and the broadcast forwards
the stored message (synthetic frame remains a fallback when only text is available).

### QA-31 [P3] CI typecheck gate was a placeholder — `.github/workflows/ci.yml`
The `typecheck` job ran with `continue-on-error: true` plus a warning telling maintainers to remove
it "before removing continue-on-error" — tsc is clean now, so the gate is real.

### QA-32 [P2] Flaky auth tests under parallel-worker load — `tests/auth.test.ts`
Two episodic failures (~once per 10 full-suite runs, never solo): the session test's
`dev-login` was left unchecked and occasionally didn't establish a session (→ 401), and the
rate-limit test's setup login occasionally received a bare 404 from the registered route.
Both are load artifacts of supertest's ephemeral servers, not product bugs (14+ solo runs green).
**Fix:** the setup logins now assert status with full response-body diagnostics and get a single
retry; the properties under test (session persistence, 429 boundary) remain strictly asserted.
Stability verified over 4 consecutive full-suite runs after the change.

## Deliberate scope decisions

- **`local/` models stay "paid" for tier enforcement.** `tests/tier.test.ts` explicitly pins
  `isPaidModel("local/llama3.1") === true`, so the client's free-model filter was aligned to the
  server rule (`id.endsWith(":free")`) rather than exempting local models server-side. Revisit as a
  product decision if self-hosters on free plans should get local models.
- **DB migration required:** the `custom_instructions` column (QA-01) needs `npm run db:push` on
  deploy. It is nullable, so the change is backward-compatible.
- The register endpoint now builds the user from explicitly whitelisted fields (username, email,
  hashed password) — a crafted body can no longer set `tier` or Stripe fields at signup.

## Verification results (after fixes + review round)

- `npx tsc --noEmit`: **clean**
- `npm test`: **175/175 passing, exit code 0** (verified over 6 consecutive runs; baseline was
  159/175 with exit 1 — `billing.test.ts` red + teardown errors)
- `npm run build` (vite + esbuild): **success**


## Observations (no action this pass)

- None — all audit, review, and sweep findings are resolved.

## Acceptance criteria

1. `npx tsc --noEmit` clean.
2. `npm test` fully green (including `tests/billing.test.ts`).
3. Every P0–P2 finding above fixed and covered by the existing suite where applicable.
4. No regressions in flows the audit marked clean (auth forms, WS `state_update`/`expert_stream_*`/`messages_updated` contracts, query invalidation pairings).
