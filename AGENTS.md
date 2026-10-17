# Working in this repository

## Working rules

- Think before coding. State assumptions and tradeoffs explicitly; ask when ambiguity affects the outcome.
- For multi-step work, outline the plan and its verification checks before editing.
- Write the minimum code that solves the requested problem. Avoid speculative features, abstractions, and error handling.
- Make surgical changes, match surrounding style, and leave unrelated code and formatting alone.
- Inspect `git status` and relevant diffs first. Preserve existing uncommitted work; do not reset, revert, or include it in commits without authorization.
- When the user requests a swarm, development team, fleet, or work with other agents, use the Herdr skill and follow its environment requirements. Do not start a team for routine work without that request.

## Product and source map

FarmFriend Roundtable is an agricultural advisory app with a farmer-selected panel of AI experts. Advice must not be presented as field measurements or imply physical control of farm equipment.

- `client/src/`: React 18, TypeScript, Vite, Wouter, TanStack Query, Tailwind, and shadcn/ui. `pages/home-page.tsx` and `components/chat/ChatInterface.tsx` are key conversation entry points. WebSocket updates feed the client query cache.
- `server/index.ts`: dotenv loading, Express middleware, and shared HTTP server for the API and client. Development uses Vite middleware; the default port is **5001**, overridable with `PORT`.
- `server/routes.ts`: REST endpoints, uploads, Stripe integration, and session-authenticated `/ws` connections. Keep conversation ownership and subscription-scoped broadcasts intact.
- `server/orchestrator.ts`: per-conversation routing, turn budgets, pause/resume, interruption, moderator decisions, and persisted state snapshots. `ORCH_DEBUG=1` enables tracing.
- `server/ai.ts`: expert prompts, streaming, auxiliary model selection, insights, and closing synthesis.
- `server/ai-providers.ts`: OpenRouter and local OpenAI-compatible provider routing, request limits, and free-model fallbacks. `server/dev-config.json` supplies the default expert roster/models.
- `server/expert-tools.ts`: bounded research tools, public-URL checks, HTML/PDF extraction, and deliverable parsing/versioning/ownership.
- `server/pending-deliverables.ts`: deferred deliverable commit/discard, intentionally separate from `ai.ts` so AI mocks do not disable persistence behavior.
- `server/response-hygiene.ts`, `turn-fairness.ts`, and `text-similarity.ts`: citation/evidence cleanup, participation limits, and repetition handling.
- `server/storage.ts`: `IStorage`, `MemStorage`, and `PostgresStorage`. Implement storage interface changes in both backends. `DATABASE_URL` selects PostgreSQL; absent it, data is in memory and lost on restart.
- `shared/schema.ts`: Drizzle schema and shared validation/types. Other `shared/` modules cover mentions, Markdown, schedules, ICS, and the expert catalog.
- `tests/`: Vitest unit and API integration tests. Aliases are `@/` → `client/src/` and `@shared/` → `shared/`.

## Commands and verification

Use Node.js 24+ and npm with the root `package-lock.json`. CI and Docker use Node.js 24 LTS; the PDF dependency requires APIs absent from Node.js 20.

| Task | Command |
| --- | --- |
| Install from lockfile | `npm ci` |
| Development server | `npm run dev` |
| Typecheck application source | `npm run check` |
| Full test suite | `npm test` |
| Focused tests | `npx vitest run tests/orchestrator.test.ts` |
| Filter test names | `npx vitest run tests/orchestrator.test.ts -t "name"` |
| Watch tests | `npm run test:watch` |
| Production build | `npm run build` |
| Start built server | `npm start` |
| Push schema to configured DB | `npm run db:push` |

`vitest.config.ts` forces `DATABASE_URL=""`, `NODE_ENV=test`, and a test session secret; tests use memory storage without touching the development database. Tests are excluded from the application TypeScript check, so run the relevant tests as well when changing them. Mock external AI, research, weather, and billing calls in automated tests.

For code changes, run focused tests, then the relevant broader checks. CI runs TypeScript and the full suite; builds run on pushes to main. No ESLint configuration is currently present. For documentation-only edits, inspect the diff and run `git diff --check`; application tests are unnecessary unless validating a claimed baseline.

`scripts/verify.sh` reinstalls dependencies and suppresses check output; its `fail` accumulator is not updated by failed steps. Use direct commands and their exit statuses when reporting verification.

Database schema pushes affect the configured database. Check the target before running them; do not apply schema changes or the self-host guide's legacy timestamp repair as part of routine initialization. Never expose `.env` values, credentials, or private uploaded content.

## Recent development context

Reviewed on 2026-10-17, with HEAD at `5be397b`. Recheck history and the working tree before relying on this snapshot.

- Recent commits address unavailable free models, expert cross-talk, moderator empty responses, fair autonomous turns, and citation claims checked against fetched evidence. Free-model availability changes; do not assume a historical fallback is still usable.
- Deliverables are saved only after a turn is accepted. Duplicate/rejected responses must not leave files behind. Revisions create versions; another expert's changes become proposals unless the farmer explicitly hands off ownership. Preserve these rules when changing parsing, streaming, or persistence.
- Timestamp display uses `client/src/lib/format-local-time.ts`; legacy database repair guidance lives in `README-SELF-HOST.md`.
- At review time, uncommitted edits in `server/ai.ts`, `server/orchestrator.ts`, `server/expert-tools.ts`, and associated tests add provider-failure retry handling, more explicit colleague references, concise expert turns, and stronger research instructions. Treat this as work in progress, not a released contract. Retry changes must preserve interruption, single-turn behavior, and turn budgets.
- Relevant regression suites include `orchestrator*`, `turn-fairness`, `response-hygiene`, `model-routing`, `expert-tools`, `ai-deliverables`, `deliverable-commit`, `deliverable-ownership`, and `websocket-scoping` under `tests/`.

## Further reading

- `README-SELF-HOST.md`: local PostgreSQL, Docker, local AI, environment configuration, and deployment troubleshooting.
- `.env.example` and `.env.production.example`: configuration names and examples; use these instead of printing secrets.
- `SPEC_AUTONOMOUS_COUNCIL.md`, `SPEC_FORUM_COUNCIL.md`, and their `HANDOFF_*.md` companions: design context and goal IDs. Compare historical plans with current source and tests before treating them as unfinished work.
- `CLAUDE.md`: existing companion agent guidance. Verify historical notes against current evidence rather than assuming failures are known flakes.
- `demo-video-assets/farm-friend-demo/AGENTS.md`: separate guidance for that nested demo project.
