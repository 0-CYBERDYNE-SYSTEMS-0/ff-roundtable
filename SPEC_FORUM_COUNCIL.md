# SPEC — Forum Council: A Roundtable That Behaves Like Real Experts

**Branch:** `feat/forum-council` (from `main` @ `fffc585`, after PR #5 merged)
**Status:** APPROVED 2026-09-25 — budget default 25 turns + "let it run"; G11 retires newest-message-wins/full-round-restart
**Builds on:** `SPEC_AUTONOMOUS_COUNCIL.md` (G1–G9). Goal IDs continue at G10.

---

## Mission

> The council works like a room of real experts, or a Discord channel of them. A chair always holds the floor — the farmer when present, an agent Moderator when not. Experts answer each other by name, agree, disagree, challenge, and tag each other or the farmer. A question to an absent farmer never stops the room: it is logged, the experts proceed on stated assumptions, and the answer is folded in whenever it arrives. Depth scales with the problem inside a budget. Every discussion ends in a record: positions, consensus, dissent, open questions, assumptions awaiting confirmation.

### Semantics this spec deliberately changes

| Was (G1–G9) | Becomes |
|---|---|
| Any user message mid-sequence interrupts and restarts a full sequential round (newest-message-wins) | A user message **joins** the discussion; the chair routes who responds. Interrupt-restart survives only as an explicit command |
| Every user message starts a sequential round where every expert speaks in order | No forced roll-call; the first responder(s) are picked by mention or chair |
| Moderator is an optional roster expert (absent from the default council) | Moderator is always seated, system-provided, hidden from the roster picker |
| Autonomous cap `experts.length * 2` | Per-council turn budget (default 25, or unlimited) + Moderator continue/conclude judgment |
| Experts can tag experts only | Experts can tag `@[User]`; open questions are tracked, never blocking |
| Conclude = one model's judgment | Conclude backed by a stance ledger; closing record lists consensus, dissent, assumptions |

Invariants from `HANDOFF_AUTONOMOUS_COUNCIL.md` §2 that **still hold**: single turn chain (`turnChainScheduled` claim rule for any new `setImmediate` site), WS auth/scoping, both storages complete, `isUsableConversationState` covers new state fields, `disableAutonomous()` never pauses, 0.80 redundancy brake, mention ping-pong guard.

---

## G10 · The Moderator is always seated

**Design**
1. When a conversation's roster lacks a `Moderator`, the orchestrator seats a **system Moderator** (synthetic `Expert`, `role: "Moderator"`, model from `resolveAuxModel` → `DEFAULT_AUX_MODEL` → first expert's model). It is not a user-created row; it never takes a normal expert turn — it only routes, recaps, and concludes.
2. A roster Moderator the user added keeps working as today (its configured model wins).
3. `client/src/components/roundtable/ExpertSelector.tsx`: remove the "add a Moderator" nudge (G8); Moderator no longer offered as a pickable role.
4. Moderator-degraded notice (G8) stays.

**Acceptance**
- [ ] `/api/dev/quick-setup` council (no Moderator) gets mention/moderator routing and can Conclude.
- [ ] System Moderator never appears as a speaking turn except the closing synthesis/recaps.
- [ ] Tests: seating with and without a roster Moderator; model resolution order.

---

## G11 · Messages join the flow (no reset, no roll-call)

**Design**
1. `processMessageTurnBased` busy branch (`server/orchestrator.ts` ~1008): stop setting `wasInterrupted`. Append the message to history; set `pendingUserMessage` so the next routing decision sees it; current expert finishes; routing continues in the same sequence (budget counters untouched).
2. Routing for the turn after a user message: **user mentions > Moderator pick (told "the farmer just spoke") > round-robin**. User mentions no longer narrow a forced round — they pick first responders.
3. Idle branch: a new message starts a sequence in `autonomous` mode directly. `processing_sequential` is retired as a forced roll-call; the first turn is picked by mentions or the Moderator. (Keep the mode value readable in snapshots for G7 recovery of old rows → map to `autonomous`.)
4. Explicit restart: `POST .../restart` (and a composer command `/new`) keeps the old interrupt-and-restart path for a genuine topic change.
5. Paused branch: message resumes in place (no reset).
6. Remove the "Steering…" banner semantics; replace with a subtle "the council will pick this up next" indicator.

**Acceptance**
- [ ] Message mid-sequence: current expert finishes, next speaker responds to the farmer's message, `totalAutonomousTurnsTaken` continues (not reset).
- [ ] `@[Soil Scientist] …` from the farmer: Soil Scientist speaks next; no other forced turns.
- [ ] `/new` restarts on the new topic.
- [ ] Existing steering/restart tests rewritten to the new semantics; all other orchestrator tests green.

---

## G12 · `@[User]` — non-blocking questions to the farmer

**Design**
1. `shared/mentions.ts`: recognize `@[User]` / `@[Farmer]` as the reserved token `"User"`; never routed as a speaker.
2. Expert prompt (`server/ai.ts` ~90): "Tag @[User] only for facts only the farmer can know. Do not wait for an answer — state the assumption you will proceed on (`Assuming …`)."
3. Schema: `open_questions` table (or jsonb on conversation) `{id, messageId, expertRole, question, assumption, status: open|answered, answerMessageId}` — both storages.
4. Farmer reply: composer offers "Answer" on an open question → message stored with `answersQuestionId`; question marked answered; Moderator told "the farmer answered X: … — revisit assumptions that conflict". If the council is idle, the answer starts a sequence (G11).
5. Client: badge "N questions for you" + side panel listing open questions with the expert's assumption.
6. Broadcast `open_questions_updated`.

**Acceptance**
- [ ] Expert tags `@[User]` → question logged, discussion continues without pause.
- [ ] Answer hours later → linked, question closed, council resumes addressing it.
- [ ] Tests: parser reserved token; ledger create/answer in both storages; no routing to "User".

---

## G13 · Depth budget replaces the hard cap

**Design**
1. `conversations.turn_budget` int nullable (default 25; `null`/0 in UI = "let it run", server still enforces a hard safety ceiling of 100 and the tier limits in `server/tiers.ts`).
2. `maxAutonomousTurns` initializes from the budget, not `experts.length * 2`.
3. Moderator suggestion prompt gains budget awareness ("turn 14 of 25") and an explicit choice: continue / go deeper with a role / Conclude.
4. Redundancy brake unchanged.
5. Client: budget control in the charter dialog (G6).

**Acceptance**
- [ ] Default council runs up to 25 turns unless Moderator concludes or redundancy stops it.
- [ ] "Let it run" stops at the 100 ceiling.
- [ ] Tests: budget init, ceiling, PUT validation.

---

## G14 · Experts talk to each other

**Design** — prompt-only (`generateSystemPrompt`):
- Build on or challenge a specific colleague by name; say "I agree with X because…" / "I disagree with X on…".
- Tag an expert when you need their specialty or want them to defend a point.
- Don't repeat what's settled; add new information or a new objection.
- End with a stance line (G15).

**Acceptance**
- [ ] Prompt unit test covers the new block; live run shows cross-references in ≥ half of turns after the first.

---

## G15 · Stance ledger and a verdict with dissent

**Design**
1. Each expert reply ends with a machine line: `STANCE: <agree|disagree|conditional|abstain> | <confidence 1-5> | <one-line position>`. Parsed in `server/ai.ts` (no extra model call), stripped from displayed content, stored on the message (`messages.stance` jsonb) — both storages.
2. Orchestrator keeps the latest stance per expert for the current question.
3. Moderator Conclude gate: allowed when stances converged (all non-abstain agree/conditional) **or** budget ≥ 80% used with a stable split. Otherwise Moderator continues and targets the dissenter.
4. `generateClosingSynthesis` input includes the ledger; output sections: **Verdict**, **Consensus**, **Dissent (named)**, **Open questions for you**, **Assumptions awaiting confirmation**.
5. Client: compact stance row on the council panel (per-expert chip colored by stance); verdict card on the synthesis message.

**Acceptance**
- [ ] Stance parsed and stripped; missing/malformed stance line tolerated (stance null).
- [ ] Conclude blocked while an unaddressed dissent exists and budget remains.
- [ ] Synthesis includes named dissent and open questions.

---

## G16 · Threads (later — separate spec pass)

Side debates between 2–3 experts branch into a thread; the thread's outcome posts back to the main channel as a summary. Deferred: needs schema (`parent_message_id` / thread id), per-thread orchestrator state, and client layout. Spec it after G10–G15 have been run live.

---

## Order & scope

| Item | Size | Risk | Notes |
|---|---|---|---|
| G10 always-seated Moderator | S | Low | unlocks everything below |
| G11 join-the-flow | M | **High** | rewires core loop + rewrites steering tests |
| G12 `@[User]` ledger | M | Medium | schema + client panel |
| G13 depth budget | S–M | Low | |
| G14 cross-talk prompts | S | Low | |
| G15 stance ledger + verdict | M | Medium | |
| G16 threads | L | — | deferred |

One commit per G-item (`feat(G10): …`), `npm run check` + `npm test` before each, `npm run db:push` before live verification (new columns: `turn_budget`, `stance`, open questions). Live-verify with the quick-setup council (no roster Moderator) after G11 and after G15.

**Non-goals:** parallel/overlapping turns; multi-instance orchestration; billing/tier changes beyond respecting existing limits.
