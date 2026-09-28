# HANDOFF — Autonomous Council Implementation (feat/autonomous-council)

> **STATUS: COMPLETE (historical).** G1–G9 shipped to `main` via PR #5 (`fffc585`). Current work: `SPEC_FORUM_COUNCIL.md` + `HANDOFF_FORUM_COUNCIL.md`. The §2 invariants below still apply except where `SPEC_FORUM_COUNCIL.md` changes them (G11 retires newest-message-wins/full-round restart; G13 replaces the 2×N cap).

**For:** incoming dev team
**From:** lead of the three-specialist crew (Patch-Surgeon / WS-Security-Surgeon / Red-Team rotation), 2026-09-16
**Mission:** Implement SPEC_AUTONOMOUS_COUNCIL.md (G1–G9), verify in-app, ship PR to `origin/main`.
**Spec:** `SPEC_AUTONOMOUS_COUNCIL.md` (repo root, committed). **Audit:** `audit-report/index.html` (committed; also served on Tailscale at `http://100.98.195.126:8787` — a background `python3 -m http.server 8787` may still be running from the previous session; kill it if the port is needed).

---

## 1. Where things stand

Branch: **`feat/autonomous-council`** (local; **not pushed yet**), cut from `daf03ef` (dogfood-remediation HEAD, which is ahead of `origin/main` — the PR will therefore include the dogfood commits; they are prerequisites, keep them).

Commits on the branch, in order:

| Commit | What |
|---|---|
| `bf49c3d` | docs: spec + audit report |
| `43959e3` | feat(G1,G2): immediate steering via server interrupt + paused-deadlock fix |
| `790a3d7` | feat(G3): authenticated `/ws`, subscription-scoped broadcasts, state replay |
| `c478270` | fix(P0 review): signature-verified WS auth, single turn-chain guard, race fixes |
| `0e25249` | feat(G4): mention mechanics end to end (parsed, persisted, routed, addressable) |

**Done:** G1, G2, G3 (+ red-team hardening), G4 server-side complete.
**Remaining:** G4 client UI, G5, G6, G7, G8, G9, final review, live verification, push + PR.

Test/typecheck status at handoff: `npm run check` clean; **372 tests, all pass** except a **pre-existing full-suite flake** (see §5 — it exists at `origin/main`, do not chase it as a regression).

Working tree: clean except untracked `videos/` (pre-existing, unrelated — do not commit).

---

## 2. Invariants already established — do NOT break these

These are the semantics the P0/P1 review locked in with regression tests (`tests/orchestrator.test.ts`, `tests/websocket-scoping.test.ts`, `tests/mentions.test.ts`):

1. **Steering:** a message arriving mid-sequence sets `wasInterrupted` + `lastUserMessage`, broadcasts `{type:"steering"}`, the current expert finishes, then the **full sequential round restarts on the newest message** (newest-message-wins). No client-side queue anymore.
2. **Sequential round 1 is never cut.** Autonomous cap stays `experts.length * 2`; redundancy stop stays trigram-Jaccard ≥ 0.80 (`server/text-similarity.ts`). Don't touch these.
3. **`disableAutonomous()` never pauses.** A running sequence ends naturally at idle (+ insights) once the current expert finishes. `pause()` is only reachable via the explicit Pause button.
4. **Message-while-paused = implicit resume-and-restart**, decided by the `turnInFlight` state flag (interrupt-after-turn vs immediate restart).
5. **Single turn chain:** `turnChainScheduled` guard in `server/orchestrator.ts`. **If you add any new site that schedules `processNextTurn` via `setImmediate`, it must claim that flag** (copy the pattern at the three existing sites) or you reintroduce double-drive races.
6. **WS protocol:** upgrade auth verifies the `connect.sid` **HMAC signature** (hand-rolled, `node:crypto`, `timingSafeEqual`, in `server/routes.ts` — `getVerifiedSessionIdFromUpgradeRequest`); no session → close 4401. Clients `{type:"subscribe"|"unsubscribe", conversationId}` with server-side ownership checks (`subscribe_denied` on failure); broadcasts go **only** to subscribed sockets; successful subscribe replays current orchestrator state. Early frames during the async session lookup are buffered and drained post-auth. If you change payload shapes, remember old clients get nothing until they subscribe.
7. **Mention routing priority (autonomous mode only): mention > moderator suggestion > round-robin**, with a ping-pong guard (3rd consecutive same-pair mention route falls back). User mentions narrow **only the sequential round** (`state.roundExperts`); the autonomous extension always uses the full roster. Mentions live as jsonb on `messages` (`shared/schema.ts`), parsed once by `shared/mentions.ts` (pure; 22 unit tests — extend, don't rewrite).
8. **Both storages stay complete:** every schema change lands in `PostgresStorage` AND `MemStorage` (`server/storage.ts`). Tests force MemStorage via `DATABASE_URL=""` in `vitest.config.ts`.
9. `isUsableConversationState` in orchestrator.ts validates state fields — new ConversationState fields (like `roundExperts`) must be added there too, or stale-recovery misfires.

---

## 3. Remaining work, implementation-ready

Work bottom-up; G5/G6 touch `server/ai.ts` + `orchestrator.ts` (sequential, not parallel, on those two files). After each item: `npm run check` + `npm test`, one commit per G-item (house rule from the spec contract).

### G4-finish · Mention UI (client only; server payload already ships `message.mentions`)
- `client/src/components/chat/ChatInterface.tsx`: render the message's `mentions` array as role-colored chips under the bubble header (data already arrives on every `messages_updated` / `expert_stream_done`); optionally style `@[Role]` occurrences in the body via a ReactMarkdown custom renderer.
- Composer `@`-autocomplete: popover listing the conversation's experts (name + role), inserts `@[Role Name]` bracketed form.
- `client/src/components/roundtable/ExpertCard.tsx`: pulse/ring highlight when this expert is in the latest message's `mentions`.

### G5 · Semantic conclusion (spec §G5)
- `server/ai.ts`: Moderator role instructions (~line 228) + `getModeratorNextSpeakerSuggestion` query prompt and its validator (~line 807) gain `'Conclude'` alongside role names / `'RoundRobin'`.
- New `generateClosingSynthesis(conversationId, moderatorExpert, broadcastFn)`: one streamed assistant message from the Moderator — prompt: *summarize consensus, decisions, open disagreements, next actions; name the experts; be brief*; charter-aware once G6 lands. Mark the message with a new `messages.isSynthesis` boolean column (schema + both storages; rides broadcasts automatically).
- `server/orchestrator.ts`: in autonomous next-speaker selection, `suggestedRole === 'Conclude'` → broadcast `{type:"concluding"}` (add branch in `broadcastToConversation`) → run the synthesis turn (streamed like a normal turn; does **not** count against `maxAutonomousTurns`) → existing natural-end cleanup. Note: Conclude is only reachable when a Moderator expert exists (the suggestion call is moderator-gated); the spec's "no moderator" fallback clause is unreachable — fine.
- `server/routes.ts`: `"concluding"` broadcast branch.
- Client (can ride G4-finish): status line "The council is concluding…" + a "Closing summary" tag on bubbles where `message.isSynthesis`.
- Tests: moderator returns Conclude → concluding broadcast → synthesis stored/streamed → idle + insights; synthesis not counted vs cap; existing cap/redundancy tests stay green.

### G6 · Council charter (spec §G6)
- `shared/schema.ts`: `conversations.charter` text nullable; API-level 2,000-char cap.
- `PUT /api/protected/conversations/:id` accepting `{title?, charter?}`, ownership-checked like other conversation routes (add `updateConversation` to `IStorage` + both storages).
- `server/ai.ts`: `generateSystemPrompt` gains a charter param → block after the roster: `📜 COUNCIL CHARTER (governs this roundtable — all experts): …`. `getExpertResponseStream`/`getExpertResponse` already fetch the conversation — pass `conversation.charter` through. Inject the charter into the moderator suggestion prompt and the G5 synthesis prompt.
- Client: "Charter" button in the conversation header/control bar → dialog with textarea + save; charter-present badge; one-time dismissible nudge when a council has no charter.
- Tests: prompt injection unit test; PUT endpoint (create/update/ownership/length cap).

### G7 · Survivable orchestrator state (spec §G7)
- `conversations.orchestrator_state` jsonb `{mode, currentExpertIndex, totalAutonomousTurnsTaken, wasInterrupted, pausedFromMode}` written in `updateConversationState` (turn boundaries only — never per token).
- Cold start in `processMessageTurnBased` when no in-memory state: read snapshot — was `processing_sequential`/`autonomous` (dead loop) → recover to `idle` + broadcast corrected `state_update`; was `paused` → restore paused (safe: two exits exist now).
- Non-goal: multi-instance. Single-writer per conversation stands.
- Tests: kill-mid-round simulation (construct state, drop the Map, next message recovers to idle); paused restores paused.

### G8 · Aux-call hygiene (spec §G8)
- Kill the hardcoded legacy slugs: insights model `mistralai/mixtral-8x7b-instruct` (`server/ai.ts`, `generateInsights`) and moderator fallback `mistralai/mistral-7b-instruct` (same file, `getModeratorNextSpeakerSuggestion`). Resolution order: **Moderator expert's configured model → `DEFAULT_AUX_MODEL` env → first expert's model.** Add the env var to `.env.example`.
- Degradation notice: when the moderator call fails/returns invalid → broadcast `{type:"notice", conversationId, message:"Moderator unavailable — speaking in round-robin."}` (new broadcast branch) → client ephemeral toast.
- `client/src/components/roundtable/ExpertSelector.tsx`: one-line nudge when a selection has no Moderator ("Add a Moderator so the council can route itself and conclude on its own").
- Tests: resolver unit test; mocked moderator failure → round-robin continues + notice broadcast.

### G9 · Legibility (spec §G9)
- Next-speaker preview: orchestrator knows `nextExpertIndex` before the turn starts → broadcast `{type:"next_speaker", conversationId, expertId, expertRole}` there (routes branch). Client: "up next" chip + shimmer on that expert's card; `ExpertCard` gains `isUpNext`/`isTyping`.
- Quiet console: gate the per-event `console.log`s in `client/src/pages/home-page.tsx` (~line 529 "WebSocket received") behind `import.meta.env.DEV` or a `localStorage.ffDebug` flag.
- Carried-forward context: when building expert turns, if the conversation has a stored Insight from a prior sequence, inject a compact "PRIOR DECISIONS" block (latest insight points) — zero extra model calls.
- Tests: `next_speaker` event ordering (before `expert_stream_start`); PRIOR DECISIONS injection into message assembly.

---

## 4. Review + ship (Phase E/F)

1. **Adversarial review** of the full branch diff (`git diff origin/main...feat/autonomous-council`) — at minimum: correctness of the new G5/G6/G7 state transitions against the §2 invariants (especially the `turnChainScheduled` claim rule), WS changes, and schema/storage parity.
2. **DB push before live verification** — new column `messages.mentions` (and later `isSynthesis`, `charter`, `orchestrator_state`): `npm run db:push` (dev Postgres via `DATABASE_URL` in `.env`). Without it, PostgresStorage will fail on message inserts at runtime (tests won't catch it — they run MemStorage).
3. **Live verification** (`OPENROUTER_API_KEY` is present in `.env`, so real rounds work): `npm run dev` (serves on **port 5001**, host 0.0.0.0). Fast path: `POST /api/dev-login` (dev mode) → `POST /api/dev/quick-setup` creates a 4-expert council (note: **no Moderator in `server/dev-config.json`** — good for testing the G8 nudge; add a Moderator expert manually to test G5 Conclude). Verify by driving the real app: steering banner mid-round, Pause/Resume, mention routing (`@[Role]` in an expert reply routes the next speaker; a user `@Meteorologist ...` narrows round 1), WS: second browser profile/tab without login gets 4401; two users only see their own streams.
4. **Commit remaining items** (one per G-item, house style `feat(G5): ...`).
5. **Push + PR:**
   ```
   git push -u origin feat/autonomous-council
   gh pr create --base main --head feat/autonomous-council \
     --title "feat: autonomous council — steering, mentions, conclusion (SPEC_AUTONOMOUS_COUNCIL G1–G9)" \
     --body <summary referencing SPEC_AUTONOMOUS_COUNCIL.md and audit-report/index.html>
   ```
   PR notes to include: WS protocol change is breaking-but-same-deploy; PR includes the stacked dogfood commits (not yet on main); the flake attribution below.

---

## 5. Known pre-existing test flake (verified NOT ours)

Full-suite runs occasionally fail 1–2 session-auth tests (`tests/auth.test.ts > persists session…`, `tests/billing.test.ts > webhook…`) with 401s. Attribution evidence at handoff:

- Isolated: `npx vitest run tests/auth.test.ts tests/billing.test.ts` → 5/5 runs fully green.
- At `origin/main` (worktree, 4 full-suite runs): 1 run failed 1 test. At `c478270` (pre-G4): 1 of 3 runs failed 2 tests. On this branch: ~1-in-3 full-suite runs, always the same 401-session family.

Conclusion: pre-existing, load-related bleed (suspect shared state across parallel vitest workers / session-store timing), slightly more visible as the suite grows. **Recommended fix for the incoming team** (not a blocker for the PR): run the two suites with `pool: 'forks'` isolation or add `sequential` file ordering for auth/billing; root-cause is likely inter-worker env bleed. Don't let it mask real failures — rerun before believing a red suite, and check the failing test is in that family.

---

## 6. Environment facts

- Repo: `/Users/scrimwiggins/FarmFriendRoundtable-PRO`. Node deps installed. Dev server: `npm run dev` → port 5001.
- `.env` has: `DATABASE_URL`, `SESSION_SECRET`, `OPENROUTER_API_KEY`, Stripe vars, `OWM_API_KEY` — live LLM rounds are possible (free models in `server/dev-config.json`).
- Tests: `npm test` (vitest, node env, MemStorage-forced). Typecheck: `npm run check`.
- Background process possibly still alive from the audit session: `python3 -m http.server 8787` serving `audit-report/` on the Tailscale net (`100.98.195.126`). Kill if the port is needed; the report itself is committed.
- Untracked `videos/` directory is unrelated video-production assets — leave it out of the PR.

## 7. Team State at handoff

- Mission: implement SPEC_AUTONOMOUS_COUNCIL.md G1–G9, verify in-app, PR to origin/main
- Phase: C (P1) — G4 server-side done at `0e25249`; next specialist job is G4-finish (UI) then G5
- S1 Mention-Mechanic: completed, idle. S2 Conclude-Charter: not started. S3 UI-Chip-Builder: not started
- Known facts: 372 tests green; check clean; flake pre-existing (§5); db:push REQUIRED before live run (§4.2)
- Open risks: G5/G6/G7 all touch orchestrator+ai.ts (sequence them); `turnChainScheduled` claim rule on any new schedule site; WS same-deploy breaking change
- Next integration step: G4-finish client chips → commit → G5 → G6 → G7 → G8 → G9 → review → verify → PR
