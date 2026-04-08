# DeskCheck Architecture

Chrome extension (Manifest V3) that records debugging sessions for AI-assisted bug fixing. Captures user interactions, console errors, network failures, JS exceptions, screenshots, and user annotations into an exportable zip.

## Components

```
┌──────────────┐    chrome.runtime.sendMessage     ┌──────────────────┐
│  Side Panel  │ ─────────────────────────────────► │  Service Worker  │
│  (chrome UI) │ ◄───── chrome.storage.onChanged    │  (background)    │
│              │                                    │                  │
│ - Event feed │                                    │  - Session mgmt  │
│ - Controls   │                                    │  - CDP client    │
│ - Metrics    │                                    │  - Screenshots   │
└──────────────┘                                    │  - Export (zip)  │
                                                    │  - Storage I/O   │
┌──────────────┐    chrome.runtime.sendMessage      │  - sidePanel reg │
│  Content     │ ◄────────────────────────────────► └──────┬───────────┘
│  Script      │                                           │
│              │    chrome.storage.local                   │
│ - Recorder   │ ◄────────────────────────────────────────►│
│ - Widget     │                                           │
│ - Picker     │                                  chrome.debugger (CDP)
└──────────────┘                                           │
                                                   ┌───────▼───────┐
                                                   │  Target Tab   │
                                                   │  (observed)   │
                                                   └───────────────┘
```

### Service Worker (`src/background/`)
- **service-worker.ts** — Message router, session lifecycle, keyboard shortcuts, export orchestration. Restores state on wake. **Calls `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` at top level on every wake** so a toolbar click opens the side panel directly (no popup in between). Pinned by `tests/service-worker-setpanel.test.ts`.
- **screenshot.ts** — `chrome.tabs.captureVisibleTab` wrapper scoped to the recorded tab. Exports a pure `canCaptureRecordedTab()` gate that refuses capture if the recorded tab is not currently active, so mid-session tab switches cannot leak content from an unrelated tab.

### Content Script (`src/content/`)
- **index.ts** — Injection guard, message listener, session state sync with fallbacks (message + storage.onChanged). Also handles `START_ELEMENT_PICKER` from the side panel and replies via `PICK_ELEMENT_RESULT` (containing the picked `ElementInfo` plus `window.devicePixelRatio` for crop math).
- **recorder.ts** — DOM event recording (click, input, scroll, resize, SPA navigation). Input events are debounced (800ms) to capture final values, not keystrokes.
- **element-picker.ts** — Interactive element selector with closed Shadow DOM overlay. Triggered on demand by the side panel; not exposed via any in-page UI of its own.

There is **no in-page widget**. Earlier versions hosted a floating annotation panel on the recorded tab; that surface was removed in 0.4.0 in favor of the side panel, which is always visible across tab switches and never overlaps with page content.

### Side Panel (`src/sidepanel/`)
Chrome side panel UI — the only DeskCheck surface other than the in-page recorder + element picker. Persistent across tab switches within a window; opens directly when the user clicks the toolbar action. Replaces both the legacy browser-action popup AND the legacy in-page widget.

- **index.html** — Minimal shell hosting `#sidepanel-root`.
- **sidepanel-entry.ts** — Production entry point that wires real Chrome APIs (`chrome.runtime.sendMessage`, `chrome.runtime.onMessage`, `chrome.storage.onChanged`, `chrome.windows.onFocusChanged`, `chrome.storage.session`) into the glue layer.
- **sidepanel.ts** — Glue layer (`mountSidePanel`). Two-region flex layout: scrollable event feed above, sticky controls form below. 2-state machine (`idle` | `active`) plus a `paused` flag. Hosts: start / pause / stop, annotation textarea, "Pick element" trigger, screenshot button, PII mode selector, session metrics (with paused badge), first-run notice, inline pre-export reminder. **Never imports privileged Chrome capture APIs** (verified by `tests/sidepanel-no-direct-capture.test.ts`); all capture goes through the service worker. Uses `image-utils.cropScreenshot` to crop element-only screenshots client-side at annotation submit time, with the recorded tab's `devicePixelRatio` carried in via `PICK_ELEMENT_RESULT`.
- **sidepanel.css** — Dark theme palette (`slate-900` background, `blue-500` accent, per-row accents for danger/warning/annotation/screenshot rows). Thumbnails are `100px` square (`object-fit: cover`) and visible by default — there is no click-to-reveal gate (the side panel lives in the user's own browser chrome, where the user already controls visibility during screen sharing).

### Shared Libraries (`src/lib/`)
- **session-store.ts** — chrome.storage.local CRUD for sessions, events, screenshots. `getSession` back-fills `pii_mode` to `"full"` for legacy sessions.
- **exporter.ts** — Builds zip (fflate) from session data. Strips internal fields (tab_id). Skips corrupted screenshots gracefully. Embeds `agents.md` from `agents-doc.ts` so the export is self-documenting.
- **agents-doc.ts** — Single source of truth for the export schema version and the `agents.md` reference doc shipped inside every zip. Includes a compile-time exhaustiveness helper (`assertExhaustiveEventTypes`) so adding a new `TimelineEvent` variant fails `make typecheck` until the doc is updated.
- **debugger-client.ts** — CDP v1.3 client. Subscribes to Network, Log, Runtime domains. Filters extension URLs. Sanitizes sensitive headers (Authorization, Cookie, etc.) before storing.
- **session-metrics.ts** — Pure functions for session metrics: size estimation, duration/bytes formatting, threshold checking. Polled by widget every 2s via `GET_SESSION_METRICS`.
- **privacy.ts** — Pure module: single source of truth for the in-widget first-run notice bullets, the pre-export reminder line, and the `PRIVACY.md` template shipped in every export. Imported by `widget.ts`, `exporter.ts`, and `privacy-notice.ts` so the copy cannot drift.
- **privacy-notice.ts** — Pure module: `buildFirstRunNoticeModel()` view-model shared between the in-page widget and the side panel so both surfaces render the same first-run bullets. Pinned by `privacy-notice.test.ts` against `PRIVACY_NOTICE_BULLETS`.
- **privacy-store.ts** — `chrome.storage.local` wrapper for the first-run notice flag. Read failures default to "not seen" so the notice errs on the side of being shown; write failures are logged but not thrown.
- **sidepanel-render.ts** — Pure view-model module for the side panel event feed. Maps each `TimelineEvent` variant to a `SidePanelEventRow` with timestamp, label, detail, accent, and **privacy-safe** screenshot fields (`screenshotPlaceholderId` + `screenshotDataUrl` as a string field — never embedded in HTML). Exports `assertExhaustiveSidePanelEvent` for compile-time exhaustiveness, mirroring `agents-doc.assertExhaustiveEventTypes`. Adding a new `TimelineEvent` variant fails `make typecheck` until the side panel renderer handles it.
- **sidepanel-storage.ts** — Per-window scroll position persistence backed by `chrome.storage.session` (in-memory, cleared on browser restart so stale scroll positions don't survive). Rejects `WINDOW_ID_NONE` (-1) and clamps negative values. Injectable `SessionStorageApi` seam for tests.
- **sidepanel-events-source.ts** — Wraps `chrome.storage.onChanged` to expose a clean `subscribeToEvents` API for the side panel. Reads `change.newValue` directly (never calls `session-store` accessors — pinned by spy test). Computes append-only deltas; falls back to a full reset if the events array shrinks, becomes undefined, or is replaced with the same length (defensive against partial writes).
- **pii-modes.ts** — Pure module for PII capture mode policy. **PRIVACY-CRITICAL**: `capturePayloadForMode` is the only code path that reads `target.value` for input events. Defines the `PiiCaptureMode` (`full` | `metadata` | `none`) and metadata extraction. In metadata mode, records exact counts for each character class (`letter_count`, `digit_count`, `emoji_count`, `whitespace_count`, `special_count`) plus `length` and `word_count` — enough for an engineer to reconstruct a realistic repro input without the raw value.
- **dom-utils.ts** — CSS selector generation, element info extraction, throttle utility.
- **image-utils.ts** — Screenshot cropping for element annotations.

### Types (`src/types.ts`)
Discriminated union for timeline events: interaction, viewport_resize, network_error, console_error, js_exception, annotation, screenshot. Message types for inter-component communication.

## Data Flow

1. User clicks the toolbar action → side panel opens directly (no popup) via `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`
2. User clicks "Start session" in the side panel → service worker creates session in storage, attaches CDP debugger, injects content script
3. Content script starts recorder (DOM events) + shows in-page widget overlay
4. Events flow: content script → `RECORD_EVENT` message → service worker → `appendEvent()` → `chrome.storage.local`
5. CDP events (network errors, console, exceptions) flow directly from debugger client → storage
6. **Live event feed**: side panel subscribes to `chrome.storage.onChanged` filtered to the events key. Each delta appends new rows to the feed without re-rendering existing rows (DOM nodes are preserved by identity)
7. **Cross-window**: switching focus to another window fires `chrome.windows.onFocusChanged` → side panel re-fetches `GET_SESSION_STATE` so each window's panel reflects the global session
8. User clicks "Stop & download" in the side panel (or in the in-page widget) → service worker ends session, builds zip, triggers download, clears storage. The side panel observes `session.end_time` flipping via storage onChanged and transitions to idle (revealed screenshot thumbnails are unmounted from the DOM)

## Export Schema (v1.1.0)

```
deskcheck-session-{timestamp}.zip
├── session.json    # { schema_version, session, timeline[], summary }
├── agents.md       # self-documenting schema reference for AI consumers
├── PRIVACY.md      # Privacy notice — sibling artifact, not part of session.json
└── screenshots/    # PNGs referenced by timeline events
```

`schema_version` follows semver and tracks the *whole zip layout*, not
just `session.json`. The single source of truth lives in `src/lib/agents-doc.ts`
as `SCHEMA_VERSION` and is consumed by `exporter.ts`.

`PRIVACY.md` is a sibling artifact in the zip, not a field of `session.json`.
It is added to `zipData` BEFORE the screenshots loop in `exportSession` and is
intentionally not wrapped in try/catch — a missing privacy notice is a louder
failure mode than a missing screenshot.

`session.pii_mode` records which PII capture mode the session ran under
(`full` | `metadata` | `none`). In `metadata` mode, input interaction events
omit `value` and instead carry `value_metadata` with exact counts per
character class: `{length, word_count, letter_count, digit_count,
emoji_count, whitespace_count, special_count}`. The counts are precise
rather than boolean flags so an engineer can reproduce the input shape
from the metadata alone. In `none` mode, no input events are emitted.

## Security

- A session is bound to the **single tab** it started on. DOM events come from the content script injected into that tab, CDP events come from the debugger attached to that tab, and `takeScreenshot()` refuses to capture unless that tab is currently active (`canCaptureRecordedTab`). This prevents a mid-session tab switch from silently leaking content from an unrelated tab into the export.
- **Side panel never captures directly.** The side panel UI is forbidden from importing `chrome.tabs.captureVisibleTab`, `chrome.debugger`, or `chrome.scripting`. Pinned by a grep test (`tests/sidepanel-no-direct-capture.test.ts`) so a future shortcut cannot bypass the service-worker chokepoint.
- **Annotation-attached screenshots are stored once.** When the user submits an annotation, the SW captures the full-page screenshot (and crops the picked element if any) but does NOT append a separate `screenshot` timeline event for either image. The screenshots live in the screenshots map and are rendered inline on the annotation row in the side panel feed. This prevents "screenshot, screenshot, annotation" triple-rows in the timeline for a single user action.
- Sensitive headers (Authorization, Cookie, Set-Cookie, Proxy-Authorization, X-Api-Key) are stripped from network error events before storage
- Widget and element picker use closed Shadow DOM
- Password fields are masked as `[password]` in `full` mode; in `metadata` mode only their length/char-class flags are recorded; in `none` mode they are not recorded at all
- PII capture mode (`full` | `metadata` | `none`) is selected per-session in the popup. `capturePayloadForMode` in `src/lib/pii-modes.ts` is the single chokepoint that decides whether the raw input value reaches the timeline; negative property tests assert raw values never appear in serialized events for non-`full` modes
- No external network requests; all data stays local
- Session data cleared from storage after export
- First-run privacy notice (shown once per install via `chrome.storage.local`) explains that DeskCheck captures the recorded tab's viewport, form inputs, and network headers — not the whole screen, not other tabs
- Pre-export reminder panel surfaces inside the widget on every Stop & Download click; "Keep recording" cancels with no state changes, "Download" proceeds with the unchanged stop/export flow
- Every export zip ships a `PRIVACY.md` describing exactly what is (and is not) in the contents, and an `agents.md` describing the schema for AI consumers
- Single production dependency (fflate)

## Conventions

- Vanilla TypeScript, no framework
- Vitest for testing; pure functions tested without Chrome API mocks
- Semver versioning; manifest.json and package.json versions must match
- `make build` = typecheck + vite build + copy icons

## Changelog

| Version | Changes |
|---------|---------|
| 0.4.0   | Side panel UX (feature #8): primary UI moves from the browser-action popup into a Chrome side panel (`chrome.sidePanel`). The toolbar action opens the side panel directly via `setPanelBehavior({ openPanelOnActionClick: true })` called on every SW wake. Two-region layout — scrollable live event feed above, sticky controls form below — with dark-theme palette. New pure modules: `sidepanel-render.ts` (exhaustive `eventToRow` mapper mirroring `agents-doc.assertExhaustiveEventTypes`), `sidepanel-storage.ts` (per-window scroll persistence in `chrome.storage.session`), `sidepanel-events-source.ts` (append-only delta subscription that reads `change.newValue` directly and never calls store accessors), `privacy-notice.ts` (single source of truth for the first-run notice copy). The side panel hosts: start / pause / stop, annotation textarea, "Pick element" trigger, screenshot button, PII mode selector, session metrics with paused badge, first-run notice, inline pre-export reminder. Element picker round-trips via `START_ELEMENT_PICKER`/`PICK_ELEMENT_RESULT` messages between the side panel and the recorded tab's content script; element-screenshot cropping happens client-side in the side panel at annotation submit time, using the recorded tab's `devicePixelRatio` from the pick result. Annotation-attached screenshots are stored once and rendered inline on the annotation row instead of producing separate `screenshot` timeline events. Thumbnails are 100px square and visible by default. **Privacy hardening**: the side panel never imports `captureVisibleTab`/`debugger`/`scripting` (grep-pinned by `tests/sidepanel-no-direct-capture.test.ts`). The legacy `src/popup/` and `src/content/widget.ts` surfaces are deleted; manifest no longer declares `default_popup` or the `toggle-annotation` keyboard shortcut. SW gains a transient in-memory `paused` flag (gates DOM + CDP events; manual screenshot/annotation actions still work while paused). |
| schema 1.1.0 | Added `agents.md` self-documenting schema reference inside every export zip (`src/lib/agents-doc.ts`). Compile-time exhaustiveness guard keeps the doc in lockstep with `TimelineEvent`. PII capture modes (feature #4): per-session Full/Metadata/None selector in the popup controls how form inputs are recorded. New pure module `src/lib/pii-modes.ts` is the single chokepoint that reads `target.value`. `SessionMetadata.pii_mode` and `InteractionEvent.value_metadata` added; metadata mode records exact per-class counts (letter/digit/emoji/whitespace/special) for repro fidelity. |
| (unreleased) | Sensitive data warnings (feature #2): first-run notice in the widget, pre-export reminder panel with explicit Keep-recording cancel, and a `PRIVACY.md` shipped in every export. New `src/lib/privacy.ts` (pure copy + decision helper) and `src/lib/privacy-store.ts` (storage wrapper). Single source of truth for notice copy across the widget and the exporter. Tightened `takeScreenshot()` to refuse capture when the recorded tab is not the currently-active tab (new pure `canCaptureRecordedTab()` gate), so mid-session tab switches cannot leak content from an unrelated tab into the export. |
| 0.3.0   | Consolidated UI into widget overlay, debounced input recording, security hardening, new icon |
| 0.2.0   | Initial release as DeskCheck (renamed from Examiner) |
