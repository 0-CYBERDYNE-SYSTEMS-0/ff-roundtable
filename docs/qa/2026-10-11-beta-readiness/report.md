# Beta readiness live QA

| Field | Value |
|---|---|
| Date | 2026-10-11 |
| App | `http://localhost:5001` |
| Browser session | `beta-readiness-20261011` |
| Initial code revision | `454977f` |
| OpenRouter spend ceiling | `$2.00 total` |

## Preflight

Before the live run, OpenRouter's read-only model catalog listed all four requested models: `z-ai/glm-5.3-flash`, `deepseek/deepseek-v4.1-flash`, `xiaomi/mimo-v2.6-flash`, and `openai/gpt-6-luna`. The app's Perplexity key is absent, so Research Analyst requests use the OpenRouter path covered by the spend cap. The live run below used the existing UI and no direct model calls were made. The actual dollar spend and provider-attempt log were not visible in the UI.

The test account was first registered on Free. Its paid-model filter correctly hides the reference models; this is expected tier gating, not a catalog defect ([captured picker](screenshots/precondition-free-tier-model-picker.png)). A separate fictional QA account was locally flagged Pro for model-picker testing; no subscription, checkout, or payment was created. The local tier was left unchanged during this QA run.

The fictional Iowa profile and uploaded fixture are for QA only. The fixture labels the fertilizer quotes as fictional and records weather as unavailable. Do not treat its figures as current prices or a field recommendation. Videos were not captured because `ffmpeg` is unavailable; use the screenshots and live persisted records as evidence.

The UI confirmed the saved expert-turn limit was four. The selected roster was Soil Scientist — GLM 5.3 Flash; Crop Specialist — DeepSeek V4.1 Flash; File Creator — GPT-6 Luna; Research Analyst — MiMo V2.6 Flash. Screenshots: [limit](screenshots/preflight-charter-limit.png), [Soil Scientist](screenshots/preflight-soil-model.png), [Crop Specialist](screenshots/preflight-crop-model.png), [File Creator](screenshots/preflight-file-creator-model.png), and [Research Analyst](screenshots/preflight-research-model.png).

## Live run

One plain-language request was accepted in the existing session, followed by the single budget correction while Research Analyst was processing. The UI showed one expert turn used at that point. It later went idle at **3 used / 1 remaining** on the saved four-turn limit. No second normal request or run retry was sent.

Visible model/call evidence: the active Research Analyst card displayed `Xiaomi/mimo V2.6 Flash`. Its first response began a code-fenced table for the original USD 85/ac ceiling, then ended with `Response reached the output limit`. The visible partial table showed $0.598/lb N, 309.1 lb urea/ac, and 142.2 lb N/ac; UAN32 showed $0.656/lb N, 404.8 lb product/ac, and 129.5 lb N/ac. It did not incorporate the correction to USD 65/ac. The UI then showed an empty Research Analyst entry and went idle without a corrected calculation or council handoff. Screenshots: [correction while processing](screenshots/run-after-correction.png), [partial response](screenshots/first-research-response.png), [output-limit error](screenshots/research-output-limit.png), and [idle state](screenshots/run-idle-after-error.png).

The visible source discussion was cut off before citations could be reviewed. No current-price claim or weather forecast was visible in the partial response. The comparison appeared as code-fenced text, not a rendered table. The Visualizations pane said no visualizations were available.

## Deliverables and retrieval

The Files pane showed only the uploaded `fictional-farm-inputs.csv`; no SOP appeared, so there was no SOP to inspect or download. The retrieval-only request was accepted after the run, but no assistant reply or link appeared. The UI remained idle at 3/4 turns and showed no File Creator response or new file. Because no SOP existed, retrieval of an existing link is **BLOCKED**; the UI does not expose provider-attempt logs, so the absence of a File Creator attempt cannot be independently proven. Screenshots: [Files pane](screenshots/files-pane-after-run.png) and [retrieval-only result](screenshots/retrieval-only-result.png).

The calendar preview reported that it was unavailable and would recheck the schedule on export. The date controls remained at 2026-10-12. One Export .ics action produced no visible download; no ICS file was available to preview or inspect. Screenshots: [sidebar with no plan](screenshots/sidebar-no-plan.png) and [export result](screenshots/ics-export-result.png). **Download paths:** none; no SOP or ICS was downloaded.

## Acceptance status

| Requirement | Status | Evidence |
|---|---|---|
| BETA-01 Routing and bounded work | FAIL — correction was accepted but not reflected; no handoff. Retrieval-only produced no link because no SOP existed. UI turn count stayed within 4. Provider-attempt logs unavailable. | [run](screenshots/run-after-correction.png), [retrieval](screenshots/retrieval-only-result.png) |
| BETA-02 Canonical deliverables | FAIL — requested SOP was not produced. Version identity, size/date validation, ownership, and actual download checks are BLOCKED because no file exists. | [Files pane](screenshots/files-pane-after-run.png) |
| BETA-03 Evidence and calculation consistency | BLOCKED — partial $85 table only; correction and source claims were not completed or verified. | [partial response](screenshots/first-research-response.png), [error](screenshots/research-output-limit.png) |
| BETA-04 Questions and final handoff | FAIL — a budget clarification appeared in ordinary language but was not acted on; no closing council handoff appeared before idle. | [partial response](screenshots/first-research-response.png), [idle state](screenshots/run-idle-after-error.png) |
| BETA-05 Calendar dates and plan consistency | BLOCKED — no plan preview or ICS download; export had no visible result. | [sidebar](screenshots/sidebar-no-plan.png), [export](screenshots/ics-export-result.png) |
| BETA-06 Failure recovery and capability status | BLOCKED — broader failure, recovery, and capability scenarios not tested. | — |
| BETA-07 Continuity and deliverable breadth | BLOCKED — reload/restart, account isolation, and other deliverable journeys not tested. | — |

No application server restart, database change, or app-source edit was performed. Only QA screenshots and this report are intended for the validation-worktree commit.

