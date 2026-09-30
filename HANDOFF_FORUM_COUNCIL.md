# HANDOFF — Forum Council (feat/forum-council)

**For:** incoming dev team
**Date:** 2026-09-28
**Mission:** Implement `SPEC_FORUM_COUNCIL.md` G10–G15 (G16 threads deferred), verify in the real app, ship a PR to `main`.

---

## 1. Where things stand

- `main` (`fffc585`) contains everything through G9 (PR #5, merged; CI green: typecheck, tests, lint, security). PR #3 (.ics export + image vision) was already absorbed into `main` via PR #4 and is closed as superseded.
- Branch `feat/forum-council` = `main` + docs only (spec, this handoff, `CLAUDE.md`). **No G10–G16 code yet.** A draft PR tracks it.
- Baseline: `npm run check` clean; 430/430 tests pass (18 files).

## 2. Product intent (read before coding)

The roundtable should behave like a room — or a Discord channel — of real experts: a chair always holds the floor (the farmer when present, an agent Moderator when not); experts address each other by name, agree, disagree, and tag each other or the farmer; a question to an absent farmer **never pauses** the room (logged, experts proceed on stated assumptions, the answer is folded in whenever it arrives); depth scales with the problem inside a budget; every discussion ends in a record — verdict, consensus, named dissent, open questions, assumptions.

Owner decisions (2026-09-25): default turn budget **25** plus a "let it run" option (safety ceiling 100); **G11 approved** — user messages join the flow instead of interrupting and restarting the round.

## 3. Invariants

Still binding (from `HANDOFF_AUTONOMOUS_COUNCIL.md` §2):
- **Single turn chain** — any new `setImmediate(processNextTurn)` site must claim `turnChainScheduled` (copy the existing pattern in `server/orchestrator.ts`).
- WS auth/scoping protocol (`server/routes.ts`); `disableAutonomous()` never pauses; 0.80 redundancy brake; mention ping-pong guard.
- Every schema change lands in both `PostgresStorage` and `MemStorage`; new `ConversationState` fields go into `isUsableConversationState`.

Deliberately changed by this spec: newest-message-wins/full-round restart (G11), forced sequential roll-call (G11), 2×N cap (G13), optional Moderator (G10).

## 4. Work order

G10 → G11 → G12 → G13 → G14 → G15, one commit per item (`feat(G10): …`), `npm run check` + `npm test` before each. Details and acceptance criteria are in the spec.

Risks:
- **G11 is the high-risk item** — it rewires `processMessageTurnBased` and the sequential/autonomous transition; existing steering/interrupt tests in `tests/orchestrator.test.ts` must be rewritten to the new semantics, not deleted. Keep the old restart path reachable via `/new`.
- G10/G11/G13/G15 all touch `server/orchestrator.ts` + `server/ai.ts` — do them sequentially, not in parallel.
- G7 snapshots may contain `processing_sequential`; map to the new flow on recovery.

## 5. Verification & ship

1. `npm run db:push` before any live run (new columns: turn budget, stance, open questions — plus G5/G6/G7 columns if the dev DB predates them). Tests use MemStorage and will not catch a missing column.
2. `npm run dev` (port 5001) → `POST /api/dev-login` → `POST /api/dev/quick-setup` (4 experts, **no roster Moderator** — exercises the G10 system Moderator).
3. Live checks: message mid-discussion joins without reset; expert `@[User]` logs a question and the room keeps going; answer later resumes it; Moderator concludes with named dissent; budget ceiling holds.
4. G1–G9 were never verified live against real models (notably the Conclude → closing synthesis path) — cover it in the same session.
5. Free OpenRouter slugs in `server/dev-config.json` get retired and 404 — refresh them if live calls fail.

## 6. Environment notes

- Untracked `jev-audit/` and `videos/` are unrelated — keep them out of commits.
- `core.fileMode` is set to `false` locally (a folder copy had flipped 457 files to 755). Other clones may need the same.
- Known test flake: occasional 401s in `tests/auth.test.ts` / `tests/billing.test.ts` on full runs — pre-existing; rerun before treating as a regression.
