---
agent: speed-planner
generated: 2026-04-07T00:00:00Z
task_id: feature-8
perspective: speed
---

# Speed Plan: Side Panel UX with Live Event Timeline

## Architecture Impact

**Components affected:**
- `manifest.json`: adds `sidePanel` permission, adds `side_panel.default_path`, removes `action.default_popup`.
- `src/background/service-worker.ts`: adds a single `chrome.sidePanel.setPanelBehavior` call at module init.
- `src/popup/*`: deleted entirely (option b from brief — no popup HTML/JS in the build).
- `src/sidepanel/*`: new folder — `index.html`, `sidepanel.ts`, `sidepanel.css` plus a pure render helper.
- `src/lib/sidepanel-render.ts`: new pure module for event → row mapping (unit testable without jsdom).
- `src/constants.ts`: adds one new storage key `STORAGE_SIDEPANEL_SCROLL` for per-session scroll restore.

**New patterns or abstractions introduced:**
- None. Reuses the existing message router, `chrome.storage.local` plus `chrome.storage.onChanged` as a pub/sub, and the existing `session-metrics` helpers.

**Dependencies added or modified:**
- None. `chrome.sidePanel` is a built-in MV3 API, no npm package required. No type package needed — the `@types/chrome` already bundled with the extension project covers it (no explicit dep change).

**Breaking changes to existing interfaces:**
- The toolbar action no longer opens a popup. Users who previously expected the popup will now get the side panel. This is the intended UX of feature #8 and matches the DoD — not a regression.
- No message/shape changes to `Message` union or any storage schema (additive only).

## Approach

Delete the popup. Drop a single new side panel entrypoint (`src/sidepanel/`) that mounts an `<ul>` of events, subscribes to `chrome.storage.onChanged` on `STORAGE_EVENTS` / `STORAGE_SCREENSHOTS` / `STORAGE_SESSION`, and renders events through a pure helper in `src/lib/sidepanel-render.ts`. All the existing background message handlers (`START_SESSION`, `STOP_SESSION`, `ADD_ANNOTATION`, `TAKE_SCREENSHOT`, `GET_SESSION_METRICS`) are reused unchanged — the side panel is a thin replacement for the popup that also happens to subscribe to storage changes.

## Files to Modify (Minimal)

| File | Change Type | Estimated Lines | Rationale |
|------|-------------|-----------------|-----------|
| `manifest.json` | Modify | ~6 | Add `sidePanel` permission, add `side_panel.default_path`, remove `action.default_popup`. |
| `src/background/service-worker.ts` | Modify | ~6 | Call `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` on module init. |
| `src/constants.ts` | Modify | ~2 | Add `STORAGE_SIDEPANEL_SCROLL` key. |
| `src/popup/index.html` | Delete | -23 | Removed. |
| `src/popup/popup.ts` | Delete | -92 | Removed. |
| `src/popup/popup.css` | Delete | -99 | Removed. |
| `src/sidepanel/index.html` | Add | ~35 | Markup: header, event list `<ul>`, form region with start/stop, PII fieldset, annotation textarea, metrics row, notice slot. |
| `src/sidepanel/sidepanel.ts` | Add | ~260 | Bootstraps UI, wires messages, subscribes to `chrome.storage.onChanged`, restores scroll. |
| `src/sidepanel/sidepanel.css` | Add | ~170 | Dark/widget-aligned theme, full-height flex layout. |
| `src/lib/sidepanel-render.ts` | Add | ~110 | Pure helpers: `eventTypeLabel`, `formatEventTimestamp`, `buildEventRowModel`, `getScreenshotIdForEvent`. |
| `src/lib/sidepanel-render.test.ts` | Add | ~140 | Vitest suite for the pure helpers. |
| `src/sidepanel/sidepanel.test.ts` | Add | ~180 | `// @vitest-environment jsdom` — wire a fake `chrome.storage` and assert DOM updates. |

**Total files**: 12 (3 deletes, 6 adds, 3 modifies)
**Total estimated lines**: ~900 added, ~214 removed → net ~690 lines of diff

## Implementation Steps

1. **Manifest**: add `"sidePanel"` to `permissions`, add top-level `"side_panel": { "default_path": "src/sidepanel/index.html" }`, delete the `default_popup` line. `vite-plugin-web-extension` will auto-discover the new HTML entrypoint from the manifest with no Vite config change.
2. **Service worker**: after `restoreState()` call, add:
   ```ts
   chrome.sidePanel
     .setPanelBehavior({ openPanelOnActionClick: true })
     .catch((e) => console.warn("[DeskCheck] setPanelBehavior failed:", e));
   ```
   No other service worker changes.
3. **Constants**: add `export const STORAGE_SIDEPANEL_SCROLL = "deskcheck_sidepanel_scroll";`
4. **Delete** `src/popup/` folder in its entirety.
5. **Create `src/sidepanel/index.html`**: minimal skeleton with two regions:
   - `<section id="events" aria-label="Event timeline">` containing `<ul id="event-list">`.
   - `<form id="controls" aria-label="Session controls">` containing:
     - `<div id="notice-slot">` (first-run privacy notice mounts here).
     - `<div id="metrics-row">` (duration, counts, size — reuses `session-metrics` helpers).
     - `<fieldset id="pii-mode-fieldset">` (identical to popup markup, copy-paste).
     - `<textarea id="annotation-text" placeholder="Note (optional)">`.
     - `<div class="button-row">` with `<button id="start-btn">`, `<button id="stop-btn">`, `<button id="screenshot-btn">`, `<button id="annotation-btn">`, `<button id="download-btn">`.
     - `<p id="status" role="status">`.
   - `<script type="module" src="sidepanel.ts">`.
6. **Create `src/lib/sidepanel-render.ts`** — pure functions only, no DOM, no chrome:
   - `export function eventTypeLabel(ev: TimelineEvent): string` (switch over discriminated union).
   - `export function formatEventTimestamp(iso: string): string` (returns `HH:MM:SS.mmm`).
   - `export function buildEventRowModel(ev: TimelineEvent, screenshots: Record<string,string>): { seq: number; label: string; time: string; description: string; thumbnailDataUrl?: string; }` — `thumbnailDataUrl` is set for `screenshot` events and for `annotation` events whose `screenshot_id` resolves in the screenshots map.
   - `export function describeEvent(ev: TimelineEvent): string` (short one-liner: "click button#submit", "console.error: ...", "GET /api/x → 500", etc.).
7. **Create `src/sidepanel/sidepanel.ts`**:
   - On load: call `GET_SESSION_STATE` + `GET_SESSION_METRICS`, then `chrome.storage.local.get([STORAGE_EVENTS, STORAGE_SCREENSHOTS, STORAGE_SIDEPANEL_SCROLL])` to seed the list.
   - Render first-run notice (reusing `PRIVACY_NOTICE_BULLETS` + `shouldShowFirstRunNotice` + `getFirstRunSeen`/`markFirstRunSeen`).
   - Wire start/stop/download/screenshot/annotation buttons to existing message types.
   - Subscribe to `chrome.storage.onChanged` (area === `"local"`): when `STORAGE_EVENTS` changes, diff new list against rendered count and `appendChild` only the new rows (no full re-render). When `STORAGE_SCREENSHOTS` changes, backfill any `<img data-screenshot-id="…">` placeholders. When `STORAGE_SESSION` changes, re-render the metrics row and toggle start/stop visibility.
   - Debounced (`setTimeout 250ms`) `scroll` listener on the event list writes `{ [STORAGE_SIDEPANEL_SCROLL]: { sessionId, top } }` to `chrome.storage.local`. On mount, read this back and restore if `sessionId` matches current session.
   - Poll `GET_SESSION_METRICS` every `METRICS_POLL_INTERVAL_MS` like the widget does, OR (cheaper) recompute metrics in-panel from the cached events list + screenshots map already held in memory — prefer the latter to avoid the extra message round-trip.
8. **Create `src/sidepanel/sidepanel.css`**:
   - `html, body { height: 100%; margin: 0; }`
   - `body { display: flex; flex-direction: column; font-family: system-ui; font-size: 13px; background: #0f172a; color: #e5e7eb; }` (dark theme per DoD #11).
   - `#events { flex: 1 1 auto; overflow-y: auto; min-height: 0; }` — independent scroll (DoD #9).
   - `#controls { flex: 0 0 auto; border-top: 1px solid #1e293b; padding: 10px 12px; background: #111827; }` — pinned bottom.
   - `#event-list li { display: flex; gap: 8px; padding: 6px 12px; border-bottom: 1px solid #1e293b; }`
   - `.event-thumb { max-width: 64px; max-height: 48px; border-radius: 4px; }`
   - Reuse visual tokens from widget.css (dark inversion): rounded corners (6px), blue accent `#2563eb`, tabular-nums for metrics.
9. **Tests** (see Test Plan section).
10. Run `make typecheck && make test && make build`. Load `dist/` into Chrome, verify side panel opens on action click, events stream in live, scroll persists across tab switches.

## Manifest Changes (Exact JSON Diff)

```diff
   "permissions": [
     "activeTab",
     "debugger",
     "storage",
     "unlimitedStorage",
     "tabs",
     "downloads",
-    "scripting"
+    "scripting",
+    "sidePanel"
   ],
   "host_permissions": [
     "<all_urls>"
   ],
   "background": {
     "service_worker": "src/background/service-worker.ts"
   },
+  "side_panel": {
+    "default_path": "src/sidepanel/index.html"
+  },
   "content_scripts": [ ... ],
   "action": {
-    "default_popup": "src/popup/index.html",
     "default_icon": {
       "16": "icons/icon-16.png",
       "48": "icons/icon-48.png",
       "128": "icons/icon-128.png"
     }
   },
```

## Service Worker Changes (Exact Lines)

Insert immediately after the existing `restoreState().catch(...)` block (around current line 38) and before the `chrome.runtime.onInstalled.addListener` block:

```ts
// ── Side panel: open directly on action click, no popup ──
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => {
    console.warn("[DeskCheck] setPanelBehavior failed:", err);
  });
```

No other changes to `service-worker.ts`. All existing message handlers work unchanged; the side panel sends the same messages the popup did.

## New Side Panel Module Structure

```
src/sidepanel/
├── index.html          # skeleton: #events + #controls regions
├── sidepanel.ts        # bootstrap, message wiring, storage subscription
└── sidepanel.css       # full-height flex, dark theme

src/lib/
├── sidepanel-render.ts           # pure helpers (no DOM, no chrome)
└── sidepanel-render.test.ts      # vitest suite

src/sidepanel/
└── sidepanel.test.ts   # jsdom integration test for storage → DOM
```

**Exports from `src/lib/sidepanel-render.ts`:**
- `eventTypeLabel(ev: TimelineEvent): string`
- `formatEventTimestamp(iso: string): string`
- `describeEvent(ev: TimelineEvent): string`
- `buildEventRowModel(ev, screenshots): EventRowModel`
- `interface EventRowModel { seq; label; time; description; thumbnailDataUrl?; }`

**Responsibilities of `src/sidepanel/sidepanel.ts`:**
1. Wire DOM on `DOMContentLoaded`.
2. Seed state from `chrome.storage.local.get`.
3. Subscribe to `chrome.storage.onChanged`.
4. Forward button clicks to the background via `chrome.runtime.sendMessage`.
5. Manage first-run notice lifecycle.
6. Debounce-save scroll position; restore on mount.

## Live Event Update Mechanism

- **Storage keys watched**: `STORAGE_EVENTS`, `STORAGE_SCREENSHOTS`, `STORAGE_SESSION` — all already defined in `src/constants.ts`.
- **Listener**:
  ```ts
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_EVENTS]) applyEventsDelta(changes[STORAGE_EVENTS].newValue ?? []);
    if (changes[STORAGE_SCREENSHOTS]) backfillThumbnails(changes[STORAGE_SCREENSHOTS].newValue ?? {});
    if (changes[STORAGE_SESSION]) renderSessionState(changes[STORAGE_SESSION].newValue ?? null);
  });
  ```
- **Delta rendering**: maintain `let renderedCount = 0;`. On each `STORAGE_EVENTS` change, the new value is the full array (`appendEvent` writes the full array); we append `newEvents.slice(renderedCount)` as new `<li>` nodes, set `renderedCount = newEvents.length`. No re-render of prior rows. Auto-scroll to bottom if user is already near the bottom (within 40px) — otherwise leave scroll untouched so users can inspect history mid-session.
- **Screenshot backfill**: when a new screenshot event is appended, its thumbnail may not yet be in `STORAGE_SCREENSHOTS` (ordering is not guaranteed). Render the `<img>` with `data-screenshot-id` and empty `src`, and fill it when `STORAGE_SCREENSHOTS` updates.
- **No new message types**. No new background logic. The service worker already writes events via `appendEvent` which sets the whole array — `chrome.storage.onChanged` fires automatically.

## State Persistence Design

**Open/closed state**: handled automatically by Chrome — `chrome.sidePanel` with `openPanelOnActionClick: true` persists per-window open state without extra code. When the user switches tabs within a window, the side panel stays open and its DOM stays alive (Chrome treats it as a per-window panel).

**Scroll position**: the side panel document is the same DOM across tab switches (Chrome does not tear it down), so scroll survives natively. But to be safe against window-level reopen (panel closes then opens), we also:

1. On the `#events` element: `addEventListener("scroll", debounce(saveScroll, 250))`.
2. `saveScroll()` writes `chrome.storage.local.set({ [STORAGE_SIDEPANEL_SCROLL]: { sessionId: currentSessionId, top: eventsEl.scrollTop } })`.
3. On `DOMContentLoaded`, after the initial event list is seeded, read `STORAGE_SIDEPANEL_SCROLL`; if `sessionId` matches the current live session, restore `eventsEl.scrollTop`.
4. When a session ends (via `STORAGE_SESSION` change with `end_time` set), the scroll key is left alone; when a new session starts, it is overwritten by the first scroll save.

Debounce implementation: 15 lines inline, no library.

## PII Mode + First-Run Notice Migration

**PII mode**: the fieldset markup from `popup/index.html` (lines 12–17) is copied verbatim into `sidepanel/index.html`. The `selectedPiiMode()` helper from `popup.ts` (lines 9–14) is copied verbatim into `sidepanel.ts`. No changes to `src/lib/pii-modes.ts`, no changes to the `START_SESSION` message shape.

**First-run notice**: the side panel imports `PRIVACY_NOTICE_BULLETS`, `shouldShowFirstRunNotice` from `src/lib/privacy.ts` and `getFirstRunSeen`, `markFirstRunSeen` from `src/lib/privacy-store.ts`. On load, if `shouldShowFirstRunNotice(await getFirstRunSeen())`, it renders a dismissible `<div class="notice">` inside `#notice-slot` above the form. On dismiss → `await markFirstRunSeen()` + remove the DOM node. Implementation is ~25 lines copied and adapted from `widget.ts`'s existing notice render. The in-page widget's notice machinery is left untouched — both surfaces read the same flag, so whichever appears first dismisses for both.

## Test Plan

### `src/lib/sidepanel-render.test.ts` (Vitest, node env, no jsdom)

Pure helper tests covering every branch of the discriminated union:

1. `eventTypeLabel` returns a human label for each event type (`interaction`, `viewport_resize`, `network_error`, `console_error`, `js_exception`, `annotation`, `screenshot`).
2. `formatEventTimestamp` pads fields to `HH:MM:SS.mmm`.
3. `describeEvent` — one test per event type, asserting the key phrase is present.
4. `buildEventRowModel` — screenshot event returns its `dataUrl` when the id exists in the map.
5. `buildEventRowModel` — annotation event with `screenshot_id` resolved returns the thumbnail.
6. `buildEventRowModel` — annotation event with missing screenshot returns `undefined` (no crash).
7. `buildEventRowModel` — non-screenshot event returns no thumbnail.

### `src/sidepanel/sidepanel.test.ts` (Vitest, `// @vitest-environment jsdom`)

Glue tests with a hand-rolled `globalThis.chrome` mock (no real extension APIs):

1. **Seeds initial list** — preload `STORAGE_EVENTS` with 3 events, bootstrap the panel, assert 3 `<li>` in `#event-list`.
2. **Appends new events live** — fire the `storage.onChanged` listener with one extra event; assert a 4th `<li>` is appended and old rows are unchanged (check same node identity via `data-seq`).
3. **Renders screenshot thumbnail** — storage change with a screenshot event whose id is in `STORAGE_SCREENSHOTS`; assert the new `<li>` contains `<img src="data:...">`.
4. **Backfills thumbnail when screenshot arrives after event** — fire events change first, then screenshots change; assert the `<img>` src is populated.
5. **Scrolls independently** — set `#events.scrollTop`, dispatch `scroll`, assert `chrome.storage.local.set` called with `STORAGE_SIDEPANEL_SCROLL` after debounce flush.
6. **Restores scroll on mount** — seed `STORAGE_SIDEPANEL_SCROLL = { sessionId: "s1", top: 123 }` with matching active session; assert `scrollTop === 123` after init.
7. **Does not restore scroll when session id differs** — assert `scrollTop === 0`.
8. **Start button sends `START_SESSION` with selected PII mode** — click `#start-btn` with `metadata` radio checked; assert the dispatched message has `piiMode: "metadata"`.
9. **First-run notice shown when flag is false** — seed `STORAGE_PRIVACY_FIRST_RUN_SEEN = false`; assert notice DOM is present. Click dismiss; assert `chrome.storage.local.set` called with the flag true and the notice is removed.
10. **Event list is pinned above a bottom-anchored form** — assert `#events` has `flex: 1` computed and `#controls` follows it in the layout (use `getBoundingClientRect` ordering assertion).

### DoD → Test Mapping

| DoD # | Requirement | Test(s) |
|------|------------|---------|
| 1 | Side panel registered, opens on action click | Manifest snapshot test (plain JSON parse + assert keys) |
| 2 | Legacy popup removed | File-existence assertion in build output test / manifest snapshot (`default_popup` absent) |
| 3 | Start control in side panel | sidepanel.test.ts #8 |
| 4 | Full-height two-region layout | sidepanel.test.ts #10 |
| 5 | Live chronological list with timestamp + type label | sidepanel.test.ts #1, sidepanel-render.test.ts #1-3 |
| 6 | Inline screenshot thumbnails | sidepanel.test.ts #3, sidepanel-render.test.ts #4-7 |
| 7 | Live updates, no manual refresh | sidepanel.test.ts #2, #4 |
| 8 | Lower region has start/stop/annotation/screenshot/metrics | sidepanel.test.ts #8 + smoke assertion for each button id |
| 9 | Independent scrolling, form pinned | sidepanel.test.ts #5, #10 |
| 10 | State persists across tab switches | sidepanel.test.ts #5, #6, #7 |
| 11 | Visual styling consistent with widget theme | Manual visual check (no automated test — CSS snapshot is over-engineered for speed) |

A tiny `manifest.test.ts` (~25 lines) uses `import manifest from "../manifest.json"` to lock DoD #1 and #2 at build time.

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | Side panel registered, opens on action click | Unit | JSON snapshot of manifest — no need for Chrome runtime. |
| 2 | Legacy popup removed | Unit | Same manifest snapshot + `fs.existsSync("src/popup")` check. |
| 3 | Start control lives in side panel | Unit (jsdom) | DOM wiring test with mocked chrome — no real extension. |
| 4 | Full-height two-region layout | Unit (jsdom) | `getComputedStyle` + `getBoundingClientRect`. |
| 5 | Live chronological list with timestamp + type label | Unit | Pure helper tests cover the mapping; jsdom test covers rendering. |
| 6 | Screenshot thumbnails inline | Unit (jsdom) | Pure helper returns dataUrl; jsdom test asserts `<img>` src. |
| 7 | Live updates, no manual refresh | Unit (jsdom) | Fire mocked `chrome.storage.onChanged` listener directly. |
| 8 | Lower region controls + metrics | Unit (jsdom) | DOM ids + message dispatch. |
| 9 | Independent scroll | Unit (jsdom) | Verified via layout assertions + scroll event. |
| 10 | State persists across tab switches | Unit (jsdom) | Mock storage read/write, assert restore logic. |
| 11 | Visual consistency with widget | Manual | Visual fidelity can't be cheaply unit-tested; defer to hand QA. |

**Speed planner bias**: every automated criterion is unit-testable. No integration or e2e tests proposed.

**Determinism rule**: all tests use a hand-rolled `chrome` mock plus jsdom. No LLM calls, no live Chrome runtime, no network.

## Testing Strategy

- **Unit**: `src/lib/sidepanel-render.test.ts` (pure helpers) + `src/sidepanel/sidepanel.test.ts` (jsdom DOM wiring) + `src/manifest.test.ts` (JSON snapshot).
- **Integration**: Skip — the whole extension is small enough that jsdom + mocked chrome covers every collaborator boundary cheaply.
- **E2E**: Skip — the repo has no e2e harness (the `e2e/` folder is excluded in `vite.config.ts`), and adding one for a UI-shell change is massive scope creep.

**E2E Test Impact**:
- **Existing e2e tests affected**: None — repo has no e2e suite.
- **New e2e tests needed**: None — no new user-visible flow beyond a UI relocation already covered by jsdom.
- **Cost note**: n/a.

**Test files to create/modify**:
- `src/lib/sidepanel-render.test.ts` (new, ~140 lines)
- `src/sidepanel/sidepanel.test.ts` (new, ~180 lines)
- `src/manifest.test.ts` (new, ~25 lines)

## Risk Assessment

**Risk Level**: Low

**Why this is safe**:
- Zero changes to the service worker message contract — the popup's message surface is identical to the side panel's.
- Zero changes to storage schema or export schema — `schema_version` stays at `1.1.0`.
- `chrome.sidePanel` is a stable MV3 API (Chrome 114+).
- Popup deletion is reversible with a single git revert.
- All rendering logic is isolated in a pure helper that's unit-testable without Chrome APIs.

**Tradeoffs accepted**:
- No event list virtualization — sessions with > ~2,000 events may feel sluggish scrolling. Feature #1 already warns at 50MB so this is unlikely to hit in practice.
- Debounced storage writes on scroll (250ms) — the last scroll position in a rapid tab-switch may not be saved. Acceptable trade for avoiding excessive storage churn.
- No CSS snapshot test for DoD #11 — visual parity with the widget is verified manually.
- The side panel re-computes metrics in-memory from the cached events/screenshots instead of calling `GET_SESSION_METRICS`, which means the widget and side panel can briefly show slightly different totals between storage writes. Accepted; they converge within one tick.
- First-run notice appears in both the in-page widget and the side panel; whichever is dismissed first flips the flag for both. Slightly odd UX but correct behaviour.

## Estimated Effort

- Planning: Already done
- Implementation: 90 minutes
- Testing: 45 minutes
- Manual verification (load unpacked, smoke): 15 minutes
- **Total**: ~150 minutes

## Formal Verification Assessment

- Concurrency concerns: No — the side panel is single-threaded JS; the only shared state is `chrome.storage.local`, which Chrome serializes writes on.
- State machine complexity: No — the side panel has two states (session active / not active) driven by `STORAGE_SESSION`.
- Conservation laws: No — rendered row count must track stored event count, but this is a trivial invariant asserted by the unit test.
- Authorization model: No — no new permissions boundary; reuses existing extension permissions.
- Recommendation: **Not needed**. This is UI shell work with a pure helper; standard unit tests cover the invariants.
- Key invariants (for reference): rendered row count equals `STORAGE_EVENTS.length`; thumbnail `<img>` src is non-empty iff the screenshot id exists in `STORAGE_SCREENSHOTS`.

## Acceptance Test Seeds

One-sentence given/when/then for each DoD checkbox — for Phase 3 to expand into failing tests.

1. **Side panel registered**: GIVEN the built `dist/manifest.json`, WHEN parsed, THEN `side_panel.default_path === "src/sidepanel/index.html"` and `permissions` contains `"sidePanel"`.
2. **Popup removed**: GIVEN the repo, WHEN checking the filesystem and manifest, THEN `src/popup/` does not exist and `manifest.action.default_popup` is undefined.
3. **Start in side panel**: GIVEN the side panel loaded in jsdom with a mocked chrome, WHEN the user clicks `#start-btn` with PII mode `metadata` selected, THEN `chrome.runtime.sendMessage` is called once with a `START_SESSION` message whose `piiMode === "metadata"`.
4. **Two-region full-height layout**: GIVEN the side panel mounted in jsdom, WHEN the body is measured, THEN `body.clientHeight === window.innerHeight` and `#events` + `#controls` are the only flex children of `body` in that order.
5. **Chronological list with type + timestamp**: GIVEN `STORAGE_EVENTS` preloaded with one event of each type, WHEN the panel renders, THEN `#event-list` contains one `<li>` per event in order, each `<li>` contains a `.event-time` and `.event-label` node whose text matches `formatEventTimestamp` and `eventTypeLabel` for that event.
6. **Inline thumbnails for screenshot events**: GIVEN `STORAGE_EVENTS` contains a `screenshot` event with id `"ss1"` and `STORAGE_SCREENSHOTS["ss1"] === "data:image/png;base64,abc"`, WHEN rendered, THEN the matching `<li>` contains an `<img>` whose `src` equals that data URL.
7. **Live updates with no refresh**: GIVEN the panel is mounted with 2 events, WHEN `chrome.storage.onChanged` fires with a `STORAGE_EVENTS` change adding a 3rd event, THEN `#event-list` has 3 children without any manual reload and the original 2 `<li>` nodes have identical `data-seq` attributes (proving append-only rendering).
8. **Lower region controls present**: GIVEN the side panel mounted, WHEN the DOM is queried, THEN `#controls` contains `#start-btn`, `#stop-btn`, `#screenshot-btn`, `#annotation-text`, `#download-btn`, `#pii-mode-fieldset`, and `#metrics-row`.
9. **Independent scrolling, form pinned**: GIVEN the panel mounted at 600px height with 50 events, WHEN `#events.scrollTop` is set to 500, THEN `#controls.getBoundingClientRect().bottom` is still within the viewport and unchanged from its initial position.
10. **Scroll persists across simulated remount**: GIVEN the user scrolled to position 250 during session `s1`, WHEN the panel is torn down and re-bootstrapped with `STORAGE_SIDEPANEL_SCROLL === { sessionId: "s1", top: 250 }` and active session `s1`, THEN `#events.scrollTop === 250` after mount.
11. **Visual styling dark**: GIVEN the panel mounted, WHEN `getComputedStyle(document.body).backgroundColor` is read, THEN it is a dark color (blue/slate < 30 on each RGB channel). (Weak automated check; manual visual QA is the primary verification.)

## What This Plan Does NOT Include

- Does NOT add event list virtualization — a naive `<li>` per event is enough for realistic sessions.
- Does NOT add filtering/search over events — out of scope.
- Does NOT add a per-event "jump to timestamp" or "replay" interaction — deferred.
- Does NOT add an e2e / Puppeteer harness — the repo doesn't have one and adding it is its own feature.
- Does NOT restyle the in-page widget to match the new dark theme — side panel picks up the theme on its own, widget stays as-is.
- Does NOT refactor `popup.ts` into a shared module before deleting it — direct delete, copy needed snippets.
- Does NOT change `GET_SESSION_METRICS` or add any new message types — storage subscription covers everything.
- Does NOT add a CSS snapshot test for DoD #11 — manual QA is cheaper.
- Does NOT change the `schema_version` — no export schema changes.
- Does NOT add a migration path for users who had a popup-specific shortcut workflow — the toolbar icon still opens the UI, just in a panel instead of a popup.

## Rollback

If the side panel breaks after release:

1. `git revert <commit>` — restores `src/popup/`, manifest `default_popup`, and removes the side panel files. Single revert.
2. Or, as a hotfix without reverting: restore `action.default_popup` in `manifest.json` and remove the `sidePanel` permission + `side_panel` block; the side panel files can stay dormant in the repo (not referenced from manifest → not built into the extension).
3. Re-bump patch version with `make bump-patch`, re-tag, re-release.

No data migration concerns — the side panel reads and writes no new storage keys except `STORAGE_SIDEPANEL_SCROLL`, which is a disposable UI hint and safe to leave orphaned.
