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

## Farmer text used

Initial request:

> I am planning corn after soybeans near Ames on my fictional 120-acre rain-fed farm, aiming for 180 bu/ac. Use the attached CSV prices only as fictional scenario assumptions, not current quotes. Compare the cost per pound of actual nitrogen for urea and UAN32, and how much each product a 85 USD/ac nitrogen-input ceiling buys. Do not turn a spreadsheet target into an agronomic recommendation; use retrieved Iowa sources and state what they support or what remains unverified. Create exactly one Markdown SOP under 2,000 characters with exactly four actionable 2027 dates starting April 5, plus a matching calendar plan. Do not invent application costs, current prices, or a weather forecast. Ask any consequential missing-fact question in ordinary language. End with a concise council handoff.

Mid-run budget correction:

> My nitrogen-input ceiling is now 65 USD/ac, not 85. Recheck pending calculations and outputs. I have no application quote, so exclude that cost and say so. Keep one current SOP; do not duplicate it.

## Live run

One plain-language request was accepted in the existing session, followed by the single budget correction while Research Analyst was processing. The UI showed one expert turn used at that point. It later went idle at **3 used / 1 remaining** on the saved four-turn limit. No second normal request or run retry was sent.

Visible model/call evidence: the active Research Analyst card displayed `Xiaomi/mimo V2.6 Flash`. Its first response began a code-fenced table for the original USD 85/ac ceiling, then ended with `Response reached the output limit`. The visible partial table showed $0.598/lb N, 309.1 lb urea/ac, and 142.2 lb N/ac; UAN32 showed $0.656/lb N, 404.8 lb product/ac, and 129.5 lb N/ac. It did not incorporate the correction to USD 65/ac. The UI then showed an empty Research Analyst entry and went idle without a corrected calculation or council handoff. Screenshots: [correction while processing](screenshots/run-after-correction.png), [partial response](screenshots/first-research-response.png), [output-limit error](screenshots/research-output-limit.png), and [idle state](screenshots/run-idle-after-error.png).

The visible source discussion was cut off before citations could be reviewed. No current-price claim or weather forecast was visible in the partial response. The comparison appeared as code-fenced text, not a rendered table. The Visualizations pane said no visualizations were available.

### Operator diagnostics

The application log recorded five OpenRouter attempts for conversation 6. Each attempt returned provider usage, so the total below is the provider-reported cost rather than a cap reservation. The cap remained at 2 USD and was not reached.

| Request ID | Generation ID | Model / provider | Elapsed | Result | Cost USD |
|---|---|---|---:|---|---:|
| `4e6d0450-706c-45fc-82b7-e662b4030fc2` | `gen-1791757969-aZpryIADMFUKl3tV1Ll6` | `openai/gpt-6-luna` / OpenAI | 1,973 ms | success | 0.0003158595 |
| `3e91c693-1d15-4cfb-ba9b-71f22651c0da` | `gen-1791757971-ItH6ct4Ee1CfWl2xNRTs` | `xiaomi/mimo-v2.6-flash` / Venice | 34,887 ms | failed: output limit | 0.008655577 |
| `a6647811-266d-48b8-8e21-103b74ca760a` | `gen-1791758006-jZyS4sXgAL9WPzwS5SL0` | `openai/gpt-6-luna` / OpenAI | 2,232 ms | success | 0.00014573295 |
| `374afe62-4f13-4151-82b0-8351b7a60fe7` | `gen-1791758008-tAQNFEp4JLuo5rvVOWzu` | `xiaomi/mimo-v2.6-flash` / Venice | 25,072 ms | success, empty assistant content | 0.008128204 |
| `e7f4f653-cc7a-45a6-b966-e5bbf0c860ca` | `gen-1791758033-DW64Jhj7ZNQMTJyNMG1x` | `openai/gpt-6-luna` / OpenAI | 2,543 ms | success | 0.00015711795 |

Provider-reported total: **0.01740249 USD** of the 2.00 USD ceiling. The failed output-limit attempt had known usage and its cost was included. No further provider attempt followed the retrieval-only request; the operator log and persisted assistant message 28 confirm the static no-file reply.

## Deliverables and retrieval

The Files pane showed only the uploaded `fictional-farm-inputs.csv`; no SOP appeared, so there was no SOP to inspect or download. Read-only database verification confirms retrieval request 27 received assistant message 28 with the static reply: “I could not find a saved deliverable in this conversation yet; you can open Files or ask the council to create one.” The row confirms no provider attempt. Retrieval-only behavior is a **PARTIAL PASS** for returning the no-file reply without provider generation. Link retrieval is **BLOCKED** because no SOP exists. The refreshed browser transcript screenshot does not display the database-confirmed reply. Screenshots: [Files pane](screenshots/files-pane-after-run.png), [retrieval-only result](screenshots/retrieval-only-result.png), and [refreshed transcript](screenshots/retrieval-transcript-refreshed.png).

The calendar preview reported that it was unavailable and would recheck the schedule on export. The date controls remained at 2026-10-12. One Export .ics action produced no visible download; no ICS file was available to preview or inspect. Screenshots: [sidebar with no plan](screenshots/sidebar-no-plan.png) and [export result](screenshots/ics-export-result.png). **Download paths:** none; no SOP or ICS was downloaded.

### Calendar empty-state follow-up

After the initial live run, a browser regression check confirmed the sidebar treated any uploaded file as a possible schedule and left export enabled. The UI now enables export only after a successful schedule preview. A new session using the local Quick Development Login uploaded the existing fictional CSV fixture to conversation 4; the browser showed “No dated plan yet. Ask the council to create a week-by-week plan before exporting.” and kept Export .ics disabled. The upload succeeded, and the stored conversation had one user file and no assistant messages; no model request was made for this check. Screenshots: [desktop empty state with reference file](screenshots/calendar-empty-state-with-reference-file.png) and [mobile viewport](screenshots/calendar-empty-state-mobile.png).

At 390 × 844, `document.documentElement.scrollWidth` matched the 390-pixel viewport. This checks horizontal page overflow only; mobile navigation and the full deliverable workflow remain unverified. The page rendered without a framework overlay. The browser logged a development Vite HMR error for an invalid `ws://localhost:undefined/` URL; the app's own WebSocket connected, and this dev-server issue is outside the calendar change.

## Acceptance status

| Requirement | Status | Evidence |
|---|---|---|
| BETA-01 Routing and bounded work | FAIL — correction was accepted but not reflected; no handoff. Retrieval-only was a PARTIAL PASS: the static no-file reply returned without a provider attempt; link retrieval is BLOCKED because no SOP exists. UI turn count stayed within 4. | [run](screenshots/run-after-correction.png), [retrieval](screenshots/retrieval-only-result.png) |
| BETA-02 Canonical deliverables | FAIL — requested SOP was not produced. Version identity, size/date validation, ownership, and actual download checks are BLOCKED because no file exists. | [Files pane](screenshots/files-pane-after-run.png) |
| BETA-03 Evidence and calculation consistency | FAIL — only the partial $85 calculation appeared; it did not reflect the $65 correction, and the source response was incomplete. Broader calculation and source scenarios remain BLOCKED. | [partial response](screenshots/first-research-response.png), [error](screenshots/research-output-limit.png) |
| BETA-04 Questions and final handoff | FAIL — a budget clarification appeared in ordinary language but was not acted on; no closing council handoff appeared before idle. | [partial response](screenshots/first-research-response.png), [idle state](screenshots/run-idle-after-error.png) |
| BETA-05 Calendar dates and plan consistency | BLOCKED — no dated plan, ICS download/import, or current-plan revision was available in the farmer run. Follow-up verified the actionable no-plan UI and disabled export for an uploaded reference CSV. | [original sidebar](screenshots/sidebar-no-plan.png), [empty-state regression](screenshots/calendar-empty-state-with-reference-file.png) |
| BETA-06 Failure recovery and capability status | FAIL — the observed output-limit path ended with an empty Research Analyst message and no handoff. Broader failure, recovery, and capability scenarios remain BLOCKED. | [error](screenshots/research-output-limit.png), [idle state](screenshots/run-idle-after-error.png) |
| BETA-07 Continuity and deliverable breadth | BLOCKED — reload/restart, account isolation, and other deliverable journeys not tested. | — |

No application server restart, database change, or app-source edit was performed. Only QA screenshots and this report are intended for the validation-worktree commit.

