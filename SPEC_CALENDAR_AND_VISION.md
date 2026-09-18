# Storyboard-Reality SPEC — Calendar (.ics) Export & Uploaded-Image Analysis

**Branches:** `feat/ics-calendar-export` (worktree) + `feat/image-analysis` (main tree), both from `qa/ui-ux-audit-fixes`
**Status:** APPROVED — EXECUTING
**Why:** The launch storyboard made two honesty calls: the product has **no calendar/.ics feature** and **no uploaded-image analysis** — so the deliverables frame showed a week-by-week nitrogen plan file (genuinely what the File Creator produces) instead of a fake calendar. This spec turns both avoided claims into true ones with two small, dependency-free changes.

---

## TL;DR

| Track | What ships | Honesty call resolved |
|-------|-----------|----------------------|
| A — `feat/ics-calendar-export` | `GET /api/protected/conversations/:id/export.ics` + "Export .ics" button in the Files sidebar; converts week-by-week plan **artifacts** (table/chart/json) and File-Creator-generated `.md` plans into all-day weekly VEVENTs | "no calendar feature" → real .ics that opens in the user's calendar app |
| B — `feat/image-analysis` | Uploaded images are base64-delivered to experts as native OpenAI `image_url` content parts (max 2/turn, ≤5 MB each); the Imagery Specialist actually sees the picture | "no uploaded-image analysis" → real vision input |

**Zero new npm dependencies.** Both AI providers are raw `fetch` to OpenAI-compatible APIs (content-part arrays pass through verbatim), and the .ics builder is ~80 lines of string formatting.

## Non-goals (honest boundaries)

- No in-app calendar UI — the .ics opens in the user's own calendar app.
- No prose date-inference beyond the conservative patterns in §A2. If nothing parses, the route returns 422 and says so — it never invents events.
- No image storage changes, thumbnails, or EXIF parsing. Analysis happens on the next expert turn only.
- No billing changes: image parts go to whatever model the expert already uses. If that model can't accept images, the user gets an explicit per-expert error, not silence. (Known behavior, unchanged: the Imagery Specialist default `openai/gpt-4o-vision` is a paid model, so free-tier users must switch it to a vision-capable free/local model such as a `local/` ollama vision model or BYOK.)

---

## Track A — .ics calendar export

### A1. Core builder: `shared/ics.ts` (new, pure, node-testable)

`buildVCalendar(events: VEventData[], calName: string): string` plus a TEXT escaper, implementing RFC 5545 basics:
- CRLF line endings; fold lines longer than **75 octets** (bytes, not chars — test with multibyte).
- TEXT escaping: backslash, semicolon, comma, newline.
- All-day events: `DTSTART;VALUE=DATE:YYYYMMDD` and **exclusive** `DTEND;VALUE=DATE` (+1 day).
- Every VEVENT gets `DTSTAMP` (now, UTC), a deterministic `UID` (`<conversationId>-<index>@farmfriend-roundtable`), and `SUMMARY` capped at 255 chars.
- `X-WR-CALNAME: <conversation title>` on the VCALENDAR.

### A2. Schedule extraction: `shared/schedule-extract.ts` (new, pure)

Inputs: conversation messages (with their `artifacts`) + conversation `files` rows. Output: `ScheduleRow[] = { weekIndex?: number; date?: string; title: string; description: string }`, capped at 60 rows.

- **table artifacts** (markdown pipe table in `artifact.content`): split rows like `ArtifactDisplay` does (client/src/components/artifacts/ArtifactDisplay.tsx:130-161). Detect a week/date-ish column by header among `week, wk, w, date, day, period, phase, month, stage, time` (superset of the chart-axis heuristic at ArtifactDisplay.tsx:171-173). First cell of a matching column → week index or date; remaining cells → description.
- **chart artifacts**: `JSON.parse(content)` → `data[]` entries; same key detection; description = remaining numeric fields as `key: value` pairs.
- **json artifacts** (array of objects): same treatment.
- **File-Creator `.md` files** (`files` rows with `uploadedBy` starting `"Expert:"`, `filename` ending `.md`): conservative line parser — a line matching `/^(?:#{1,4}\s*|[-*]\s*|\*\*)?(?:week|wk\.?|w)\s*(\d{1,2})\b/i` or an ISO date `/\d{4}-\d{2}-\d{2}/` starts an event; the rest of the line is the title; following non-matching lines up to 200 chars become the description.
- `weekIndex` → anchor date + (n−1)×7 days. `date` → that date verbatim.
- **No matches anywhere → empty list.** The route then returns 422.

Title every event with its source: `SUMMARY:<artifact title / file title> — Week N`.

### A3. Route: `GET /api/protected/conversations/:id/export.ics` (server/routes.ts, beside the markdown export at ~L951-990)

- Same ownership check as other conversation routes (`conversation.userId !== req.user.id` → 404).
- Anchor: `?start=YYYY-MM-DD` (validated, 422 on garbage) — default **next Monday** from today.
- Success: `Content-Type: text/calendar; charset=utf-8`, `Content-Disposition: attachment; filename="roundtable-<slug>-<date>.ics"` (mirror the md export's slug helper).
- Empty extraction → 422 `{ error: "No schedulable items found in this conversation. Ask an expert for a week-by-week plan first." }`.

### A4. Client: "Export .ics" button

`client/src/components/sidebar/SidebarPanel.tsx` Files tab, beside "Export as Markdown" (L81-88) → new handler in `client/src/pages/home-page.tsx` shaped exactly like `exportMarkdown` (L393-404): `window.open(\`/api/protected/conversations/${id}/export.ics\`, "_blank")`. Same-origin, so the session cookie rides along; button disabled with tooltip when the conversation has no artifacts and no files.

### A5. Tests: `tests/ics.test.ts` (node env, no jsdom)

Unit: escaping, octet folding (incl. multibyte boundary), all-day anchoring (explicit `start` + next-Monday default + week arithmetic), table/chart/json/md extraction (including noise rows and the no-match case). Route: supertest with the `conversations.test.ts` preamble (env-forcing + `vi.hoisted` mocks of `../server/ai` + `../server/orchestrator`, mock storage returning a conversation with artifacts) — 200 with `BEGIN:VCALENDAR` body, 422 on artifact-free conversation.

---

## Track B — uploaded-image analysis

### B1. Type widening (three mirrors)

`AIMessage.content` in `server/ai.ts` (L28-31) becomes `string | ContentPart[]` where `ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }`. Mirror the widened type in `server/ai-providers.ts` (message interface, ~L7-15) and in the client-side type in `client/src/types/index.ts` if it declares this shape. No transport change — both providers already serialize `messages` verbatim into the fetch body.

### B2. `server/image-context.ts` (new)

`collectImageParts(files: FileRow[]): { parts: ImagePart[]; skipped: string[] }` — most-recent `image/*` files first, **max 2**, each `fs.stat`-capped at **5 MB** (raw bytes; base64 inflates ~4/3 and must not blow the 120 s provider timeout or the 10 MB upload cap retroactively). Resolve disk path with the same `path.join(process.cwd(), relativePath)` convention as `readFileContent` (ai.ts:330-331). Unreadable/oversize/missing → skip, never throw. Returns `data:<mime>;base64,<...>` URLs.

### B3. Wiring in `server/ai.ts` — BOTH call paths

The stream path (~L391-402) and non-stream path (~L507-521) build "Attached Files Context" today. Changes to both:
- Text files: unchanged.
- Image files: listed in the text block as `[Image attached: <name> — delivered visually]`, and their `image_url` parts are appended to the **user message content**, which becomes `[{ type: "text", text: … }, …parts]` when any parts exist.
- The 12,000-char history truncation (ai.ts:12-20) must apply to the **text part only** — never truncate inside a base64 part.

### B4. Honest failure

When the provider 4xx's with an image/vision/modality-related error, that expert's turn becomes: `⚠️ <Expert> could not analyze the image — this model doesn't accept image input. Try a vision-capable model (e.g. switch this expert to one, or use BYOK).` Reuse the existing per-expert error path (study the File Creator handler's catch at ai.ts:426-457 and the actual orchestrator error flow first, then mirror it). Other experts still respond.

### B5. Prompt nudge

Imagery Specialist role prompt (ai.ts:216-218): add one line — uploaded images are delivered directly as vision input; describe and analyze what you actually see.

### B6. Tests: `tests/image-analysis.test.ts` + provider passthrough in `tests/ai-providers.test.ts` pattern

Unit: image-context (2-file limit, 5 MB skip, non-image filtered out, missing file skipped, correct data-URL prefix). Message-building (mock provider): content array containing an `image_url` data URL reaches the provider call. Passthrough: array content survives verbatim in the JSON body via the existing `global.fetch` mock pattern. B4: honest-error message on a mocked 400.

---

## Git plan

1. Commit this SPEC on `qa/ui-ux-audit-fixes` (docs only).
2. `git worktree add ../FarmFriendRoundtable-PRO-ics -b feat/ics-calendar-export` (node_modules symlinked from main tree) → Track A lands there.
3. Main tree: `git checkout -b feat/image-analysis` → Track B lands there. The two tracks touch **disjoint files** (A: routes.ts + sidebar/home-page + new shared/tests; B: ai.ts + ai-providers.ts + types + new server/tests) so merges are conflict-free by construction.
4. Both merge back `--no-ff` into `qa/ui-ux-audit-fixes`; then `npm run check` + `npm test` on the merge result; `git worktree remove` + delete merged branches. **No push** (not requested). `videos/` stays untracked and untouched.

## Definition of done (both tracks)

- `npm run check` clean; `npm test` green including the new test files.
- Manual: a conversation with a week-by-week plan artifact → "Export .ics" → opens in Calendar.app as weekly all-day events anchored next Monday. An uploaded image + Imagery Specialist (vision-capable model) → the expert describes the picture; non-vision model → the explicit honest error, other experts unaffected.
