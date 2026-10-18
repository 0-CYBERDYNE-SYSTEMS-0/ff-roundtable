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

`npm run dev` with `DATABASE_URL` set (as in `.env`) uses the real Postgres DB. For a throwaway instance alongside it: `REPL_ID=local PORT=5002 DATABASE_URL= npm run dev`. Vite HMR otherwise binds fixed port 24678 (`server/vite.ts`), so a second plain instance dies with "Port is already in use"; `REPL_ID` makes HMR share the HTTP port. In-memory mode seeds `developer`/`password`; `POST /api/dev-login` then `POST /api/dev/quick-setup` gives a logged-in session with a conversation.

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

Deletion rules: `DELETE /api/protected/conversations/:id` and `DELETE /api/protected/conversations/:id/experts/:expertId` return 409 while the orchestrator is non-idle, unless that state is older than `STALE_PROCESSING_MS` (5 min, `orchestrator.ts`) — so a long-paused conversation can be deleted. A removed expert's messages are kept with `expertId: null`. The conversations list returns a computed `updatedAt` (latest message, else `createdAt`); it is not a DB column.

`server/dev-config.json` defines the default expert panel and their OpenRouter model slugs (free-tier models). Free slugs get retired and start 404ing — update them there.

## Client conventions

- **Layout:** at most three columns — left sidebar (conversations default tab, files), chat column with a horizontal expert strip inside `ChatInterface`, right sidebar (`ConversationSidebar`: Insights + Artifacts). On mobile/compact both sidebars are overlays. Mobile drawers must not carry `relative` and `absolute` together (Tailwind emits `.relative` later, so it wins and the drawer takes layout space).
- **Theme (light/dark/system):** `client/src/lib/theme.ts`, picker in the account menu (`Header.tsx`), stored as `ffTheme` (default light) and applied pre-paint by the inline script in `client/index.html`. The `neutral`, `gray`, `farm-powder` and `farm-tan` palettes are CSS-variable backed (`tailwind.config.ts` + `client/src/index.css`) and run in reverse under `.dark`, so `text-neutral-800`, `bg-neutral-50`, etc. adapt automatically — don't add `dark:` variants for those. Use `bg-card` (not `bg-white`) for panels; keep `bg-white` only for things that must stay white (logo tiles, chips on colored backgrounds, Vega chart canvas). `text-primary`, `text-farm-blue` and `text-farm-dark-green` are lightened in dark via overrides in `index.css`. Other Tailwind color scales (amber, red, emerald, …) are not themed: pale surfaces or dark text in those need explicit `dark:` variants. The `@replit/vite-plugin-shadcn-theme-json` plugin injects its own CSS variables, but `index.css` overrides them.
- **localStorage:** keys are prefixed `ff` (e.g. `ffTheme`, `ffFarmProfileDismissed`, `ffLeftSidebarWidth`, `ffRightSidebarCollapsed`, `ffExpertStripCollapsed`) and every access is wrapped in try/catch.
- **API data:** dates arrive as ISO strings, not `Date` — wrap in `new Date(...)` before calling Date methods. Model-generated content (artifacts, charts) can be malformed or truncated; guard every `JSON.parse` so one bad artifact can't crash the page.
- **Toasts** are for errors and actions with no visible result; successful in-place changes don't toast.

## Env

See `.env.example`. Relevant: `DATABASE_URL`, `SESSION_SECRET`, `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY`, `OWM_API_KEY`, `STRIPE_*`, `ENCRYPTION_KEY`, `ALLOWED_ORIGIN`.

## Project docs

Self-hosting (Docker / `docker-compose.yml`) is covered in `README-SELF-HOST.md`.

Feature specs live in root `SPEC_*.md` files; G1–G9 (autonomous council) shipped per `SPEC_AUTONOMOUS_COUNCIL.md`; current work (forum council, goals G10–G16) is in `SPEC_FORUM_COUNCIL.md` and `HANDOFF_FORUM_COUNCIL.md`. Commit messages reference goal IDs (e.g. `feat(G10): ...`).

`UI_UX_AUDIT.md` lists 33 UI/UX findings; all are implemented on `feat/ui-ux-audit` (#30 dark mode was done after the doc marked it "decision needed"). Those commits reference finding numbers (e.g. `ui(audit #9): ...`). Tag `ui-ux-audit-restore-point` marks `main` before that work.
