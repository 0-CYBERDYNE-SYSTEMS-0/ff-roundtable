# UI/UX Audit — Farm Friend Roundtable Client

- **Date:** 2026-10-17
- **Baseline:** `main` @ `9c800ba` (after artifacts/calendar release and sidebar collapse work)
- **Scope:** `client/` (pages, layout, chat, sidebars, expert selection, artifacts, auth), `client/index.html`, `tailwind.config.ts`, `client/src/index.css`
- **Method:** Static code review. The app was not run. Items that depend on rendered layout are marked **(verify in browser)**.

Each finding lists where it is, what's wrong, and what "done" looks like. Line numbers are as of the baseline commit.

---

## Priority summary

| # | Priority | Area | Finding |
|---|---|---|---|
| 1 | P0 | Experts | No way to add/remove experts after the initial selector closes |
| 2 | P0 | Farm profile | Profile can't be reopened or edited; dismissal not persisted |
| 3 | P0 | Navigation | Conversation history hidden behind non-default tab; no rename/delete/search |
| 4 | P0 | Layout | Four columns on desktop squeeze the chat to ~330px at 1280px |
| 5 | P0 | Mobile | Floating experts button likely overlaps the composer |
| 6 | P0 | Mobile | No way to open the left sidebar before a conversation exists |
| 7 | P1 | Trust | Fake model performance metrics shown in expert picker |
| 8 | P1 | Trust | Placeholder "Chart Visualization" box shown to users |
| 9 | P1 | IA | Insights and charts duplicated across 2–3 places |
| 10 | P1 | Polish | Dev/test leftovers visible in production |
| 11 | P1 | Polish | Every user shares the same stock-photo avatar |
| 12 | P1 | Feedback | Presets and max-expert limit truncate silently |
| 13 | P1 | Consistency | Expert avatars resolved differently in panel vs. chat |
| 14 | P1 | Feedback | Loading skeleton shows every expert; progress bar animation undefined |
| 15 | P1 | Clarity | Status bar shows internal state names; redundant autonomous controls |
| 16 | P1 | Clarity | Up to five status bars stack above the chat |
| 17 | P1 | Noise | Success toasts for routine actions |
| 18 | P1 | Composer | No hints, no auto-grow, no queued-state cue, no jump-to-latest |
| 19 | P2 | A11y | Pinch-zoom disabled |
| 20 | P2 | A11y | Color contrast failures |
| 21 | P2 | A11y | No reduced-motion support; persistent pulsing |
| 22 | P2 | A11y | Artifact fullscreen view isn't an accessible dialog |
| 23 | P2 | A11y | Right sidebar resize is mouse/touch only |
| 24 | P2 | A11y | Incomplete ARIA on tabs and mention autocomplete |
| 25 | P2 | A11y | Expert selector likely has two close buttons |
| 26 | P2 | A11y | Auth forms lack `autoComplete` hints |
| 27 | P2 | Visual | Font loading doesn't match CSS; mixed icon systems |
| 28 | P2 | Visual | Global CSS side effects |
| 29 | P2 | Visual | Theme token choices tint shadcn components |
| 30 | P2 | Visual | Dark mode configured but not implemented |
| 31 | P2 | Visual | Heavy gradients/shadows and 8 expert bubble colors |
| 32 | P2 | Persistence | Panel widths and collapsed states reset on reload |
| 33 | P2 | Navigation | Account menu is nearly empty |

---

## P0 — Broken flows and dead ends

### 1. Experts can't be managed after setup
- **Where:** `client/src/pages/home-page.tsx:633-641`, `:1330-1336`
- **Problem:** `setShowExpertSelector(true)` is only called right after creating a conversation. If the selector is closed without adding anyone, the conversation has no experts, the chat area is blank, and there's no recovery path. There is no add or remove for experts in an existing conversation; `ExpertSettingsModal` only edits.
- **Done when:** The expert panel has an "Add / manage experts" action that opens the selector for the active conversation. Experts can be removed. A conversation with zero experts shows an empty state with an "Add experts" CTA.

### 2. Farm profile can't be reopened
- **Where:** `client/src/pages/home-page.tsx:692-702`, `:1339-1349`
- **Problem:** The modal opens automatically only when no profile exists. After saving there's no entry point to edit it. `farmProfileModalDismissed` is component state, so a dismissed modal reappears on every page load.
- **Done when:** The account menu (see #33) has a "Farm profile" item. Dismissal is persisted (localStorage is fine, matching the existing `ffCharterNudgeDismissed` pattern).

### 3. Conversation history is hard to reach and hard to scan
- **Where:** `client/src/components/sidebar/SidebarPanel.tsx:81`, `:302-341`
- **Problem:** The left sidebar defaults to the **Insights** tab. Conversations are all created as "New Conversation" (`home-page.tsx:178`) and the list shows only `createdAt`, so they're indistinguishable. No rename, delete, or search.
- **Done when:** Conversations is the default tab (or always visible). Titles are auto-derived from the first topic or are renameable. Delete is available. The list shows last activity, not creation time. Search is added once the list gets long.

### 4. Four-column desktop layout squeezes the chat
- **Where:** `home-page.tsx:1032-1099` (left sidebar 288–400px), `ChatInterface.tsx:619-713` (expert panel 256px), `:1073-1105` (right sidebar default 400px)
- **Problem:** At 1280px wide, the chat column ends up around 330px, the narrowest column on screen.
- **Done when:** At most three columns on desktop. Options: fold the expert panel into a horizontal avatar strip above the chat, or merge it into the left sidebar. The chat keeps a sensible minimum (~560px) at 1280px. **(verify in browser)**

### 5. Mobile experts button likely overlaps the composer
- **Where:** `client/src/components/chat/ChatInterface.tsx:1057-1070`
- **Problem:** The floating button is `fixed bottom-20` (80px) at `right: 16px`. The composer is roughly 92px tall (`p-4` + `min-h-[60px]` textarea), so the button probably sits over the textarea's right edge. **(verify in browser)**
- **Done when:** The button doesn't cover any input or the send button at common phone sizes (360–430px wide), or it moves into the control bar.

### 6. No left-sidebar access on mobile before a conversation exists
- **Where:** `home-page.tsx:1142-1158`
- **Problem:** The mobile menu toggle is inside the control bar, which only renders when `activeConversation` is set.
- **Done when:** The menu toggle lives in the header (or always renders) on mobile.

---

## P1 — Misleading or unfinished UI

### 7. Fake model performance metrics
- **Where:** `client/src/components/roundtable/ExpertCard.tsx:46-63`, `:312-326`
- **Problem:** Speed/Quality/Cost come from a hardcoded lookup on model ID substrings (the code comment says "sample data"). Current free models match none of them, so every one shows "Medium / Medium / Medium". Provider grouping (`:66-75`) also misses current providers (NVIDIA, DeepSeek, Qwen), so most models land in "Other".
- **Done when:** The fake metrics are removed, or replaced with real data from the OpenRouter response (context length, pricing). Provider is derived from the model ID prefix.

### 8. Placeholder chart box
- **Where:** `client/src/components/roundtable/ConversationSidebar.tsx:56-106`, `:195-204`
- **Problem:** URLs matching `chart.googleapis.com` and ```` ```chart ```` blocks render a box that just says "Chart Visualization". Any maps URL an expert writes is put into an iframe.
- **Done when:** The legacy URL/codeblock scanning is removed. Visualizations come only from structured `chart` artifacts (already rendered via `VegaChart`).

### 9. Duplicated information architecture
- **Where:** `SidebarPanel.tsx:343-393` and `ConversationSidebar.tsx:238-268` (insights twice); `ChatInterface.tsx:874-884`, `ConversationSidebar.tsx:270-318` (charts inline + Artifacts tab + Visualizations tab)
- **Done when:** Each content type has one home. Suggested: left sidebar = conversations + files; right sidebar = insights + artifacts (charts as a filter, not a separate tab); artifacts also stay inline in the chat.

### 10. Dev/test leftovers in production
- **Where:**
  - "⚡ Quick Test" button on the welcome screen: `home-page.tsx:1314-1320` (calls `/api/dev/quick-setup`)
  - Replit badge script: `client/index.html`
  - Hardcoded "v1.0.0 © 2026 Farm Friend Technologies" footer: `SidebarPanel.tsx:474-477`
  - Subscription badge with pulsing dot in the header: `Header.tsx:51-54` (in production, unsubscribed users are redirected to `/subscribe` by `lib/protected-route.tsx:78-84`, so this effectively only appears in dev)
- **Done when:** Quick Test is gated behind `import.meta.env.DEV`. The Replit script is removed. The version is injected at build time or the footer is removed. The header badge is gated or replaced with a plan label.

### 11. Shared stock-photo avatar
- **Where:** `Header.tsx:64`, `ChatInterface.tsx:811`
- **Problem:** Every user gets the same Unsplash portrait, which also adds a third-party request.
- **Done when:** User avatars use initials (the `AvatarFallback` already exists), or a user-uploaded image.

### 12. Silent truncation in the expert picker
- **Where:** `client/src/components/roundtable/ExpertSelector.tsx:235-285`
- **Problem:** On the free tier (max 3), "Problem Solving Team" (4 experts) silently drops one. Clicking Add past the limit does nothing. Presets referencing roles not in the catalog are skipped silently.
- **Done when:** The user sees why (an inline message like "Your plan allows 3 experts — File Creator wasn't added"), with a link to upgrade. Add buttons show as disabled with a reason at the limit. Selected experts from other category tabs are visible in a summary row.

### 13. Inconsistent expert avatars
- **Where:** Panel/mention list use the `catalogAvatar` fallback (`ChatInterface.tsx:589`, `:654`, `:703`, `:1013`); message bubbles and streaming bubbles use `expert?.avatarUrl || ""` (`:833`, `:906`).
- **Done when:** One helper resolves an expert's avatar and is used everywhere.

### 14. Loading skeleton misrepresents what's happening
- **Where:** `ChatInterface.tsx:580-614`
- **Problem:** While any request is pending, a skeleton renders for **every** expert, even though only one speaks at a time in sequential mode. The progress bar uses `animation: 'loading 2s infinite'`, but no `loading` keyframe exists in `tailwind.config.ts` or `index.css`, so it never moves.
- **Done when:** Only the announced/next speaker shows a placeholder (the `upNextExpertId` signal already exists). The keyframe is defined or the bar is removed.

### 15. Status bar uses internal state names
- **Where:** `home-page.tsx:1159-1258`
- **Problem:** Shows `interactionMode.replace('_', ' ')`, e.g. "processing sequential". "Autonomous: Enabled" plus a "Disable Auto" button says the same thing twice.
- **Done when:** Plain-language status ("Experts are discussing…", "Paused", "Waiting for you"). Autonomous mode is one labeled switch with a short tooltip explaining what it does.

### 16. Stacked status banners
- **Where:** `home-page.tsx:1111-1279`
- **Problem:** Connection, queued message, concluding, control bar, and charter nudge can all render at once, pushing the chat down.
- **Done when:** One status strip that shows the highest-priority state, with the control bar beside it.

### 17. Toast noise
- **Where:** `home-page.tsx:185-187` (conversation created), `:498-500` / `:522-524` (autonomous on/off), `:447-449` (file uploaded), `:469-471` (insights generated)
- **Done when:** Toasts are reserved for errors and for outcomes that aren't otherwise visible on screen.

### 18. Composer gaps
- **Where:** `ChatInterface.tsx:948-1052`
- **Problems:**
  - No hint for Shift+Enter, `@` mentions, or `/new`.
  - The textarea doesn't auto-grow; `pr-10` reserves space for nothing.
  - No cue when a message will be queued behind a running discussion (the server queues it; the UI only says so afterwards).
  - No "jump to latest" button when the user has scrolled up during streaming (`isNearBottomRef` already tracks this).
  - Messages show no per-message timestamp (date separators only). `format` from `date-fns` is imported but unused.
- **Done when:** A one-line hint under the composer, an auto-growing textarea with a max height, a queued-state placeholder, and a floating "New messages ↓" button.

---

## P2 — Accessibility

### 19. Pinch-zoom disabled
- **Where:** `client/index.html` — `maximum-scale=1`
- **Done when:** Removed (WCAG 1.4.4 Resize Text).

### 20. Contrast failures
- **Where:**
  - `text-farm-green` (#4CAF50) on white ≈ 2.8:1, used on the Resume and Enable Auto buttons (`home-page.tsx:1223`, `:1253`) and the calendar button (`SidebarPanel.tsx:258`)
  - White text on the green end of the auth hero gradient (`pages/auth-page.tsx`, `from-farm-blue to-farm-green`)
- **Done when:** Text uses `farm-dark-green` (#2E7D32) or darker. All text meets 4.5:1 (3:1 for large text).

### 21. Motion
- **Where:** `animate-pulse` on mentioned expert cards persists until the next message (`ChatInterface.tsx:648`, `:698`); ping dots (`:661`, `:910`); blinking cursor (`:934`); `animate-pulse` on the header badge.
- **Done when:** All continuous animations respect `prefers-reduced-motion` (Tailwind `motion-reduce:`). The mention highlight pulses briefly, then settles to a static ring.

### 22. Artifact fullscreen isn't a dialog
- **Where:** `client/src/components/artifacts/ArtifactDisplay.tsx:291-313`
- **Problem:** Hand-built overlay `div`: no focus trap, no Escape to close, no `role="dialog"`. Icon buttons have `title` only, no `aria-label`. Copy (`:29-31`) gives no feedback and doesn't handle failure.
- **Done when:** Uses the existing shadcn `Dialog`. Icon buttons have `aria-label`. Copy shows a "Copied" confirmation.

### 23. Right sidebar resize is pointer-only
- **Where:** `ConversationSidebar.tsx:108-167`, `:321-332`
- **Problem:** No `role="separator"`, no keyboard support, and an off-palette inline border color `rgb(59 130 246)`. The left sidebar handle (`home-page.tsx:1080-1098`) already does this correctly.
- **Done when:** It mirrors the left handle's implementation (pointer capture, arrow/Home/End keys, ARIA values).

### 24. Incomplete ARIA
- **Where:**
  - Left sidebar tabs use `role="tab"` without a `role="tablist"` container, `aria-controls`, or arrow-key navigation (`SidebarPanel.tsx:270-298`). Swapping to shadcn `Tabs` (already used on the right) fixes this.
  - The mention autocomplete has `role="listbox"`/`option`, but the textarea lacks combobox wiring (`aria-expanded`, `aria-controls`, `aria-activedescendant`) (`ChatInterface.tsx:996-1041`).
  - The open-questions close button renders a bare "×" character (`:734-741`).

### 25. Duplicate close buttons in the expert picker
- **Where:** `ExpertSelector.tsx:378-383`
- **Problem:** A custom unlabeled X button inside `DialogContent`, which (in standard shadcn) already renders its own close button. **(verify in browser)**
- **Done when:** One close button with an accessible label. Use `DialogTitle` for the heading so the dialog is announced correctly.

### 26. Auth forms lack autocomplete hints
- **Where:** `client/src/pages/auth-page.tsx` login and register forms
- **Done when:** `autoComplete="username"`, `"current-password"`, `"new-password"`, and `"email"` are set.

---

## P2 — Visual system and consistency

### 27. Fonts and icons
- `index.html` loads **Roboto** and **Roboto Slab**, but CSS and Tailwind ask for **Inter** (not loaded, so it falls back to system fonts) and **Georgia** for serif. The Roboto request is wasted.
- **Material Icons** is loaded for four glyphs (`ChatInterface.tsx:558`, `auth-page.tsx:295/305/315`), alongside lucide icons and emoji used as icons in empty states.
- **Done when:** Load the fonts the CSS uses (or change the CSS). Replace Material Icons and emoji-as-icons with lucide.

### 28. Global CSS side effects
- **Where:** `client/src/index.css`
- `transition: all 0.2s` on every button, link, and input (`:104-106`). It animates layout properties and conflicts with component transitions.
- `p { margin-bottom: 1rem }` globally (`:99-101`) fights component spacing; code works around it with `mb-2` and similar.
- Global `h1–h4` sizes (`:81-97`) are large for an app UI and get overridden ad hoc.
- Custom scrollbar: teal thumb on a powder-blue track (`:109-125`) is visually heavy.
- **Done when:** These are scoped to a markdown/prose context or removed, and the scrollbar is neutralized.

### 29. Theme tokens tint shadcn components
- **Where:** `index.css:30-44`
- `--muted` = powder blue, so every shadcn "muted" surface (tabs, skeletons, hover rows) turns blue. `--border`/`--input` = tan everywhere.
- **Done when:** `--muted` and `--border` are neutral grays. Brand colors are reserved for primary/accent.

### 30. Dark mode
- `darkMode: ["class"]` is configured in `tailwind.config.ts`, but there are no dark tokens and only `ArtifactDisplay.tsx` uses `dark:` classes.
- **Decision needed:** Implement it (dark token block + toggle) or remove the stray `dark:` classes.

### 31. Visual density
- Gradients and shadows on most surfaces (header, buttons, bubbles, sidebars, empty states), plus 8 pastel bubble colors per expert (`ChatInterface.tsx:466-478`).
- **Suggestion:** Calmer neutral base. Identify each expert with one accent (avatar ring or bubble left border) instead of full-bubble fills.

### 32. Layout preferences not persisted
- Left sidebar width/collapsed (`home-page.tsx:60-61`), right sidebar width/collapsed (`ChatInterface.tsx:199-200`), and expert panel collapsed (`:198`) all reset on reload.
- **Done when:** Persisted in localStorage with try/catch, as done elsewhere in the codebase.

### 33. Account menu
- **Where:** `Header.tsx:71-80`
- **Problem:** A separator with nothing above it, then Logout. No links to farm profile, plan/billing (`/subscribe`), or settings.
- **Done when:** The menu includes Farm profile, Plan & billing, and Logout, with the username shown at the top.

---

## Suggested sequencing

1. **Dead ends (P0 #1–3, #6):** manage-experts entry, farm profile in the account menu, conversations as the default tab with rename/delete.
2. **Layout (P0 #4–5, P1 #9):** collapse to three columns; one home per content type.
3. **Remove misleading UI (P1 #7, #8, #10, #11):** small, low-risk changes with high trust impact.
4. **Status and composer clarity (P1 #15–18).**
5. **Accessibility pass (P2 #19–26):** #19 and #20 are one-line fixes; do them early.
6. **Design tokens, fonts, persistence (P2 #27–33).**

## Notes for whoever picks this up

- Several items are one-line fixes: #6, #10, #19, #20, #26.
- `npm run check` and `npm test` should stay green. UI changes touching `home-page.tsx` WebSocket handling should be checked against the existing orchestrator and WebSocket tests.
- Items marked **(verify in browser)** should be confirmed at 1280px and 1440px desktop and at 375px mobile before fixing.
