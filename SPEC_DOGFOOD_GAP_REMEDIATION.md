# SPEC — Dogfood Gap Remediation

**Branch:** `fix/dogfood-gap-remediation` (PR target: `main`)
**Status:** Implemented — `npm run check` clean, 331/331 tests green, live smoke verified (single 401 log + 30-min cooldown, typed `auth` response, negative-cache hit at 3ms).
**Origin:** Dogfood pass findings (2026-09-15). Four gaps: dead weather on bad OWM key, autonomous-mode token waste, generic .ics summaries, raw markdown in .ics descriptions.

---

## Mission

Make every failure and artifact surface honest and cheap: weather degrades with a typed, cached, human-readable reason instead of silently vanishing; the autonomous expert loop stops paying for redundant answers and re-sent images; exported calendar events carry human-readable summaries and clean plaintext descriptions.

---

## F1 — Weather resilience (OWM 401 must not kill weather silently)

### Findings
- `server/weather.ts:52-89` — `getWeather` swallows every non-OK response (incl. 401) into `null`. No status classification, no negative caching.
- Consequence: with an invalid key, **every chat message and every `/api/protected/weather` call re-hits OWM and 401s again** (successes are cached, failures are not). Latency tax on every turn; features silently vanish.
- `server/routes.ts:1241` — user-facing message leaks ops advice: *"Check OWM_API_KEY or try again later."*
- `server/weather.ts:3` — uses One Call 3.0 (`/data/3.0/onecall`), which **requires a key with 3.0 access** (1000 calls/day free tier, but the key must be enabled for it). A valid-looking legacy key returns 401 here.
- Storage already tracks `fetchedAt` (`server/storage.ts:671-687`, `shared/schema.ts:85-86`) but discards cache entries older than 30 min at read time, so stale-while-revalidate is impossible today.

### Design
1. **Typed results.** `getWeather(lat, lng)` returns
   `{ ok: true; data: WeatherData } | { ok: false; reason: "missing_key" | "auth" | "transient"; message: string }`.
   - HTTP 401/403 → `auth`; any other non-OK or network error → `transient`; unset env var → `missing_key`.
   - `message` is end-user-safe. `auth`/`missing_key` → "Weather is not configured for this server."; `transient` → "Weather data is temporarily unavailable." Ops hints (e.g. "check OWM_API_KEY / One Call 3.0 access") go to **server logs and DEV_MODE responses only**, never to end users.
2. **Negative cache.** Module-level `Map<lat:lng, { reason, until }>`: `auth` failures cached 30 min (a key doesn't heal mid-process), `transient` 5 min. Short-circuit before the network call. Log loudly **once per cooldown window**, not per message.
3. **Stale-while-revalidate.** Widen `storage.getCachedWeather` to return the last entry regardless of age (plus `fetchedAt`); `weather.ts` decides freshness. On fetch failure, if any cache entry ≤ 24 h old exists, serve it instead of failing.
4. **Startup sanity log** (`server/index.ts`): at boot, log whether `OWM_API_KEY` is present and whether it looks malformed (OWM keys are 32 hex chars). No boot-time network call.
5. **Call sites updated:** `server/routes.ts` weather endpoint (uses `reason`/`message` from the union), `server/routes.ts` farm-profile (unavailable → weather field absent, as today), `server/ai.ts:477-491` (`!ok` → empty weather context, as today).

### Acceptance
- [ ] With an invalid key: exactly one 401 log per 30 min per location; `/api/protected/weather` returns `{ available: false, reason: "auth", message: <user-safe> }` with no ops leak.
- [ ] With no key: `reason: "missing_key"`, zero network calls.
- [ ] With a transient failure and a cache entry < 24 h old: stale data is served.
- [ ] `npm run check` and `npm run test` pass.

---

## F2 — Autonomous loop token cost (stop re-answering, stop re-sending images)

### Findings
- One user message → sequential round (each expert once) + autonomous extension capped at `experts.length * 2` turns (`server/orchestrator.ts:91,144,171`) → up to `3N` model calls per message.
- In autonomous mode the reference content is just the last expert message (`orchestrator.ts:268-278`), so experts keep producing near-identical re-answers until the hard cap. **No redundancy detection exists.**
- Vision: `orchestrator.ts:291` fetches **all** conversation files each turn; `server/ai.ts:497,615` → `collectImageParts` (`server/image-context.ts:51-96`) re-reads disk and re-embeds base64 images on **every** turn — the same image up to `3N` times per user message.
- `server/routes.ts:766-774` stores and processes every incoming message unconditionally — sending the same message twice immediately re-triggers the full `3N` fan-out.
- No schema change is required: `files.uploadedAt` + message timestamps already exist, so "already analyzed" is derivable (an assistant message exists with `createdAt > file.uploadedAt`).

### Design
1. **Redundancy early-stop (autonomous mode).** After each autonomous expert turn, compare the new message against the other expert messages of the current sequence using a cheap word-trigram Jaccard similarity (new util `server/text-similarity.ts`, pure function, unit-tested). If similarity > **0.80** against any prior expert message in the sequence, stop the sequence early (log + broadcast idle as usual). Sequential round 1 is never cut. Conservative threshold: prefer burning one extra turn over cutting a legitimately new contribution.
2. **Duplicate-submission gate.** In `POST .../messages` (`routes.ts:766-774`): if the incoming (trimmed) content is identical to the current last message *and* that message is a user message *and* no new files are attached, store nothing extra and skip the orchestrator kickoff — return 200 with the existing message. Only guards the "double-click / resend with nothing new" case; a repeated question asked *after* expert replies still processes normally.
3. **Analyze-image-once.** `collectImageParts` gains an `analyzedBefore` predicate (passed in from `ai.ts`, which has history): a **user-uploaded** image is embedded as base64 only if no assistant message exists with `createdAt > file.uploadedAt`. Once analyzed, subsequent turns get a one-line text note (`[Image "<filename>" — analyzed earlier in this conversation]`) in the file context instead of base64. Expert-generated (File-Creator) files keep current behavior so a freshly generated image is never invisible. `MAX_IMAGE_PARTS` budget then naturally applies to only-new images.

### Explicitly kept
- `maxAutonomousTurns = experts.length * 2` stays (dogfood verdict: "fine").

### Acceptance
- [ ] Two consecutive autonomous turns producing near-identical text stop the sequence before the cap (unit test on the similarity + stop rule).
- [ ] Re-sending an identical message with no new files triggers zero model calls (route-level behavior; logic unit-tested).
- [ ] An uploaded image is base64-embedded exactly once per conversation lifetime; later turns reference it as text (unit test on the predicate).
- [ ] `npm run check` and `npm run test` pass.

---

## F3 — .ics cosmetics (human summaries, plaintext descriptions)

### Findings
- Generic titles originate upstream: `server/artifact-extractor.ts:66` names tables `Data Table ${n}`; `shared/schedule-extract.ts:101-105` builds SUMMARY as `"<title> — Week N"` → "Data Table 1 — Week 1".
- DESCRIPTION gets raw markdown: table cells joined with " — " (`schedule-extract.ts:139-142`), JSON `key: value` pairs (`:174-177`), File-Creator `.md` lines verbatim (`:226-231`) — `**bold**`, `#` headers, pipes all leak into calendar apps.
- No markdown-strip utility exists anywhere in the repo (`stripCellDecorations` at `schedule-extract.ts:43-45` only strips `*_~` from week/date cells).
- RFC 5545 escaping/folding is already correct (`shared/ics.ts:30-36,64-68`); SUMMARY is truncated to 75 chars; DESCRIPTION is escaped but never cleaned.

### Design
1. **Better artifact titles** (`server/artifact-extractor.ts`): when a markdown heading precedes the table/JSON block in the expert output, use it as the artifact title; else use the table's first header cell; else fall back to `Data Table N`. This flows into SUMMARY automatically via `schedule-extract.ts:101-105`.
2. **Fallback summary label** (`shared/schedule-extract.ts`): if the title still matches `^Data Table \d+$`, compose SUMMARY from the row's own title / first description cell instead.
3. **New `shared/markdown.ts` → `stripMarkdownToText(md: string): string`**: remove heading hashes, bold/italic/strikethrough markers, inline-code backticks, links `[text](url)` → `text`, images → alt text; convert table pipes to ` | `; collapse runs of blank lines. Pure, unit-tested.
4. **Apply at the three DESCRIPTION sources** in `shared/schedule-extract.ts` (`:139-142`, `:174-177`, `:226-231`) so calendar apps get clean plaintext.

### Acceptance
- [ ] A table exported under a markdown heading produces SUMMARY `"<Heading> — Week N"`, never "Data Table N".
- [ ] No `.ics` DESCRIPTION contains `**`, leading `#`, or `](`  (unit test on `stripMarkdownToText` + schedule-extract outputs).
- [ ] Existing ics escaping/folding tests still pass; `npm run check` and `npm run test` pass.

---

## Out of scope
- **Headless (cdp) browser unavailability** in the dogfood session — environment constraint, not a code defect. Radix widgets remain driven via the same REST endpoints the UI calls.
- OWM One Call 2.5 fallback mapping (different response shape; not worth the surface — the correct fix is a 3.0-enabled key).
- Any change to `maxAutonomousTurns`, expert count, or sequential round behavior.

## Keys / env
- `OWM_API_KEY` already exists in `.env`. Owner adds a One Call 3.0-enabled key after merge-prep; the app must behave honestly (F1 acceptance) until then. One Call 3.0 requires the key to be enabled for 3.0 (free tier: 1,000 calls/day, card required at signup).

## Verification plan
1. `npm run check` (tsc) clean.
2. `npm run test` (vitest) green, including new unit tests for text-similarity, analyze-once predicate, stripMarkdown, artifact titles.
3. Boot smoke (`npm run dev`) with a deliberately invalid `OWM_API_KEY`: single 401 log, `GET /api/protected/weather` returns typed `auth` failure with user-safe message; then with key removed: `missing_key`, zero network calls.
