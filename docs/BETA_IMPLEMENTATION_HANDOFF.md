# Beta implementation session handoff

Prepared 2026-10-11. Workspace preparation only; specification implementation has not started.

## Start here

Read [the beta specification](BETA_READINESS_SPEC.md) and [the live QA report](qa/2026-10-11-farmer-roundtable/report.md). The user wants a coordinated professional farming council, natural farmer input, real API generation, usable deliverables, and honest final conclusions. Use real browser input and real expert responses for acceptance; automated tests supplement that evidence.

The tested fixes are checkpointed as `fa10d98`. The report, evidence, and specification are checkpointed as `3af32b0` on `feat/forum-council`. The integration branch is `feat/beta-readiness`, created from those checkpoints. Work from that branch; do not reopen the old QA branch for implementation. Nothing has been pushed by this setup task.

## Prepared team topology

| Role | Branch | Worktree | Initial ownership |
|---|---|---|---|
| Lead/integration | `feat/beta-readiness` | `/Users/scrimwiggins/Dev/FarmFriendRoundtable-PRO` | Architecture decisions; integration; `shared/schema.ts`, `server/storage.ts`, shared routes and page-level UI unless explicitly delegated |
| Council worker | `work/beta-council` | `/Users/scrimwiggins/Dev/FarmFriendRoundtable-beta/council` | `server/orchestrator.ts`, `tests/orchestrator.test.ts`; bounded work, routing, persistence, terminal handoff |
| Deliverables worker | `work/beta-deliverables` | `/Users/scrimwiggins/Dev/FarmFriendRoundtable-beta/deliverables` | `server/ai.ts`, `server/ai-providers.ts`, focused AI tests; generation constraints, evidence and deliverable contracts agreed with lead |
| Live validator | `work/beta-validation` | `/Users/scrimwiggins/Dev/FarmFriendRoundtable-beta/validation` | Real browser QA and new dated evidence only; no application-source changes or shared app control without coordination |

Herdr linked workspaces are labeled **Beta Council**, **Beta Deliverables**, and **Beta Validation**. Their shell panes are prepared but no new worker agent is running. Existing `farmer-luna` and `council-audit` agents belong to the completed QA session and are idle; do not treat their old context as a fresh implementation assignment.

Use `herdr agent list`, `herdr workspace list`, and `herdr pane list` to discover current IDs. IDs are runtime handles; do not guess them. Preserve the lead's focus with `--no-focus` when creating layout. Read the Herdr skill fully before controlling panes.

At the next session, start fresh Codex workers in the prepared shell panes with the user's requested model and effort:

```sh
herdr agent start beta-council --kind codex --pane <council-pane-id> -- -m gpt-6-luna -c model_reasoning_effort=max -s danger-full-access -a never
herdr agent start beta-deliverables --kind codex --pane <deliverables-pane-id> -- -m gpt-6-luna -c model_reasoning_effort=max -s danger-full-access -a never
herdr agent start beta-validator --kind codex --pane <validation-pane-id> -- -m gpt-6-luna -c model_reasoning_effort=max -s danger-full-access -a never
```

Choose small explicit tasks before submitting prompts. Workers are not alone in the repository: never revert another person's changes, widen file ownership silently, or modify shared modules without coordination. Worktrees isolate Git edits but do not isolate the shared database or application.

## Coordination and completion protocol

1. Lead assigns one requirement and exact file ownership per worker. Start with BETA-01 and BETA-02 contracts before dependent calendar/UX changes. Workers report proposed cross-module changes to the lead before editing them.
2. Each worker acknowledges scope, reports a reproduced defect and important contract decisions, and checks in when blocked or changing direction. Lead monitors via `herdr agent read <name> --source visible` and lifecycle state; successful prompt submission is not proof of completion.
3. Workers commit only their owned changes. Completion reply includes commit SHA, files changed, verification results, remaining risks, and integration dependencies. If Herdr history is unavailable, save a report in that worker's ignored `.local/` folder and return its path.
4. Lead reads the actual completion, reviews the diff, and cherry-picks reviewed commits onto `feat/beta-readiness`. Avoid bulk merges containing unrelated edits. Integrate shared schema/routes centrally.
5. Update idle clean worker branches to the latest integration branch before their next assignment. Never reset or remove a dirty worktree to synchronize it.
6. Run shared live QA serially through one validator against the integrated app. Coordinate server restarts and schema changes; do not let workers overwrite each other's farmer sessions.
7. Preserve final live evidence under a new `docs/qa/<date>-<scenario>/` directory. Do not overwrite the existing historical QA evidence. Track each spec requirement as PASS/FAIL/BLOCKED.

## Environment and cost controls

- Main app: `http://localhost:5001`. One shared development server should run from the integration worktree. Check whether it is already running before `npm run dev`.
- PostgreSQL17 is installed and runs as a Homebrew service. Database: `farm_roundtable_dev`. Verify with `/opt/homebrew/opt/postgresql@17/bin/pg_isready`.
- The main worktree's ignored, private `.env` contains the working API configuration, encryption key, and database URL. Do not print, commit, copy into reports, or distribute credentials to worker worktrees. No local AI service is required.
- `uploads/` is ignored and remains in the main worktree. Git commits do not back up the live database or uploaded files. Preserved QA downloads are tracked separately under `docs/qa/`.
- Worker worktrees reuse the current installed dependencies through a local ignored `node_modules` symlink. Package or lockfile changes require lead coordination and isolated dependencies before installation; never run a worker package install through that shared symlink.
- Worker `.local/WORKER_READY.md` files repeat scope and startup instructions and are ignored. Workers do not launch additional app servers or apply database changes independently.
- Baseline verification: 542 tests passed; TypeScript and production build passed. Run checks appropriate to new changes, then final integrated checks and real acceptance scenarios.
- Weather One Call3.0 currently needs subscription activation; do not claim forecast availability. Markdown conversation export and the final transcript-link download remain live verification tasks.
- Codex workers use MAX reasoning as requested. Development API expert calls currently use optional `OPENROUTER_REASONING_EFFORT=low`; this is independent of worker effort. Validate response quality and latency before changing it.
- Record a bounded API spend limit before live scenario batches. Stop safely at that limit, retaining completed outputs and reporting missing work. Avoid repeated large snapshots and redundant full-suite runs.

## Suggested first message for the next session

> Implement `docs/BETA_READINESS_SPEC.md` from `feat/beta-readiness`. First read `docs/BETA_IMPLEMENTATION_HANDOFF.md` and the preserved live QA report. Use the prepared Herdr worktrees and GPT-6 Luna MAX workers with explicit file ownership and monitored check-ins. Start with bounded routing and canonical deliverables. Validate through real farmer input, actual OpenRouter responses, and real downloads. Do not rely on mocked expert responses to approve beta readiness.
