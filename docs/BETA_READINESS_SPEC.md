# FarmFriend Roundtable — beta readiness specification

Date: 2026-10-11
Status: Ready for implementation; beta release has not been approved by validation
Evidence: [Real farmer workflow report and artifacts](qa/2026-10-11-farmer-roundtable/report.md)

## 1. Product outcome

A farmer speaks naturally to a council of specialists. The council understands the farm and the requested outcome, researches relevant evidence, checks calculations, challenges assumptions, asks useful questions, and produces usable deliverables. The farmer can intervene at any time and leaves with a clear decision, unresolved questions, and working downloads.

The farmer should not need to know role mention syntax, provider configuration, JSON formats, or which expert creates files. The roundtable must coordinate that work itself. Expert disagreement must remain visible; a summary must not manufacture agreement.

This specification closes the gaps observed in real browser sessions using real OpenRouter calls. It also defines the additional live checks required before inviting beta users. Passing unit tests alone does not satisfy this specification.

## 2. Assumptions and scope decisions

- Use the existing application, API routes, PostgreSQL storage, and OpenRouter integration. No local inference or embedding service is required.
- The development database remains `farm_roundtable_dev`. Beta environments need their own persistent database and file storage; developer subscription overrides must not carry into beta accounts.
- The initial reference council uses `z-ai/glm-5.3-flash`, `deepseek/deepseek-v4.1-flash`, `xiaomi/mimo-v2.6-flash`, and `openai/gpt-6-luna`. A live preflight must confirm availability; substitutions must be visible rather than silent.
- The long-term audience is farmers worldwide. Initial beta invitations should identify the languages, regions, and farming workflows actually validated. Unknown regional rules, units, seasons, and agronomy trigger clarification or a clearly qualified answer.
- Beta deliverables include research answers, comparisons, charts, SOPs, plans, downloadable documents/data/code, and calendar files. A feature advertised to testers must pass its corresponding live test. An unsupported format must be explained before generation.
- Calendar export produces a downloadable `.ics` file. Direct insertion into an external calendar is a separate integration and must not be claimed by this beta.
- Implementation should extend existing contracts narrowly. Use structured fields where routing, scheduling, version selection, or completion must be reliable; prompts alone cannot enforce those properties.

## 3. Required farmer journey

1. **Describe the farm and goal.** Accept ordinary language and optional attachments. Confirm relevant crop/livestock, location, units, season/year, constraints, and desired outputs. Ask only for missing information that changes the answer; other details can remain explicit assumptions.
2. **See the work agreed.** Show a short goal, requested deliverables, relevant specialists, and the discussion limit. Ordinary requests such as “make this into an SOP and calendar” work without expert tags. Offer a sensible council without requiring model selection.
3. **Watch useful collaboration.** Show who is working, completed work, meaningful disagreement, and questions for the farmer. New input joins the current discussion; an explicit new-topic action starts a new run.
4. **Answer or redirect.** “The budget is now $65,” “stop creating files,” and “just give me the link” affect subsequent work. Pause, resume, autonomy, and restart controls accurately reflect server state.
5. **Receive a handoff.** Every completed run ends with a concise council verdict, what was delivered, what remains missing, and the farmer's next action. Files, charts, and dates agree with that verdict.
6. **Return later.** Reopening restores the conversation, farm context, questions, current deliverables, and honest run status. It never silently restarts paid work.

## 4. Requirements and acceptance criteria

### BETA-01 — Routing, farmer intervention, and bounded work (release blocker)

Observed: a request for an existing file link triggered unnecessary File Creator calls and errors. Duplicate SOP creation followed an already fulfilled request. The saved restart limit previously retained an old value; a fix exists but needs live confirmation. Autonomy behavior after a cold restart remains unverified.

Requirements:

- Route from the farmer's intent and outstanding work. Expert mentions are optional hints, not the only way to coordinate.
- Distinguish answer, research, create, revise, and retrieve-existing-deliverable requests. Retrieving a link must not create or revise a file.
- Do not dispatch an expert merely because its name or role appears in quoted history, a filename, a source, or a previous output.
- An explicit stop/no-file instruction removes pending file work. A budget correction updates pending calculations and deliverables, preserving the transcript.
- Read and persist autonomy settings even when no in-memory run exists. Disabled autonomy permits the requested response without continuing an unrelated council loop.
- Apply the saved expert-turn limit to new runs and explicit restarts. Pending mention routes cannot bypass it. Display expert turns consumed and remaining.
- Permit one closing handoff after the expert limit; identify it separately from expert turns and include its cost in the run cap. If generation is unavailable, show a deterministic partial-work handoff.
- Pausing allows an already dispatched request to settle but dispatches no new paid calls until resumed. Restarting never allows two active chains for the same conversation.

Live acceptance: change six turns to four and restart; observe at most four expert calls plus one closing handoff. Disable autonomy, restart the server, then request only a stored download link: receive that link with no File Creator call or extra files. While research is running, lower the budget and prohibit file creation; later outputs use the new budget and create no file. Pause/resume during a response without losing the farmer's message or duplicating work.

### BETA-02 — Deliverable identity, versions, and reliable downloads (release blocker)

Observed: two same-name files, no canonical version, oversized SOPs, an invented `/uploads/<display-name>` link, and selection of an older file when asked for the latest.

Requirements:

- Identify each requested deliverable independently of its display filename. A repeated generation attempt for the same request must not create a second current deliverable.
- A deliberate revision creates a version linked to the previous version. Show one current version with a visible revision timestamp; retain older versions as superseded history.
- Resolve “latest,” “current,” and download links from stored deliverable identity/version metadata. Link rendering must use the actual authorized download route. Models must not select or construct storage paths.
- Show creation/revision success only after content validation and persistence. Failed generation leaves the last valid version intact.
- Validate requested format, required sections, task count, and explicit size constraints before declaring success. For an “under 2,000 characters” request, count Unicode characters in the complete saved content, including Markdown. Never truncate a document blindly.
- If a draft violates constraints, offer a bounded repair; if it cannot be repaired within the run cap, mark the deliverable incomplete and explain the available draft.
- Publish new files to the UI immediately and verify authorized download bytes match the stored content. Check conversation ownership on file access; a guessed URL must not grant another user access.

Live acceptance: ask for one SOP under 2,000 characters with four dated tasks. Download and count the actual file. Request its link twice: no additional files. Revise the budget: one new current version, previous version visibly superseded. Download the current version from both transcript and Files pane after reload and server restart. A second beta account cannot download the first account's files.

### BETA-03 — Evidence, calculations, and corrections (release blocker)

Observed: an unrelated wage-survey PDF cited as nitrogen guidance, inconsistent rounded chart numbers, and an unsupported farm-rate inference later propagated into insights. Retrieval and farmer-requested correction improved the response, but neither is a complete reliability guarantee.

Requirements:

- Separate farmer facts, fictional inputs, retrieved evidence, calculations, and assumptions in consequential recommendations.
- Attach retrieved source identity and URL to factual research claims. A valid URL alone is insufficient: the source must support the claim and match relevant geography/time/context.
- Research-backed recommendations cite primary sources when available. When retrieval fails or applicability is unknown, disclose the missing evidence and give a qualified answer or question.
- Do not translate a published price ratio, example, or regional budget into a farm-specific prescription without the necessary inputs and method. Never invent weather, delivered prices, test results, or regulatory approval.
- Use one calculation result with explicit units and rounding across text, tables, charts, files, and conclusions. Show enough inputs for the farmer to understand the comparison.
- Assign the relevant specialist to check consequential arithmetic and applicability before finalizing the recommendation. A disagreement or missing check remains visible in the handoff.
- Corrections mark the affected claims as withdrawn/superseded. Rebuild affected current insights and deliverables; historical errors remain identifiable rather than continuing as current advice.

Live acceptance: replay the fictional Iowa fixture. Urea cost is $550/(2,000×0.46) = $0.597826/lb N; $65 buys approximately 108.727 lb N/ac. UAN-32 is $0.65625/lb N; $65 buys approximately 99.048 lb N/ac. All current outputs agree within stated rounding. No anhydrous quote or weather forecast is invented. A reviewer opens every consequential citation and checks support. Introduce an unsupported rate claim and ask for correction: the final verdict, current insights, and revised SOP all withdraw it.

### BETA-04 — Questions and automatic final handoff (release blocker)

Observed: the original retry reached idle without a clear closing synthesis. A natural follow-up produced a Council Verdict. Questions appeared in prose; reliable question-list capture and answer routing still need live verification.

Requirements:

- Every natural terminal path—completed work, turn limit, redundant discussion, disabled autonomy, and unrecoverable failure—produces exactly one handoff for that run. A pause is not completion.
- The handoff contains the decision or conditional recommendation, actual expert support/dissent, assumptions, outstanding farmer questions, and delivered/missing outputs with current links.
- Completion is derived from validated stored outputs. Do not say “all deliverables checked” when a file was not validated or a requested output is absent.
- Persist actionable farmer questions through a structured contract, without requiring the model to emit an exact `@[User]` string. Associate answers with the question and resume only necessary work.
- Handle a farmer message arriving during synthesis once, without losing it, duplicating the verdict, or falsely closing outstanding work.

Live acceptance: let a four-turn run finish without requesting a summary. A visible handoff appears with working current links. Answer “the cap includes application” in ordinary language: the question is resolved and the affected comparison is reconsidered. Repeat with an expert failure and a message during synthesis; missing work is clearly identified.

### BETA-05 — Calendar dates and plan consistency (release blocker for calendar beta)

Observed: a 2027 plan exported as 2026 events until the farmer manually changed a date control.

Requirements:

- Save the plan's explicit dates, planning anchor, and relevant timezone with its schedule. Prefer structured plan tasks over extracting dates from arbitrary old messages.
- Preserve explicit ISO dates. Infer a year or seasonal anchor only after confirmation when ambiguous.
- Show the schedule version, start date/year, timezone, and event count before export. A manual anchor override must visibly shift the preview before download and must not silently rewrite explicit dates.
- Export the current plan, excluding obsolete schedules. Calendar and SOP tasks must agree. Label conditional fieldwork windows as conditional rather than forecasts or appointments already booked.
- Preserve selected plan dates across reload. No schedule means an actionable in-app empty state.

Live acceptance: create a four-task plan starting 2027-04-05, reload, export, and import the actual `.ics` into a calendar application. Confirm event count, dates, titles, and conditional wording against the current SOP. Revise the plan and confirm old events are not included. Validate all-day boundaries and timezone behavior in a second region.

### BETA-06 — Failure recovery and capability status (release blocker)

Requirements:

- Detect provider errors, timeouts, output limits, malformed artifacts, failed writes, and lost connections. Show the affected work as failed or incomplete; never imply success from a partial stream.
- Give plain-language recovery actions: retry affected work, shorten/split the request, or continue with available results. Retry must not repeat successful deliverables or consume an unlimited budget.
- Distinguish account/provider configuration failures from farmer input errors. Show configuration guidance only to the appropriate account/operator, without exposing credentials or raw provider payloads.
- Display actual progress while work is running. Each dispatched provider attempt has a bounded deadline; no spinner remains indefinitely after failure.
- Weather must report unavailable when its subscription/API is not working. Disable forecast-dependent promises while still allowing conditional planning.
- Record request/run/attempt identifiers, provider/model, elapsed time, result, and cost where supplied. Keep operator diagnostics outside the farmer's chat.

Live acceptance: exercise a real invalid/unfunded credential in an isolated account, a real provider timeout/failure where available, interrupted connectivity, and an oversized generation request. Successful prior work remains downloadable, failed work is identified, and the farmer can recover. Controlled fault injection may supplement hard-to-trigger failures but cannot replace the successful live flow.

### BETA-07 — Discoverability, continuity, and deliverable breadth

Requirements:

- Offer understandable examples: “compare options,” “research this,” “make an SOP,” “plan my season,” and “create a calendar.” Explain what the council is preparing and where results appear.
- Name conversations from the farmer's goal, allowing edits. Switching conversations never mixes messages, streams, files, questions, or progress.
- Charts label units, source inputs, and dates where relevant. Tables and charts use the same validated numbers; malformed charts get an explicit recovery state.
- Downloaded Markdown/data/code must be the advertised file type and complete. Generated code is not represented as executed or verified unless execution actually occurred.
- On mobile, the farmer can send input, answer questions, manage the council, read charts, and download artifacts without horizontal page overflow or clipped controls. Core controls work by keyboard.
- Browser reconnect and backend restart restore honest status. An interrupted provider call is not silently resumed or charged again; offer recovery with preserved partial work.

Live acceptance: complete the reference journey on desktop and a 390-pixel mobile viewport. Request a small CSV and a farm-related calculation script; download and inspect them, and run the script in an isolated environment against stated inputs. Verify Markdown conversation export separately—the previous automation attempt was inconclusive. Switch conversations during streaming and reopen the saved farm after restart.

## 5. Implementation work packages

| Order | Owner responsibility | Existing areas to extend | Completion evidence |
|---|---|---|---|
| 1 | Run control and intent routing | `server/orchestrator.ts`, conversation control routes, saved orchestrator state | BETA-01 live traces; exactly bounded calls and persistent controls |
| 2 | Deliverable identity and validation | `shared/schema.ts`, `server/storage.ts`, generation in `server/ai.ts`, file routes and Files UI | BETA-02 real downloads, revisions, constraint validation and ownership checks |
| 3 | Evidence and calculation consistency | `server/ai.ts`, `server/ai-providers.ts`, artifact validation/rendering, insights generation | BETA-03 citation review and matched calculations across outputs |
| 4 | Questions and completion | orchestrator terminal paths, question routes, Council Verdict and insights UI | BETA-04 automatic handoff and natural-language answer routing |
| 5 | Canonical schedule and exports | `shared/schedule-extract.ts`, calendar/export routes, `SidebarPanel.tsx`, `home-page.tsx` | BETA-05 actual calendar import and current-version consistency |
| 6 | Recovery and farmer usability | provider errors, WebSocket handling, progress controls, onboarding and mobile UI | BETA-06/07 real recovery and complete desktop/mobile journeys |

First inspect the current contracts before adding schema or abstractions. Reuse existing files, questions, artifacts, and state wherever sufficient. Any schema change needs an explicit migration, existing-data behavior, and rollback/backup plan. Preserve current transcripts and downloads. Historical September QA findings are background, not proof that those areas currently pass.

## 6. Real application validation plan

Use isolated beta test accounts and persistent SQL storage, real typed input, actual uploads, and actual configured API models. Capture the visible UI and correlate it with persisted records and provider attempt logs. Do not replace experts with scripted responses for the release demonstration.

Required scenarios:

| Scenario | Farmer action | Evidence required |
|---|---|---|
| Iowa reference | Upload saved fictional fixture; request research, cost chart, constrained SOP, and 2027 calendar; change budget mid-run | Supported citations, matching calculations, one current SOP, actual download, calendar import, automatic verdict |
| Natural coordination | Ask for all outputs without role tags, retrieve an existing link, then prohibit new files | Appropriate specialists, no unnecessary generation, clear fulfillment status |
| Farmer clarification | Ask a question with a consequential missing fact, answer it in ordinary language | Persisted question resolved; relevant work updated; no fabricated assumption |
| Persistence and controls | Change limit/autonomy, pause, reload, restart backend, resume or explicitly start over | Durable settings, honest status, bounded calls, no duplicate messages/files |
| Different context | Use a second region/crop with local units, season, language if advertised, and credible regional sources | Correct units/context or explicit missing capability; no transplanted Iowa prescription |
| Failure and recovery | Unavailable research/weather, failed expert, lost connection, invalid output | Partial work retained, actionable recovery, no false completion or infinite retries |
| Deliverable breadth | Request CSV, calculation code, Markdown export, and revised plan | Real complete files; verified calculations; clear execution status; canonical revisions |
| Two-user isolation | Separate accounts and conversations; attempt cross-account downloads and controls | Access denied without exposing the other farm's data |

Run the reference scenario three consecutive times after fixes, plus every other scenario at least once on the release candidate. This is a stability gate, not a statistical accuracy guarantee. Archive evidence under a new dated repository folder; never overwrite the existing failure report.

For every requirement, record PASS/FAIL/BLOCKED, exact build/revision, provider models, actual request text, screenshots, downloaded files, citation review, timings, call counts, and known limitations. A missing credential/capability is BLOCKED, not PASS. Live testing must use an explicitly recorded spend cap; stop safely at that cap and report unfinished work.

Focused automated regressions remain useful for deterministic behavior such as caps, file identity, authorization, and calendar serialization. Keep TypeScript, existing tests, and build green. They supplement the live acceptance evidence.

## 7. Beta release gate

Invite the first users only when:

- All release blockers above pass real acceptance checks; existing source checks remain green.
- The required scenarios have archived evidence and no unresolved data-loss, access-control, false-completion, broken-download, or runaway-generation defect.
- The platform can recover an interrupted run, restore database/file backups, and identify the affected run from a farmer's report.
- Operator preflight verifies database, authorized file storage, funded generation, exact model availability, and capabilities actually advertised. Weather is either functioning or visibly unavailable.
- Farmers receive a clear description of the validated beta scope and an in-app way to report a problem with conversation/run context. No credential or private farm content is included automatically without an explicit choice.
- A small observed pilot demonstrates that farmers can finish the full journey without a developer explaining tags, fixing dates, locating files, or requesting a missing final verdict for them.

During the pilot, measure successful journeys, requested versus delivered outputs, broken links, duplicate work, unsupported claims found in review, recovery success, elapsed time, and API spend. Every advertised delivered output must be valid; partial outcomes must be labeled. Widen invitations only after reviewing pilot evidence and closing newly observed release-blocking defects.

## 8. Definition of done

The beta candidate lets a farmer describe a real need, work naturally with a coordinated expert council, understand evidence and disagreements, answer important questions, and obtain consistent, current, usable outputs. It preserves work and user control when services fail. Its final handoff tells the truth about what was achieved and what still requires the farmer's decision.

This document defines that target and its verification. It does not claim the implementation is already beta-ready.
