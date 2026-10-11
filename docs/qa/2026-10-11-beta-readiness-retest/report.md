# Beta readiness live retest

- Date: 2026-10-11
- Branch: `feat/beta-readiness`
- Local QA account: `beta_pro_farmer_20261011` (user 3; local Pro tier override, inactive subscription)
- Conversation: 9
- Approved aggregate OpenRouter cap: **$2.00**

## Result

The routing recovery fix passed its live control-flow check. The farmer changed the nitrogen-input ceiling from $85/ac to $65/ac while Research Analyst was streaming. After Research failed, the Moderator dispatched File Creator using the still-active deliverable request; the run then used its remaining turns and produced a closing handoff at the configured four-turn limit.

The live content gate remains **blocked**. OpenRouter attempts for Research Analyst, File Creator, Soil Scientist, and Crop Specialist all failed. No price comparison, citations, chart, calendar plan, or generated SOP was produced. The only conversation file is the uploaded fictional CSV. The closing handoff correctly labels the price calculations as unverified, records the $65/ac ceiling, and does not claim expert consensus or a completed recommendation.

## Preflight and farmer input

Conversation 9 was saved with a four-expert roster and `turn_budget=4`, verified in the charter dialog and read-only PostgreSQL. The roster was Crop Specialist `deepseek/deepseek-v4.1-flash`, File Creator `openai/gpt-6-luna`, Research Analyst `xiaomi/mimo-v2.6-flash`, and Soil Scientist `z-ai/glm-5.3-flash`. The fictional CSV was uploaded through the UI before the farmer message.

The farmer asked for fictional urea/UAN-32 comparisons, Iowa sources, one Markdown SOP under 2,000 Unicode characters with four dated 2027 tasks, a matching plan, and a natural council handoff. While Research Analyst was active, the farmer revised the input ceiling to $65/ac, said no application quote was available, and asked to keep one current SOP without duplication. The correction persisted as message 38 while the Research request was in flight.

## Live OpenRouter attempts

| Step | Call | Model / provider | Result | Cost (USD) |
|---:|---|---|---|---:|
| 1 | Moderator routing | `openai/gpt-6-luna` / OpenAI | Success; selected Research Analyst | 0.0002945745 |
| 2 | Research Analyst | `xiaomi/mimo-v2.6-flash` / Makora | Failed | 0.0081028996 |
| 3 | Moderator routing | `openai/gpt-6-luna` / OpenAI | Success; selected File Creator | 0.00033306075 |
| 4 | File Creator | `openai/gpt-6-luna` / OpenAI | Failed | 0.00082756575 |
| 5 | Moderator routing | `openai/gpt-6-luna` / OpenAI | Success; selected Soil Scientist | 0.00031994325 |
| 6 | Soil Scientist | `z-ai/glm-5.3-flash` / Sail Research | Failed | 0.00072323955 |
| 7 | Moderator routing | `openai/gpt-6-luna` / OpenAI | Success; invalid failed-role suggestion fell back to round-robin | 0.00035459325 |
| 8 | Crop Specialist | `deepseek/deepseek-v4.1-flash` / GMICloud | Failed | 0.0011880594 |
| 9 | Closing handoff | `openai/gpt-6-luna` / OpenAI | Success; stored as synthesis | 0.000198099 |
| 10 | Insights | `openai/gpt-6-luna` / OpenAI | Success | 0.000127017 |
|  | **Conversation 9 total** |  |  | **0.01246905** |

The persisted expert error messages are in order: Research Analyst, File Creator, Soil Scientist, Crop Specialist. The Moderator used exactly four expert turns, then stored a synthesis and insights. The final UI showed 4 used and 0 remaining. PostgreSQL confirms the conversation is idle, `turn_budget=4`, and its only file is the farmer-uploaded CSV (file ID 7); there is no generated deliverable version.

## Spend accounting

Known provider spend across the live attempts was:

| Run | Known spend |
|---|---:|
| Conversation 6 initial live run | $0.01740249 |
| Conversation 7 interrupted routing-stall run | $0.01226534 |
| Conversation 9 retest | $0.01246905 |
| **Known aggregate** | **$0.04213688** |

The conversation 7 server was stopped while a Moderator request may have been in flight. I reserved up to $0.40 for that unconfirmed request and reduced the next server process cap to $1.57033217. Even including that reserve, the total exposure is at most $0.44213688, below the approved $2.00 cap. The retest process cap was $1.57033217 and its measured spend was $0.01246905.

## Readiness impact

- **Council routing and bounded recovery:** Pass for the tested correction path. The outstanding file request survived an unrelated budget correction, File Creator was dispatched after a failed Research turn, failed experts were skipped, and the four-turn limit closed the run.
- **Canonical deliverable:** Blocked in the live run because File Creator's provider attempt failed; no SOP or version was saved. The regression test verifies that the source request and its constraints remain attached across the correction.
- **Research, calculations, chart, and calendar export:** Not verified; the relevant expert responses and generated plan were unavailable. The UI kept `.ics` export disabled without a dated plan.
- **Closing handoff:** Pass for the failure path. The synthesis accurately states what remains unverified and avoids inventing expert agreement or a fertilizer recommendation.
- **Weather:** Not exercised by this farmer request. The local farm-profile lookup logged an OpenWeather One Call 3.0 subscription 401 during preflight.

**Overall beta release readiness remains blocked** until a capped live run produces and verifies expert answers, citations, and a canonical SOP with matching dated calendar data. This report supplements, and does not replace, the initial [beta readiness report](../2026-10-11-beta-readiness/report.md).

## Automated verification

- `npm run check` — passed.
- `npm test` — passed, 23 test files and 591 tests.
- `npm run build` — passed. Vite reported the existing stale Browserslist database and large-chunk warnings.
- `git diff --check` — passed.

## Evidence

- [Conversation 7 routing stall after the correction](screenshots/conversation-7-routing-stall.png)
- [Conversation 7 connection interruption](screenshots/conversation-7-connection-interrupted.png)
- [Conversation 9 roster preflight](screenshots/conv9-preflight-roster.png)
- [Conversation 9 four-turn limit](screenshots/conv9-budget-4-verified.png)
- [Conversation 9 final handoff and four failed expert responses](screenshots/conversation-9-terminal-handoff.png)
