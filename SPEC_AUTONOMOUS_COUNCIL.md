# SPEC — Autonomous Council: Vision Realization

**Branch:** `feat/autonomous-council` (from `main` after `fix/dogfood-gap-remediation` merges)
**Status:** PENDING APPROVAL — DO NOT EXECUTE
**Origin:** Jury-architecture UX audit (2026-09-15, commit `daf03ef`) — report served at `audit-report/index.html` (Tailscale :8787). F-numbers below refer to that report's §3 Findings.

---

## Mission

Close every gap between the roundtable as built and the product vision:

> An autonomous council of experts that keeps building on each other as they speak, tags each other with intent, understands its own roles and rules, and knows — on its own — when it is done. The farmer can steer the discussion at any moment, address specific experts, or just sit back and read. Entering a message wakes the council; the council wakes the right experts.

Audit scorecard at origin: **2/10 claims realized, 4 partial, 4 cosmetic/missing/broken.** Exit criteria for this spec: **10/10 realized**, with regression tests holding the line.

Phases in order, each independently verifiable: **P0 trust & steering → P1 council mechanics → P2 legibility & durability.**

---

## Phase 0 — Trust & Steering (unbreak what exists)

### G1 · Steering: send immediately, use the server's interrupt path (audit F2)

**Findings**
- `client/src/pages/home-page.tsx:261-269` — while `isProcessing`, typed messages go into a client-side queue; `:272-284` drains it only when mode returns to `idle`. Steering is deferred by up to a full sequence (N sequential + ≤2N autonomous turns).
- `server/orchestrator.ts:597-608` — the server already implements interrupt-and-restart: a message arriving mid-sequence sets `wasInterrupted` + `lastUserMessage`; the loop finishes the current expert, resets, and restarts on the newest message. Tested (`tests/orchestrator.test.ts` "Interruption") but unreachable from the UI.
- Queued messages are client state only — lost on tab close.

**Design**
1. **Delete the client queue.** `handleSendMessage` always calls `sendMessageMutation.mutate(content)` immediately. Remove `pendingMessages`, `isQueueProcessing`, the queue-processor effect, and the "N queued" badge. Double-click safety is already covered server-side by the duplicate-submission gate (`server/text-similarity.ts:96-105`, applied at `server/routes.ts:771-776`).
2. **New broadcast `steering`.** In `processMessageTurnBased`, when a message arrives during an active sequence (`isBusy` branch), broadcast `{ type: "steering", conversationId }` (add a branch in `broadcastToConversation`, `server/routes.ts:238-336`).
3. **Client steering state.** On `steering`: show a persistent banner "Steering — the council takes this after the current expert finishes." Clear it on the next `state_update` with `mode: "processing_sequential"`. No other UI change; optimistic send already exists (`home-page.tsx:199-229`).
4. **Keep newest-message-wins and full-round restart.** A steering message restarts the full sequential round on the new message (current tested semantics). Rejected alternative — resuming from the current expert index — saves tokens but produces a half-round addressed to a stale question; not worth the semantic ambiguity.

**Acceptance**
- [ ] Send a message during an active autonomous round: current expert's turn completes, no further autonomous turns run, a fresh sequential round starts on the new message (verified via WS event order: `expert_stream_done` → `state_update(processing_sequential)` → `expert_stream_start`).
- [ ] Steering banner appears on `steering` and clears on the subsequent `state_update`.
- [ ] No queue state remains in `home-page.tsx`; rapid double-click sends exactly one round (duplicate gate).
- [ ] `npm run check` and `npm run test` pass, including a new orchestrator test: steering during autonomous restarts on the new message.

**Files touched:** `client/src/pages/home-page.tsx`, `server/orchestrator.ts` (broadcast only), `server/routes.ts` (broadcast branch), `tests/orchestrator.test.ts`.

---

### G2 · Kill the paused deadlock (audit F3)

**Findings**
- `server/orchestrator.ts:550-565` — `disableAutonomous()` pauses when mode is `autonomous` → mode `paused`, nothing resumes it: the Resume button was removed (`home-page.tsx:691`), a message in paused mode is stored but never starts a sequence (`orchestrator.ts:620-627` only starts when `idle`), and paused is exempt from staleness recovery (`orchestrator.ts:585-587`).
- Net effect: one click on "Disable Auto" mid-round wedges the conversation until server restart.

**Design**
1. **`disableAutonomous()` never pauses.** Remove the `pause()` call. Instead, in "Decide Next Action" (`orchestrator.ts:428-444`) add a natural-end condition: `mode === "autonomous" && !isAutonomousEnabled` → `processingEndedNaturally = true` (existing idle + insights cleanup). "Disable Auto" now means: finish the current expert, stop cleanly, generate insights.
2. **`turnInFlight` flag.** Add internal (non-broadcast) field to `ConversationState`: set `true` immediately before `getExpertResponseStream`, `false` in a `finally`. This is the only reliable "is a turn actually streaming" signal; pause can land mid-turn.
3. **Message-in-paused = implicit resume-and-restart.** In `processMessageTurnBased`, add a `paused` branch before the idle check: update `lastUserMessage`; if `turnInFlight` → set `wasInterrupted: true` (the running loop's existing stop path resets and restarts — `orchestrator.ts:183-201`); else → reset to `idle` (clear `pausedFromMode`, `currentExpertIndex: -1`, `totalAutonomousTurnsTaken: 0`) and `scheduleInterruptedMessage(...)`. A parked conversation comes back to life the moment the farmer speaks.
4. **Restore Pause/Resume controls.** Re-add buttons to the interaction control bar (`home-page.tsx:767-833`) calling the existing `POST .../pause` / `POST .../resume` endpoints (`server/routes.ts:1086-1112`). Show "Paused" state with a prominent Resume. Pause remains available at any time; it is now always escapable via either Resume or sending a message.
5. **Staleness:** leave paused exempt (it is a legitimate resting state now that it has two exits).

**Acceptance**
- [ ] Disable Auto during an autonomous round: current turn completes → `state_update(idle)` → insights event. Next user message starts a fresh round.
- [ ] Pause during a round: current turn completes, mode `paused`, badge shows Paused, Resume button works, and sending a message also restarts the council.
- [ ] New regression tests: (a) message while parked-paused (no turn in flight) restarts; (b) message while paused-mid-turn interrupts after the turn; (c) disable-auto mid-autonomous ends at idle with insights.
- [ ] `npm run check` and `npm run test` pass.

**Files touched:** `server/orchestrator.ts`, `client/src/pages/home-page.tsx`, `tests/orchestrator.test.ts`.

---

### G3 · WebSocket authentication + conversation scoping (audit F1)

**Findings**
- `server/routes.ts:205-236` — `/ws` accepts any connection; no session check. `:238-336` — `broadcastToConversation` sends every conversation's tokens/messages/errors to **all** connected sockets; filtering is client-side only (`home-page.tsx:532`).
- On a multi-user deployment (accounts, tiers, Stripe), any party that can reach `/ws` receives every farmer's private conversation in real time. Highest-severity issue in the codebase.

**Design**
1. **Authenticate the upgrade.** On `wss.on("connection")` parse the session cookie from the upgrade request headers and resolve it against the same express-session store used by HTTP. No valid session → close the socket (code 4401). Attach `userId` to the socket.
2. **Subscription protocol.** The server currently ignores client→server WS messages (`routes.ts:221-227`). Add: `{type:"subscribe", conversationId}` / `{type:"unsubscribe", conversationId}`. On subscribe, verify ownership via `storage.getConversation` (`userId` match) and add to a per-socket `Set<conversationId>`; on failure reply `{type:"subscribe_denied", conversationId}`.
3. **Scoped broadcasts.** `broadcastToConversation` iterates sockets and sends only to those whose subscription set contains `conversationId`.
4. **State replay on subscribe.** After a successful subscribe, immediately send the current `{type:"state_update", mode, isAutonomousEnabled, maxAutonomousTurns}` snapshot so reconnects restore the mode badge correctly (closes the reconnect gap where a mid-stream drop leaves `isProcessing` stale).
5. **Client.** `client/src/lib/websocket-utils.ts`: add `subscribe(socket, conversationId)` / `unsubscribe` helpers. `home-page.tsx`: effect subscribes on `activeConversation` change (and on socket reopen), unsubscribes the previous. Handle `subscribe_denied` with a toast.
6. **Breaking protocol note.** Unsubscribed clients now receive nothing — old clients go silent on WS. Client and server ship in the same deploy; acceptable. No REST changes.

**Acceptance**
- [ ] WS connect without a session: closed with 4401, no broadcasts received.
- [ ] Two authenticated users in separate conversations: each receives only their own `expert_stream_*` / `messages_updated` / `state_update` events (integration test with two sockets).
- [ ] Subscribe to another user's conversation id → `subscribe_denied`.
- [ ] Kill the socket mid-stream, reconnect, resubscribe → correct mode badge without a refetch; in-flight stream that completed meanwhile appears via the existing on-reconnect invalidation.
- [ ] `npm run check` and `npm run test` pass.

**Files touched:** `server/routes.ts`, `client/src/lib/websocket-utils.ts`, `client/src/pages/home-page.tsx`, new `tests/websocket-scoping.test.ts` (or extend an existing route test file).

---

## Phase 1 — Council Mechanics (make the vision real)

### G4 · Mention mechanics, end to end (audit F4 + F6)

**Findings**
- `server/ai.ts:78-80` prompts experts to write `'@[Role Name]'`; nothing anywhere parses, routes on, or renders mentions (`orchestrator.ts:215-240` routing is round-robin/moderator-only; `ChatInterface.tsx:411-413` renders plain markdown). The vision's signature behavior is inert prose.
- No addressing: every user message fans out to all experts (`routes.ts:755-811`, `orchestrator.ts:238-240`).

**Design**
1. **New pure util `shared/mentions.ts`.** `extractMentions(content: string, knownRoles: string[]): string[]` — canonical form `@[Role Name]` (bracketed, case-insensitive); bare `@Role` prefix-matched and tolerated; returns roles in order of first appearance, deduped, filtered to the roster. Unit-tested. Shared so client and server agree.
2. **Persist mentions on the message.** `shared/schema.ts`: `messages.mentions` (jsonb, nullable). `POST /messages` and the orchestrator's expert-message creation parse once and store; the field rides along on every broadcast (`messages_updated`, `expert_stream_done`) so the client never re-parses.
3. **Routing priority in autonomous mode** (`orchestrator.ts:215-240`), in order:
   1. **Mention:** if the just-completed expert's message mentions role R (R ≠ speaker, R in roster) → R speaks next.
   2. **Moderator suggestion** (existing; extended in G5).
   3. **Round-robin** (existing fallback).
   Ping-pong guard: if the same pair of experts has exchanged mentions for 2 consecutive turns, skip to moderator/round-robin. Mention-routed turns still consume the autonomous budget and remain subject to the redundancy stop.
4. **User mentions = selective wake.** If the user's message contains valid mentions, the sequential round runs **only** the addressed experts (in roster order); the autonomous extension still runs over the full council (moderator arbitrates). No mentions → current full fan-out. `processMessageTurnBased` passes the addressee set into the sequence state.
5. **Prompt honesty.** Replace the passive tagging instruction (`ai.ts:78-80`) with the real contract: *"You can direct the discussion: if you write @[Role Name], that expert will be asked to speak next. Tag only when their expertise is genuinely needed; otherwise speak to the table."*
6. **UI.**
   - `ChatInterface.tsx`: render `mentions` from the message row as chips (role-colored, small) under the bubble header — not inline markdown rewriting; also style `@[Role]` occurrences in the body via a ReactMarkdown custom renderer.
   - Composer: `@` triggers an autocomplete popover of the roster (name + role); selection inserts the bracketed form.
   - `ExpertCard.tsx`: mention ring pulse when this expert was mentioned in the latest message.

**Acceptance**
- [ ] Unit tests: `extractMentions` (bracketed, bare, case, unknown roles, self-mention excluded from routing).
- [ ] Orchestrator test: autonomous turn mentioning `@Crop Specialist` → next speaker is Crop Specialist; ping-pong guard forces arbitration after 2 consecutive pair exchanges.
- [ ] Orchestrator test: user message `@Meteorologist …` → sequential round contains only the Meteorologist; autonomous extension includes the full roster.
- [ ] UI: chips render from the `mentions` field; composer autocomplete inserts `@[Role]`; mentioned expert's card pulses.
- [ ] `npm run check` and `npm run test` pass.

**Files touched:** `shared/mentions.ts` (new), `shared/schema.ts` (+migration), `server/routes.ts`, `server/orchestrator.ts`, `server/ai.ts`, `client/src/components/chat/ChatInterface.tsx`, `client/src/components/roundtable/ExpertCard.tsx`, tests.

---

### G5 · Semantic conclusion — the council knows when it's done (audit F5)

**Findings**
- No agent can end the discussion: the Moderator is restricted to role names / `'RoundRobin'` (`ai.ts:228-229`, query at `:792`, validator at `:807`). Stops are the hard cap (2×N, `orchestrator.ts:98`) and the ≥0.80 trigram redundancy trip-wire (`text-similarity.ts:59`). Mechanically fine, semantically blind — and there is no closing synthesis moment.

**Design**
1. **Widen the verdict space.** Moderator role instructions, query prompt, and validator all gain `'Conclude'`: the Moderator answers with a role name, `'RoundRobin'`, or `'Conclude'` (with the charter's stop criteria — G6 — as its reference for when).
2. **Orchestrator handling.** In autonomous mode, `suggestedRole === 'Conclude'` → broadcast `{type:"concluding", conversationId}` → run one **closing synthesis turn** → existing natural-end cleanup (idle + insights). `'Conclude'` is ignored in sequential mode (round 1 is never cut — preserved).
3. **Synthesis turn.** New `generateClosingSynthesis(conversationId, moderatorExpert, broadcastFn)`: streamed assistant message from the Moderator with a dedicated prompt — *summarize consensus, decisions, open disagreements, and next actions; name the experts; be brief.* Does **not** count against `maxAutonomousTurns`. No Moderator in the council → fall back to the existing insights generator as the closing artifact (still broadcasts `concluding`).
4. **Guardrails unchanged.** Cap and redundancy stop remain underneath; a Moderator that never concludes still terminates at the cap.
5. **UI.** `concluding` → status line "The council is concluding…" + the synthesis message renders with a distinct "Closing summary" tag on the bubble.

**Acceptance**
- [ ] Orchestrator test: moderator returns `'Conclude'` → synthesis turn runs (streamed), sequence ends naturally at idle, insights generated; synthesis not counted against the turn cap.
- [ ] `'Conclude'` during sequential mode is ignored (existing behavior preserved).
- [ ] Cap + redundancy tests still green (guardrails intact).
- [ ] UI shows the concluding state and tags the synthesis bubble.
- [ ] `npm run check` and `npm run test` pass.

**Files touched:** `server/ai.ts`, `server/orchestrator.ts`, `server/routes.ts` (broadcast branch), `client/src/pages/home-page.tsx`, `client/src/components/chat/ChatInterface.tsx`, tests.

---

### G6 · Council charter (audit F7)

**Findings**
- Only per-expert instructions exist (`shared/schema.ts:32`, injected at `ai.ts:63-66`). Nothing conversation-scoped governs the roundtable's goal, depth, or stop criteria — the vision's "the system can have those instructions."

**Design**
1. **Schema.** `conversations.charter` (`text`, nullable, hard-capped at 2,000 chars on write). Drizzle migration.
2. **API.** `PUT /api/protected/conversations/:id` accepting `{ title?, charter? }` (ownership-checked like other conversation routes).
3. **Injection.** `generateSystemPrompt` gains a `charter` parameter, rendered as a governing block after the roster: `📜 COUNCIL CHARTER (governs this roundtable — all experts): …`. `getExpertResponseStream` already fetches the conversation (`ai.ts:478`) — pass `conversation.charter` through. The charter is also injected into the Moderator's speaker/conclude prompts (G5) and the synthesis prompt so stop criteria are charter-aware.
4. **UI.** "Charter" button in the conversation header → dialog with textarea + save; charter-present badge in the control bar. First-run nudge (once, dismissible) when a council is assembled without a charter.

**Acceptance**
- [ ] Charter set → present in expert system prompts (unit test on `generateSystemPrompt`; spot-check via `ORCH_DEBUG=1`).
- [ ] Charter editable from the UI, persists across reload, enforced 2,000-char cap.
- [ ] Moderator conclude judgment and synthesis reference the charter (prompt-level; covered by prompt-string tests).
- [ ] `npm run check` and `npm run test` pass.

**Files touched:** `shared/schema.ts` (+migration), `server/routes.ts`, `server/ai.ts`, `client/src/components/layout/Header.tsx` (or control bar), new `client/src/components/roundtable/CharterDialog.tsx`, tests.

---

## Phase 2 — Legibility & Durability (polish that compounds)

### G7 · Survivable orchestrator state (audit F8)

**Findings**
- `orchestrator.ts:46` — state is a module-level Map. Server restart mid-round kills the sequence silently; recovery only occurs if a new message arrives and the stale guard trips (`orchestrator.ts:585-595`), and only for processing modes.

**Design**
1. **Persist a minimal snapshot per turn boundary.** `conversations.orchestrator_state` (jsonb: `{mode, currentExpertIndex, totalAutonomousTurnsTaken, wasInterrupted, pausedFromMode}`). Written in `updateConversationState` (turn boundaries only — never per token).
2. **Cold-start reconstruction.** When `processMessageTurnBased` finds no in-memory state, read the snapshot: `processing_*`/`autonomous` (a dead loop) → recover to `idle` and broadcast the corrected `state_update`; `paused` → restore `paused` (safe now — G2 gives it two exits); `idle`/absent → current behavior.
3. **Non-goal:** multi-instance / horizontal scale. Single-writer per conversation remains; this is restart survival and honest state, not clustering.

**Acceptance**
- [ ] Kill the server mid-autonomous round; restart; open the conversation: mode shows `idle` (corrected snapshot broadcast), next message starts a fresh sequence, no zombie turns.
- [ ] Kill while paused; restart: still paused, resume works.
- [ ] `npm run check` and `npm run test` pass.

**Files touched:** `shared/schema.ts` (+migration), `server/storage.ts` (both storages), `server/orchestrator.ts`, tests.

---

### G8 · Aux-call hygiene (audit F9)

**Findings**
- Hardcoded legacy model slugs: insights `mistralai/mixtral-8x7b-instruct` (`ai.ts:754`) and Moderator fallback `mistralai/mistral-7b-instruct` (`ai.ts:804`) — likely dead on OpenRouter; insights fail silently on fresh installs.
- Moderator routing costs +1 LLM call per autonomous turn and degrades silently to round-robin (`ai.ts:814-817`); the Moderator expert is absent from most councils (one preset has it, `ExpertSelector.tsx:144`) with nothing telling the user what they lose.

**Design**
1. **Model resolution order** for insights and the Moderator fallback: Moderator expert's configured model → `DEFAULT_AUX_MODEL` env → first expert's model. Delete both hardcoded slugs.
2. **Surface degradation.** When the moderator suggestion call fails or returns an invalid verdict, broadcast `{type:"notice", conversationId, message:"Moderator unavailable — speaking in round-robin."}`; client renders an ephemeral toast (not a chat message).
3. **Moderator nudge.** `ExpertSelector`: when a selection has no Moderator, show a one-line suggestion ("Add a Moderator so the council can route itself and conclude on its own"), not a forced default.

**Acceptance**
- [ ] Fresh install without legacy slugs: insights generate via the resolved model; moderator fallback resolves per the order above (unit test on the resolver).
- [ ] Forced moderator-call failure (mocked): round-robin continues and the notice toast appears.
- [ ] `npm run check` and `npm run test` pass.

**Files touched:** `server/ai.ts`, `server/orchestrator.ts` (notice broadcast), `server/routes.ts`, `client/src/pages/home-page.tsx`, `client/src/components/roundtable/ExpertSelector.tsx`, tests.

---

### G9 · Legibility: next-speaker preview, quiet console, carried-forward context (audit F10–F12)

**Findings**
- No "who's next" signal between turns; `ExpertCard` has no typing state (the project's own `SPEC.md:86` promised one).
- Every WS payload is `console.log`ged (`home-page.tsx:529`).
- History window is 15 messages / Moderator 6 (`ai.ts:512-515`, `:796-799`); early commitments fade and invite re-litigation, currently caught bluntly by the redundancy stop.

**Design**
1. **Next-speaker preview.** The orchestrator knows `nextExpertIndex` before the turn starts (`orchestrator.ts:255-267`): broadcast `{type:"next_speaker", conversationId, expertId, expertRole}` there. Client: "up next" chip + shimmer on that expert's card; `ExpertCard` gains `isUpNext`/`isTyping` props (shimmer on `expert_stream_start`).
2. **Quiet console.** Gate all WS/received-event `console.log`s behind `import.meta.env.DEV` or a `localStorage.ffDebug` flag (client), `ORCH_DEBUG` already exists server-side.
3. **Carried-forward context.** When building expert turns, if the conversation has a stored Insight from a prior sequence, inject a compact "PRIOR DECISIONS" block (latest insight points) alongside the history window — replacing nothing, just anchoring. Keeps early commitments visible past the 15-message window at zero extra model calls (insights already exist).

**Acceptance**
- [ ] Between turns, the invited expert's card shows the up-next state before tokens arrive (WS event order: `next_speaker` → `expert_stream_start`).
- [ ] Production console shows no per-event WS logs.
- [ ] A conversation with a stored insight injects the PRIOR DECISIONS block into subsequent expert prompts (unit test on message assembly).
- [ ] `npm run check` and `npm run test` pass.

**Files touched:** `server/orchestrator.ts`, `server/ai.ts`, `client/src/pages/home-page.tsx`, `client/src/components/roundtable/ExpertCard.tsx`, tests.

---

## Non-goals (explicitly out of scope)

- Parallel/overlapping expert turns or backchannels — the council stays serial; the vision is served by routing + conclusion, not concurrency.
- Multi-instance orchestration (single-writer per conversation stands; G7 is restart survival only).
- Any change to billing/tiers/Stripe, farm profiles, weather, vision handling, or the visualization prompt block.
- Rewriting `MemStorage` away — both storages get every schema addition.

---

## Contract Terms

**I will:**
1. Execute phases in order (P0 → P1 → G7 → G8 → G9), one commit per G-item with clear messages.
2. Run `npm run check` + the full test suite before each commit; add the regression tests named in each acceptance block (steering, deadlock, WS scoping, mention routing, conclude, snapshot recovery).
3. Preserve existing tested semantics unless this spec says otherwise: newest-message-wins, full-round restart on steering, sequential round never cut, 2×N cap, 0.80 redundancy threshold, duplicate-submission gate.
4. Keep both `PostgresStorage` and `MemStorage` complete for every schema change.
5. Flag blockers immediately — no silent scope changes.

**I won't:**
1. Touch Stripe, tiers, farm/weather, or vision pipelines.
2. Change REST API shapes used by existing clients except additively (new fields/events only; the WS subscribe change is the one acknowledged breaking change, same-deploy).
3. Push to remote or deploy without explicit approval.
4. Start before this spec is approved.

---

## Estimated Scope

| Item | Lines (approx) | Risk | Notes |
|------|----------------|------|-------|
| G1 steering | ~80 changed | Low | mostly client deletion + one broadcast |
| G2 deadlock | ~120 changed | Medium | turnInFlight touches the core loop; well-tested area |
| G3 WS scoping | ~200 new/changed | Medium-High | upgrade auth + protocol; the one breaking change |
| G4 mentions | ~400 new/changed | Medium | parser + routing + schema + UI chips/autocomplete |
| G5 conclusion | ~200 new/changed | Medium | verdict widening + synthesis turn |
| G6 charter | ~250 new/changed | Low | column + injection + dialog |
| G7 state snapshot | ~150 changed | Medium | persistence at turn boundaries |
| G8 aux hygiene | ~100 changed | Low | |
| G9 legibility | ~180 changed | Low | |
| **Total** | **~1,700** | | 3 sessions: P0, P1, P2 |

---

**⛔ STOP — AWAITING APPROVAL**

Reply with:
- "approved" → I start Phase 0 (G1) immediately
- "approved for phase X / item G-N only" → scoped execution
- Changes / questions → I revise and re-present
