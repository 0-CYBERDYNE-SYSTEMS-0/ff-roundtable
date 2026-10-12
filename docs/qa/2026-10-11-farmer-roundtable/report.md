# FarmFriend farmer dogfood QA — 2026-10-11

Report and referenced evidence are preserved in this repository. The lead follow-up section records the latest results; earlier sections retain the original test observations.

| Field | Value |
|---|---|
| Date | 2026-10-11 |
| App | http://localhost:5001 |
| Browser session | `farmer-luna` (left open) |
| Database | Persistent PostgreSQL development database `farm_roundtable_dev`; lead confirmed profile and conversation survived server restart |
| API | Funded platform API configured; no key material recorded here |
| Fixture | [fixtures/fictional-farm-inputs.csv](fixtures/fictional-farm-inputs.csv) |
| Code | No source read or app code edited by QA |

## Overall result

**Core dogfood flow now works, but the final retry is not a clean pass.** In existing conversation ID 3, the lead ran `/new` with the saved roster and fixture. Message 10 (Research Analyst) returned traceable Iowa State sources, message 11 (Crop Specialist) produced correct quote arithmetic and a rendered 4-row table, and messages 12–13 (File Creator) created two downloadable SOPs with the same name. The calendar retest contains 10 valid 2027 events. The retry ended `Idle` without an explicit closing council message.

Open issues: the saved 4-turn charter was reportedly ignored by the `/new` orchestrator, Crop Specialist made an unsupported 130–140 lb N/ac agronomic inference, File Creator produced two same-name files both over the requested 2,000-character limit, and the round ended without a final synthesis.

## Environment and fixture

Prairie Bend Farm is a fictional 120-acre, rain-fed corn farm near Ames, Iowa, following soybeans; yield goal 180 bu/ac, pH 6.3, OM 3.4%, and fictional urea/UAN prices. The quotes are explicitly fictional, not current market prices. No weather forecast was available, and the final outputs correctly did not invent one.

Saved conversation ID 3 had these exact models and the uploaded fixture:

- Soil Scientist — `z-ai/glm-5.3-flash`
- Crop Specialist — `deepseek/deepseek-v4.1-flash`
- Research Analyst — `xiaomi/mimo-v2.6-flash`
- File Creator — `openai/gpt-6-luna`

Lead submitted the final request in this existing conversation, not a newly created roundtable. I only observed the result and downloaded the visible files; I did not send messages or change the roster/charter. Empty test conversations were preserved.

## Final retry findings

### Research sources: PASS with a rate-claim caveat

The Research Analyst explicitly withdrew its prior, unverified citations, then cited three Iowa State Extension publications. I checked the linked content:

1. [Iowa State 2026 crop production budgets (PDF)](https://www.extension.iastate.edu/AGDm/crops/pdf/a1-20.pdf) states that 2026 corn budget N rates use N-FACT, gives a projected corn:N price ratio of 7.74, and lists nitrogen at $0.53/lb. Its corn-after-soybean table lists 117, 159, and 174 lb N/ac for 190, 211, and 232 bu/ac budgets.
2. [Iowa State LSNT decision-support article](https://crops.extension.iastate.edu/post/nitrogen-soil-sampling-late-spring-nitrate-test-lsnt-decision-support-tool-help-n-fertilizer) supports the cited 7 ppm example: 71% chance of yield response and 149 lb N/ac average sidedress need, with a 13–193 range.
3. [Iowa State 2026 late-spring nitrate article](https://crops.extension.iastate.edu/post/late-spring-nitrate-test-2026-opportunity-reduce-nitrogen-costs) supports the cited 4 ppm median, 0–10 ppm interquartile range, and an approximately 55 lb N/ac difference in rate needs across that range.

The Crop Specialist’s claim that the retrieved 7.74 price ratio implies a corn-after-soybean MRTN of 130–140 lb N/ac is **not established by the cited budget PDF**. That PDF reports different rates by yield budget, and the response did not show an N-FACT result for this farm. Treat the 130–140 figure as an unsupported inference; the File Creator’s safer instruction to check field-specific N-FACT is appropriate.

### Cost comparison and chart: PASS

Crop Specialist computed `$550 / (2,000 × 0.46) = $0.598/lb N` for urea and `$420 / (2,000 × 0.32) = $0.656/lb N` for UAN-32. The corresponding $65/ac capacities are about 108.7 and 99.0 lb N/ac. The 4-row comparison table rendered in the conversation: urea, UAN-32, unquoted anhydrous, and anhydrous break-even. It correctly labels the prices as fictional and flags the product-only budget assumption, application costs, and urea volatilization/inhibitor costs. The break-even anhydrous price is approximately $980–$981/ton at 82% N, before application costs.

This is a budget comparison, not a farm-specific rate prescription. The specialist itself says to confirm the rate through N-FACT and asks whether the $65 cap includes application passes.

### SOP files: creation/download PASS; length and duplication FAIL

Files appeared in the Files pane without a page refresh. The UI showed two attachments named `prairie_bend_nitrogen_sop.md`; both downloaded through their visible UI download links and contain four ISO-dated tasks (2027-04-05, 2027-04-12, 2027-04-19, 2027-05-17), the fictional-price caveat, unknowns, and no invented forecast.

- [prairie_bend_nitrogen_sop-1.md](prairie_bend_nitrogen_sop-1.md) — 2,728 bytes / 2,710 characters
- [prairie_bend_nitrogen_sop-2.md](prairie_bend_nitrogen_sop-2.md) — 2,562 bytes / 2,543 characters
- Lead reports the latest copy is also saved as [lead-final-sop.md](lead-final-sop.md) (2,728 bytes).

Both exceed the prompt’s 2,000-character limit. The duplicate same-name attachments make it unclear in the app which version is canonical. The contents themselves are usable planning drafts but explicitly defer final N-rate selection to N-FACT.

### Closing synthesis: FAIL

The run reached `Idle` after Research, Crop Specialist, and duplicate File Creator outputs. A sidebar insight card summarizes the plan, but no final moderator/council message tied the source caveat, product-cost comparison, budget-scope question, and next actions together in the conversation. Evidence: [screenshots/72-final-chart-view.png](screenshots/72-final-chart-view.png) and the live conversation transcript.

## Calendar, empty states, progress, and persistence

- **Calendar anchor: pass after explicit date change; default-date path fails.** [calendar-2027-retest.ics](calendar-2027-retest.ics) has 10 events, starts 2027-04-05, and W7 starts 2027-05-17. The older [calendar-2027.ics](calendar-2027.ics) is a failed baseline: it starts 2026-10-12 because the date control was left at its default. The app still displayed that default in the later screenshot. Set and verify the anchor before export.
- **No-schedule recovery: pass after UI fix.** Exporting with no schedule produced an actionable toast instead of a raw JSON page. Evidence: [screenshots/47-no-schedule-ics-enabled.png](screenshots/47-no-schedule-ics-enabled.png), [screenshots/48-no-schedule-toast.png](screenshots/48-no-schedule-toast.png), and [screenshots/lead-calendar-no-schedule.png](screenshots/lead-calendar-no-schedule.png).
- **Chart visibility: pass after UI fix.** Earlier, Visualizations said “No visualizations available” while chart artifacts existed. Lead verified charts render in the conversation/sidebar after the fix; the final 4-row table is visible in the retry. Evidence: [screenshots/lead-visualizations-verified.png](screenshots/lead-visualizations-verified.png), [screenshots/lead-charts-rendered.png](screenshots/lead-charts-rendered.png), and [screenshots/72-final-chart-view.png](screenshots/72-final-chart-view.png).
- **Files empty state and refresh behavior:** the initial empty state was clear. In the final retry, the created SOPs appeared immediately when Files was opened, without a page refresh; see [screenshots/71-final-files-tab.png](screenshots/71-final-files-tab.png).
- **Persistence: pass for existing setup.** Lead verified Prairie Bend Farm and conversation ID 3 survived backend restart under PostgreSQL. This does not independently verify that the latest retry outputs survive another restart. Evidence: [screenshots/41-postgres-session-after-reload.png](screenshots/41-postgres-session-after-reload.png).
- **Mobile: pass after lead’s responsive-layout fixes.** Lead rechecked header and controls after reload. Evidence: [screenshots/lead-mobile-header-fixed.png](screenshots/lead-mobile-header-fixed.png), [screenshots/lead-mobile-controls-fixed-after-reload.png](screenshots/lead-mobile-controls-fixed-after-reload.png), and [screenshots/lead-mobile-council.png](screenshots/lead-mobile-council.png).

## Historical failures and recovery

These belong to earlier attempts and must not be reported as the final retry’s results:

- Initial provider call returned OpenRouter 402 because the account lacked credits. The lead configured a funded API key; the 402 is no longer the active generation blocker. The raw error exposed provider token/credit details and external links but no farmer-oriented support path. No API key is included in this report.
- With funding configured, the first substantive round still had a Soil Scientist response truncated mid-chart JSON, a Research Analyst timeout, a false citation of `c1-60.pdf` as corn-nitrogen guidance (lead verified it was an Iowa farm-wage survey), an unsubstantiated “typical” anhydrous price range, and a File Creator JSON error. Evidence: [screenshots/lead-truncated-chart.png](screenshots/lead-truncated-chart.png), [screenshots/61-research-analyst-timeout.png](screenshots/61-research-analyst-timeout.png), [screenshots/67-paused-file-creator-state.png](screenshots/67-paused-file-creator-state.png), and [research-response.md](research-response.md).
- In the final retry, Research explicitly withdrew the unverified prior citations and used retrieved ISU sources. Do not carry the old false citation forward as a current source pass; retain it as a historical failure.

## Open findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| FF-001 | High | Saved charter is 4 turns, but lead reports `/new` orchestration retained max 6. | Fixed; restart-budget regression passes (see lead follow-up) |
| FF-002 | Medium | Crop Specialist’s 130–140 lb N/ac inference is not supported by the cited budget table or a displayed N-FACT result. | Claim withdrawn in live follow-up; field-specific rate remains unresolved |
| FF-003 | Medium | File Creator duplicates same-name SOPs and both exceed the 2,000-character prompt limit. | Open |
| FF-004 | Medium | Calendar control defaults to 2026-10-12 and the uncorrected export uses that date despite a 2027 plan. | Workaround verified; default behavior remains misleading |
| FF-005 | Low | Run ended idle without explicit closing synthesis. | Verdict delivered after farmer follow-up; initial automatic handoff gap remains |
| FF-006 | Low | Provider 402 message is operator-oriented and lacks in-app farmer recovery guidance. | Historical setup blocker resolved; UX issue remains |

## Reproduction and evidence index

- Persistent profile and reload: [screenshots/36-persistent-onboarding-filled.png](screenshots/36-persistent-onboarding-filled.png), [screenshots/41-postgres-session-after-reload.png](screenshots/41-postgres-session-after-reload.png).
- Exact selected models and saved charter evidence: [screenshots/43-roster-support-gpt6-selected.png](screenshots/43-roster-support-gpt6-selected.png) through [screenshots/46-charter-six-saved.png](screenshots/46-charter-six-saved.png). The final 4-turn charter state was lead-confirmed; the `/new` enforcement discrepancy is FF-001.
- Final files pane and generated table: [screenshots/71-final-files-tab.png](screenshots/71-final-files-tab.png), [screenshots/72-final-chart-view.png](screenshots/72-final-chart-view.png).
- Downloaded final files: [prairie_bend_nitrogen_sop-1.md](prairie_bend_nitrogen_sop-1.md), [prairie_bend_nitrogen_sop-2.md](prairie_bend_nitrogen_sop-2.md), and lead-reported [lead-final-sop.md](lead-final-sop.md).
- Valid and failed calendar downloads: [calendar-2027-retest.ics](calendar-2027-retest.ics) (10 events, anchored 2027) and [calendar-2027.ics](calendar-2027.ics) (failed 2026 default).
- Original raw report and response captures were replaced by this final report; raw response captures remain at [soil-response.md](soil-response.md) and [research-response.md](research-response.md).

## Lead follow-up: real application testing

After this report, the lead submitted real farmer follow-up text through the browser. Crop Specialist explicitly withdrew the unsupported 130–140 lb N/ac inference. Research agreed and the application rendered an actual Council Verdict with consensus, dissent, open questions and assumptions (messages 15–17). The missing wrap-up is therefore recoverable through farmer follow-up, but was not automatic in the original retry.

The handoff initially invented `/uploads/prairie_bend_nitrogen_sop.md`, which is not a stored URL. Lead added exact stored download URLs to attached-file context. A second live follow-up returned a real hashed URL; its URL matches an existing stored attachment. The browser automation download attempt stalled and an unauthenticated HTTP check returned401; that follow-up link has not been independently click-verified. Earlier authenticated Files-pane downloads passed. It selected the earlier file despite asking for latest, so version selection remains imperfect. This follow-up also triggered unnecessary File Creator turns/errors despite requesting no file, which remains an orchestration gap.

The saved turn-budget restart defect was fixed and regression verified. Final source checks: all 542 tests passed, TypeScript passed, production build passed. These supplement the real browser/API checks; they do not certify model output quality. PostgreSQL17 is permanent, started via Homebrew service, with `farm_roundtable_dev` and ignored credentials. The app remains running at localhost5001. Final restart restored saved attachments, roster, messages and insights. Screenshot: [screenshots/lead-persistent-files-after-restart.png](screenshots/lead-persistent-files-after-restart.png). Markdown export verification was interrupted by a stalled browser automation command; it is not counted as passed.

Remaining: duplicate/oversized SOPs; unreliable latest-version selection; unnecessary file turns; autonomy control behavior across cold restarts needs further real-user verification; old erroneous messages remain historical context. Weather One Call3.0 returns401 and needs subscription activation for real forecasts. This single fictional Iowa farm scenario does not validate worldwide farming advice or every deliverable type.
