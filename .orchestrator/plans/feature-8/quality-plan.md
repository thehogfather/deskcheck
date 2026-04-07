---
agent: quality-planner
generated: 2026-04-07T00:00:00Z
task_id: feature-8
perspective: quality
---

# Quality Plan: Side Panel UX with Live Event Timeline

## 1. Architectural intent

DeskCheck already follows a strict "pure module + thin glue" layering: `src/lib/*` holds DOM-free, Chrome-free logic (`session-metrics`, `privacy`, `pii-modes`, `agents-doc`, `exporter`), and the surface layers (`content/widget.ts`, `background/service-worker.ts`, `popup/popup.ts`) wire these modules to the Chrome runtime. The side panel must slot into this pattern: a new `src/sidepanel/` surface (glue only) mounted on top of three new pure lib modules (`sidepanel-render.ts`, `sidepanel-storage.ts`, `sidepanel-events-source.ts`) that are fully unit-testable without jsdom or Chrome. The event-type→row mapper reuses the `assertExhaustiveEventTypes` compile-time guard pattern from `agents-doc.ts` so a new `TimelineEvent` variant makes `make typecheck` fail until the side panel renderer is updated. No new coupling is introduced between the side panel and the content script widget; shared copy (privacy notice bullets, PII mode parsing) is imported from the existing pure modules.

## 2. Component map

```
src/sidepanel/                          (new surface — thin glue)
├── index.html                          mount point + <script> tag
├── sidepanel.ts                        DOM wiring only, no business logic
└── sidepanel.css                       dark theme stylesheet
                │
                │ imports (pure, DOM-free)
                ▼
src/lib/
├── sidepanel-render.ts        (new)   TimelineEvent → SidePanelEventRow + label helpers
├── sidepanel-storage.ts       (new)   scroll position get/set (chrome.storage.session)
├── sidepanel-events-source.ts (new)   chrome.storage.onChanged subscription wrapper
│                                       (the one Chrome-touching lib module — kept
│                                        tiny so the DOM glue has a single seam to mock)
├── session-store.ts            reuse   getSession, getEvents, getScreenshots
├── session-metrics.ts          reuse   computeSessionMetrics, formatDuration, formatBytes
├── privacy.ts                  reuse   PRIVACY_NOTICE_BULLETS, shouldShowFirstRunNotice
├── privacy-store.ts            reuse   getFirstRunSeen, markFirstRunSeen
├── pii-modes.ts                reuse   parsePiiMode, DEFAULT_PII_MODE, PII_MODES
└── agents-doc.ts               reuse   assertExhaustiveEventTypes pattern (mirrored, not imported)

src/background/service-worker.ts        modified: sidePanel.setPanelBehavior on install
manifest.json                            modified: side_panel + sidePanel permission, drop popup
```

Dependency direction is strictly downward: the glue layer (`src/sidepanel/sidepanel.ts`) depends on `src/lib/*`; nothing in `src/lib/*` depends on the side panel. `sidepanel-render.ts` has zero Chrome API imports and zero DOM imports — it produces plain view-model objects the glue layer turns into DOM nodes.

## 3. File-level changes

| File | Action | Purpose | Est. LOC |
|------|--------|---------|----------|
| `manifest.json` | modify | Add `side_panel.default_path`, add `sidePanel` permission, remove `action.default_popup` (keep `action` for the toolbar icon + badge) | +3 / -1 |
| `src/background/service-worker.ts` | modify | Call `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` inside `onInstalled` and on service worker boot | +15 |
| `src/popup/index.html` | delete | No longer referenced from the manifest | -23 |
| `src/popup/popup.ts` | delete | Replaced by side panel | -92 |
| `src/popup/popup.css` | delete | Replaced by side panel CSS | -99 |
| `src/sidepanel/index.html` | create | Side panel document, two-region layout skeleton | ~25 |
| `src/sidepanel/sidepanel.ts` | create | Glue: mount, wire callbacks, subscribe to event stream, render via pure module, persist scroll | ~320 |
| `src/sidepanel/sidepanel.css` | create | Dark theme palette, sticky form, scrollable list | ~260 |
| `src/lib/sidepanel-render.ts` | create | Pure: `eventToRow`, `eventTypeLabel`, `formatEventTimestamp`, `SidePanelEventRow` type, exhaustive mapper | ~180 |
| `src/lib/sidepanel-storage.ts` | create | Pure-ish: `getScrollPosition(windowId)`, `setScrollPosition(windowId, y)` over `chrome.storage.session` | ~55 |
| `src/lib/sidepanel-events-source.ts` | create | `subscribeToEvents(cb): () => void` — `chrome.storage.onChanged` wrapper filtered to `STORAGE_EVENTS` + `STORAGE_SCREENSHOTS` + `STORAGE_SESSION` | ~70 |
| `src/lib/sidepanel-render.test.ts` | create | Unit tests for the pure render module | ~260 |
| `src/lib/sidepanel-storage.test.ts` | create | Unit tests for scroll persistence with a fake `chrome.storage.session` | ~80 |
| `src/lib/sidepanel-events-source.test.ts` | create | Unit tests for the subscription wrapper with a fake listener registry | ~90 |
| `src/sidepanel/sidepanel.test.ts` | create | jsdom integration test for mount, storage-change → DOM update, first-run notice, PII mode wiring | ~240 |
| `src/sidepanel/build-artifacts.test.ts` | create | Negative test: asserts `src/popup/` is empty in the source tree and that `manifest.json` does not reference `popup` | ~35 |
| `src/constants.ts` | modify | Add `STORAGE_SIDE_PANEL_SCROLL_PREFIX = "deskcheck_sidepanel_scroll_"` | +1 |
| `src/types.ts` | modify | None required — `SidePanelEventRow` lives in `sidepanel-render.ts` (view-model, not export contract) | 0 |
| `docs/ARCHITECTURE.md` | modify | Append "Side panel" component block + updated data-flow diagram | +20 |

**Total new files**: 9. **Total modified files**: 4. **Total deleted files**: 3.

## 4. Manifest changes (exact diff)

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
   ...
   "action": {
-    "default_popup": "src/popup/index.html",
     "default_icon": {
       "16": "icons/icon-16.png",
       "48": "icons/icon-48.png",
       "128": "icons/icon-128.png"
     }
   },
+  "side_panel": {
+    "default_path": "src/sidepanel/index.html"
+  },
```

Rationale: keeping the top-level `action` block lets the service worker continue setting the `REC` badge via `chrome.action.setBadgeText`. Removing `default_popup` and calling `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` in the service worker turns the toolbar icon click into a side-panel-open gesture — no custom `chrome.action.onClicked` listener needed.

## 5. Type model

All types live in `src/lib/sidepanel-render.ts`:

```ts
// View-model the renderer emits. Uniform shape across every TimelineEvent
// variant so the glue layer has a single code path for DOM construction.
export interface SidePanelEventRow {
  seq: number;
  timestamp: string;        // ISO, unchanged from the source event
  label: string;            // human-readable event type + subtype
  detail: string;           // 1-line detail (selector, URL, message, annotation preview)
  accent: RowAccent;        // color category for the row border
  screenshotDataUrl: string | null; // thumbnail if the event has an embedded screenshot
}

export type RowAccent =
  | "neutral"      // interaction, viewport_resize
  | "error"        // network_error, console_error (level=error), js_exception
  | "warning"      // console_error (level=warning)
  | "annotation"   // annotation
  | "screenshot";  // screenshot

// Pure mapper — no DOM, no Chrome. The `event: never` fallback makes
// `make typecheck` fail if a new TimelineEvent variant is added to
// src/types.ts without updating this mapper.
export function eventToRow(
  event: TimelineEvent,
  screenshots: Readonly<Record<string, string>>,
): SidePanelEventRow;

// Display helpers, also pure.
export function eventTypeLabel(event: TimelineEvent): string;
export function formatEventTimestamp(iso: string, now?: Date): string;
//   returns "12:34:56" for today, otherwise "Apr 06 12:34:56"
//   `now` param is injected so tests are deterministic

// Compile-time guard, mirroring agents-doc.ts
export function assertExhaustiveSidePanelEvent(e: TimelineEvent): void;
```

And in `src/lib/sidepanel-events-source.ts`:

```ts
export interface EventsSourceSnapshot {
  session: SessionMetadata | null;
  events: TimelineEvent[];
  screenshots: Readonly<Record<string, string>>;
}

// Subscribes to chrome.storage.onChanged for STORAGE_EVENTS, STORAGE_SCREENSHOTS,
// and STORAGE_SESSION. Fires `callback` with a fresh snapshot on any change.
// Returns an unsubscribe function. Also triggers one initial snapshot fetch.
// Injectable `storageApi` parameter for tests.
export function subscribeToEvents(
  callback: (snapshot: EventsSourceSnapshot) => void,
  storageApi?: StorageApi,
): () => void;

export interface StorageApi {
  local: Pick<chrome.storage.LocalStorageArea, "get">;
  onChanged: {
    addListener(listener: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void): void;
    removeListener(listener: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void): void;
  };
}
```

And in `src/lib/sidepanel-storage.ts`:

```ts
export async function getScrollPosition(
  windowId: number,
  sessionStorage?: SessionStorageApi,
): Promise<number>;

export async function setScrollPosition(
  windowId: number,
  scrollY: number,
  sessionStorage?: SessionStorageApi,
): Promise<void>;

export interface SessionStorageApi {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}
```

## 6. Pure modules

### `src/lib/sidepanel-render.ts`

Responsibilities:
- Map every `TimelineEvent` variant to a `SidePanelEventRow` (the single source of truth for row content)
- Produce `label` and `detail` strings deterministically — no `Date.now()`, no locale-dependent calls unless `now` is injected
- Resolve screenshot thumbnails: for `screenshot` events and `annotation` events with a `screenshot_id`, look up `screenshots[id]` and attach it as `screenshotDataUrl`
- Classify rows by accent for color-coded borders (error/warning/annotation/screenshot/neutral)
- Hold the `assertExhaustiveSidePanelEvent` function mirroring `agents-doc.ts`

Signatures (final):
```ts
export function eventToRow(event: TimelineEvent, screenshots: Readonly<Record<string, string>>): SidePanelEventRow
export function eventTypeLabel(event: TimelineEvent): string
export function formatEventTimestamp(iso: string, now?: Date): string
export function assertExhaustiveSidePanelEvent(e: TimelineEvent): void
export type { SidePanelEventRow, RowAccent }
```

Implementation note: `eventToRow` uses a `switch (event.type)` with a `default: const _: never = event` branch — identical discipline to `assertExhaustiveEventTypes`. Adding an 8th `TimelineEvent` variant without updating this file is a compile error.

### `src/lib/sidepanel-storage.ts`

Responsibilities:
- Thin typed wrapper over `chrome.storage.session` for scroll positions keyed by `STORAGE_SIDE_PANEL_SCROLL_PREFIX + windowId`
- Read failures return `0` (safe default — top of list); write failures are logged via `console.warn` but never throw
- Accepts an injectable `SessionStorageApi` so tests can supply an in-memory fake without polyfilling `chrome`

Why `chrome.storage.session`: faster than `local`, cleared on browser restart (which is exactly when "restore my scroll" stops being useful), and doesn't pollute the long-lived storage area where session data lives.

### `src/lib/sidepanel-events-source.ts`

Responsibilities:
- One seam between the side panel and Chrome's storage event stream
- `subscribeToEvents(cb)`: registers a listener on `chrome.storage.onChanged`, filters to the three relevant keys, fetches a fresh snapshot via `getSession() / getEvents() / getScreenshots()`, and calls `cb(snapshot)`
- Fires an initial snapshot immediately (after scheduling, so callers can `await`)
- Returns an unsubscribe closure that calls `removeListener`
- Uses a minimal `StorageApi` interface so tests can drive change events synchronously

This is the ONLY Chrome-touching module under `src/lib/` introduced by this feature; the glue layer has exactly one seam to mock when testing the DOM.

## 7. Glue layer (`src/sidepanel/sidepanel.ts`)

Narrative: the side panel is a state machine with two visible states — **idle** (no active session; show start form, show "Download last report" if an exportable session exists) and **active** (session running; show live events list + sticky form). The glue layer owns the DOM, owns the state machine, and delegates all transformation to `sidepanel-render.ts`.

Mount flow:
1. `document.readyState === "loading"` ? wait for `DOMContentLoaded` : run immediately.
2. Query or fetch the current window id via `chrome.windows.getCurrent()` — used for scroll persistence.
3. Fetch initial state: `chrome.runtime.sendMessage({ type: "GET_SESSION_STATE" })` → idle vs active.
4. Conditionally render the first-run notice (reuses `getFirstRunSeen` / `shouldShowFirstRunNotice` / `PRIVACY_NOTICE_BULLETS`).
5. In active state: call `subscribeToEvents` to start the live stream; initial snapshot populates the list immediately.
6. Restore scroll position via `getScrollPosition(windowId)`.
7. Attach scroll listener with 200ms debounce → `setScrollPosition(windowId, scrollTop)`.
8. Start metrics poll (`GET_SESSION_METRICS` every 2s, reusing `METRICS_POLL_INTERVAL_MS`) and the 1s duration timer (mirrors widget.ts logic — see section 10 for optional extraction).

Unmount / state transition flow:
1. `SESSION_STOPPED` message or storage change where `session.end_time != null` → tear down subscription, tear down intervals, transition to idle view.
2. Idle view shows: PII mode fieldset, Start Session button, Download Report button (if `hasExportableSession`).
3. Transitioning from idle → active: `sendMessage({ type: "START_SESSION", ... })` with selected PII mode, then re-run the active-state mount flow (steps 5–8).

DOM layout:
```html
<body>
  <div id="sidepanel-root" class="dc-sp-root">
    <!-- First-run notice mounted here conditionally, above the events list -->
    <section id="events-list" class="dc-sp-events" role="log" aria-live="polite">
      <!-- SidePanelEventRow DOM nodes, newest at bottom -->
    </section>
    <section id="controls" class="dc-sp-controls">
      <!-- Idle: PII mode fieldset + start button + download button -->
      <!-- Active: metrics bar, textarea, pick element, add note, screenshot, stop & download -->
    </section>
  </div>
</body>
```

The events list uses `flex: 1 1 auto; overflow-y: auto;` and the controls section uses `flex: 0 0 auto;` so the controls pin to the bottom and only the events list scrolls — satisfies DoD #4 and #9 by CSS alone, no JS layout.

Auto-scroll rule: if the user is within 40px of the bottom when a new event arrives, scroll to the new bottom; otherwise preserve their position. This is a small pure helper in `sidepanel-render.ts` called `shouldAutoScroll(scrollTop: number, scrollHeight: number, clientHeight: number): boolean`, unit-tested.

Business logic lives nowhere inside this file. Every interesting transformation is a call into a pure lib module.

## 8. Manifest + service worker integration

Manifest changes: see section 4.

Service worker changes (`src/background/service-worker.ts`):

```ts
// Set panel behavior once on install — openPanelOnActionClick makes the
// toolbar icon open the side panel directly (no popup in between).
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    console.warn("[DeskCheck] Failed to set side panel behavior:", e);
  }
  // ... existing content script injection loop ...
});

// Also set on boot (sw wake) in case setPanelBehavior was cleared.
// Pattern mirrors the existing restoreState() call.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn("[DeskCheck] setPanelBehavior on boot failed:", e));
```

No changes to any message handler — `START_SESSION`, `STOP_SESSION`, `EXPORT_SESSION`, `GET_SESSION_STATE`, `GET_SESSION_METRICS`, `TAKE_SCREENSHOT`, `ADD_ANNOTATION` are reused verbatim. This is intentional: the side panel is a new surface, not a new protocol.

Semantics: `openPanelOnActionClick: true` is global for the extension. Clicking the toolbar icon toggles the side panel for the active window. The side panel document instance persists while the panel is open and is torn down when the user closes it — Chrome handles open/closed state per-window automatically, so DoD #10 (state persists across tab switches within a window) is satisfied by the platform, not by us.

## 9. State persistence design

| Concern | Mechanism | Storage area | Key |
|---|---|---|---|
| Side panel open/closed per window | Chrome `sidePanel` API built-in | (platform) | n/a |
| Scroll position of events list | `sidepanel-storage.ts` | `chrome.storage.session` | `deskcheck_sidepanel_scroll_<windowId>` |
| First-run privacy notice flag | reuse `privacy-store.ts` | `chrome.storage.local` | `deskcheck_privacy_first_run_seen` |
| PII mode selection | reuse existing `START_SESSION` message path | (in-memory until session starts) | n/a |
| Active session state (events, screenshots, metadata) | reuse `session-store.ts` | `chrome.storage.local` | existing keys |
| Textarea draft annotation text | **NOT persisted** (quality decision: keeps the surface stateless; draft survives tab-switches because the side panel document itself is not torn down when the user switches tabs within a window) | — | — |

Scroll persistence details:
- Debounce: 200ms — long enough to batch scroll-wheel events, short enough that closing the panel mid-scroll still saves
- Key is window-id scoped so two Chrome windows with the panel open don't fight over one value
- On mount, restore is best-effort: if the stored position exceeds `scrollHeight - clientHeight` (because events were pruned), clamp to bottom
- On visibility change (`document.visibilitychange` → hidden), force a flush so the last write is not lost

## 10. PII mode and first-run notice migration

PII mode: the existing popup uses a `<fieldset>` with three radio buttons (`full` / `metadata` / `none`) and calls `parsePiiMode` on the checked value. The side panel replicates this markup and imports `parsePiiMode`, `PII_MODES`, and `DEFAULT_PII_MODE` from `src/lib/pii-modes.ts`. No new copy, no new coercion logic.

First-run notice: the widget uses `renderFirstRunNotice` from `src/content/widget.ts` — a private function, shadow-DOM-scoped, styled via `widget.css?raw`. The side panel runs in a top-level document with its own stylesheet, so it cannot reuse that render function directly. Two options considered:

**Option A (chosen for quality)**: Extract a new pure module `src/lib/privacy-notice.ts` that exports `buildFirstRunNoticeModel()` returning `{ title: string, bullets: readonly string[], dismissLabel: string }`. Both the widget and the side panel construct their own DOM from this view-model. This eliminates the risk that a copy change in the widget silently drifts from the side panel. Estimated refactor: ~20 LOC added, ~15 LOC simplified in widget.ts. Low risk because `widget.ts` already imports `PRIVACY_NOTICE_BULLETS` — this just formalizes the view-model shape.

**Option B (fallback)**: Import `PRIVACY_NOTICE_BULLETS` directly into the side panel and build DOM inline. Acceptable because the bullets array is the only copy-shaped thing shared, but leaves the "title" string and "Got it" button label duplicated.

**Decision**: do Option A. The refactor is small, the invariant ("first-run notice copy is identical between widget and side panel") is worth a compile-time guarantee, and the new pure module earns a direct unit test. Widget regression risk is covered by the existing `src/lib/privacy.test.ts` plus a new test that asserts the widget and side panel both render the same bullets count/text.

## 11. Visual design

Dark theme palette (diverges from widget's light theme — called out explicitly):

| Token | Value | Used for |
|---|---|---|
| `--dc-sp-bg` | `#0f172a` (slate-900) | body background |
| `--dc-sp-surface` | `#1e293b` (slate-800) | controls section, event rows |
| `--dc-sp-surface-hover` | `#334155` (slate-700) | row hover |
| `--dc-sp-border` | `#334155` | dividers, row borders |
| `--dc-sp-text` | `#f1f5f9` (slate-100) | primary text |
| `--dc-sp-text-muted` | `#94a3b8` (slate-400) | timestamps, labels |
| `--dc-sp-accent` | `#3b82f6` (blue-500) | primary buttons, focus rings |
| `--dc-sp-accent-error` | `#ef4444` (red-500) | error row accent |
| `--dc-sp-accent-warning` | `#f59e0b` (amber-500) | warning row accent |
| `--dc-sp-accent-annotation` | `#a855f7` (purple-500) | annotation row accent |
| `--dc-sp-accent-screenshot` | `#10b981` (emerald-500) | screenshot row accent |
| `--dc-sp-rec` | `#dc2626` | REC dot (consistent with widget) |

Divergence rationale: the widget is a floating overlay on top of arbitrary web pages, so it deliberately uses a light neutral palette that disappears against most page backgrounds. The side panel is a dedicated surface hosted by Chrome — a dark theme looks better against both dark and light Chrome themes, feels "IDE-like" (fitting for a debug tool), and matches the roadmap brief ("dark theme, rounded input, compact list rows"). The REC dot color and the duration/size warning colors are kept consistent with the widget so a user alternating between the two surfaces sees the same status semantics.

Layout:
```
┌─────────────────────────────────────┐ <- viewport top (side panel = full height)
│  [first-run notice — dismissable]   │
├─────────────────────────────────────┤
│  ┌────┐ 12:34:56  click             │ <- event rows, 4px left border in accent color
│  │thumb│ button#submit              │
│  └────┘                             │
│  12:34:57  console_error            │
│  TypeError: Cannot read property... │
│                                     │ <- events list: flex:1, overflow-y:auto
│  12:34:58  annotation               │
│  "button didn't respond"            │
│  ┌──────┐                           │
│  │thumb │                           │
│  └──────┘                           │
│  ...                                │
├─────────────────────────────────────┤
│  ● 0:42 · 12 events, 2 shots · 3 KB │ <- metrics bar
│  ┌─────────────────────────────┐   │
│  │ What did you expect? ...    │   │ <- textarea
│  └─────────────────────────────┘   │
│  [Select Element] [Add Note]        │
│  ────────                           │
│  [Screenshot] [Stop & Download]     │
└─────────────────────────────────────┘ <- viewport bottom; controls section: flex:0 0 auto
```

Idle state replaces the controls with the PII fieldset + Start button + conditional Download button; events list is hidden and replaced by an onboarding card ("No active session — click Start to begin recording"). The same two-region flex layout is preserved in idle so the transition between states doesn't reflow the whole panel.

Compact row layout: 11px font for timestamp, 13px for label, 12px for detail; 6px vertical padding; thumbnail 40×40 inline-block at the left. Monospace font for timestamps (`font-variant-numeric: tabular-nums`).

## 12. Test plan with full pyramid

### Unit tests (pure, no DOM, no Chrome mocks)

**`src/lib/sidepanel-render.test.ts`** — covers every row mapping case:
1. `eventToRow` produces a row for every `TimelineEvent` variant: one test case per discriminator — `interaction` (click, input, scroll, navigation — 4 subtests), `viewport_resize`, `network_error`, `console_error` (error + warning), `js_exception`, `annotation`, `screenshot`. Each asserts `label`, `detail`, `accent`, and `screenshotDataUrl`.
2. `eventToRow` resolves screenshot thumbnails for `screenshot` events via `screenshots[event.id]`.
3. `eventToRow` resolves annotation thumbnails via `screenshots[event.screenshot_id]`.
4. `eventToRow` returns `screenshotDataUrl: null` if the referenced id is not in the map (graceful missing).
5. `eventToRow` never throws for any branch.
6. **Exhaustiveness guard test**: asserts `assertExhaustiveSidePanelEvent` is a function. The real guard is the compile-time `never` check — this test just keeps the import live so tree-shaking can't drop it.
7. **Discriminator set test**: mirrors `agents-doc.test.ts` — a `EXPECTED_DISCRIMINATORS` set equal to every `TimelineEvent["type"]`; for each, call `eventToRow` with a minimal valid fixture and assert a non-empty `label`. If a new variant is added without updating the mapper, the `eventToRow` call fails to compile.
8. `formatEventTimestamp(iso, now)` — deterministic: fixed `now` returns `"HH:MM:SS"` for same-day, `"MMM DD HH:MM:SS"` for other days, `"HH:MM:SS"` for events within the last 24h that cross midnight (edge case).
9. `eventTypeLabel` — one test per variant, verifying the exact human string.
10. `shouldAutoScroll`: true when within 40px of bottom, false otherwise, true when list is empty (first event), handles `scrollHeight === clientHeight` (no scrollbar) as true.

**`src/lib/sidepanel-storage.test.ts`** — covers `getScrollPosition` / `setScrollPosition`:
1. Round trip: set 420, get returns 420.
2. Missing key returns 0 (safe default).
3. Read error is swallowed, returns 0.
4. Write error is swallowed, doesn't throw.
5. Uses a distinct key per window id (`windowId=1` and `windowId=2` don't collide).
6. Uses the exact key prefix `deskcheck_sidepanel_scroll_` (guards the constants drift).

**`src/lib/sidepanel-events-source.test.ts`** — covers `subscribeToEvents`:
1. Initial snapshot is delivered on subscribe.
2. `STORAGE_EVENTS` change fires a new snapshot with the latest events.
3. `STORAGE_SCREENSHOTS` change fires a new snapshot with the latest screenshots.
4. `STORAGE_SESSION` change (session ended) fires a new snapshot with `session.end_time !== null`.
5. Changes to unrelated keys do NOT fire the callback.
6. Unsubscribe stops the callback firing on subsequent changes.
7. Unsubscribe is idempotent (second call is a no-op).

**`src/lib/privacy-notice.test.ts`** (new, Option A) — asserts `buildFirstRunNoticeModel()` returns a stable view-model whose `bullets` are identical to `PRIVACY_NOTICE_BULLETS`.

### Integration tests (jsdom, Chrome API faked via injectable seams)

**`src/sidepanel/sidepanel.test.ts`** (uses `// @vitest-environment jsdom`):
1. **Mount in idle state**: stub `chrome.runtime.sendMessage` for `GET_SESSION_STATE` returning `{ recording: false, hasExportableSession: false }`. Call `mountSidePanel(rootEl, fakeChrome)`. Assert PII fieldset is visible, events list is hidden, Start button is visible.
2. **Mount in active state**: stub `GET_SESSION_STATE` returning `{ recording: true, sessionId: "x", activeTabId: 1 }`. Pre-populate fake storage with 3 events. Assert 3 rows are rendered in DOM, controls include Stop button.
3. **Live update**: fake storage fires `onChanged` with 4 events. Assert a 4th row appears in DOM, no full re-render (existing nodes preserved).
4. **Auto-scroll behavior**: simulate scroll near bottom, new event arrives → scroll follows. Simulate scroll to top, new event arrives → scroll stays at top.
5. **Scroll persistence round-trip**: scroll to 200, fire debounce timer, assert fake session storage has `deskcheck_sidepanel_scroll_1 = 200`. Remount: assert events list scrollTop restored to 200.
6. **First-run notice shows when flag is unset**: stub `getFirstRunSeen` to return false. Assert notice is in DOM. Click Got it. Assert notice removed, `markFirstRunSeen` called.
7. **First-run notice hidden when flag is set**: stub returns true. Assert notice not in DOM.
8. **PII mode selection flows to START_SESSION**: select metadata radio, click Start, assert `sendMessage` called with `{ type: "START_SESSION", ..., piiMode: "metadata" }`.
9. **Annotation submit**: type text, click Add Note, assert `sendMessage` called with `{ type: "ADD_ANNOTATION", text: "..." }`.
10. **Session end transition**: fire fake storage change where `session.end_time` flips from null to an ISO string. Assert active controls swap to idle controls, events list is cleared.
11. **Transition from idle to active**: successful Start Session causes mount flow to rerun and produce active layout without full page reload.
12. **Exhaustive renderer coverage through DOM**: for each `TimelineEvent` variant, push an event into fake storage, fire change, assert a row with the expected accent class appears.

**`src/sidepanel/build-artifacts.test.ts`** (negative test for popup removal):
1. `manifest.json` parsed and `action.default_popup` is undefined.
2. `manifest.json` has `side_panel.default_path === "src/sidepanel/index.html"`.
3. `manifest.json` has `"sidePanel"` in `permissions`.
4. `src/popup/index.html` does not exist on disk (`fs.existsSync` → false).
5. `src/popup/popup.ts` does not exist on disk.
6. No file under `src/` imports anything from `src/popup/` (grep via `fs.readdirSync`).

### DoD → test mapping

| DoD criterion | Test file | Test case |
|---|---|---|
| 1. Side panel registered; toolbar click opens it | `build-artifacts.test.ts` | Manifest has `side_panel.default_path` + `sidePanel` permission |
| 2. Legacy popup removed | `build-artifacts.test.ts` | `popup/` files absent, manifest has no `default_popup` |
| 3. Start Session in side panel form | `sidepanel.test.ts` | "Mount in idle state", "PII mode selection flows to START_SESSION" |
| 4. Two-region layout | `sidepanel.test.ts` | "Mount in active state" asserts `#events-list` and `#controls` are siblings with the expected flex classes |
| 5. Live chronological list | `sidepanel.test.ts` | "Live update" |
| 6. Inline screenshot thumbnails | `sidepanel-render.test.ts` + `sidepanel.test.ts` | render resolves thumbnails; integration asserts `<img>` appears |
| 7. Real-time updates | `sidepanel.test.ts` | "Live update" |
| 8. Lower region controls + metrics | `sidepanel.test.ts` | "Mount in active state" asserts metrics bar, textarea, screenshot, stop buttons |
| 9. Event list scrolls independently | `sidepanel.test.ts` | "Scroll persistence round-trip" implicitly verifies `#events-list` is the scroll container |
| 10. State persists across tab switches | Manual (Chrome platform) + `sidepanel.test.ts` | "Scroll persistence round-trip" |
| 11. Visual styling consistent with theme | Visual QA checklist (documented in `sidepanel.css`) + `build-artifacts.test.ts` asserts `sidepanel.css` exists and contains the expected CSS custom properties |

**Coverage target**: 90% for `src/lib/sidepanel-*.ts` (pure modules — easy), 75% for `src/sidepanel/sidepanel.ts` (glue — some paths require manual Chrome interaction).

## 13. Acceptance test seeds (one-sentence given/when/then per DoD)

1. **Side panel registered**: Given the extension is installed, when the user clicks the toolbar icon, then the DeskCheck side panel opens in the current window.
2. **Legacy popup removed**: Given the extension is installed, when the user clicks the toolbar icon, then no popup appears — only the side panel opens.
3. **Start Session from side panel**: Given the side panel is open and no session is active, when the user selects a PII mode and clicks "Start Session", then the service worker receives `START_SESSION` with the selected mode and recording begins.
4. **Two-region layout**: Given the side panel is open with an active session, when the viewport height changes, then the events list region grows/shrinks while the controls region stays pinned to the bottom with fixed height.
5. **Live chronological list**: Given an active session, when a new `TimelineEvent` is appended to storage, then within one tick a new row appears at the bottom of the events list with its timestamp and type label.
6. **Inline screenshot thumbnails**: Given an active session, when a screenshot event is appended with a valid data URL in the screenshots map, then the row for that event renders a 40×40 `<img>` thumbnail inline.
7. **Real-time updates**: Given an active session with the side panel open, when 10 events arrive in quick succession, then all 10 rows render without the user taking any refresh action.
8. **Lower region controls**: Given an active session, when the side panel is open, then the lower region shows a metrics bar (duration, event count, size), an annotation textarea, Select Element, Add Note, Screenshot, and Stop & Download buttons.
9. **Independent scrolling**: Given a long events list in the side panel, when the user scrolls the events region, then the controls region remains fully visible at the bottom.
10. **State persists across tab switches**: Given the side panel is open and scrolled to position Y in window W, when the user switches to a different tab in window W and back, then the side panel is still open and the events list is still scrolled to position Y.
11. **Dark theme styling**: Given the side panel is open, when inspected visually, then the body background is slate-900, the primary accent is blue-500, error rows have a red left border, warning rows amber, annotation rows purple, and screenshot rows emerald — matching the documented palette.

## 14. Architecture changelog draft (for `docs/ARCHITECTURE.md`)

```markdown
### Side Panel (`src/sidepanel/`)
Primary session-control surface, replacing the legacy popup. Renders a
dark-themed two-region layout: a live chronological events list above
a sticky controls section (metrics bar, annotation textarea, element
picker, screenshot, stop & download). Registered via
`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`
in the service worker so the toolbar icon opens the panel directly.

Data flow: the side panel subscribes to `chrome.storage.onChanged`
through `src/lib/sidepanel-events-source.ts` and re-renders the events
list on every change. Event-to-DOM mapping lives in the pure module
`src/lib/sidepanel-render.ts`, which uses the same compile-time
exhaustiveness pattern as `agents-doc.ts` — adding a new `TimelineEvent`
variant fails `make typecheck` until the side panel renderer is updated.
Scroll position per window is persisted in `chrome.storage.session` via
`src/lib/sidepanel-storage.ts`. PII mode selection and the first-run
privacy notice reuse the existing `pii-modes.ts` and `privacy.ts`
modules — no copy duplication.
```

## 15. Risks

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| `chrome.sidePanel` API not available in older Chromes (<114) | Medium | Low | Document minimum Chrome version in README; defensive `if (chrome.sidePanel)` guard in service worker with a console warning |
| Re-rendering 1000+ events on every storage change causes lag | Medium | Medium | Diff-based append: track last rendered `seq`, only create DOM nodes for events with `seq > lastRenderedSeq`. Unit-test this in `sidepanel.test.ts` |
| Scroll position restore races with initial render | Low | Medium | Restore scroll inside a `requestAnimationFrame` after the list is populated; test covers the race |
| Widget refactor (Option A) breaks the existing first-run notice | Medium | Low | Keep `PRIVACY_NOTICE_BULLETS` untouched; new module only composes it into a view-model; existing `privacy.test.ts` + new widget integration test catch regressions |
| Side panel and widget both present at once — visual competition | Low | High | Expected — the widget is the in-page annotator, the side panel is the control surface. Document this in ARCHITECTURE.md |
| `chrome.storage.session` quota exceeded | Very Low | Very Low | Scroll positions are ~10 bytes each; quota is 10 MB; N/A in practice |
| Event list accumulates memory during a long session | Medium | Medium | Pure render mapper is stateless; DOM nodes are lightweight; worst case is bounded by `STORAGE_EVENTS` size which is already the invariant on the widget surface |
| Test flakiness from debounced scroll persistence | Low | Medium | Use Vitest fake timers (`vi.useFakeTimers`) for the 200ms debounce window; no real `setTimeout` in the test path |

## 16. Rollback strategy

Rollback is a single revert:
1. `git revert <commit-range>` for the feature branch — restores `src/popup/`, removes `src/sidepanel/`, removes the new lib modules, restores `manifest.json` to its pre-feature state.
2. Delete `dist/` and run `make build` — Vite will emit the popup again from the restored files.
3. Reload the unpacked extension in `chrome://extensions`. Chrome automatically ignores the stale `sidePanel` registration once the manifest changes back.
4. No data migration needed — `chrome.storage.local` keys are unchanged, `chrome.storage.session` scroll keys will be orphaned for one browser session and then auto-cleared on restart.

Partial rollback (keep side panel, restore popup as secondary): if users complain that losing the popup is disruptive, we can reintroduce `action.default_popup` pointing to a 5-line HTML redirect that calls `chrome.sidePanel.open()` and closes itself. Defer this unless feedback demands it — quality preference is one surface, not two.

---

## Definition of Done (quality-focused)

- [ ] Side panel registered in manifest with correct permission
- [ ] Legacy popup files deleted; no import references remain
- [ ] Start Session form functional with PII mode selection
- [ ] Two-region flex layout with scrolling events list and pinned controls
- [ ] Live events list updates via `chrome.storage.onChanged` without polling
- [ ] Inline screenshot thumbnails rendered for screenshot + annotation events
- [ ] Metrics bar, textarea, element picker, screenshot, stop & download all wired
- [ ] Scroll position persisted per window in `chrome.storage.session`
- [ ] First-run privacy notice rendered via shared pure module (no copy duplication)
- [ ] Dark theme matches documented palette; visual divergence from widget documented
- [ ] `SidePanelEventRow` mapper exhaustive over `TimelineEvent` via `never` fallback
- [ ] Compile-time guard: adding a new `TimelineEvent` variant breaks `make typecheck` until the side panel renderer handles it
- [ ] No `any` in new code; no linting warnings
- [ ] `make test` passes with new unit + jsdom integration tests
- [ ] Coverage >= 90% for `src/lib/sidepanel-*.ts`, >= 75% for `src/sidepanel/sidepanel.ts`
- [ ] `docs/ARCHITECTURE.md` updated with the Side Panel component block
- [ ] No type errors (`make typecheck`)
- [ ] Tests pass (`make test`)
- [ ] Build succeeds (`make build`) and manual smoke test confirms the panel opens on toolbar click

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|---|---|---|
| 1 | Side panel registered in manifest | Unit | Parse manifest.json in a test, assert fields |
| 2 | Legacy popup files deleted | Unit | Filesystem check in a negative test |
| 3 | Start Session form functional | Integration | jsdom mount + mocked chrome.runtime.sendMessage |
| 4 | Two-region flex layout | Integration | jsdom asserts DOM structure + computed CSS classes |
| 5 | Live events list via storage.onChanged | Integration | Tests the seam between events-source and DOM |
| 6 | Inline screenshot thumbnails | Unit | `eventToRow` returns correct `screenshotDataUrl`; integration confirms `<img>` in DOM |
| 7 | Controls wired | Integration | jsdom dispatches click events, asserts sendMessage calls |
| 8 | Scroll position persisted | Unit + Integration | Unit for storage module; integration for round-trip with fake timers |
| 9 | First-run notice via shared module | Unit | New `privacy-notice.test.ts` on the pure module |
| 10 | Dark theme palette | Unit | Parse sidepanel.css, assert CSS custom properties exist with exact values |
| 11 | Exhaustive renderer | Unit | Discriminator set test mirroring agents-doc.test.ts |
| 12 | Compile-time guard on new variants | Typecheck | `make typecheck` is the guard; covered by `assertExhaustiveSidePanelEvent` existence test |
| 13 | No `any`, no lint warnings | Typecheck / Lint | CI gate |
| 14 | Tests pass | CI | `make test` |
| 15 | Coverage targets | Unit | Vitest coverage report |
| 16 | Architecture doc updated | Manual review | Judge or human reviewer |
| 17 | No type errors | Typecheck | `make typecheck` |
| 18 | Build succeeds | CI | `make build` |

**Quality planner bias**: All logic (render mapper, storage wrappers, subscription wrapper, auto-scroll helper, timestamp formatter) is unit tested. The DOM glue has one jsdom integration test file covering mount, live updates, scroll persistence, first-run notice, PII wiring, and state transitions — deliberately focused on boundaries, not layout pixels. No e2e tests are proposed for this feature because the extension has no existing e2e harness and Chrome side panels are hard to drive from Playwright without significant investment; manual smoke tests cover the remaining DoD.

**Determinism rule**: No tests make live API calls. `formatEventTimestamp` takes an injectable `now` parameter for determinism. `subscribeToEvents` takes an injectable `StorageApi` so tests use a synchronous in-memory fake. `sidepanel-storage.ts` takes an injectable `SessionStorageApi`. Vitest fake timers drive the 200ms scroll debounce.

## Testing Strategy

- **Unit**: `sidepanel-render.test.ts` (every event variant, every helper, exhaustiveness), `sidepanel-storage.test.ts` (round-trip, defaults, per-window keys), `sidepanel-events-source.test.ts` (subscribe/unsubscribe/filter), `privacy-notice.test.ts` (view-model shape).
- **Integration**: `sidepanel.test.ts` (jsdom: mount, live updates, scroll persistence, first-run notice, PII wiring, state transitions, 12 test cases).
- **Negative build test**: `build-artifacts.test.ts` (popup absent, manifest correct, no lingering imports).

**E2E Test Impact**:
- **Existing e2e tests affected**: None — the project has no e2e harness (see `vite.config.ts` excludes `e2e/**`).
- **New e2e tests needed**: None at this stage. Document a manual smoke test checklist in the PR description: (1) load unpacked, (2) click toolbar icon, verify panel opens, (3) start session, (4) interact with a page, verify events appear live, (5) scroll list, switch tabs, switch back, verify scroll preserved, (6) stop & download, verify zip exported.
- **Cost note**: N/A.

**Test files to create**: `src/lib/sidepanel-render.test.ts`, `src/lib/sidepanel-storage.test.ts`, `src/lib/sidepanel-events-source.test.ts`, `src/lib/privacy-notice.test.ts`, `src/sidepanel/sidepanel.test.ts`, `src/sidepanel/build-artifacts.test.ts`.

**Coverage target**: 90% `src/lib/sidepanel-*.ts`, 75% `src/sidepanel/sidepanel.ts`, 100% for `privacy-notice.ts` (trivial).

## Code Quality Checklist

- [ ] Follows SOLID: `sidepanel-render` is single-responsibility (view-model), `sidepanel-events-source` is single-responsibility (stream), `sidepanel.ts` is single-responsibility (DOM wiring)
- [ ] No code duplication: first-run notice bullets + PII mode parsing sourced from existing pure modules
- [ ] Clear naming: `SidePanelEventRow`, `subscribeToEvents`, `getScrollPosition`, `eventToRow`, `assertExhaustiveSidePanelEvent` — all self-documenting
- [ ] Appropriate abstraction: three pure modules + one glue file; no premature component framework
- [ ] Error handling: storage read/write failures in `sidepanel-storage.ts` degrade gracefully; `sendMessage` failures in glue surface errors in the status line
- [ ] Types: `SidePanelEventRow`, `RowAccent`, `StorageApi`, `SessionStorageApi`, `EventsSourceSnapshot` — zero `any`
- [ ] Edge cases: missing screenshots, unknown event types (blocked at compile time), empty events list, long events list, events arriving during scroll, session ending while panel is open, first-run notice flag read failure, scroll position clamp on overflow
- [ ] Logging: `console.warn` for storage failures, `console.error` for unexpected exceptions — same pattern as existing `privacy-store.ts`

## Patterns to Apply

| Pattern | Where | Why |
|---|---|---|
| Pure module + thin glue | All of `src/lib/sidepanel-*.ts` vs `src/sidepanel/sidepanel.ts` | Matches existing codebase convention |
| Compile-time exhaustiveness via `never` | `eventToRow` and `assertExhaustiveSidePanelEvent` | Forces future contributors to update the renderer when `TimelineEvent` grows |
| Injectable Chrome API seams | `StorageApi`, `SessionStorageApi` | Unit testability without global monkey-patching |
| View-model separation | `SidePanelEventRow` | Keeps DOM code trivial and mapper unit-testable |
| Debounced persistence | Scroll position | Standard quality pattern to avoid storage thrash |
| Shared pure source of truth | `buildFirstRunNoticeModel()` | Eliminates copy drift between widget and side panel |

## Impact Assessment

**Positive Impacts**:
- Introduces a clean "live-data-view" pattern (pure mapper + storage-change subscription) that future features (e.g., live metrics panel) can reuse
- Removes the popup surface entirely — one fewer UI to maintain
- The `privacy-notice.ts` extraction hardens the "no copy drift" invariant across widget and side panel
- Dark theme gives the extension a more "developer tool" feel consistent with its purpose

**Neutral (unchanged)**:
- Service worker message handlers are unchanged
- `session-store.ts`, `session-metrics.ts`, `exporter.ts` are unchanged
- Widget behavior on recorded pages is unchanged except for the minor notice-rendering refactor

**Risks**: see section 15.

## Estimated Effort

- Planning: already done
- Pure module implementation (`sidepanel-render`, `sidepanel-storage`, `sidepanel-events-source`, `privacy-notice`): 60 min
- Pure module tests: 50 min
- Glue layer (`sidepanel.ts`, `sidepanel.css`, `index.html`): 80 min
- jsdom integration tests: 70 min
- Manifest + service worker wiring: 15 min
- Popup deletion + negative build test: 15 min
- Widget refactor (Option A, small): 20 min
- Architecture doc update: 10 min
- Manual smoke test + fixes: 30 min
- **Total**: ~350 min (~5h 50min)

Note vs speed: a speed-optimized plan would skip the three-module split, inline the render logic in `sidepanel.ts`, copy the first-run notice bullets, and skip some unit tests — shaving roughly 120 min. The quality investment buys compile-time safety for future `TimelineEvent` additions, an auditable "no copy drift" guarantee on privacy text, and DOM-free unit tests that will survive future refactors.

> ⚠️ **Quality Investment**: This approach takes ~2x longer than a minimal inline implementation. Worth it because (a) the exhaustive renderer catches schema drift at compile time, (b) the pure modules are reusable for future live-view features on the roadmap, and (c) the test pyramid matches the existing codebase style (pure modules tested without Chrome mocks), which means the feature's verification surface is stable under future refactoring.

## Technical Debt Addressed

- Extracts the first-run notice into a presentation-agnostic pure module (eliminates the latent risk of widget and side panel copy drifting)
- Introduces the first storage-change subscription wrapper, which can be reused by future live-view features (removes the need for ad-hoc `chrome.storage.onChanged` calls in future surfaces)
- Removes `src/popup/` entirely — a surface that was already a thin shim around the widget

No new debt introduced.

## Formal Verification Assessment

- **Concurrency concerns**: Minor — the side panel and the service worker read/write the same storage keys, but the service worker is the only writer for `STORAGE_EVENTS`/`STORAGE_SCREENSHOTS`/`STORAGE_SESSION`. The side panel is read-only for those keys and only writes to `chrome.storage.session` under its own per-window scroll key. No shared-state writer conflicts.
- **State machine complexity**: Low — two states (idle / active) with deterministic transitions triggered by `session.end_time` flipping or by `START_SESSION` succeeding. Documentable in a single paragraph.
- **Conservation laws**: None — the side panel does not mint, burn, or transfer any persistent state. Events are append-only in the service worker and read-only here.
- **Authorization model**: None — the side panel is a user-facing surface with no permission model beyond Chrome's extension-scoped permissions.
- **Recommendation**: **Formal verification not needed**. The concerns are covered by (a) the compile-time exhaustiveness guard, (b) the injectable-seam unit tests, and (c) the jsdom integration test covering state transitions. Standard tests are sufficient.
- **If recommended, key invariants**: N/A. (For reference, the implicit invariants are: "events list DOM row count equals `events.length` whenever the side panel is mounted"; "scroll position saved per window is restored on remount"; "first-run notice is shown at most once per browser profile".)

## Future Extensibility

- **New event types**: compile-time forced through the exhaustive mapper
- **Event filtering** (e.g., "show only errors"): trivial — add a predicate before `eventToRow` call in the glue layer, unit-test the predicate in isolation
- **Event search**: the view-model already carries `label` and `detail` as strings; full-text search is a pure function on the row array
- **Multiple sessions view** (future): `subscribeToEvents` already takes a snapshot shape; extending to a list-of-sessions snapshot is additive
- **Light theme toggle**: CSS custom properties make this a 20-line swap
- **Replacing the Chrome storage seam with IndexedDB** (for #5 feature OPFS work): `StorageApi` interface already abstracts the storage area; only one module needs to change
