# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — dev server (tsx `server/index.ts`; Express + Vite middleware, serves client and API on one port, 5001 locally)
- `npm run check` — typecheck (`tsc`); CI runs `tsc --noEmit`
- `npm test` — full vitest suite; single file: `npx vitest run tests/orchestrator.test.ts`; single test: add `-t "name"`
- `npm run build` / `npm start` — Vite client build + esbuild server bundle to `dist/`
- `npm run db:push` — push Drizzle schema (`shared/schema.ts`) to Postgres; `npm run db:setup` creates local `farm_roundtable_dev` DB then pushes
- `npm run test:watch` — vitest in watch mode

Tests run with `DATABASE_URL=""` (forced by `vitest.config.ts`), so they always use in-memory storage — no DB needed. Known flake: full-suite runs occasionally fail a session-auth test in `tests/auth.test.ts` / `tests/billing.test.ts` with 401s; it is pre-existing. Rerun, or run those files in isolation, before treating it as a regression.

## Architecture

Monorepo with three roots, aliased as `@/` (client/src) and `@shared/` (shared):

- `client/` — React 18 + Vite, Wouter routing, TanStack Query, shadcn/ui. Real-time updates arrive over WebSocket and are written into the query cache.
- `server/` — Express + `ws`. Key modules:
  - `routes.ts` — all REST routes, Stripe webhooks, and the `/ws` WebSocket server (session-authenticated, broadcasts scoped to subscribed conversations, state replay on connect).
  - `orchestrator.ts` — per-conversation state machine for expert turn-taking (sequential rounds, autonomous council mode, pause/interrupt/steering, @mention routing). State is snapshotted to storage so paused conversations survive restart (`restorePausedFromSnapshot`). Set `ORCH_DEBUG=1` for verbose turn tracing.
  - `ai.ts` — prompt construction, streaming expert responses, moderator next-speaker suggestion, insights, closing synthesis, "prior decisions" context. Aux calls use `resolveAuxModel` / `DEFAULT_AUX_MODEL`.
  - `ai-providers.ts` — `getProvider(modelId)` picks OpenRouter or a local OpenAI-compatible endpoint (`LOCAL_AI_BASE_URL`).
  - `storage.ts` — `IStorage` with `MemStorage` and `PostgresStorage`; chosen at startup by presence of `DATABASE_URL`. New storage operations must be implemented in both.
  - `auth.ts` — Passport local strategy + sessions; `tiers.ts` — subscription tier limits.
- `shared/` — Drizzle schema + zod types (`schema.ts`) and pure helpers used by both sides (mentions parsing, schedule extraction, ICS export, markdown).

`server/dev-config.json` defines the default expert panel and their OpenRouter model slugs (free-tier models). Free slugs get retired and start 404ing — update them there.

## Env

See `.env.example`. Relevant: `DATABASE_URL`, `SESSION_SECRET`, `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY`, `OWM_API_KEY`, `STRIPE_*`, `ENCRYPTION_KEY`, `ALLOWED_ORIGIN`.

## Project docs

Self-hosting (Docker / `docker-compose.yml`) is covered in `README-SELF-HOST.md`.

Feature specs live in root `SPEC_*.md` files; G1–G9 (autonomous council) shipped per `SPEC_AUTONOMOUS_COUNCIL.md`; current work (forum council, goals G10–G16) is in `SPEC_FORUM_COUNCIL.md` and `HANDOFF_FORUM_COUNCIL.md`. Commit messages reference goal IDs (e.g. `feat(G10): ...`).
