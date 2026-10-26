# FarmFriend Roundtable — Dev Handoff (2026-10-26)

**Branch:** `fix/charts-premium-2026-10-24` (repo `0-CYBERDYNE-SYSTEMS-0/ff-roundtable`)
**Last good HEAD:** `a48b146`. Type-check passes, and 1,024 tests pass (1 skipped).
**Production:** https://roundtable.farm-friend.com is still on the older `da630ef` build. Nothing on this branch is published.
**Dev (Replit):** project `EssentialBleakAlphatest` (@ScrimWiggins). `/api/version` returns the running sha.

## Is it the models or the code?
Mostly the **code**. Every chart and calendar failure found today was traced to app logic, and each was fixed in code:
- The model's chart spec already contained the right data, such as low, mid and high columns and two crops in different units. Our renderer or normalizer then mishandled it: it put both units on one axis, added the two ends of a range together, or plotted only the first column.
- The calendar bugs came from our own parsing of the model's reply. It turned raw ICS text into events, rolled 2026 dates into 2027, used a stale "Week 1" anchor and produced title fragments like "29 —".

What the **models** do contribute is inconsistency. Different experts in one conversation give overlapping tables, numbers labelled "illustrative" and a moderator summary that can contradict the calendar. A stronger model reduces this but won't fix it. The real fix is to have the experts return structured output, with JSON for chart data and calendar events, and have the code validate it. That is more reliable than parsing free-form markdown.

## Fixed on this branch (commit → what)
- `be11040`: mixed-unit charts split into separate panels with their own y axes. Calendar titles no longer have stray fragments, and the 3-day note offset is gone.
- `48f3136`: fenced or raw ICS text is never treated as an event. Duplicate events are removed. Explicit years are kept.
- `fb29d74`: the "Week 1 starts" field follows the plan's first event, and stale saved anchors are ignored.
- `a48b146`: a range plots its midpoint, never the sum. Calendar dates follow frost offsets and the dates in their notes. Weeks are numbered in order. Same-title, same-date events are removed. Experts get the user's location, so they talk about Eugene, not "Zone 6b".

## Still open (start here)
1. **Low/mid/high charts plot only the "low" column.** The y axis is even titled "low". The fix is to draw mid as the main mark with a low-to-high band, and never silently drop a numeric series. The unfinished briefs (`docs/codex-r11` to `r14-brief.md`) are saved in the Replit workspace as the stash `r14-unfinished`, so run `git stash list` there.
2. **The moderator summary can contradict the calendar.** In one case it said "start seeds April 1" while the calendar said Feb 15.
3. **Raw ICS text shows inside expert chat replies.** It no longer becomes an event, but it looks messy. It should collapse into a download button.
4. **Event count:** the sidebar said 14 while the two expert tables had 7 and 8. This is probably correct de-duplication but hasn't been verified.
5. **Before publishing, flag these:** the Stripe webhook logs "Missing Stripe configuration", `/api/models` lists every OpenRouter model, and the canonical frost value is kept only in server memory.
6. **Dev environment:** `OWM_API_KEY` is not set, so weather features are off. `.replit` has a local change that is not committed on purpose.

## How we worked (gotchas)
- Codex runs inside the Replit Shell. Its `workspace-write` sandbox fails there with a bubblewrap error, so we used `--yolo`. The command was `CODEX_HOME=$PWD/.codex .tools/node_modules/.bin/codex exec --yolo -m gpt-6-luna -c model_reasoning_effort=xhigh - < docs/<brief>.md`.
- Pushing from Replit needs the GitHub credential prompt approved.
- To restart dev, run `pkill -f node` in the Shell, then press Run.
- `.tools/` and `.codex/` are gitignored, and they hold the Codex install and its login.
- Evidence and validator reports are in the box folder `/workspace/ffrt-qa/chart-fix-dev-20261026/` (VALIDATOR-r8, r9 and r10).

## Repro prompts
- Chart: "Chart Willamette Valley blueberry yield ranges (lb/acre) by year 2021-2025 as a table with low, mid and high, then chart it."
- Mixed units: "Chart typical Willamette Valley hay yield in tons per acre and blueberry yield in pounds per acre for the last 5 years."
- Calendar: "I'm in Eugene, Oregon. Make me a tomato planting calendar with events I can add to my calendar."
